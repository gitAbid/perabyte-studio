import { join } from "node:path";
import { z } from "zod";
import {
  ApprovalSchema,
  CreateApprovalCommandSchema,
  IdSchema,
  ProviderRequestSnapshotSchema,
  type Approval,
  type Asset,
  type CreateApprovalCommand,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { computeAnchorApprovalHash, productionSubmissionEligibilityFingerprint } from "../../jobs/production/queue";
import { LocalMediaVault } from "../../media/production/vault";
import { approvalCommandId, computeTakeApprovalHash, isExactApprovalReplay, validateApprovalChecklist } from "../../production/approval";
import { hashCanonicalJson } from "../../production/hash";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { resolveProductionDataDir, withProductionStore } from "../../production/runtime";
import type { ProductionReadPort, ProductionStore } from "../../repositories/production/ports";

export const ApprovalRouteCommandSchema = z.strictObject({
  projectId: IdSchema,
  idempotencyKey: IdSchema,
  command: CreateApprovalCommandSchema,
});
export type ApprovalRouteCommand = z.infer<typeof ApprovalRouteCommandSchema>;
type ApprovalChecklistItem = Approval["checklist"][number];

export interface ProductionApprovalServiceOptions {
  store: ProductionStore;
  actorId?: string;
  readAssetVerified: (asset: Asset) => Promise<unknown>;
  now?: () => number;
  idFactory?: () => string;
}

type ResolvedTarget = { targetHash: string; assets: Asset[]; visionStatus: string | null; contextFingerprint: string | null };
function stale(message: string, action = "Reload the current target and retry with a new command key."): never {
  throw new ProductionApplicationError("STALE_REVISION", message, { retryable: true, action });
}
function missing(): never { throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Approval target was not found in this project."); }

function currentShot(read: ProductionReadPort, projectId: string, shotRevisionId: string): boolean {
  const project = read.getProject(projectId);
  if (!project?.activeStoryRevisionId || !project.activeShotPlanRevisionId || !project.activeAnimaticRevisionId) return false;
  const story = read.getStoryRevision(project.activeStoryRevisionId);
  const plan = read.getShotPlanRevision(project.activeShotPlanRevisionId);
  const animatic = read.getAnimaticRevision(project.activeAnimaticRevisionId);
  const shot = read.getShotRevision(shotRevisionId);
  return !!story && story.projectId === project.id && !!plan && plan.projectId === project.id && plan.storyRevisionId === story.id &&
    plan.orderedShotRevisionIds.includes(shotRevisionId) && !!animatic && animatic.projectId === project.id &&
    animatic.shotPlanRevisionId === plan.id && animatic.slots.some((slot) => slot.shotRevisionId === shotRevisionId) &&
    !!shot && read.getStoryRevision(shot.storyRevisionId)?.projectId === project.id;
}

function validateMediaProvenance(read: ProductionReadPort, operation: "anchor" | "take", resultId: string, projectId: string): string {
  const target = operation === "anchor" ? read.getAnchor(resultId) : read.getTake(resultId);
  const job = target ? read.getJob(target.jobId) : null;
  const quote = job?.quoteId ? read.getQuote(job.quoteId) : null;
  const parsedSnapshot = job ? ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot) : null;
  const eligibilityFingerprint = target && job && quote && parsedSnapshot?.success
    ? productionSubmissionEligibilityFingerprint(read, job, quote, parsedSnapshot.data)
    : null;
  if (!target || !job || job.projectId !== projectId || job.operation !== operation || job.status !== "completed" || job.resultId !== resultId ||
      !quote || quote.projectId !== projectId || quote.operation !== operation || quote.providerId !== job.providerId || quote.modelId !== job.modelId ||
      !parsedSnapshot?.success || hashCanonicalJson(parsedSnapshot.data) !== job.requestHash ||
      eligibilityFingerprint === null) {
    stale(`The ${operation} no longer has valid current story, plan, animatic, quote, and generation provenance.`);
  }
  const resultTarget = parsedSnapshot.data.resultTarget;
  if (!resultTarget || resultTarget.kind !== operation || resultTarget.shotRevisionId !== target.shotRevisionId ||
      resultTarget.inputsHash !== target.inputsHash || !job.resultAssetIds.includes(target.assetId)) {
    stale(`The ${operation} does not match its exact recorded result target and asset.`);
  }
  if (operation === "anchor") {
    const anchor = target as NonNullable<ReturnType<ProductionReadPort["getAnchor"]>>;
    const receipt = anchor.receiptId ? read.getHonoredInputsReceipt(anchor.receiptId) : null;
    if (!receipt || receipt.jobId !== job.id || job.receiptId !== receipt.id) {
      stale("Anchor approval requires its exact durable generation receipt.");
    }
  }
  if (operation === "take") {
    const snapshot = parsedSnapshot!.data;
    if (snapshot.resultTarget?.kind !== "take" || snapshot.resultTarget.anchorId !== (target as NonNullable<ReturnType<ProductionReadPort["getTake"]>>).anchorId ||
        snapshot.resultTarget.anchorApprovalId !== (target as NonNullable<ReturnType<ProductionReadPort["getTake"]>>).approvalId) {
      stale("Take approval does not match its exact recorded anchor and approval pins.");
    }
    const providerAudioPolicy = snapshot.parameters.providerAudioPolicy;
    if (providerAudioPolicy !== "muted") {
      throw new ProductionApplicationError("CAPABILITY_MISMATCH", "This take has no supported muted provider-audio policy.", {
        action: "Create a new take with providerAudioPolicy set to muted before approval.",
      });
    }
    const take = read.getTake(resultId)!;
    const anchor = read.getAnchor(take.anchorId);
    const anchorApproval = read.getApproval(take.approvalId);
    const receipt = read.getHonoredInputsReceipt(take.receiptId);
    const asset = read.getAsset(take.assetId);
    if (!anchor || anchor.shotRevisionId !== take.shotRevisionId || !anchorApproval || anchorApproval.targetKind !== "anchor" ||
        anchorApproval.targetId !== anchor.id || anchorApproval.targetHash !== computeAnchorApprovalHash(read, anchor) ||
        anchorApproval.decision !== "approved" || !receipt || receipt.jobId !== job!.id || job!.receiptId !== receipt.id ||
        !asset || !Number.isSafeInteger(take.actualFrames) || take.actualFrames <= 0 || asset.frames !== take.actualFrames) {
      stale("Take approval requires its exact approved anchor, result receipt, and measured frame count.");
    }
  }
  return eligibilityFingerprint;
}

function referenceAssets(read: ProductionReadPort, ids: readonly string[], label: string): Asset[] {
  const assets = ids.map((id) => read.getAsset(id));
  if (assets.some((asset) => !asset)) throw new ProductionApplicationError("MEDIA_UNAVAILABLE", `${label} media is unavailable.`);
  const found = assets as Asset[];
  if (found.some((asset) => !["creator_attested", "licensed", "public_domain", "provider"].includes(asset.rightsStatus))) {
    throw new ProductionApplicationError("INVALID_INPUT", `${label} requires known media rights.`);
  }
  return found;
}

function resolveTarget(read: ProductionReadPort, projectId: string, command: CreateApprovalCommand): ResolvedTarget {
  const project = read.getProject(projectId);
  if (!project) missing();
  switch (command.targetKind) {
    case "story": {
      const target = read.getStoryRevision(command.targetId);
      if (!target || target.projectId !== projectId) missing();
      if (project.activeStoryRevisionId !== target.id) stale("Story is no longer the current selected revision.");
      return { targetHash: target.contentHash, assets: [], visionStatus: null, contextFingerprint: null };
    }
    case "canon": {
      const target = read.getCanonRevision(command.targetId);
      if (!target) missing();
      if (!project.activeCanonRevisionIds.includes(target.id)) stale("Canon revision is no longer selected by this project.");
      return { targetHash: target.contentHash, assets: referenceAssets(read, target.referenceAssetIds, "Canon"), visionStatus: null, contextFingerprint: null };
    }
    case "shotplan": {
      const target = read.getShotPlanRevision(command.targetId);
      if (!target || target.projectId !== projectId) missing();
      if (project.activeShotPlanRevisionId !== target.id || target.storyRevisionId !== project.activeStoryRevisionId) stale("Shot plan is no longer the current selected revision.");
      return { targetHash: target.contentHash, assets: [], visionStatus: null, contextFingerprint: null };
    }
    case "animatic": {
      const target = read.getAnimaticRevision(command.targetId);
      if (!target || target.projectId !== projectId) missing();
      if (project.activeAnimaticRevisionId !== target.id || target.shotPlanRevisionId !== project.activeShotPlanRevisionId) stale("Animatic is no longer the current selected revision.");
      return { targetHash: target.contentHash, assets: [], visionStatus: null, contextFingerprint: null };
    }
    case "audio": {
      const target = read.getAudioMixRevision(command.targetId);
      if (!target || target.projectId !== projectId) missing();
      if (project.activeAudioMixRevisionId !== target.id || target.storyRevisionId !== project.activeStoryRevisionId) stale("Audio mix is no longer current for the selected story.");
      const cueAssets = referenceAssets(read, target.cues.map((cue) => cue.assetId), "Audio cue");
      if (target.cues.some((cue) => cue.sourceRights === "unknown")) throw new ProductionApplicationError("INVALID_INPUT", "Audio approval requires rights information for every cue.");
      return { targetHash: target.contentHash, assets: cueAssets, visionStatus: null, contextFingerprint: null };
    }
    case "anchor": {
      const target = read.getAnchor(command.targetId);
      if (!target) missing();
      const shot = read.getShotRevision(target.shotRevisionId);
      if (!shot || !currentShot(read, projectId, shot.id)) stale("Anchor is no longer selected for a current shot.");
      const contextFingerprint = validateMediaProvenance(read, "anchor", target.id, projectId);
      const asset = read.getAsset(target.assetId);
      if (!asset) throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Anchor media is unavailable.");
      return { targetHash: computeAnchorApprovalHash(read, target), assets: [asset], visionStatus: target.visionAssessment?.status ?? "unavailable", contextFingerprint };
    }
    case "take": {
      const target = read.getTake(command.targetId);
      if (!target) missing();
      const shot = read.getShotRevision(target.shotRevisionId);
      if (!shot || !currentShot(read, projectId, shot.id)) stale("Take is no longer a current candidate for this shot.");
      const contextFingerprint = validateMediaProvenance(read, "take", target.id, projectId);
      const asset = read.getAsset(target.assetId);
      if (!asset) throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Take media is unavailable.");
      return { targetHash: computeTakeApprovalHash(read, target), assets: [asset], visionStatus: null, contextFingerprint };
    }
    case "final":
      throw new ProductionApplicationError("QC_BLOCKED", "Final approval is unavailable until checksum-bound technical QC is implemented.");
  }
}

function validateVisionAcknowledgement(command: CreateApprovalCommand, status: string | null): void {
  if (command.targetKind !== "anchor") return;
  const requiredCode = status === "pass" ? null : `vision_${status}`;
  if (requiredCode && !command.advisoryAcknowledgements.some((item) => item.code === requiredCode && item.reason.trim())) {
    throw new ProductionApplicationError("INVALID_INPUT", `Anchor review requires an explicit ${requiredCode} acknowledgement.`);
  }
}

function sameCommand(existing: Approval, route: ApprovalRouteCommand, actorId: string): boolean {
  return isExactApprovalReplay(existing, route.command, actorId);
}

function conflict(): never {
  throw new ProductionApplicationError("STALE_REVISION", "This command key already belongs to a different approval command or creator.", {
    action: "Use a new idempotency key for the changed decision.",
  });
}

function findReplay(store: ProductionStore, id: string, route: ApprovalRouteCommand, actorId: string) {
  return store.transaction((tx) => {
    const existing = tx.getApproval(id);
    if (!existing) return null;
    if (!sameCommand(existing, route, actorId)) conflict();
    return { approval: existing, created: false as const };
  });
}

export function createProductionApprovalService(options: ProductionApprovalServiceOptions) {
  const actorId = IdSchema.parse(options.actorId ?? "local-creator");
  const now = options.now ?? Date.now;
  return {
    async create(input: ApprovalRouteCommand): Promise<{ approval: Approval; created: boolean }> {
      const route = ApprovalRouteCommandSchema.parse(input);
      const id = approvalCommandId(route.projectId, route.idempotencyKey);
      const replay = findReplay(options.store, id, route, actorId);
      if (replay) return replay;

      // Resolve current ownership and checksum-bound media before any filesystem await.
      const initial = resolveTarget(options.store.read, route.projectId, route.command);
      if (initial.targetHash !== route.command.expectedHash) stale("Approval target hash no longer matches the current immutable target.");
      validateApprovalChecklist(route.command.targetKind, route.command.checklist, route.command.targetKind === "canon"
        ? options.store.read.getCanonRevision(route.command.targetId)?.entityKind : undefined);
      validateVisionAcknowledgement(route.command, initial.visionStatus);
      if (route.command.decision === "rejected" && !route.command.notes.trim() && !route.command.checklist.some((item) => !item.passed && item.note.trim())) {
        throw new ProductionApplicationError("INVALID_INPUT", "A rejected decision requires notes or a failed checklist reason.");
      }
      try { for (const asset of initial.assets) await options.readAssetVerified(asset); }
      catch { throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Approval media could not be checksum verified."); }

      return options.store.transaction((tx) => {
        const prior = tx.getApproval(id);
        if (prior) {
          if (!sameCommand(prior, route, actorId)) conflict();
          return { approval: prior, created: false };
        }
        const current = resolveTarget(tx, route.projectId, route.command);
        if (current.targetHash !== route.command.expectedHash ||
            current.contextFingerprint !== initial.contextFingerprint ||
            hashCanonicalJson(current.assets.map((asset) => [asset.id, asset.sha256, asset.vaultRef])) !==
              hashCanonicalJson(initial.assets.map((asset) => [asset.id, asset.sha256, asset.vaultRef]))) {
          stale("Approval target or media changed while it was being verified.");
        }
        const priorDecisions = tx.listApprovals(route.command.targetKind, route.command.targetId);
        const latestAt = priorDecisions.reduce((latest, item) => Math.max(latest, item.createdAt), -1);
        const createdAt = now();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new ProductionApplicationError("INTERNAL_ERROR", "Approval clock returned an invalid UTC timestamp.");
        if (createdAt <= latestAt) stale("Approval order has not advanced; retry when the system clock is later.", "Retry this approval after the UTC clock advances.");
        const approval = ApprovalSchema.parse({
          version: 1,
          id,
          targetKind: route.command.targetKind,
          targetId: route.command.targetId,
          targetHash: current.targetHash,
          decision: route.command.decision,
          actorId,
          createdAt,
          checklist: route.command.checklist,
          notes: route.command.notes,
          advisoryAcknowledgements: route.command.advisoryAcknowledgements,
        });
        tx.appendApproval(approval);
        return { approval, created: true };
      });
    },
  };
}

export interface ApprovalRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  serviceOptions?: Omit<ProductionApprovalServiceOptions, "store" | "readAssetVerified"> & { readAssetVerified?: ProductionApprovalServiceOptions["readAssetVerified"] };
  dataDir?: string;
}

const MAX_APPROVAL_BODY_BYTES = 64 * 1024;

export function createApprovalRouteHandlers(options: ApprovalRouteHandlerOptions = {}) {
  const withStore: NonNullable<ApprovalRouteHandlerOptions["withStore"]> = options.withStore ?? (work => withProductionStore((store) => work(store)));
  const vault = new LocalMediaVault({ root: join(options.dataDir ?? resolveProductionDataDir(), "media") });
  const readAssetVerified = options.serviceOptions?.readAssetVerified ?? (async (asset: Asset) => {
    try { await vault.readVerified(asset.vaultRef, asset.sha256); }
    catch { throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Approval media could not be checksum verified."); }
  });
  return {
    async POST(request: Request): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const route = await readProductionJson(request, ApprovalRouteCommandSchema, { maxBytes: MAX_APPROVAL_BODY_BYTES });
        const result = await withStore((store) => createProductionApprovalService({ ...options.serviceOptions, store, readAssetVerified }).create(route));
        return Response.json(result, { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}
