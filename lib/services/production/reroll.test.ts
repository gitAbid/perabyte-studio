import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore } from "../../repositories/production/sqlite";
import {
  ApprovalSchema, AssetSchema, ProviderRequestSnapshotSchema, QuoteSchema,
  type Approval, type Asset, type CreateShotPlanCommand, type ProductionJob,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { computeAnchorApprovalHash, computeProductionInputsHash, ProductionJobQueue } from "../../jobs/production/queue";
import { createCanonRevision, createProject, createStoryRevision } from "./revisions";
import { createShotPlan } from "./shot-plan";
import { continuityGuidancePrompt, enqueueGuidedReroll } from "./reroll";

const directories: string[] = [];
const stores: ReturnType<typeof openProductionStore>[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function asset(id: string): Asset {
  return AssetSchema.parse({ version: 1, id, sha256: "a".repeat(64), mime: "image/png", byteSize: 1, vaultRef: id,
    width: 1, height: 1, frames: null, fps: null, audioSamples: null, sourceKind: "upload", sourceJobId: null, rightsStatus: "licensed", createdAt: 1 });
}

function approve(store: ReturnType<typeof openProductionStore>, kind: Approval["targetKind"], id: string, targetHash: string, approvalId: string, at: number) {
  store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: approvalId, targetKind: kind, targetId: id,
    targetHash, decision: "approved", actorId: "local-creator", createdAt: at, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] })));
}

/** One project with an approved story, a one-shot plan, an approved anchor, and one take job for shot "shot_0". */
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-reroll-")); directories.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  let n = 0;
  const serviceIds = { now: () => 100 + n, idFactory: () => `generated-${++n}` };
  const project = createProject(store, { name: "Reroll", profileId: "storybook-short-v1" }, serviceIds);
  const anchorImage = asset("fixture-anchor-image");
  store.transaction((tx) => tx.insertAsset({ asset: anchorImage, verifiedAt: 1, checksumVerified: true }));
  const location = createCanonRevision(store, { projectId: project.id, entityId: "room", expectedRevisionId: null, entityKind: "location", description: "Quiet room", attributes: {}, assetIds: [] }, serviceIds);
  const style = createCanonRevision(store, { projectId: project.id, entityId: "style", expectedRevisionId: null, entityKind: "style", description: "Paper cutout", attributes: {}, assetIds: [] }, serviceIds);
  const story = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: "A door opens.",
    beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [] }], canonRevisionIds: [location.id, style.id] }, serviceIds);
  approve(store, "story", story.id, story.contentHash, "story-approval", 10);
  const shotDraft: CreateShotPlanCommand["shots"][number] = { shotId: "shot_0", beatIds: ["beat_1"], visualIntent: "A door opens.",
    motionIntent: "Door opens slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id,
    framing: "wide", targetFrames: 124, continuation: null };
  const plan = createShotPlan(store, { projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash, shots: [shotDraft] },
    { now: () => 20, idFactory: () => `plan-${++n}`, maxShots: 10 });
  const shot = plan.shotRevisions[0]!;
  const anchorJob: ProductionJob = { version: 1, id: "fixture-anchor-job", projectId: project.id, operation: "anchor", status: "completed",
    idempotencyKey: "fixture-anchor-job-key", requestSnapshot: {}, requestHash: "b".repeat(64), providerId: "sogni", modelId: "image-model",
    providerRef: "fixture-anchor-ref", quoteId: "fixture-quote", receiptId: null, resultId: null, resultAssetIds: [anchorImage.id],
    leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 30, updatedAt: 30 };
  const anchor = { version: 1 as const, id: "fixture-anchor", shotRevisionId: shot.id, assetId: anchorImage.id, inputsHash: "c".repeat(64),
    jobId: anchorJob.id, visionAssessment: null, receiptId: null, createdAt: 40 };
  store.transaction((tx) => {
    tx.insertQuote(QuoteSchema.parse({ version: 1, id: "fixture-quote", projectId: project.id, providerId: "sogni", modelId: "video-model",
      operation: "take", inputHash: "d".repeat(64), entitlement: "subscription", estimateMinMinor: null, estimateMaxMinor: null, currency: null,
      expiresAt: 10_000, withinAuthorizedCap: "unknown", createdAt: 5 }));
    tx.insertJob(anchorJob, { id: "fixture-anchor-outbox", jobId: anchorJob.id, createdAt: 30, claimedAt: null, claimToken: null });
    tx.insertAnchor(anchor);
  });
  approve(store, "anchor", anchor.id, computeAnchorApprovalHash(store.read, anchor), "anchor-approval", 50);
  const snapshotBase = ProviderRequestSnapshotSchema.parse({ projectId: project.id, jobId: "fixture-take-job", idempotencyKey: "fixture-take-key",
    quoteId: "fixture-quote", providerId: "sogni", modelId: "video-model", prompt: "Door opens slowly.",
    inputs: [{ assetId: anchorImage.id, role: "start_frame", required: true }],
    parameters: { aspect: "9:16", frameCount: shot.targetFrames, seed: 0, providerAudioPolicy: "muted" },
    resultTarget: { kind: "take", shotRevisionId: shot.id, anchorId: anchor.id, anchorApprovalId: "anchor-approval", inputsHash: "a".repeat(64) },
    billingMode: "subscription" });
  const snapshot = ProviderRequestSnapshotSchema.parse({ ...snapshotBase, resultTarget: { ...snapshotBase.resultTarget!, inputsHash: computeProductionInputsHash(store.read, "take", snapshotBase) } });
  const takeJob: ProductionJob = { version: 1, id: "fixture-take-job", projectId: project.id, operation: "take", status: "completed",
    idempotencyKey: "fixture-take-key", requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: "sogni", modelId: "video-model",
    providerRef: "fixture-take-ref", quoteId: "fixture-quote", receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null,
    heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 60, updatedAt: 60 };
  store.transaction((tx) => tx.insertJob(takeJob, { id: "fixture-take-outbox", jobId: takeJob.id, createdAt: 60, claimedAt: null, claimToken: null }));
  return { store, project, shot, takeJob };
}

describe("continuity-guided re-roll", () => {
  it("derives a retryOf-linked take job carrying the guidance and enqueues it through the production queue", () => {
    const { store, project, shot, takeJob } = fixture();
    const guidance = { dimension: "environment" as const, note: "keep the lantern light and fog" };
    const result = enqueueGuidedReroll(store, { projectId: project.id, shotId: shot.shotId, guidance }, { now: () => 1000 });

    expect(result.created).toBe(true);
    expect(result.retryOf).toBe(takeJob.id);
    expect(result.job.id).toBe(`${takeJob.id}-retry-1`);
    expect(result.job.retryOf).toBe(takeJob.id);
    expect(result.job.idempotencyKey).toBe("fixture-take-key-retry-1");
    expect(result.job.operation).toBe("take");
    expect(result.job.status).toBe("queued");
    expect(result.job.attempt).toBe(0);
    expect(result.job.providerId).toBe("sogni");
    expect(result.job.modelId).toBe("video-model");
    expect(result.job.createdAt).toBe(1000);

    const stored = store.read.getJob(result.job.id);
    expect(stored).not.toBeNull();
    const snapshot = ProviderRequestSnapshotSchema.parse(stored!.requestSnapshot);
    expect(stored!.requestHash).toBe(hashCanonicalJson(stored!.requestSnapshot));
    expect(snapshot.jobId).toBe(result.job.id);
    expect(snapshot.idempotencyKey).toBe(result.job.idempotencyKey);
    expect(snapshot.prompt).toBe("Door opens slowly.\nContinuity guidance (environment): keep the lantern light and fog");
    expect(snapshot.parameters.continuityGuidance).toEqual({ dimension: "environment", note: "keep the lantern light and fog" });
    expect(snapshot.resultTarget?.kind).toBe("take");
    // The changed request is re-pinned: its inputs hash matches its own snapshot exactly like a first-run take.
    expect(snapshot.resultTarget && snapshot.resultTarget.kind === "take"
      ? snapshot.resultTarget.inputsHash : null).toBe(computeProductionInputsHash(store.read, "take", snapshot));

    // The job is claimable through the same outbox queue every take rides.
    const queue = new ProductionJobQueue(store, () => 2000);
    const claimed = queue.claimNext(2000);
    expect(claimed?.job.id).toBe(result.job.id);
  });

  it("chains retry ordinals so a second guided re-roll never reuses an idempotency key", () => {
    const { store, project, shot } = fixture();
    const first = enqueueGuidedReroll(store, { projectId: project.id, shotId: shot.shotId, guidance: { dimension: "lighting", note: "dusk instead of noon" } }, { now: () => 1000 });
    const second = enqueueGuidedReroll(store, { projectId: project.id, shotId: shot.shotId, guidance: { dimension: "identity", note: "same face, same scar" } }, { now: () => 1100 });
    // The latest take job after the first re-roll is the re-roll itself, so the chain derives from it.
    expect(first.job.idempotencyKey).toBe("fixture-take-key-retry-1");
    expect(second.job.retryOf).toBe(first.job.id);
    expect(second.job.idempotencyKey).toBe("fixture-take-key-retry-1-retry-2");
    const prompt = ProviderRequestSnapshotSchema.parse(second.job.requestSnapshot).prompt;
    expect(prompt).toContain(continuityGuidancePrompt({ dimension: "lighting", note: "dusk instead of noon" }));
    expect(prompt).toContain(continuityGuidancePrompt({ dimension: "identity", note: "same face, same scar" }));
  });

  it("fails closed with INVALID_INPUT and an actionable message when the shot has no take job", () => {
    const { store, project } = fixture();
    try {
      enqueueGuidedReroll(store, { projectId: project.id, shotId: "shot_never_planned", guidance: { dimension: "outfit", note: "same raincoat" } }, { now: () => 1000 });
      throw new Error("expected enqueueGuidedReroll to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionApplicationError);
      const applicationError = error as ProductionApplicationError;
      expect(applicationError.code).toBe("INVALID_INPUT");
      expect(applicationError.message).toMatch(/no take job to re-roll/i);
      expect(applicationError.action).toMatch(/storyboard/i);
      expect(applicationError.shotId).toBe("shot_never_planned");
    }
    expect(store.read.listProjectJobs(project.id).filter((job) => job.retryOf)).toEqual([]);
  });
});
