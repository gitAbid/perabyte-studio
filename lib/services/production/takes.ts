import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  AccountEvidenceSchema,
  BudgetQuoteSchema,
  CreateAnchorCommandSchema,
  CreateTakeCommandSchema,
  IdSchema,
  JobSchema,
  ProviderRequestSnapshotSchema,
  QuoteAccountBindingSchema,
  QuoteSchema,
  SelectTakeCommandSchema,
  type Asset,
  type CreateAnchorCommand,
  type CreateTakeCommand,
  type JsonValue,
  type ProductionJob,
  type ProductionQuote,
  type ProviderRequestSnapshot,
  type ResolvedStatesStamp,
  type SelectTakeCommand,
  type ProviderResultTarget,
  type Take,
} from "../../production/contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { appendContinuityState, composeGenerationStates, resolvedStatesStamp, CONTINUITY_STATE_SECTION } from "../../production/state-composition";
import { ProofArtifactSchema, QuoteProofLinkSchema } from "../../production/provider-proof";
import { latestMatchingApproval } from "../../production/approval-policy";
import { computeTakeApprovalHash } from "../../production/approval";
import { computeAnchorApprovalHash, computeProductionInputsHash, productionSubmissionEligibilityFingerprint } from "../../jobs/production/queue";
import { shotsCompatibleWithStory } from "../../production/revisions";
import { withProductionStore, resolveProductionDataDir } from "../../production/runtime";
import { LocalMediaVault } from "../../media/production/vault";
import type { ProductionStore, ProductionWritePort, ProviderQuoteRequest, TakeSelection } from "../../repositories/production/ports";
import type { PreparedMediaQuoteDraft } from "./budget-composer";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";

const PrepareAnchorCommandSchema = CreateAnchorCommandSchema.omit({ quoteId: true, idempotencyKey: true });
const PrepareTakeCommandSchema = CreateTakeCommandSchema.omit({ quoteId: true, idempotencyKey: true });
export const MediaQuoteCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("anchor"), command: PrepareAnchorCommandSchema }),
  z.strictObject({ kind: z.literal("take"), command: PrepareTakeCommandSchema }),
]);

type PrepareAnchorCommand = z.infer<typeof PrepareAnchorCommandSchema>;
type PrepareTakeCommand = z.infer<typeof PrepareTakeCommandSchema>;
export type MediaPreparation =
  | { kind: "anchor"; command: PrepareAnchorCommand }
  | { kind: "take"; command: PrepareTakeCommand };
export type BillingModeIntent = "subscription" | "tokens";
export type TrustedBillingModeResolver = (input: Readonly<{ projectId: string; providerId: string; modelId: string; operation: "anchor" | "take" }>) => Promise<BillingModeIntent | null>;
export type ValidatedMediaRecipe = Readonly<{
  recipeVersion: 1;
  operation: "anchor" | "take";
  projectId: string;
  providerId: string;
  modelId: string;
  shotRevisionId: string;
  prompt: string;
  inputs: ProviderRequestSnapshot["inputs"];
  parameters: Record<string, JsonValue>;
  billingMode: BillingModeIntent;
  resultTarget: ProviderResultTarget;
  /** Continuity-state resolution stamp (M4); undefined when the shot has no state content. */
  resolvedStates?: ResolvedStatesStamp | undefined;
  canonRevisionIds: string[];
  selectionPins: {
    storyRevisionId: string; storyHash: string; storyApprovalIds: string[];
    shotPlanRevisionId: string; shotPlanHash: string;
    animaticRevisionId: string; animaticHash: string; animaticApprovalIds: string[];
  };
}>;
export type TakeServiceOptions = {
  resolveBillingMode?: TrustedBillingModeResolver;
  quoteRecipe?: (input: Readonly<{ recipe: ValidatedMediaRecipe; request: ProviderQuoteRequest }>) => Promise<PreparedMediaQuoteDraft>;
  commitPreparedQuote?: (tx: ProductionWritePort, draft: PreparedMediaQuoteDraft, context: Readonly<{ recipe: ValidatedMediaRecipe; request: ProviderQuoteRequest; at: number }>) => void;
  readAssetVerified: (asset: Asset) => Promise<void>;
  now?: () => number;
  idFactory?: () => string;
};

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }
function clockNow(clock: () => number): number { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_INPUT", "Clock must return a nonnegative safe integer timestamp."); return value; }
function validateId(value: string): string { if (!IdSchema.safeParse(value).success) fail("INVALID_INPUT", "The configured ID factory returned an invalid ID."); return value; }
function parsePreparation(value: MediaPreparation): MediaPreparation {
  const parsed = MediaQuoteCommandSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_INPUT", "Media preparation command is invalid.");
  return parsed.data as MediaPreparation;
}
type TakeSelectionCandidate = { take: Take; asset: Asset; fingerprint: string };
function validateSelectionShot(read: ProductionStore["read"], command: SelectTakeCommand, routeShotId?: string) {
  const project = read.getProject(command.projectId);
  if (!project) fail("UNKNOWN_REFERENCE", "Project not found.");
  const shot = read.getShotRevision(command.shotRevisionId);
  if (!shot) fail("UNKNOWN_REFERENCE", "Shot revision not found.");
  const origin = read.getStoryRevision(shot.storyRevisionId);
  if (!origin || origin.projectId !== project.id) fail("UNKNOWN_REFERENCE", "Shot revision does not belong to this project.");
  if (routeShotId && shot.shotId !== routeShotId) fail("INVALID_INPUT", "Route shot does not match the command shot revision.");
  return { project, shot };
}
function captureTakeSelectionCandidate(read: ProductionStore["read"], command: SelectTakeCommand, take: Take): TakeSelectionCandidate | null {
  try {
    const { project, shot } = validateSelectionShot(read, command);
    if (take.id !== command.takeId || take.shotRevisionId !== shot.id) return null;
    const asset = read.getAsset(take.assetId);
    const anchor = read.getAnchor(take.anchorId);
    const job = read.getJob(take.jobId);
    if (!asset || !asset.mime.startsWith("video/") || !Number.isSafeInteger(asset.frames) || asset.frames! <= 0 || take.actualFrames !== asset.frames ||
        !anchor || anchor.shotRevisionId !== shot.id || !job || job.projectId !== project.id || job.operation !== "take" || job.status !== "completed" ||
        job.resultId !== take.id || job.resultAssetIds.length !== 1 || job.resultAssetIds[0] !== asset.id || job.receiptId !== take.receiptId || !job.quoteId || !job.providerId || !job.modelId) return null;
    const quote = read.getQuote(job.quoteId);
    const receipt = read.getHonoredInputsReceipt(take.receiptId);
    const parsedSnapshot = ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot);
    if (!quote || quote.projectId !== project.id || quote.providerId !== job.providerId || quote.modelId !== job.modelId || quote.operation !== "take" ||
        !receipt || receipt.jobId !== job.id || !parsedSnapshot.success || job.requestHash !== hashCanonicalJson(parsedSnapshot.data)) return null;
    const snapshot = parsedSnapshot.data;
    const target = snapshot.resultTarget;
    if (snapshot.projectId !== project.id || snapshot.jobId !== job.id || snapshot.quoteId !== quote.id || target?.kind !== "take" ||
        target.shotRevisionId !== shot.id || target.anchorId !== anchor.id || target.anchorApprovalId !== take.approvalId || target.inputsHash !== take.inputsHash ||
        snapshot.parameters.providerAudioPolicy !== "muted") return null;
    if (receipt.inputs.length !== snapshot.inputs.length || !snapshot.inputs.every((input, index) => {
      const honored = receipt.inputs[index];
      return !!honored && honored.role === input.role && honored.assetId === input.assetId && honored.required === input.required &&
        (!input.required || honored.state === "mapped" || honored.state === "acknowledged");
    })) return null;
    const anchorApprovalHash = computeAnchorApprovalHash(read, anchor);
    const anchorApprovals = latestMatchingApproval(read.listApprovals("anchor", anchor.id), "anchor", anchor.id, anchorApprovalHash);
    if (!anchorApprovals?.some(approval => approval.id === take.approvalId)) return null;
    const takeApprovalHash = computeTakeApprovalHash(read, take);
    const takeApprovals = latestMatchingApproval(read.listApprovals("take", take.id), "take", take.id, takeApprovalHash);
    if (!takeApprovals?.length) return null;
    const eligibility = productionSubmissionEligibilityFingerprint(read, job, quote, snapshot);
    if (!eligibility) return null;
    return {
      take,
      asset,
      fingerprint: hashCanonicalJson({
        eligibility,
        takeApprovalHash,
        takeApprovalIds: takeApprovals.map(approval => approval.id).sort(),
        take,
        job,
        snapshot,
        quote,
        receipt,
        anchor,
        asset,
      }),
    };
  } catch {
    return null;
  }
}
function promptForAnchor(shot: NonNullable<ReturnType<ProductionStore["read"]["getShotRevision"]>>, canon: (id: string) => NonNullable<ReturnType<ProductionStore["read"]["getCanonRevision"]>>): string {
  const body = {
    visualIntent: shot.visualIntent,
    framing: shot.framing,
    cast: shot.castBindings.map(binding => ({ characterId: binding.characterId, wardrobe: binding.wardrobe, description: canon(binding.canonRevisionId).description, attributes: canon(binding.canonRevisionId).attributes })),
    location: { description: canon(shot.locationRevisionId).description, attributes: canon(shot.locationRevisionId).attributes },
    props: shot.propRevisionIds.map(id => ({ description: canon(id).description, attributes: canon(id).attributes })),
    style: { description: canon(shot.styleRevisionId).description, attributes: canon(shot.styleRevisionId).attributes },
  };
  const prompt = `Production anchor recipe v1\n${canonicalJson(body)}`;
  if (prompt.length > 100_000) fail("INVALID_INPUT", "The derived anchor prompt exceeds the supported length; shorten the pinned shot or canon descriptions.");
  return prompt;
}
function getSelection(read: ProductionStore["read"], projectId: string, shotRevisionId: string) {
  const project = read.getProject(projectId);
  if (!project) fail("UNKNOWN_REFERENCE", "Project not found.");
  const shot = read.getShotRevision(shotRevisionId);
  if (!shot) fail("UNKNOWN_REFERENCE", "Shot revision not found.");
  const origin = read.getStoryRevision(shot.storyRevisionId);
  if (!origin || origin.projectId !== project.id) fail("UNKNOWN_REFERENCE", "Shot revision does not belong to this project.");
  const story = project.activeStoryRevisionId ? read.getStoryRevision(project.activeStoryRevisionId) : null;
  const plan = project.activeShotPlanRevisionId ? read.getShotPlanRevision(project.activeShotPlanRevisionId) : null;
  const animatic = project.activeAnimaticRevisionId ? read.getAnimaticRevision(project.activeAnimaticRevisionId) : null;
  if (!story || !plan || !animatic || story.projectId !== project.id || plan.projectId !== project.id || animatic.projectId !== project.id || plan.storyRevisionId !== story.id || animatic.shotPlanRevisionId !== plan.id || !plan.orderedShotRevisionIds.includes(shot.id) || !animatic.slots.some(slot => slot.shotRevisionId === shot.id)) fail("APPROVAL_REQUIRED", "The shot is not part of the current approved story, plan, and animatic selection.");
  const storyApprovals = latestMatchingApproval(read.listApprovals("story", story.id), "story", story.id, story.contentHash);
  const animaticApprovals = latestMatchingApproval(read.listApprovals("animatic", animatic.id), "animatic", animatic.id, animatic.contentHash);
  if (!storyApprovals || !animaticApprovals) fail("APPROVAL_REQUIRED", "Current human story and animatic approvals are required.");
  if (shot.storyRevisionId !== story.id) {
    const lineage = []; let cursor: typeof story | null = story;
    while (cursor && lineage.length <= 10_000) { lineage.push(cursor); cursor = cursor.parentRevisionId ? read.getStoryRevision(cursor.parentRevisionId) : null; }
    const selectedCanon = project.activeCanonRevisionIds.map(id => read.getCanonRevision(id)).filter((x): x is NonNullable<typeof x> => !!x);
    const { id: _id, contentHash: _hash, createdAt: _created, ...candidate } = shot;
    if (!shotsCompatibleWithStory(shot, origin, story, { projectId: project.id, storyLineage: lineage, selectedCanonRevisions: selectedCanon, candidate: { ...candidate, storyRevisionId: story.id }, continuationIsValid: !shot.continuation || plan.orderedShotRevisionIds[plan.orderedShotRevisionIds.indexOf(shot.id) - 1] === shot.continuation.previousShotRevisionId })) fail("APPROVAL_REQUIRED", "The originating shot is not compatible with the currently approved story.");
  }
  return { project, shot, story, plan, animatic, storyApprovals, animaticApprovals };
}
function validatePreparationOrigin(read: ProductionStore["read"], prep: MediaPreparation) {
  const project = read.getProject(prep.command.projectId);
  if (!project) fail("UNKNOWN_REFERENCE", "Project not found.");
  const shot = read.getShotRevision(prep.command.shotRevisionId);
  if (!shot) fail("UNKNOWN_REFERENCE", "Shot revision not found.");
  const origin = read.getStoryRevision(shot.storyRevisionId);
  if (!origin || origin.projectId !== project.id) fail("UNKNOWN_REFERENCE", "Shot revision does not belong to this project.");
}

type MediaContext = Readonly<{ recipe: ValidatedMediaRecipe; eligibilityFingerprint: string }>;
function buildMediaContext(read: ProductionStore["read"], prep: MediaPreparation, mode: BillingModeIntent, ephemeral: { jobId: string; key: string; quoteId: string }): MediaContext {
  const command = prep.command;
  const anchorCommand = prep.kind === "anchor" ? prep.command : undefined;
  const takeCommand = prep.kind === "take" ? prep.command : undefined;
  const shotRevisionId = command.shotRevisionId;
  const selected = getSelection(read, command.projectId, shotRevisionId);
  const { project, shot, story, plan, animatic, storyApprovals, animaticApprovals } = selected;
  const canonIds = [...new Set([...shot.castBindings.map(binding => binding.canonRevisionId), shot.locationRevisionId, ...shot.propRevisionIds, shot.styleRevisionId])];
  const canonById = new Map<string, NonNullable<ReturnType<typeof read.getCanonRevision>>>();
  for (const id of canonIds) {
    const revision = read.getCanonRevision(id);
    if (!revision || !project.activeCanonRevisionIds.includes(id) || !story.canonRevisionIds.includes(id)) fail("STALE_REVISION", "A pinned canon revision is no longer selected by the current story.");
    canonById.set(id, revision);
  }
  const inputs: ProviderRequestSnapshot["inputs"] = [];
  if (prep.kind === "anchor") {
    const anchor = anchorCommand!;
    const seenContextAssets = new Set<string>();
    for (const id of canonIds) for (const assetId of canonById.get(id)!.referenceAssetIds) if (!seenContextAssets.has(assetId)) { seenContextAssets.add(assetId); inputs.push({ assetId, role: "context_image", required: true }); }
    if (shot.continuation) inputs.push({ assetId: shot.continuation.endFrameAssetId, role: "end_frame", required: true });
    const expectedRefs = [...inputs.filter(input => input.role === "context_image").map(input => input.assetId), ...(shot.continuation ? [shot.continuation.endFrameAssetId] : [])];
    if (JSON.stringify(anchor.renderSettings.referenceAssetIds) !== JSON.stringify(expectedRefs)) fail("INVALID_INPUT", "Anchor references must exactly match the ordered canonical references and explicit continuation frame.");
  } else {
    const take = takeCommand!;
    if (take.motionSettings.targetFrames !== shot.targetFrames) fail("STALE_REVISION", "Take frame count must match the selected shot duration.");
    if (take.motionSettings.aspect !== project.profile.format) fail("INVALID_INPUT", "Take aspect must match the project format.");
    const anchor = read.getAnchor(take.anchorId);
    if (!anchor || anchor.shotRevisionId !== shot.id) fail("UNKNOWN_REFERENCE", "The selected anchor does not belong to this shot.");
    const anchorAsset = read.getAsset(anchor.assetId);
    if (!anchorAsset) fail("MEDIA_UNAVAILABLE", "The selected anchor media is missing.");
    const anchorHash = computeAnchorApprovalHash(read, anchor);
    const approvals = latestMatchingApproval(read.listApprovals("anchor", anchor.id), "anchor", anchor.id, anchorHash);
    if (!approvals?.some(approval => approval.id === take.approvalId)) fail("APPROVAL_REQUIRED", "The exact current human anchor approval is required.");
    inputs.push({ assetId: anchor.assetId, role: "start_frame", required: true });
    if (shot.continuation) inputs.push({ assetId: shot.continuation.endFrameAssetId, role: "end_frame", required: true });
  }
  const operation = prep.kind;
  const providerId = anchorCommand ? anchorCommand.renderSettings.providerId : takeCommand!.motionSettings.providerId;
  const modelId = anchorCommand ? anchorCommand.renderSettings.modelId : takeCommand!.motionSettings.modelId;
  const seed = anchorCommand ? anchorCommand.renderSettings.seed : takeCommand!.motionSettings.seed;
  const concreteSeed = seed ?? 0;
  const prompt = anchorCommand ? promptForAnchor(shot, id => {
    const value = canonById.get(id); if (!value) fail("UNKNOWN_REFERENCE", "A pinned canon revision is missing."); return value;
  }) : takeCommand!.motionSettings.prompt;
  // M4 state propagation: resolve the shot's scene states and compose them into the prompt as a
  // stable trailing section plus a structured snapshot stamp. Shots without a scene (the planner
  // does not set sceneId yet) or with contentless states keep today's prompt byte-for-byte.
  const scene = shot.sceneId ? read.getScene(shot.sceneId) : null;
  if (shot.sceneId && !scene) fail("UNKNOWN_REFERENCE", `The shot references a missing scene: ${shot.sceneId}.`);
  const composedStates = composeGenerationStates({
    characters: (scene?.characterStates ?? []).map(state => [{ at: "scene" as const, state }]),
    environment: scene?.environmentState ? [{ at: "scene" as const, state: scene.environmentState }] : null,
  });
  const fullPrompt = appendContinuityState(prompt, composedStates.promptBlock);
  if (fullPrompt.length > 100_000) fail("INVALID_INPUT", "The composed generation prompt exceeds the supported length; shorten the pinned shot, canon, or scene state text.");
  const resolvedStates = resolvedStatesStamp(composedStates, scene?.id ?? null) ?? undefined;
  const parameters: Record<string, JsonValue> = anchorCommand
    ? { aspect: anchorCommand.renderSettings.aspect, resolution: anchorCommand.renderSettings.resolution, seed: concreteSeed, recipeVersion: 1 }
    : { frameCount: takeCommand!.motionSettings.targetFrames, aspect: takeCommand!.motionSettings.aspect, seed: concreteSeed, providerAudioPolicy: "muted", recipeVersion: 1 };
  const resultTarget: ProviderResultTarget = anchorCommand
    ? { kind: "anchor", shotRevisionId: shot.id, inputsHash: "0".repeat(64) }
    : { kind: "take", shotRevisionId: shot.id, anchorId: takeCommand!.anchorId, anchorApprovalId: takeCommand!.approvalId, inputsHash: "0".repeat(64) };
  let snapshot = ProviderRequestSnapshotSchema.parse({ projectId: project.id, jobId: ephemeral.jobId, idempotencyKey: ephemeral.key, quoteId: ephemeral.quoteId, providerId, modelId, prompt: fullPrompt, inputs, parameters, resultTarget, billingMode: mode, ...(resolvedStates ? { resolvedStates } : {}) });
  const semanticHash = computeProductionInputsHash(read, operation, snapshot);
  snapshot = ProviderRequestSnapshotSchema.parse({ ...snapshot, resultTarget: { ...resultTarget, inputsHash: semanticHash } });
  const job = { version: 1, id: ephemeral.jobId, projectId: project.id, operation, status: "queued", idempotencyKey: ephemeral.key, requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId, modelId, providerRef: null, quoteId: ephemeral.quoteId, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 0, updatedAt: 0 } as ProductionJob;
  const eligibilityFingerprint = productionSubmissionEligibilityFingerprint(read, job, { entitlement: mode === "subscription" ? "subscription" : "spark" }, snapshot);
  if (!eligibilityFingerprint) fail("APPROVAL_REQUIRED", "Current approved selection or required human approval is unavailable.");
  const recipe = Object.freeze({ recipeVersion: 1 as const, operation, projectId: project.id, providerId, modelId, shotRevisionId: shot.id, prompt: fullPrompt, inputs: snapshot.inputs, parameters, billingMode: mode, resultTarget: snapshot.resultTarget!, ...(resolvedStates ? { resolvedStates } : {}), canonRevisionIds: canonIds, selectionPins: { storyRevisionId: story.id, storyHash: story.contentHash, storyApprovalIds: storyApprovals.map(a => a.id).sort(), shotPlanRevisionId: plan.id, shotPlanHash: plan.contentHash, animaticRevisionId: animatic.id, animaticHash: animatic.contentHash, animaticApprovalIds: animaticApprovals.map(a => a.id).sort() } });
  return Object.freeze({ recipe, eligibilityFingerprint });
}

export function buildValidatedMediaRecipe(read: ProductionStore["read"], command: MediaPreparation, billingMode: BillingModeIntent): ValidatedMediaRecipe {
  assertTrustedMode(billingMode);
  const prep = parsePreparation(command);
  const ephemeral = { jobId: validateId(`recipe:${randomUUID()}`), key: validateId(`recipe:${randomUUID()}`), quoteId: validateId(`quote:${randomUUID()}`) };
  return buildMediaContext(read, prep, billingMode, ephemeral).recipe;
}

export function toMediaQuoteRequest(recipe: ValidatedMediaRecipe): ProviderQuoteRequest {
  const revisionIds = [...new Set([recipe.shotRevisionId, ...recipe.canonRevisionIds, recipe.selectionPins.storyRevisionId, recipe.selectionPins.shotPlanRevisionId, recipe.selectionPins.animaticRevisionId])];
  return { projectId: recipe.projectId, providerId: recipe.providerId, modelId: recipe.modelId, operation: recipe.operation, inputSnapshot: { revisionIds, assetIds: recipe.inputs.map(input => input.assetId), parameters: { ...recipe.parameters, mediaRecipe: recipe as unknown as JsonValue } } };
}
/** Strip prototypes and preserve only the exact schema-valid transport snapshot. */
export function snapshotJSON(snapshot: ProviderRequestSnapshot): ProviderRequestSnapshot {
  return ProviderRequestSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)) as unknown);
}
/** One quote hash projection for both preparation and enqueue validation. */
export function quoteProjection(recipe: ValidatedMediaRecipe): ProviderQuoteRequest["inputSnapshot"] {
  return toMediaQuoteRequest(recipe).inputSnapshot;
}
export function materializeMediaSnapshot(recipe: ValidatedMediaRecipe, transport: { jobId: string; idempotencyKey: string; quoteId: string }): ProviderRequestSnapshot {
  return snapshotJSON(ProviderRequestSnapshotSchema.parse({ projectId: recipe.projectId, jobId: transport.jobId, idempotencyKey: transport.idempotencyKey, quoteId: transport.quoteId, providerId: recipe.providerId, modelId: recipe.modelId, prompt: recipe.prompt, inputs: recipe.inputs, parameters: recipe.parameters, billingMode: recipe.billingMode, resultTarget: recipe.resultTarget, ...(recipe.resolvedStates ? { resolvedStates: recipe.resolvedStates } : {}) }));
}

function assertTrustedMode(mode: BillingModeIntent | null | undefined): asserts mode is BillingModeIntent { if (mode !== "subscription" && mode !== "tokens") fail("BUDGET_BLOCKED", "A trusted server billing mode is required before preparing media."); }
function entitlementMatches(quote: ProductionQuote, mode: BillingModeIntent) { return quote.entitlement === "unknown" || (mode === "subscription" ? quote.entitlement === "subscription" : quote.entitlement === "spark"); }
function makeUnknownQuote(request: ProviderQuoteRequest, now: number, idFactory: () => string): ProductionQuote {
  return QuoteSchema.parse({ version: 1, id: validateId(`quote:${idFactory()}`), projectId: request.projectId, providerId: request.providerId, modelId: request.modelId, operation: request.operation, inputHash: hashCanonicalJson(request.inputSnapshot), entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: now + 30_000, withinAuthorizedCap: "unknown", createdAt: now });
}
async function quoteFor(recipe: ValidatedMediaRecipe, request: ProviderQuoteRequest, options: TakeServiceOptions, now: () => number, idFactory: () => string): Promise<PreparedMediaQuoteDraft> {
  const draft: PreparedMediaQuoteDraft = options.quoteRecipe ? await options.quoteRecipe({ recipe, request }) : { kind: "unknown", mediaQuote: makeUnknownQuote(request, clockNow(now), idFactory) };
  const validationNow = clockNow(now);
  const parsed = QuoteSchema.safeParse(draft.mediaQuote);
  if (!parsed.success || parsed.data.projectId !== recipe.projectId || parsed.data.providerId !== recipe.providerId || parsed.data.modelId !== recipe.modelId || parsed.data.operation !== recipe.operation || parsed.data.inputHash !== hashCanonicalJson(quoteProjection(recipe)) || parsed.data.createdAt > validationNow || parsed.data.expiresAt <= validationNow || parsed.data.expiresAt <= parsed.data.createdAt || !entitlementMatches(parsed.data, recipe.billingMode)) fail("STALE_REVISION", "Quote does not match the complete media recipe or trusted billing intent.");
  if (draft.kind === "unknown") return { kind: "unknown", mediaQuote: parsed.data };
  const companions = z.strictObject({ budgetQuote: BudgetQuoteSchema, binding: QuoteAccountBindingSchema, accountEvidence: AccountEvidenceSchema, accountArtifact: ProofArtifactSchema, policyArtifact: ProofArtifactSchema, quoteArtifact: ProofArtifactSchema, quoteProof: QuoteProofLinkSchema }).safeParse({ budgetQuote: draft.budgetQuote, binding: draft.binding, accountEvidence: draft.accountEvidence, accountArtifact: draft.accountArtifact, policyArtifact: draft.policyArtifact, quoteArtifact: draft.quoteArtifact, quoteProof: draft.quoteProof });
  if (!companions.success) fail("BUDGET_BLOCKED", "Bound media quote companions are invalid.");
  return { kind: "bound", mediaQuote: parsed.data, ...companions.data, expectedGeneration: draft.expectedGeneration, capability: draft.capability };
}

function prepFromEnqueue(command: CreateAnchorCommand | CreateTakeCommand): MediaPreparation {
  return "renderSettings" in command ? { kind: "anchor", command: { projectId: command.projectId, shotRevisionId: command.shotRevisionId, renderSettings: command.renderSettings } } : { kind: "take", command: { projectId: command.projectId, shotRevisionId: command.shotRevisionId, anchorId: command.anchorId, approvalId: command.approvalId, motionSettings: command.motionSettings } };
}
function sameCreatorIntent(job: ProductionJob, command: CreateAnchorCommand | CreateTakeCommand): boolean {
  if (job.operation !== ("renderSettings" in command ? "anchor" : "take") || job.projectId !== command.projectId || job.idempotencyKey !== command.idempotencyKey || job.quoteId !== command.quoteId) return false;
  const snapshot = ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot); if (!snapshot.success) return false;
  const value = snapshot.data; const target = value.resultTarget;
  if (job.providerId !== value.providerId || job.modelId !== value.modelId || value.quoteId !== command.quoteId || job.requestHash !== hashCanonicalJson(value)) return false;
  if (!target || target.shotRevisionId !== command.shotRevisionId) return false;
  if ("renderSettings" in command) {
    const settings = command.renderSettings;
    const refs = value.inputs.filter(input => input.role === "context_image").map(input => input.assetId);
    const endFrames = value.inputs.filter(input => input.role === "end_frame");
    const requested = settings.referenceAssetIds;
    const expected = [...refs, ...endFrames.map(input => input.assetId)];
    const orderedRoles = [...refs.map(assetId => ({ assetId, role: "context_image" })), ...endFrames.map(input => ({ assetId: input.assetId, role: "end_frame" }))];
    return target.kind === "anchor" && value.providerId === settings.providerId && value.modelId === settings.modelId && value.parameters.aspect === settings.aspect && value.parameters.resolution === settings.resolution && value.parameters.seed === (settings.seed ?? 0) && JSON.stringify(expected) === JSON.stringify(requested) && endFrames.length <= 1 && value.inputs.length === orderedRoles.length && value.inputs.every((input, index) => input.required && input.assetId === orderedRoles[index]?.assetId && input.role === orderedRoles[index]?.role);
  }
  const settings = command.motionSettings;
  const startFrames = value.inputs.filter(input => input.role === "start_frame");
  const endFrames = value.inputs.filter(input => input.role === "end_frame");
  const expectedRoles = [{ role: "start_frame" }, ...(endFrames.length ? [{ role: "end_frame" }] : [])];
  return target.kind === "take" && target.anchorId === command.anchorId && target.anchorApprovalId === command.approvalId && value.providerId === settings.providerId && value.modelId === settings.modelId && promptMatchesCreatorIntent(value.prompt, settings.prompt) && value.parameters.frameCount === settings.targetFrames && value.parameters.aspect === settings.aspect && value.parameters.seed === (settings.seed ?? 0) && value.parameters.providerAudioPolicy === "muted" && startFrames.length === 1 && endFrames.length <= 1 && value.inputs.length === expectedRoles.length && value.inputs.every((input, index) => input.required && input.role === expectedRoles[index]?.role);
}

/** The continuity-state section is server-derived from the scene; a stored take prompt matches creator intent when it is the creator prompt verbatim or with that section appended. */
function promptMatchesCreatorIntent(stored: string, creator: string): boolean {
  return stored === creator || stored.startsWith(`${creator}\n\n${CONTINUITY_STATE_SECTION}`);
}

function createJob(tx: ProductionWritePort, quote: ProductionQuote, recipe: ValidatedMediaRecipe, command: CreateAnchorCommand | CreateTakeCommand, now: number, idFactory: () => string) {
  const id = validateId(idFactory());
  const snapshot = materializeMediaSnapshot(recipe, { jobId: id, idempotencyKey: command.idempotencyKey, quoteId: quote.id });
  const job = JobSchema.parse({ version: 1, id, projectId: command.projectId, operation: recipe.operation, status: "queued", retryOf: "retryOf" in command ? command.retryOf ?? null : null, idempotencyKey: command.idempotencyKey, requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: recipe.providerId, modelId: recipe.modelId, providerRef: null, quoteId: quote.id, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now });
  tx.insertJob(job, { id: validateId(idFactory()), jobId: job.id, createdAt: now, claimedAt: null, claimToken: null });
  return { job, created: true as const };
}

export function createProductionTakeService(options: TakeServiceOptions & { store: ProductionStore }) {
  const now = options.now ?? Date.now; const idFactory = options.idFactory ?? randomUUID;
  const resolveMode = async (prep: MediaPreparation) => {
    if (!options.resolveBillingMode) fail("BUDGET_BLOCKED", "Trusted billing-mode resolution is not configured.");
    const mode = await options.resolveBillingMode({ projectId: prep.command.projectId, providerId: prep.kind === "anchor" ? prep.command.renderSettings.providerId : prep.command.motionSettings.providerId, modelId: prep.kind === "anchor" ? prep.command.renderSettings.modelId : prep.command.motionSettings.modelId, operation: prep.kind });
    assertTrustedMode(mode); return mode;
  };
  const verifyAssets = async (recipe: ValidatedMediaRecipe, read = options.store.read) => {
    const assets = recipe.inputs.map(input => read.getAsset(input.assetId));
    if (assets.some(asset => !asset)) fail("MEDIA_UNAVAILABLE", "A required recipe asset is missing.");
    for (const asset of assets as Asset[]) {
      if (!asset.mime.startsWith("image/")) fail("MEDIA_UNAVAILABLE", "A required conditioning asset is not an image.");
      await options.readAssetVerified(asset);
    }
  };
  const prepare = async (raw: MediaPreparation) => {
    const prep = parsePreparation(raw); validatePreparationOrigin(options.store.read, prep); const mode = await resolveMode(prep);
    const ephemeral = { jobId: validateId(`recipe:${idFactory()}`), key: validateId(`recipe:${idFactory()}`), quoteId: validateId(`quote:${idFactory()}`) };
    const context = buildMediaContext(options.store.read, prep, mode, ephemeral); await verifyAssets(context.recipe); return context.recipe;
  };
  const quote = async (raw: MediaPreparation) => {
    const prep = parsePreparation(raw); validatePreparationOrigin(options.store.read, prep); const mode = await resolveMode(prep);
    const ephemeral = { jobId: validateId(`recipe:${idFactory()}`), key: validateId(`recipe:${idFactory()}`), quoteId: validateId(`quote:${idFactory()}`) };
    const initialContext = buildMediaContext(options.store.read, prep, mode, ephemeral); const initial = initialContext.recipe; await verifyAssets(initial);
    const request = toMediaQuoteRequest(initial); const produced = await quoteFor(initial, request, options, now, idFactory);
    return options.store.transaction(tx => {
      const currentContext = buildMediaContext(tx, prep, mode, ephemeral); const current = currentContext.recipe; const currentRequest = toMediaQuoteRequest(current);
      if (currentContext.eligibilityFingerprint !== initialContext.eligibilityFingerprint || hashCanonicalJson(current) !== hashCanonicalJson(initial) || hashCanonicalJson(currentRequest) !== hashCanonicalJson(request)) fail("STALE_REVISION", "Selected recipe changed while the quote was being prepared.");
      const at = clockNow(now); if (produced.mediaQuote.expiresAt <= at) fail("STALE_REVISION", "Quote expired before it could be saved.");
      if (produced.kind === "bound" && !options.commitPreparedQuote) fail("BUDGET_BLOCKED", "A bound media quote requires a configured proof commit hook.");
      tx.insertQuote(produced.mediaQuote);
      if (produced.kind === "bound") options.commitPreparedQuote!(tx, produced, { recipe: initial, request, at });
      return produced.mediaQuote;
    });
  };
  const enqueue = async (raw: CreateAnchorCommand | CreateTakeCommand, routeShotId?: string) => {
    const parsed = "renderSettings" in raw ? CreateAnchorCommandSchema.safeParse(raw) : CreateTakeCommandSchema.safeParse(raw);
    if (!parsed.success) fail("INVALID_INPUT", "Enqueue command is invalid.");
    const command = parsed.data as CreateAnchorCommand | CreateTakeCommand;
    if (routeShotId) { const routeShot = options.store.read.getShotRevision(command.shotRevisionId); if (!routeShot || routeShot.shotId !== routeShotId) fail("INVALID_INPUT", "Route shot does not match the command shot revision."); }
    const existing = options.store.read.getJobByIdempotencyKey(command.projectId, command.idempotencyKey);
    if (existing) {
      if (!sameCreatorIntent(existing, command)) fail("STALE_REVISION", "Idempotency key was already used for a different media request.");
      return { job: existing, created: false };
    }
    const prep = prepFromEnqueue(command); validatePreparationOrigin(options.store.read, prep); const mode = await resolveMode(prep);
    const ephemeral = { jobId: validateId(`recipe:${idFactory()}`), key: command.idempotencyKey, quoteId: command.quoteId };
    const initialContext = buildMediaContext(options.store.read, prep, mode, ephemeral); const initial = initialContext.recipe; await verifyAssets(initial);
    const quoteRecord = options.store.read.getQuote(command.quoteId);
    if (!quoteRecord) fail("UNKNOWN_REFERENCE", "Media quote not found.");
    const initialRequest = toMediaQuoteRequest(initial);
    const quoteCheckedAt = clockNow(now);
    if (quoteRecord.inputHash !== hashCanonicalJson(initialRequest.inputSnapshot) || quoteRecord.projectId !== command.projectId || quoteRecord.providerId !== initial.providerId || quoteRecord.modelId !== initial.modelId || quoteRecord.operation !== initial.operation || quoteRecord.createdAt > quoteCheckedAt || quoteRecord.expiresAt <= quoteCheckedAt || quoteRecord.expiresAt <= quoteRecord.createdAt || !entitlementMatches(quoteRecord, mode)) fail("STALE_REVISION", "Quote does not match the current complete media recipe or is expired.");
    const result = options.store.transaction(tx => {
      const replay = tx.getJobByIdempotencyKey(command.projectId, command.idempotencyKey);
      if (replay) { if (!sameCreatorIntent(replay, command)) fail("STALE_REVISION", "Idempotency key conflicts with a different media request."); return { job: replay, created: false }; }
      const quoteCurrent = tx.getQuote(command.quoteId);
      const currentContext = buildMediaContext(tx, prep, mode, ephemeral); const current = currentContext.recipe;
      const currentRequest = toMediaQuoteRequest(current);
      const at = clockNow(now);
      if (!quoteCurrent || currentContext.eligibilityFingerprint !== initialContext.eligibilityFingerprint || quoteCurrent.inputHash !== hashCanonicalJson(currentRequest.inputSnapshot) || hashCanonicalJson(current) !== hashCanonicalJson(initial) || quoteCurrent.createdAt > at || quoteCurrent.expiresAt <= at || quoteCurrent.expiresAt <= quoteCurrent.createdAt || !entitlementMatches(quoteCurrent, mode)) fail("STALE_REVISION", "Quote, selection, approval, or media recipe changed before enqueue.");
      return createJob(tx, quoteCurrent, current, command, at, idFactory);
    });
    return result;
  };
  const selectTake = async (raw: SelectTakeCommand, routeShotId?: string): Promise<{ selection: TakeSelection; changed: boolean }> => {
    const parsed = SelectTakeCommandSchema.safeParse(raw);
    if (!parsed.success) fail("INVALID_INPUT", "Take selection command is invalid.");
    const command = parsed.data;
    const { project, shot } = validateSelectionShot(options.store.read, command, routeShotId);
    const initialSelection = options.store.read.getTakeSelection(project.id, shot.shotId);
    if (initialSelection.version !== command.expectedSelectionVersion) fail("STALE_REVISION", "Take selection version is stale.");
    if (command.takeId === null) {
      return options.store.transaction(tx => {
        validateSelectionShot(tx, command, routeShotId);
        const current = tx.getTakeSelection(project.id, shot.shotId);
        if (current.version !== command.expectedSelectionVersion) fail("STALE_REVISION", "Take selection version is stale.");
        if (current.takeId === null) return { selection: current, changed: false };
        if (!tx.compareAndSetSelectedTake(project.id, shot.shotId, null, command.expectedSelectionVersion)) fail("STALE_REVISION", "Take selection changed before it could be cleared.");
        return { selection: tx.getTakeSelection(project.id, shot.shotId), changed: true };
      });
    }
    const requested = options.store.read.getTake(command.takeId);
    if (!requested) fail("UNKNOWN_REFERENCE", "Take not found.");
    const initialCandidate = captureTakeSelectionCandidate(options.store.read, command, requested);
    if (!initialCandidate) fail("APPROVAL_REQUIRED", "Take must have a current human approval and an eligible completed result.");
    try { await options.readAssetVerified(initialCandidate.asset); }
    catch { fail("MEDIA_UNAVAILABLE", "Take media could not be verified in the local vault."); }
    return options.store.transaction(tx => {
      validateSelectionShot(tx, command, routeShotId);
      const current = tx.getTakeSelection(project.id, shot.shotId);
      if (current.version !== command.expectedSelectionVersion) fail("STALE_REVISION", "Take selection version is stale.");
      const takeNow = tx.getTake(command.takeId!);
      const candidateNow = takeNow && captureTakeSelectionCandidate(tx, command, takeNow);
      if (!candidateNow || candidateNow.fingerprint !== initialCandidate.fingerprint) fail("STALE_REVISION", "Take approval, media, or current story eligibility changed during verification.");
      if (current.takeId === command.takeId) return { selection: current, changed: false };
      if (!tx.compareAndSetSelectedTake(project.id, shot.shotId, command.takeId, command.expectedSelectionVersion)) fail("STALE_REVISION", "Take selection changed before it could be saved.");
      return { selection: tx.getTakeSelection(project.id, shot.shotId), changed: true };
    });
  };
  return { prepare, quote, selectTake, enqueueAnchor: (command: CreateAnchorCommand, shotId?: string) => enqueue(command, shotId), enqueueTake: (command: CreateTakeCommand, shotId?: string) => enqueue(command, shotId) };
}

export function createMediaRouteHandlers(options: { withStore?: typeof withProductionStore; serviceOptions?: Omit<TakeServiceOptions, "readAssetVerified"> & { readAssetVerified?: (asset: Asset) => Promise<void> } } = {}) {
  const withStore = options.withStore ?? withProductionStore;
  const serviceOptions = options.serviceOptions ?? {};
  const makeService = (store: ProductionStore) => createProductionTakeService({ store, ...serviceOptions, readAssetVerified: serviceOptions.readAssetVerified ?? (async asset => {
    try { await new LocalMediaVault({ root: join(resolveProductionDataDir(), "media") }).readVerified(asset.vaultRef, asset.sha256); }
    catch { fail("MEDIA_UNAVAILABLE", "A required media asset could not be verified in the local vault."); }
  }) });
  const within = <T>(operation: (service: ReturnType<typeof makeService>) => Promise<T>) => withStore(store => operation(makeService(store)));
  const quotePost = async (request: Request) => {
    try { assertSameOriginMutation(request); const body = await readProductionJson(request, MediaQuoteCommandSchema, { maxBytes: 512 * 1024 }); return Response.json(await within(service => service.quote(body as MediaPreparation)), { headers: { "cache-control": "no-store" } }); }
    catch (error) { return productionErrorResponse(error, getRequestId(request)); }
  };
  const anchorPost = async (request: Request, context?: { params: Promise<{ shotId: string }> | { shotId: string } }) => {
    try { assertSameOriginMutation(request); const [command, params] = await Promise.all([readProductionJson(request, CreateAnchorCommandSchema, { maxBytes: 64 * 1024 }), context?.params ?? Promise.resolve({ shotId: "" })]); const result = await within(service => service.enqueueAnchor(command, params.shotId)); return Response.json(result, { headers: { "cache-control": "no-store" }, status: result.created ? 201 : 200 }); }
    catch (error) { return productionErrorResponse(error, getRequestId(request)); }
  };
  const takePost = async (request: Request, context?: { params: Promise<{ shotId: string }> | { shotId: string } }) => {
    try { assertSameOriginMutation(request); const [command, params] = await Promise.all([readProductionJson(request, CreateTakeCommandSchema, { maxBytes: 512 * 1024 }), context?.params ?? Promise.resolve({ shotId: "" })]); const result = await within(service => service.enqueueTake(command, params.shotId)); return Response.json(result, { headers: { "cache-control": "no-store" }, status: result.created ? 201 : 200 }); }
    catch (error) { return productionErrorResponse(error, getRequestId(request)); }
  };
  const selectionPost = async (request: Request, context?: { params: Promise<{ shotId: string }> | { shotId: string } }) => {
    try { assertSameOriginMutation(request); const [command, params] = await Promise.all([readProductionJson(request, SelectTakeCommandSchema, { maxBytes: 64 * 1024 }), context?.params ?? Promise.resolve({ shotId: "" })]); return Response.json(await within(service => service.selectTake(command, params.shotId)), { headers: { "cache-control": "no-store" } }); }
    catch (error) { return productionErrorResponse(error, getRequestId(request)); }
  };
  return { anchorPOST: anchorPost, takePOST: takePost, selectionPOST: selectionPost, quotePOST: quotePost };
}
