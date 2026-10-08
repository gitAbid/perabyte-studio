import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountEvidenceSchema,
  BudgetExecutionSchema,
  BudgetQuoteSchema,
  BudgetUtcMillisSchema,
  CapabilityReceiptSchema,
  IdSchema,
  JsonValueSchema,
  ProviderRequestSnapshotSchema,
  ProviderResultTargetSchema,
  QuoteAccountBindingSchema,
  QuoteSchema,
  type QuoteAccountBinding,
  Sha256Schema,
  type AccountEvidence,
  type BudgetExecution,
  type BudgetQuote,
  type BudgetReservation,
  type CapabilityReceipt,
  type ProductionJob,
  type ProductionQuote,
  ResolvedStatesStampSchema,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { checkedAdd, foldReservation, summarizeBudget, utcBudgetDay } from "../../production/budget";
import { computeProductionInputsHash, type PreparedBudgetContext } from "../../jobs/production/queue";
import {
  ProofArtifactSchema,
  ProviderAccountSessionPayloadSchema,
  ProviderCredentialGenerationSchema,
  ProviderExecutionSessionPayloadSchema,
  ProviderMediaQuotePayloadSchema,
  ProviderReviewedPolicyPayloadSchema,
  QuoteProofLinkSchema,
  proofPayload,
  type ProofArtifact,
  type ProviderCredentialGeneration,
  type QuoteProofLink,
} from "../../production/provider-proof";
import { canSatisfy } from "../../providers/production/capabilities";
import type { AuthenticatedProviderSession, ProductionProofProvider, ProviderAccountObservation, SubmissionProofResolver } from "../../providers/production/proof-port";
import { readInstalledSogniProofMetadata } from "../../providers/production/sogni-provider";
import { ReviewedPolicyInputSchema, ReviewedQuotePolicyConfigSchema, type ReviewedPolicyInput, type ReviewedQuotePolicyConfig } from "../../production/proof-policy";
import { quoteProjection, type BillingModeIntent, type TrustedBillingModeResolver, type ValidatedMediaRecipe } from "./takes";
import { createProductionBudgetService, type TrustedAccountIdentity, type TrustedPreparedExecutionEvidence } from "./budget";
import type { ProductionStore, ProductionWritePort, ProviderQuoteRequest } from "../../repositories/production/ports";

export type PreparedMediaQuoteDraft =
  | Readonly<{ kind: "unknown"; mediaQuote: ProductionQuote }>
  | Readonly<{ kind: "bound"; mediaQuote: ProductionQuote; budgetQuote: BudgetQuote; binding: QuoteAccountBinding; accountEvidence: AccountEvidence; accountArtifact: ProofArtifact; policyArtifact: ProofArtifact; quoteArtifact: ProofArtifact; quoteProof: QuoteProofLink; expectedGeneration: ProviderCredentialGeneration; capability: CapabilityReceipt }>;

export type PreparedSubmissionContext = PreparedBudgetContext & Readonly<{ providerProofDraft: Readonly<{ workerArtifact: ProofArtifact; generation: ProviderCredentialGeneration; observedAt: number; capability: CapabilityReceipt }> }>;

export type ComposerOptions = {
  store: ProductionStore;
  provider: ProductionProofProvider;
  reviewedPolicy: ReviewedPolicyInput | null;
  now?: () => number;
  idFactory?: () => string;
  producer?: Readonly<{ producerId: string; producerVersion: string; sourceHash: string }>;
};

const RecipeInputSchema = z.strictObject({
  recipeVersion: z.literal(1),
  operation: z.enum(["anchor", "take"]),
  projectId: IdSchema, providerId: IdSchema, modelId: IdSchema, shotRevisionId: IdSchema,
  prompt: z.string().max(100_000),
  inputs: z.array(z.strictObject({ assetId: IdSchema, role: z.string().min(1).max(200), required: z.boolean() })).max(100),
  parameters: z.record(z.string(), JsonValueSchema),
  billingMode: z.enum(["subscription", "tokens"]),
  resultTarget: ProviderResultTargetSchema,
  /** Additive optional (C7, M4): continuity-state resolution stamp; absent for stateless shots. */
  resolvedStates: ResolvedStatesStampSchema.optional(),
  canonRevisionIds: z.array(IdSchema).max(500),
  selectionPins: z.strictObject({
    storyRevisionId: IdSchema, storyHash: Sha256Schema, storyApprovalIds: z.array(IdSchema).max(100),
    shotPlanRevisionId: IdSchema, shotPlanHash: Sha256Schema,
    animaticRevisionId: IdSchema, animaticHash: Sha256Schema, animaticApprovalIds: z.array(IdSchema).max(100),
  }),
});
const QuoteRequestInputSchema = z.strictObject({
  projectId: IdSchema, providerId: IdSchema, modelId: IdSchema,
  operation: z.enum(["anchor", "take", "speech", "music"]),
  inputSnapshot: z.strictObject({ revisionIds: z.array(IdSchema).max(100), assetIds: z.array(IdSchema).max(100), parameters: z.record(z.string(), JsonValueSchema) }),
});
const QuoteCompanionsSchema = z.strictObject({
  budgetQuote: BudgetQuoteSchema, binding: QuoteAccountBindingSchema, accountEvidence: AccountEvidenceSchema,
  accountArtifact: ProofArtifactSchema, policyArtifact: ProofArtifactSchema, quoteArtifact: ProofArtifactSchema, quoteProof: QuoteProofLinkSchema,
});
const PreparedSubmissionContextSchema = z.strictObject({
  accountEvidenceId: IdSchema, budgetQuoteId: IdSchema, policyId: IdSchema,
  expectedPolicyRevision: z.number().int().safe().positive(), expectedAuthorizationRevision: z.number().int().safe().positive(),
  expectedQuoteInputHash: Sha256Schema, executionSemanticHash: Sha256Schema, credentialBindingId: IdSchema,
  providerProofDraft: z.strictObject({ workerArtifact: ProofArtifactSchema, generation: ProviderCredentialGenerationSchema, observedAt: BudgetUtcMillisSchema, capability: CapabilityReceiptSchema }),
});

function blocked(message: string): never { throw new ProductionApplicationError("BUDGET_BLOCKED", message); }
function staleRevision(message: string): never { throw new ProductionApplicationError("STALE_REVISION", message); }
function proofPayloadOrNull(artifact: ProofArtifact): ReturnType<typeof proofPayload> | null {
  try { return proofPayload(artifact); } catch { return null; }
}

/**
 * Offline proof composer (I01-B6-C): turns a reviewed price policy plus injected provider observations
 * into durable account/quote proof companions, worker execution evidence, and the synchronous
 * submission proof resolver. Missing or unknown inputs fail closed with BUDGET_BLOCKED; no value is
 * ever invented. Provider interactions always happen outside transactions. Quote and reservation
 * writes go through the caller's transaction seam (protocol steps 8/13), while the composer's own
 * protocol steps also write directly in their own short transactions: the credential-generation CAS
 * (step 2) and the account-session evidence inserts (steps 10/11).
 */
export function createProductionBudgetComposer(options: ComposerOptions) {
  const store = options.store;
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const clockNow = (): number => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) blocked("The composer clock must return a nonnegative safe integer timestamp."); return value; };
  const nextId = (prefix: string): string => { const id = `${prefix}:${idFactory()}`; if (!IdSchema.safeParse(id).success) blocked("The configured ID factory returned an invalid ID."); return id; };
  const producer: Readonly<{ producerId: string; producerVersion: string; sourceHash: string }> = options.producer ?? (() => {
    try { return { producerId: "budget-composer", producerVersion: "budget-composer-v1", sourceHash: hashCanonicalJson({ schemaVersion: 1, producerId: "budget-composer", producerVersion: "budget-composer-v1", sogni: readInstalledSogniProofMetadata() }) }; }
    catch { return blocked("The installed provider SDK proof metadata is unavailable; the default proof producer cannot be derived."); }
  })();

  let policyInput: ReviewedPolicyInput | null = null;
  let reviewedPolicy: ReviewedQuotePolicyConfig | null = null;
  if (options.reviewedPolicy !== null) {
    try {
      policyInput = ReviewedPolicyInputSchema.parse(options.reviewedPolicy);
      const config = ReviewedQuotePolicyConfigSchema.parse(JSON.parse(policyInput.configCanonicalJson));
      if (canonicalJson(config) !== policyInput.configCanonicalJson) blocked("The reviewed policy configuration is not canonical; pricing stays blocked.");
      reviewedPolicy = config;
    } catch (error) {
      if (error instanceof ProductionApplicationError) throw error;
      blocked("The reviewed provider policy could not be validated; pricing stays blocked.");
    }
  }
  const usablePolicy = (providerId: string): ReviewedQuotePolicyConfig | null => {
    if (!reviewedPolicy || !policyInput || reviewedPolicy.providerId !== providerId) return null;
    const at = clockNow();
    if (policyInput.capturedAt > at || policyInput.expiresAt <= at) return null;
    return reviewedPolicy;
  };

  const observeAccount = async (providerId: string): Promise<ProviderAccountObservation> => {
    let observation: ProviderAccountObservation;
    try { observation = await options.provider.observeAccount(); }
    catch { return blocked("The provider account observation failed; quote composition is blocked."); }
    if (observation.providerId !== providerId || !observation.captured.accountId) blocked("The provider account observation does not match the requested provider.");
    return observation;
  };
  /** Reuses the durable head when account and fingerprint match; otherwise CAS-adopts a fresh generation. */
  const adoptGeneration = (providerId: string, observation: ProviderAccountObservation, at: number): ProviderCredentialGeneration => {
    const readHead = () => store.read.getProviderCredentialGeneration(providerId);
    const matches = (generation: ProviderCredentialGeneration | null) => !!generation && generation.accountId === observation.captured.accountId && generation.credentialFingerprint === observation.captured.credentialFingerprint;
    const current = readHead();
    if (current && matches(current)) return current;
    const candidate = { schemaVersion: 1 as const, providerId, revision: (current?.revision ?? 0) + 1, generationId: nextId("sogni-generation"), accountId: observation.captured.accountId, credentialFingerprint: observation.captured.credentialFingerprint, changedAt: at };
    const adopted = store.transaction(tx => tx.compareAndSetProviderCredentialGeneration(candidate, current?.revision ?? null) ? candidate : null);
    if (adopted) return adopted;
    const reread = readHead();
    if (reread && matches(reread)) return reread;
    return blocked("The provider credential generation rotated concurrently; composition is blocked.");
  };
  const buildAccountSession = (providerId: string, observation: ProviderAccountObservation, generation: ProviderCredentialGeneration, ttlMs: number) => {
    const parsed = ProviderAccountSessionPayloadSchema.safeParse({ schemaVersion: 1, kind: "account_session", producer, generation, session: observation.captured.session, subscription: observation.subscription, observedAt: observation.observedAt, expiresAt: observation.observedAt + ttlMs });
    if (!parsed.success) blocked("The provider account observation cannot form a valid account_session proof.");
    // createdAt is a pure function of payload fields (observedAt and generation.changedAt are both embedded in the payload), so an identical hash always re-inserts with an identical createdAt: account artifacts can never hit the immutable-artifact conflict.
    const artifact: ProofArtifact = { schemaVersion: 1, hash: hashCanonicalJson(parsed.data), canonicalPayload: canonicalJson(parsed.data), createdAt: Math.max(observation.observedAt, generation.changedAt) };
    const evidence = { schemaVersion: 1 as const, id: nextId("account-evidence"), providerId, accountId: generation.accountId, source: `${producer.producerId}/${producer.producerVersion}`.slice(0, 200), reference: `sha256:${artifact.hash}`, observedAt: observation.observedAt, expiresAt: parsed.data.expiresAt, credentialBindingId: generation.generationId };
    return { payload: parsed.data, artifact, evidence };
  };
  const buildPolicyArtifact = (policy: ReviewedQuotePolicyConfig, policyInput: ReviewedPolicyInput) => {
    const parsed = ProviderReviewedPolicyPayloadSchema.safeParse({ schemaVersion: 1, kind: "reviewed_policy", producer, providerId: policy.providerId, reviewVersion: policyInput.reviewVersion, sourceUrl: policyInput.sourceUrl, sourceCapture: policyInput.sourceCapture, sourceCaptureSha256: policyInput.sourceCaptureSha256, reviewedConfigCanonicalJson: policyInput.configCanonicalJson, reviewedConfigHash: hashCanonicalJson(policy), capturedAt: policyInput.capturedAt, expiresAt: policyInput.expiresAt });
    if (!parsed.success) blocked("The reviewed policy cannot form a valid reviewed_policy proof.");
    // The payload is static per installed policy, so the artifact's createdAt must be payload-stable
    // too: ProofArtifactSchema floors reviewed_policy createdAt at payload.capturedAt, so deriving
    // createdAt from capturedAt keeps the schema valid while making a re-insert of the same policy's
    // artifact a true no-op instead of an immutable-artifact conflict on every requote.
    const artifact: ProofArtifact = { schemaVersion: 1, hash: hashCanonicalJson(parsed.data), canonicalPayload: canonicalJson(parsed.data), createdAt: policyInput.capturedAt };
    return { payload: parsed.data, artifact };
  };
  const discoverCapabilities = async (recipe: ValidatedMediaRecipe): Promise<Readonly<{ capability: CapabilityReceipt; capabilityAt: number }>> => {
    let capability: CapabilityReceipt;
    try { capability = await options.provider.discoverCapabilities(recipe.modelId); }
    catch { return blocked("Provider capability discovery failed; quote composition is blocked."); }
    // Capability freshness is judged against a post-await clock snapshot, not the pre-await `at`:
    // live catalog discovery legitimately observes after the request clock was taken (the provider
    // stamps observedAt following its awaited network round-trip), so requiring observedAt <= a
    // pre-await clock read every live receipt as "from the future" and blocked every live quote.
    // Fail-closed direction is unchanged: expired receipts and receipts stamped ahead of even this
    // post-await clock remain blocked.
    const capabilityAt = clockNow();
    const required = { startFrame: recipe.inputs.some(input => input.required && input.role === "start_frame"), endFrame: recipe.inputs.some(input => input.required && input.role === "end_frame"), contextImages: recipe.inputs.filter(input => input.required && input.role === "context_image").length };
    const mediaOperation = recipe.operation === "anchor" ? "image" as const : "video" as const;
    if (capability.providerId !== recipe.providerId || capability.modelId !== recipe.modelId || capability.provenance !== "live_catalog" || capability.expiresAt === null || capability.expiresAt <= capabilityAt || capability.observedAt > capabilityAt || !capability.supportedOperations.includes(mediaOperation) || !canSatisfy(capability, required, capabilityAt)) {
      blocked("Fresh live provider capability evidence does not satisfy this operation; quote composition is blocked.");
    }
    return { capability, capabilityAt };
  };
  /** Advisory only: admission re-checks caps independently. Unknown when heads or caps are absent. */
  const advisoryWithinAuthorizedCap = (read: ProductionStore["read"], projectId: string, accountId: string, quote: Readonly<{ providerId: string; estimateMax: number | null; currency: string | null; unit: "minor_currency" | "spark_token" | "unknown" }>, at: number): "yes" | "no" | "unknown" => {
    try {
      if (quote.estimateMax === null || quote.unit === "unknown") return "unknown";
      const scope = { providerId: quote.providerId, accountId, currency: quote.currency, unit: quote.unit };
      const policy = read.getLatestAccountPolicy(scope);
      const authorization = policy ? read.getLatestBudgetAuthorization(projectId, policy.policyId) : null;
      if (!policy || !authorization || policy.dailyCap === null || authorization.projectCap === null) return "unknown";
      const withAccounting = (entries: ReturnType<typeof read.listBudgetLedger>) => summarizeBudget(entries.map(entry => ({ reservation: entry.reservation, accounting: foldReservation(entry.reservation, entry.events.map(event => event.evidence)) })), scope);
      const projectTotals = withAccounting(read.listBudgetLedger({ kind: "project", projectId, ...scope }));
      const dayTotals = withAccounting(read.listBudgetLedger({ kind: "account_day", utcDay: utcBudgetDay(at), ...scope }));
      return checkedAdd(projectTotals.totalLiability, quote.estimateMax) <= authorization.projectCap && checkedAdd(dayTotals.totalLiability, quote.estimateMax) <= policy.dailyCap ? "yes" : "no";
    } catch { return "unknown"; }
  };
  const unknownQuote = (request: z.infer<typeof QuoteRequestInputSchema>, inputHash: string): ProductionQuote => {
    const at = clockNow();
    return QuoteSchema.parse({ version: 1, id: nextId("quote"), projectId: request.projectId, providerId: request.providerId, modelId: request.modelId, operation: request.operation, inputHash, entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: at + 30_000, withinAuthorizedCap: "unknown", createdAt: at });
  };

  const resolveBillingMode: (input: Readonly<{ projectId: string; providerId: string; modelId: string; operation: "anchor" | "take" }>) => Promise<BillingModeIntent> = async input => {
    const mode = usablePolicy(input.providerId)?.billingModeByModel.find(item => item.modelId === input.modelId)?.billingMode;
    if (!mode) blocked("No reviewed billing mode covers this model; refusing to infer a billing mode.");
    return mode;
  };

  const prepareMediaQuoteDraft = async (input: Readonly<{ recipe: ValidatedMediaRecipe; request: ProviderQuoteRequest }>): Promise<PreparedMediaQuoteDraft> => {
    const recipe = RecipeInputSchema.safeParse(input.recipe);
    const request = QuoteRequestInputSchema.safeParse(input.request);
    if (!recipe.success || !request.success) blocked("The media recipe or quote request is invalid; quote composition is blocked.");
    const rec: ValidatedMediaRecipe = recipe.data;
    const req = request.data;
    if (req.providerId !== rec.providerId || req.modelId !== rec.modelId || req.projectId !== rec.projectId || req.operation !== rec.operation) blocked("The quote request does not match the media recipe.");
    const projectionHash = hashCanonicalJson(quoteProjection(rec));
    const policy = usablePolicy(rec.providerId);
    const entry = policy?.priceByModel.find(price => price.modelId === rec.modelId && price.operations.includes(rec.operation));
    if (!policy || !policyInput || !entry) return { kind: "unknown", mediaQuote: unknownQuote(req, projectionHash) };
    const mode = policy.billingModeByModel.find(item => item.modelId === rec.modelId)?.billingMode;
    if (!mode || (entry.entitlement === "subscription") !== (mode === "subscription") || mode !== rec.billingMode) blocked("The reviewed entitlement and billing mode do not pair for this model.");

    const observation = await observeAccount(rec.providerId);
    if (!observation.captured.accountId) blocked("The provider account observation is not authenticated.");
    const at = clockNow();
    const generation = adoptGeneration(rec.providerId, observation, at);
    const account = buildAccountSession(rec.providerId, observation, generation, policy.accountSessionTtlMs);
    const reviewed = buildPolicyArtifact(policy, policyInput);
    const { capability, capabilityAt } = await discoverCapabilities(rec);
    if (capability.expiresAt === null) blocked("Fresh live provider capability evidence is required; quote composition is blocked.");
    const priced = entry.unit === "minor_currency";
    const estimateMin = priced ? entry.estimateMinMinor : null;
    const estimateMax = priced ? entry.estimateMaxMinor : null;
    const currency = priced ? entry.currency : null;
    const expiresAt = Math.min(at + policy.quoteTtlMs, account.payload.expiresAt, reviewed.payload.expiresAt, capability.expiresAt);
    if (expiresAt <= at) blocked("The composed quote lifetime is empty; refusing to quote.");
    const mediaQuote = { version: 1 as const, id: nextId("quote"), projectId: rec.projectId, providerId: rec.providerId, modelId: rec.modelId, operation: rec.operation, inputHash: projectionHash, entitlement: entry.entitlement, estimateMinMinor: estimateMin, estimateMaxMinor: estimateMax, currency, expiresAt, withinAuthorizedCap: advisoryWithinAuthorizedCap(store.read, rec.projectId, generation.accountId, { providerId: rec.providerId, estimateMax, currency, unit: entry.unit }, at), createdAt: at };
    const budgetQuote = { schemaVersion: 1 as const, id: nextId("budget-quote"), projectId: rec.projectId, providerId: rec.providerId, modelId: rec.modelId, operation: rec.operation, inputHash: projectionHash, estimateMin, estimateMax, currency, unit: entry.unit, entitlement: entry.entitlement, createdAt: at, expiresAt, mediaQuoteId: mediaQuote.id };
    const binding = { schemaVersion: 1 as const, id: nextId("quote-binding"), budgetQuoteId: budgetQuote.id, accountEvidenceId: account.evidence.id, providerId: rec.providerId, accountId: generation.accountId, credentialBindingId: generation.generationId, currency, unit: entry.unit, executionSemanticHash: rec.resultTarget.inputsHash, quotedAt: at };
    // The proof snapshot embeds the capability receipt, which is legitimately observed after `at`,
    // so the snapshot itself (and its artifact) is stamped with the post-await capabilityAt that
    // admitted the receipt; all durable quote math above stays on the request clock `at`.
    const payload = ProviderMediaQuotePayloadSchema.safeParse({
      schemaVersion: 1, kind: "media_quote", producer, mediaQuote, budgetQuote, binding, accountEvidence: account.evidence,
      accountProofHash: account.artifact.hash, policyProofHash: reviewed.artifact.hash,
      canonicalRecipeJson: canonicalJson(rec), recipeHash: hashCanonicalJson(rec),
      canonicalQuoteProjectionJson: canonicalJson(quoteProjection(rec)), quoteProjectionHash: projectionHash,
      executionSemanticHash: rec.resultTarget.inputsHash, capability, session: observation.captured.session, createdAt: capabilityAt, expiresAt,
    });
    if (!payload.success) blocked("The composed provider quote snapshot failed integrity validation; no partial draft escapes.");
    const quoteArtifact: ProofArtifact = { schemaVersion: 1, hash: hashCanonicalJson(payload.data), canonicalPayload: canonicalJson(payload.data), createdAt: capabilityAt };
    return { kind: "bound", mediaQuote: payload.data.mediaQuote, budgetQuote: payload.data.budgetQuote, binding: payload.data.binding, accountEvidence: payload.data.accountEvidence, accountArtifact: account.artifact, policyArtifact: reviewed.artifact, quoteArtifact, quoteProof: { schemaVersion: 1, mediaQuoteId: payload.data.mediaQuote.id, budgetQuoteId: payload.data.budgetQuote.id, artifactHash: quoteArtifact.hash }, expectedGeneration: generation, capability: payload.data.capability };
  };

  const commitPreparedQuote = (tx: ProductionWritePort, draft: PreparedMediaQuoteDraft, context: Readonly<{ recipe: ValidatedMediaRecipe; request: ProviderQuoteRequest; at: number }>): void => {
    if (draft.kind !== "bound") blocked("Only bound media quote drafts carry proof companions to commit.");
    if (!QuoteCompanionsSchema.safeParse({ budgetQuote: draft.budgetQuote, binding: draft.binding, accountEvidence: draft.accountEvidence, accountArtifact: draft.accountArtifact, policyArtifact: draft.policyArtifact, quoteArtifact: draft.quoteArtifact, quoteProof: draft.quoteProof }).success) blocked("Bound media quote companions are invalid.");
    tx.insertProofArtifact(draft.accountArtifact);
    tx.insertProofArtifact(draft.policyArtifact);
    tx.insertAccountEvidence(draft.accountEvidence);
    tx.insertBudgetQuote(draft.budgetQuote, draft.binding);
    tx.insertProofArtifact(draft.quoteArtifact);
    tx.insertQuoteProof(draft.quoteProof);
    const recomputed = advisoryWithinAuthorizedCap(tx, context.recipe.projectId, draft.accountEvidence.accountId, { providerId: draft.budgetQuote.providerId, estimateMax: draft.budgetQuote.estimateMax, currency: draft.budgetQuote.currency, unit: draft.budgetQuote.unit }, context.at);
    if (recomputed !== draft.mediaQuote.withinAuthorizedCap) staleRevision("The authorized-cap advisory changed before the bound quote could be committed.");
  };

  const resolveAccountIdentity = async (providerId: string): Promise<TrustedAccountIdentity> => {
    const policy = usablePolicy(providerId);
    if (!policy || !policyInput) blocked("No reviewed policy covers this provider; account identity is unavailable.");
    const observation = await observeAccount(providerId);
    const at = clockNow();
    const generation = adoptGeneration(providerId, observation, at);
    const session = buildAccountSession(providerId, observation, generation, policy.accountSessionTtlMs);
    store.transaction(tx => { tx.insertProofArtifact(session.artifact); tx.insertAccountEvidence(session.evidence); });
    return { providerId, accountId: generation.accountId, accountEvidenceId: session.evidence.id, credentialBindingId: generation.generationId };
  };

  const currentCredentialBindingId = (providerId: string): string | null => {
    try {
      const head = store.read.getProviderCredentialGeneration(providerId);
      const session = options.provider.currentSession();
      if (!head || !session || !session.accountId || session.accountId !== head.accountId || session.credentialFingerprint !== head.credentialFingerprint) return null;
      return head.generationId;
    } catch { return null; }
  };

  const prepareExecutionEvidence = async (input: Readonly<{ execution: BudgetExecution; budgetQuoteId: string }>, capture?: (draft: Readonly<{ workerArtifact: ProofArtifact; generation: ProviderCredentialGeneration; observedAt: number }>) => void): Promise<TrustedPreparedExecutionEvidence> => {
    const execution = BudgetExecutionSchema.safeParse(input.execution);
    if (!execution.success || execution.data.kind !== "media_job") blocked("Only media job executions prepare worker account evidence.");
    const providerId = execution.data.providerId;
    const policy = usablePolicy(providerId);
    if (!policy) blocked("No reviewed policy covers this provider; worker evidence is unavailable.");
    const observation = await observeAccount(providerId);
    if (observation.captured.session.role !== "worker") blocked("Worker account evidence requires a worker-role provider session.");
    const at = clockNow();
    const generation = adoptGeneration(providerId, observation, at);
    const worker = buildAccountSession(providerId, observation, generation, policy.executionSessionTtlMs);
    store.transaction(tx => { tx.insertProofArtifact(worker.artifact); tx.insertAccountEvidence(worker.evidence); });
    capture?.({ workerArtifact: worker.artifact, generation, observedAt: observation.observedAt });
    const job = store.read.getJob(execution.data.executionId);
    const mediaQuoteId = job?.quoteId ?? null;
    const budgetQuoteForJob = mediaQuoteId ? store.read.getBudgetQuoteForMediaQuote(mediaQuoteId) : null;
    const quoteProof = budgetQuoteForJob ? store.read.getQuoteProof(budgetQuoteForJob.id) : null;
    const quoteArtifact = quoteProof ? store.read.getProofArtifact(quoteProof.artifactHash) : null;
    const quotePayload = quoteArtifact ? proofPayloadOrNull(quoteArtifact) : null;
    if (!quotePayload || quotePayload.kind !== "media_quote") blocked("The quote-time proof chain for this execution is missing or invalid.");
    const budgetQuote = store.read.getBudgetQuote(input.budgetQuoteId);
    if (!budgetQuote) blocked("The pinned budget quote is missing.");
    return { accountEvidenceId: quotePayload.accountEvidence.id, budgetQuoteId: input.budgetQuoteId, expectedQuoteInputHash: budgetQuote.inputHash, executionSemanticHash: execution.data.executionSemanticHash, credentialBindingId: generation.generationId };
  };

  // reserveInTransaction performs no provider interaction, so this shared instance carries no
  // observation hooks; worker evidence is prepared through the per-call scoped service below.
  const budgetService = createProductionBudgetService({
    store, now, idFactory,
    currentCredentialBindingId: providerId => currentCredentialBindingId(providerId),
  });

  const prepareWorkerBudgetContext = async (job: ProductionJob, quote: ProductionQuote, capability: CapabilityReceipt): Promise<PreparedSubmissionContext> => {
    if (job.operation !== "anchor" && job.operation !== "take") blocked("Only anchor and take jobs prepare worker budget context.");
    if (job.providerId === null || job.modelId === null) blocked("The job is missing its provider or model pin.");
    const snapshot = ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot);
    const inputsHash = snapshot.success ? snapshot.data.resultTarget?.inputsHash : undefined;
    if (!snapshot.success || !inputsHash) blocked("The job request snapshot is missing its immutable result target hash.");
    try { if (computeProductionInputsHash(store.read, job.operation, snapshot.data) !== inputsHash) blocked("The job's pinned inputs no longer hash to its result target."); }
    catch { blocked("The job's pinned inputs are missing; worker budget context is unavailable."); }
    const budgetQuote = store.read.getBudgetQuoteForMediaQuote(quote.id);
    const quoteProof = budgetQuote ? store.read.getQuoteProof(budgetQuote.id) : null;
    if (!budgetQuote || !quoteProof) blocked("The media quote has no durable budget companion and quote proof.");
    // The captured worker draft is per-invocation state: a scoped budget service binds the capture
    // into this call's scope, so interleaved preparations on one composer can never cross-wire
    // worker artifacts or credential generations between contexts.
    let capturedWorkerDraft: Readonly<{ workerArtifact: ProofArtifact; generation: ProviderCredentialGeneration; observedAt: number }> | null = null;
    const scopedBudgetService = createProductionBudgetService({
      store, now, idFactory,
      resolveAccountIdentity: providerId => resolveAccountIdentity(providerId),
      prepareExecutionEvidence: async input => prepareExecutionEvidence(input, draft => { capturedWorkerDraft = draft; }),
      currentCredentialBindingId: providerId => currentCredentialBindingId(providerId),
    });
    const context = await scopedBudgetService.prepareBudgetContext({ kind: "media_job", executionId: job.id, operation: job.operation, projectId: job.projectId, idempotencyKey: job.idempotencyKey, requestHash: job.requestHash, executionSemanticHash: inputsHash, providerId: job.providerId, modelId: job.modelId }, budgetQuote.id);
    const capturedDraft = capturedWorkerDraft as Readonly<{ workerArtifact: ProofArtifact; generation: ProviderCredentialGeneration; observedAt: number }> | null;
    if (!capturedDraft) blocked("Worker account evidence was not produced during budget context preparation.");
    return { ...context, providerProofDraft: { ...capturedDraft, capability } };
  };

  const reserveSubmission = (tx: ProductionWritePort, currentJob: ProductionJob, quote: ProductionQuote, capability: CapabilityReceipt, at: number, contextValue: PreparedSubmissionContext): BudgetReservation => {
    const parsed = PreparedSubmissionContextSchema.safeParse(contextValue);
    if (!parsed.success) blocked("The prepared submission context is invalid.");
    const context = parsed.data;
    // budget.ts strictObject rejects extra keys; strip to exactly the eight B3 fields.
    const stripped = { accountEvidenceId: context.accountEvidenceId, budgetQuoteId: context.budgetQuoteId, policyId: context.policyId, expectedPolicyRevision: context.expectedPolicyRevision, expectedAuthorizationRevision: context.expectedAuthorizationRevision, expectedQuoteInputHash: context.expectedQuoteInputHash, executionSemanticHash: context.executionSemanticHash, credentialBindingId: context.credentialBindingId };
    const snapshot = ProviderRequestSnapshotSchema.safeParse(currentJob.requestSnapshot);
    if (currentJob.operation !== "anchor" && currentJob.operation !== "take") blocked("Only anchor and take executions reserve submissions.");
    if (!snapshot.success || !snapshot.data.resultTarget || currentJob.providerId === null || currentJob.modelId === null) blocked("The submitting job snapshot is incomplete.");
    const execution = { kind: "media_job" as const, executionId: currentJob.id, operation: currentJob.operation, projectId: currentJob.projectId, idempotencyKey: currentJob.idempotencyKey, requestHash: currentJob.requestHash, executionSemanticHash: snapshot.data.resultTarget.inputsHash, providerId: currentJob.providerId, modelId: currentJob.modelId };
    const reservation = budgetService.reserveInTransaction(tx, execution, at, stripped);
    const quoteProof = tx.getQuoteProof(context.budgetQuoteId);
    const quoteArtifact = quoteProof ? tx.getProofArtifact(quoteProof.artifactHash) : null;
    const quotePayload = quoteArtifact ? proofPayloadOrNull(quoteArtifact) : null;
    const binding = tx.getQuoteAccountBinding(context.budgetQuoteId);
    const budgetQuote = tx.getBudgetQuote(context.budgetQuoteId);
    const workerPayload = proofPayloadOrNull(context.providerProofDraft.workerArtifact);
    if (!quoteProof || !quotePayload || quotePayload.kind !== "media_quote" || !binding || !budgetQuote || !workerPayload || workerPayload.kind !== "account_session" || quotePayload.capability.expiresAt === null) blocked("The durable quote proof chain is incomplete before execution proof composition.");
    // C13-LIVE-FIX-2: the reservation pins the QUOTE's authorized evidence — the execution proof
    // embeds the quote payload's capability, which the store's insert-time validator requires by
    // canonical equality. The worker's own fresh discovery (a second network observation with a
    // different observedAt) remains the admission/submit gate in worker.ts, so the worker-passed
    // `capability` parameter stays in the signature but is deliberately not proof evidence.
    const expiresAt = Math.min(workerPayload.expiresAt, quotePayload.expiresAt, budgetQuote.expiresAt, quotePayload.capability.expiresAt);
    if (expiresAt <= context.providerProofDraft.observedAt) blocked("The execution proof lifetime is empty; submission is blocked.");
    const executionPayload = {
      schemaVersion: 1 as const, kind: "execution_session" as const, producer, execution,
      mediaQuoteId: quote.id, budgetQuoteId: context.budgetQuoteId, quoteBindingId: binding.id, accountEvidenceId: context.accountEvidenceId,
      quoteProofHash: quoteProof.artifactHash, accountProofHash: context.providerProofDraft.workerArtifact.hash,
      generation: context.providerProofDraft.generation, session: workerPayload.session, capability: quotePayload.capability,
      observedAt: context.providerProofDraft.observedAt, expiresAt,
    };
    const parsedExecution = ProviderExecutionSessionPayloadSchema.safeParse(executionPayload);
    if (!parsedExecution.success) blocked("The execution session proof is inconsistent; submission is blocked.");
    const artifact: ProofArtifact = { schemaVersion: 1, hash: hashCanonicalJson(parsedExecution.data), canonicalPayload: canonicalJson(parsedExecution.data), createdAt: Math.max(context.providerProofDraft.observedAt, context.providerProofDraft.generation.changedAt) };
    tx.insertProofArtifact(artifact);
    tx.insertExecutionProof({ schemaVersion: 1, executionId: currentJob.id, reservationId: reservation.id, artifactHash: artifact.hash });
    return reservation;
  };

  const submissionProofResolver: SubmissionProofResolver = (snapshotValue, captured: AuthenticatedProviderSession, at) => {
    try {
      const snapshot = ProviderRequestSnapshotSchema.parse(snapshotValue);
      const job = store.read.getJob(snapshot.jobId);
      if (!job || job.status !== "submitting" || job.requestHash !== hashCanonicalJson(snapshot) || job.quoteId !== snapshot.quoteId || job.modelId !== snapshot.modelId) return false;
      const link = store.read.getExecutionProof(snapshot.jobId);
      const artifact = link ? store.read.getProofArtifact(link.artifactHash) : null;
      const payload = artifact ? proofPayloadOrNull(artifact) : null;
      if (!payload || payload.kind !== "execution_session") return false;
      if (payload.execution.executionId !== snapshot.jobId || payload.execution.requestHash !== job.requestHash || payload.execution.executionSemanticHash !== snapshot.resultTarget?.inputsHash) return false;
      if (canonicalJson(captured.session) !== canonicalJson(payload.session) || captured.credentialFingerprint !== payload.generation.credentialFingerprint || captured.accountId !== payload.generation.accountId) return false;
      const head = store.read.getProviderCredentialGeneration(snapshot.providerId);
      if (!head || canonicalJson(head) !== canonicalJson(payload.generation)) return false;
      if (!(at >= payload.observedAt && at < payload.expiresAt && payload.capability.expiresAt !== null && at < payload.capability.expiresAt)) return false;
      const quoteProof = store.read.getQuoteProof(payload.budgetQuoteId);
      const quoteArtifact = quoteProof && quoteProof.artifactHash === payload.quoteProofHash ? store.read.getProofArtifact(quoteProof.artifactHash) : null;
      const quotePayload = quoteArtifact ? proofPayloadOrNull(quoteArtifact) : null;
      const budgetQuote = store.read.getBudgetQuote(payload.budgetQuoteId);
      if (!quotePayload || quotePayload.kind !== "media_quote" || quotePayload.mediaQuote.id !== job.quoteId || !budgetQuote || budgetQuote.mediaQuoteId !== job.quoteId || at >= budgetQuote.expiresAt) return false;
      const reservation = store.read.getReservationByExecution(snapshot.jobId);
      if (!reservation || reservation.budgetQuoteId !== payload.budgetQuoteId) return false;
      return true;
    } catch { return false; }
  };

  return { resolveBillingMode, prepareMediaQuoteDraft, commitPreparedQuote, resolveAccountIdentity, prepareExecutionEvidence: (input: Readonly<{ execution: BudgetExecution; budgetQuoteId: string }>) => prepareExecutionEvidence(input), currentCredentialBindingId, prepareWorkerBudgetContext, reserveSubmission, submissionProofResolver };
}
