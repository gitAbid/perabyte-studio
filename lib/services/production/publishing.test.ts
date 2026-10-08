import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import {
  ApprovalSchema, AssetSchema, ExportSchema, JobSchema, TakeSchema,
  type Approval, type Asset, type CreateShotPlanCommand, type ExportRecord, type ProductionJob,
  type Project, type RenderManifest, type ShotRevision, type StoryRevision, type Take,
} from "../../production/contracts";
import { computeAnchorApprovalHash } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { derivePublicationPackage, hashPublicationPackage, resolvePublicationProfile } from "../../production/publishing";
import { createCanonRevision, createProject, createStoryRevision, getProjectReadModel } from "./revisions";
import { createShotPlan } from "./shot-plan";
import { compileManifest, createExportCommand } from "./manifest";
import { deriveProjectPublication } from "./publishing";

const dirs: string[] = [];
const stores: Array<SqliteProductionStore> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("Expected the publishing service operation to fail closed");
}
type ShotInput = CreateShotPlanCommand["shots"][number];
const SHOT_TARGET_FRAMES = 24;
const shotInput = (shotId: string, visualIntent: string, locationId: string, styleId: string, framing: ShotInput["framing"] = "wide"): ShotInput =>
  ({ shotId, beatIds: ["beat_1"], visualIntent, motionIntent: `${visualIntent} slowly.`, castBindings: [], locationRevisionId: locationId, propRevisionIds: [], styleRevisionId: styleId, framing, targetFrames: SHOT_TARGET_FRAMES, continuation: null });

interface Fixture {
  store: SqliteProductionStore;
  project: Project;
  story: StoryRevision;
  shotRevisions: ShotRevision[];
  takes: Take[];
  assets: Asset[];
  manifest: RenderManifest;
  exportRecord: ExportRecord;
  selectionVersion: () => number;
  createTake: (shot: ShotRevision, takeId: string, select: boolean) => { take: Take; asset: Asset };
  approve: (kind: Approval["targetKind"], targetId: string, targetHash: string, id: string, at?: number, decision?: Approval["decision"]) => void;
  advanceExport: (exportId: string, status: Extract<ExportRecord["status"], "ready_for_review" | "approved"> | null) => void;
}
function fixture(options: { exportStatus?: Extract<ExportRecord["status"], "ready_for_review" | "approved"> | null } = {}): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-publishing-fixture-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  let n = 0; let now = 100;
  const idFactory = () => `fixture-${++n}`;
  const clock = () => ++now;
  const project = createProject(store, { name: "The Lantern Fox", profileId: "storybook-short-v1" }, { now: clock, idFactory });
  const location = createCanonRevision(store, { projectId: project.id, entityId: "room", expectedRevisionId: null, entityKind: "location", description: "Quiet room", attributes: {}, assetIds: [] }, { now: clock, idFactory });
  const style = createCanonRevision(store, { projectId: project.id, entityId: "look", expectedRevisionId: null, entityKind: "style", description: "Paper cutout", attributes: {}, assetIds: [] }, { now: clock, idFactory });
  const story = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: "A door opens.", beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [] }], canonRevisionIds: [location.id, style.id] }, { now: clock, idFactory });
  const approve = (kind: Approval["targetKind"], targetId: string, targetHash: string, id: string, at = clock(), decision: Approval["decision"] = "approved") =>
    store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id, targetKind: kind, targetId, targetHash, decision, actorId: "local-creator", createdAt: at, checklist: [{ id: "review", passed: decision === "approved", note: "Fixture review" }], notes: decision === "rejected" ? "Fixture rejection" : "", advisoryAcknowledgements: [] })));
  approve("story", story.id, story.contentHash, "story-approval");
  const planned = createShotPlan(store, { projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash, shots: [shotInput("shot_0", "A door opens.", location.id, style.id), shotInput("shot_1", "Rain begins.", location.id, style.id, "close")] }, { now: clock, maxShots: 10, idFactory });
  approve("animatic", planned.animaticRevision.id, planned.animaticRevision.contentHash, "animatic-approval");

  const anchorAsset = AssetSchema.parse({ version: 1, id: "anchor-asset", sha256: hashCanonicalJson({ fixture: "anchor-asset" }), mime: "image/png", byteSize: 1024, vaultRef: "vault-anchor", width: null, height: null, frames: null, fps: null, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: clock() });
  const anchorJob: ProductionJob = JobSchema.parse({ version: 1, id: "anchor-job", projectId: project.id, operation: "anchor", status: "queued", idempotencyKey: "anchor-job-key", requestSnapshot: {}, requestHash: hashCanonicalJson({ fixture: "anchor-job" }), providerId: "sogni", modelId: "image-model", providerRef: "anchor-job-ref", quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: clock(), updatedAt: clock() });
  store.transaction((tx) => { tx.insertAsset({ asset: anchorAsset, verifiedAt: clock(), checksumVerified: true }); tx.insertJob(anchorJob, { id: "anchor-job-outbox", jobId: anchorJob.id, createdAt: anchorJob.createdAt, claimedAt: null, claimToken: null }); });

  let selectionVersion = project.takeSelectionVersion;
  let ordinal = 0;
  const createTake = (shot: ShotRevision, takeId: string, select: boolean): { take: Take; asset: Asset } => {
    const asset = AssetSchema.parse({ version: 1, id: `${takeId}-asset`, sha256: hashCanonicalJson({ fixture: takeId }), mime: "video/mp4", byteSize: 8192, vaultRef: `vault-take-${++ordinal}`, width: 540, height: 960, frames: 48, fps: 24, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: clock() });
    const anchor = { version: 1 as const, id: `anchor-${++ordinal}`, shotRevisionId: shot.id, assetId: anchorAsset.id, inputsHash: hashCanonicalJson({ fixture: `${takeId}-anchor` }), jobId: anchorJob.id, visionAssessment: null, receiptId: null, createdAt: clock() };
    const job: ProductionJob = JobSchema.parse({ version: 1, id: `${takeId}-job`, projectId: project.id, operation: "take", status: "queued", idempotencyKey: `${takeId}-job-key`, requestSnapshot: {}, requestHash: hashCanonicalJson({ fixture: `${takeId}-job` }), providerId: "sogni", modelId: "video-model", providerRef: `${takeId}-job-ref`, quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: clock(), updatedAt: clock() });
    const receipt = { version: 1 as const, id: `${takeId}-job-receipt`, jobId: job.id, capabilityProvenance: "sdk_contract" as const, capabilityObservedAt: job.createdAt, inputs: [{ role: "start_frame", assetId: anchorAsset.id, required: true, state: "mapped" as const, providerField: "start_frame", disclosedOmission: null }], createdAt: job.createdAt };
    const take = TakeSchema.parse({ version: 1, id: takeId, shotRevisionId: shot.id, anchorId: anchor.id, approvalId: `${anchor.id}-approval`, jobId: job.id, assetId: asset.id, actualFrames: 48, inputsHash: hashCanonicalJson({ fixture: `${takeId}-inputs` }), receiptId: receipt.id, createdAt: clock() });
    store.transaction((tx) => {
      tx.insertAsset({ asset, verifiedAt: clock(), checksumVerified: true });
      tx.insertJob(job, { id: `${job.id}-outbox`, jobId: job.id, createdAt: job.createdAt, claimedAt: null, claimToken: null });
      tx.insertHonoredInputsReceipt(receipt);
      tx.insertAnchor(anchor);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `${anchor.id}-approval`, targetKind: "anchor", targetId: anchor.id, targetHash: computeAnchorApprovalHash(tx, anchor), decision: "approved", actorId: "local-creator", createdAt: clock(), checklist: [{ id: "review", passed: true, note: "Fixture review" }], notes: "", advisoryAcknowledgements: [] }));
      tx.insertTake(take);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `${takeId}-approval`, targetKind: "take", targetId: take.id, targetHash: computeTakeApprovalHash(tx, take), decision: "approved", actorId: "local-creator", createdAt: clock(), checklist: [{ id: "review", passed: true, note: "Fixture review" }], notes: "", advisoryAcknowledgements: [] }));
    });
    if (select) { expect(store.transaction((tx) => tx.compareAndSetSelectedTake(project.id, shot.shotId, take.id, selectionVersion))).toBe(true); selectionVersion += 1; }
    return { take, asset };
  };
  const created = planned.shotRevisions.map((shot, index) => createTake(shot, `take-${index}`, true));
  const takes = created.map(({ take }) => take);
  const assets = created.map(({ asset }) => asset);
  const { manifest } = compileManifest(store, { projectId: project.id, shotPlanRevisionId: planned.shotPlanRevision.id, animaticRevisionId: planned.animaticRevision.id, audioMixRevisionId: null, selectedTakeIds: takes.map((take) => take.id), profileId: project.profileId, expectedSelectionVersion: selectionVersion }, { now: clock });
  const { exportRecord } = createExportCommand(store, { projectId: project.id, manifestId: manifest.id, expectedManifestHash: manifest.inputsHash, idempotencyKey: "publish-export" }, { now: clock });
  const advanceExport = (exportId: string, status: Extract<ExportRecord["status"], "ready_for_review" | "approved"> | null) => {
    if (status === null) return;
    for (const next of ["rendering", "qc_pending", "ready_for_review", "approved"]) {
      store.transaction((tx) => {
        const current = tx.getExport(exportId)!;
        const updated = status === "approved" && next === "approved"
          ? ExportSchema.parse({ ...current, status: next, assetId: "final-asset", qcReportId: "qc-report", approvedSha256: hashCanonicalJson({ fixture: `final:${exportId}` }), finalApprovalId: "final-approval" })
          : ExportSchema.parse({ ...current, status: next });
        if (!tx.compareAndSetExport(updated, current.status)) throw new Error("Fixture export transition was not committed");
      });
      if (next === status) return;
    }
    throw new Error(`Fixture export could not reach status ${status}`);
  };
  advanceExport(exportRecord.id, options.exportStatus === undefined ? "ready_for_review" : options.exportStatus);
  return { store, project, story, shotRevisions: planned.shotRevisions, takes, assets, manifest, exportRecord: store.read.getExport(exportRecord.id)!, selectionVersion: () => selectionVersion, createTake, approve, advanceExport };
}

describe("C17 publishing service", () => {
  it("derives a publication package from an approved-export project through the read model", () => {
    for (const exportStatus of ["ready_for_review", "approved"] as const) {
      const f = fixture({ exportStatus });
      const pkg = deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "documentary-publication-v1" });
      expect(pkg.schemaVersion).toBe(1);
      expect(pkg.projectId).toBe(f.project.id);
      expect(pkg.profileId).toBe("documentary-publication-v1");
      expect(pkg.basis.exportId).toBe(f.exportRecord.id);
      expect(pkg.basis.exportStatus).toBe(exportStatus);
      expect(pkg.basis.manifestId).toBe(f.manifest.id);
      expect(pkg.title.text).toBe("The Lantern Fox — Documentary");
      expect(pkg.description.sections.map((section) => section.id)).toEqual(["synopsis", "chapters", "sources"]);
      expect(pkg.reelPlan.clips.map((clip) => clip.takeId)).toEqual(f.takes.map((take) => take.id));
      expect(pkg.reelPlan.clips.map((clip) => clip.assetId)).toEqual(f.assets.map((asset) => asset.id));
      expect(pkg.reelPlan.clips.map((clip) => clip.durationFrames)).toEqual([SHOT_TARGET_FRAMES, SHOT_TARGET_FRAMES]);
      expect(pkg.uploadChecklist.alteredSyntheticDisclosure.value).toBeNull();
      // Deterministic across repeated calls and identical to the pure derivation over the same read model.
      const again = deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "documentary-publication-v1" });
      expect(again).toEqual(pkg);
      expect(hashPublicationPackage(again)).toBe(hashPublicationPackage(pkg));
      const pure = derivePublicationPackage(getProjectReadModel(f.store, f.project.id), resolvePublicationProfile("documentary-publication-v1"));
      expect(pure).toEqual(pkg);
    }
  });

  it("accepts an injected catalog and rejects unknown profiles and missing projects", () => {
    const f = fixture();
    const custom = { id: "horror-publication-v1", title: { template: "{projectName}", maxLength: 80 }, descriptionSections: [{ id: "synopsis", heading: "Synopsis", source: "derived_summary" as const }], disclosureGuidance: "Decide and record the disclosure outcome; no default is provided.", reel: { maxClips: 100, ordering: "shot_plan_order" as const }, thumbnails: { candidateLimit: 1 } };
    const pkg = deriveProjectPublication(f.store, { projectId: f.project.id, profileId: custom.id }, { catalog: [custom] });
    expect(pkg.profileId).toBe(custom.id);
    expect(pkg.thumbnailCandidates).toHaveLength(1);
    expect(failOf(() => deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "missing-publication-v1" })).code).toBe("INVALID_INPUT");
    expect(failOf(() => deriveProjectPublication(f.store, { projectId: "no-such-project", profileId: "mythology-publication-v1" })).code).toBe("UNKNOWN_REFERENCE");
    expect(failOf(() => deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "bad id!" })).code).toBe("INVALID_INPUT");
  });

  it("refuses when the project has no gate-passing export", () => {
    const f = fixture({ exportStatus: null });
    const error = failOf(() => deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "mythology-publication-v1" }));
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toMatch(/ready_for_review|approved/);
  });

  it("refuses when an active selection drifts from the approved export manifest", () => {
    const f = fixture();
    f.createTake(f.shotRevisions[1]!, "take-drift", true);
    const error = failOf(() => deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "mythology-publication-v1" }));
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toMatch(/Approved export/);
  });

  it("refuses when the latest take decision is a rejection after export", () => {
    const f = fixture();
    f.approve("take", f.takes[0]!.id, computeTakeApprovalHash(f.store.read, f.takes[0]!), "later-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    const error = failOf(() => deriveProjectPublication(f.store, { projectId: f.project.id, profileId: "mythology-publication-v1" }));
    expect(error.code).toBe("APPROVAL_REQUIRED");
  });
});
