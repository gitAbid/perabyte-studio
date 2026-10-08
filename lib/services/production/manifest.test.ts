import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createExportAssemblyScheduler, type AssembleManifestOptions, type AssemblyOutput } from "../../media/production/assembly";
import { createExportCommand, createExportRouteHandlers, createManifestRouteHandlers } from "./manifest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import {
  AnimaticRevisionSchema, ApprovalSchema, AssetSchema, AudioCueSchema, JobSchema, ManifestShotSchema,
  ProjectSchema, RenderManifestSchema, ShotPlanRevisionSchema, ShotRevisionSchema, StoryRevisionSchema, TakeSchema,
  type Approval, type Asset, type CreateExportCommand, type CreateManifestCommand, type CreateShotPlanCommand,
  type ExportRecord, type ProductionJob, type Project, type RenderManifest, type ShotRevision,
  type StoryRevision, type Take,
} from "../../production/contracts";
import { computeAnchorApprovalHash } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import {
  MANIFEST_MASTERING_RECIPE_VERSION, buildRenderProfile, manifestInputsHash,
  type ManifestCompileModel,
} from "../../production/manifest";
import type { ProductionStore } from "../../repositories/production/ports";
import { createCanonRevision, createProject, createStoryRevision } from "./revisions";
import { createShotPlan } from "./shot-plan";
import { saveAudioMix } from "./audio";
import { compileManifest } from "./manifest";

const dirs: string[] = [];
const stores: Array<SqliteProductionStore> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
function manifestCount(dataDir: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='manifest'").get() as { count: number }).count; } finally { db.close(); }
}
function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("Expected the fixture operation to fail closed");
}
type ShotInput = CreateShotPlanCommand["shots"][number];
const SHOT_TARGET_FRAMES = 24;
const shotInput = (shotId: string, visualIntent: string, locationId: string, styleId: string, framing: ShotInput["framing"] = "wide"): ShotInput =>
  ({ shotId, beatIds: ["beat_1"], visualIntent, motionIntent: `${visualIntent} slowly.`, castBindings: [], locationRevisionId: locationId, propRevisionIds: [], styleRevisionId: styleId, framing, targetFrames: SHOT_TARGET_FRAMES, continuation: null });

interface Fixture {
  store: SqliteProductionStore;
  project: Project;
  story: StoryRevision;
  planned: ReturnType<typeof createShotPlan>;
  takes: Take[];
  assets: Asset[];
  mixId: string;
  command: CreateManifestCommand;
  approve: (kind: Approval["targetKind"], targetId: string, targetHash: string, id: string, at?: number, decision?: Approval["decision"]) => void;
  createTake: (shot: ShotRevision, takeId: string, select: boolean) => { take: Take; asset: Asset };
  clock: () => number;
  dataDir: string;
  selectionVersion: () => number;
}
function fixture(options: { approveAudioMix?: boolean; assetFrames?: number; withDimensions?: boolean } = {}): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-manifest-fixture-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  let n = 0; let now = 100;
  const idFactory = () => `fixture-${++n}`;
  const clock = () => ++now;
  const project = createProject(store, { name: "Manifest Fixture", profileId: "storybook-short-v1" }, { now: clock, idFactory });
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
    const asset = AssetSchema.parse({ version: 1, id: `${takeId}-asset`, sha256: hashCanonicalJson({ fixture: takeId }), mime: "video/mp4", byteSize: 8192, vaultRef: `vault-${++ordinal}`, width: options.withDimensions === false ? null : 540, height: options.withDimensions === false ? null : 960, frames: options.assetFrames ?? 48, fps: 24, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: clock() });
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
    // Complete the take job in a second transaction now that its receipt and result asset exist.
    store.transaction((tx) => {
      const at = Date.now();
      const lease = { jobId: job.id, leaseToken: `${job.id}-lease`, leaseUntil: at + 60_000, heartbeatAt: at };
      if (!tx.claimJob(job.id, at, lease)) throw new Error("Fixture job lease was not acquired");
      const current = tx.getJob(job.id)!;
      if (!tx.updateLeasedJob({ ...current, status: "completed", receiptId: receipt.id, resultAssetIds: [asset.id], updatedAt: at }, lease.leaseToken)) throw new Error("Fixture job completion was not committed");
    });
    if (select) { expect(store.transaction((tx) => tx.compareAndSetSelectedTake(project.id, shot.shotId, take.id, selectionVersion))).toBe(true); selectionVersion += 1; }
    return { take, asset };
  };
  const created = planned.shotRevisions.map((shot, index) => createTake(shot, `take-${index}`, true));
  const takes = created.map(({ take }) => take);
  const assets = created.map(({ asset }) => asset);

  const audioAsset = AssetSchema.parse({ version: 1, id: "audio-asset", sha256: hashCanonicalJson({ fixture: "audio-asset" }), mime: "audio/wav", byteSize: 4096, vaultRef: "vault-audio", width: null, height: null, frames: null, fps: null, audioSamples: 192_000, sourceKind: "upload", sourceJobId: null, rightsStatus: "creator_attested", createdAt: clock() });
  store.transaction((tx) => tx.insertAsset({ asset: audioAsset, verifiedAt: clock(), checksumVerified: true }));
  const mix = saveAudioMix(store, {
    projectId: project.id, expectedAudioVersion: 0, expectedStoryRevisionId: story.id,
    cues: [{ assetId: audioAsset.id, sourceStartSample: 0, sourceEndSample: 96_000, timelineStartSample: 0, gainDb: -22, role: "music", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested" }],
    mixSettings: { sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true },
  }, { now: clock });
  if (options.approveAudioMix !== false) approve("audio", mix.revision.id, mix.revision.contentHash, "audio-mix-approval");

  const command: CreateManifestCommand = {
    projectId: project.id, shotPlanRevisionId: planned.shotPlanRevision.id, animaticRevisionId: planned.animaticRevision.id,
    audioMixRevisionId: mix.revision.id, selectedTakeIds: takes.map((take) => take.id),
    profileId: project.profileId, expectedSelectionVersion: selectionVersion,
  };
  return { store, project, story, planned, takes, assets, mixId: mix.revision.id, command, approve, createTake, clock, dataDir, selectionVersion: () => selectionVersion };
}

describe("C11-PRE manifest compiler service", () => {
  it("pins only accepted matching selections and persists a manifest readable after reopen", () => {
    const f = fixture();
    const { manifest, created } = compileManifest(f.store, f.command, { now: () => 9_000 });
    expect(created).toBe(true);
    expect(manifest.version).toBe(1);
    expect(manifest.id).toBe(`manifest-${manifest.inputsHash}`);
    expect(manifest.createdAt).toBe(9_000);
    expect(manifest.storyRevisionId).toBe(f.story.id);
    expect(manifest.shotPlanRevisionId).toBe(f.planned.shotPlanRevision.id);
    expect(manifest.animaticRevisionId).toBe(f.planned.animaticRevision.id);
    expect(manifest.audioMixRevisionId).toBe(f.mixId);
    expect(manifest.shots.map((shot) => shot.shotRevisionId)).toEqual(f.planned.shotRevisions.map((shot) => shot.id));
    expect(manifest.shots.map((shot) => shot.takeId)).toEqual(f.takes.map((take) => take.id));
    expect(manifest.shots.map((shot) => shot.assetId)).toEqual(f.assets.map((asset) => asset.id));
    for (const shot of manifest.shots) {
      expect(shot.startFrame).toBe(0);
      expect(shot.endFrame).toBe(SHOT_TARGET_FRAMES);
      expect(shot.transition).toBe("cut");
      expect(shot.crop).toEqual({ x: 0, y: 0, width: 540, height: 960 });
    }
    expect(manifest.profile).toEqual({ id: "render-profile-storybook-short-v1", version: 1, aspect: "9:16", width: 1080, height: 1920, fps: 24, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", sampleRate: 48_000 });
    expect(manifest.captionCues).toEqual([]);
    expect(manifest.audioCues.map((cue) => cue.id)).toEqual(f.store.read.getAudioMixRevision(f.mixId)!.cues.map((cue) => cue.id));
    expect(manifest.audioCues[0]!.assetId).toBe("audio-asset");

    const model: ManifestCompileModel = {
      projectId: f.project.id, storyRevisionId: f.story.id, storyHash: f.story.contentHash,
      shotPlanRevisionId: f.planned.shotPlanRevision.id, shotPlanHash: f.planned.shotPlanRevision.contentHash,
      animaticRevisionId: f.planned.animaticRevision.id, animaticHash: f.store.read.getAnimaticRevision(f.planned.animaticRevision.id)!.contentHash,
      audioMixRevisionId: f.mixId, audioMixHash: f.store.read.getAudioMixRevision(f.mixId)!.contentHash,
      profile: buildRenderProfile(f.project.profile),
      shots: f.planned.shotRevisions.map((shot, index) => ({
        shotRevisionId: shot.id, shotHash: shot.contentHash, takeId: f.takes[index]!.id, takeInputsHash: f.takes[index]!.inputsHash,
        assetId: f.assets[index]!.id, assetSha256: f.assets[index]!.sha256, assetWidth: 540, assetHeight: 960,
        actualFrames: 48, startFrame: 0, endFrame: SHOT_TARGET_FRAMES, crop: { x: 0, y: 0, width: 540, height: 960 }, transition: "cut" as const,
      })),
      audioCues: f.store.read.getAudioMixRevision(f.mixId)!.cues, captionCues: [],
      totalFrames: 2 * SHOT_TARGET_FRAMES, totalAudioSamples: 2 * SHOT_TARGET_FRAMES * 2000,
      selectionVersion: f.selectionVersion(), masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
    };
    expect(manifest.inputsHash).toBe(manifestInputsHash(model));

    const reopened = openProductionStore({ dataDir: f.dataDir }); stores.push(reopened);
    expect(reopened.read.getManifest(manifest.id)).toEqual(manifest);
  });

  it("rejects a stale selection CAS and leaves the manifest count unchanged", () => {
    const f = fixture();
    const before = manifestCount(f.dataDir);
    const stale = failOf(() => compileManifest(f.store, { ...f.command, expectedSelectionVersion: f.selectionVersion() - 1 }));
    expect(stale.code).toBe("STALE_REVISION");
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("rejects command take sets that drift from the current selection set", () => {
    const f = fixture();
    const spare = f.createTake(f.planned.shotRevisions[1]!, "take-spare", false);
    expect(spare.take.id).toBe("take-spare");
    const before = manifestCount(f.dataDir);
    const substitution = failOf(() => compileManifest(f.store, { ...f.command, selectedTakeIds: [f.takes[0]!.id, spare.take.id] }));
    expect(substitution.code).toBe("STALE_REVISION");
    const missing = failOf(() => compileManifest(f.store, { ...f.command, selectedTakeIds: [f.takes[0]!.id] }));
    expect(missing.code).toBe("STALE_REVISION");
    const superset = failOf(() => compileManifest(f.store, { ...f.command, selectedTakeIds: [f.takes[0]!.id, f.takes[1]!.id, spare.take.id] }));
    expect(superset.code).toBe("STALE_REVISION");
    const duplicate = failOf(() => compileManifest(f.store, { ...f.command, selectedTakeIds: [f.takes[0]!.id, f.takes[0]!.id, f.takes[1]!.id] }));
    expect(duplicate.code).toBe("INVALID_INPUT");
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("rejects a take whose latest decision is a later rejection", () => {
    const f = fixture();
    const before = manifestCount(f.dataDir);
    const take = f.takes[1]!;
    f.approve("take", take.id, computeTakeApprovalHash(f.store.read, take), "take-1-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    const error = failOf(() => compileManifest(f.store, f.command));
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toMatch(/take-1/);
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("rejects missing or stale audio-mix approvals", () => {
    const unapproved = fixture({ approveAudioMix: false });
    const beforeUnapproved = manifestCount(unapproved.dataDir);
    expect(failOf(() => compileManifest(unapproved.store, unapproved.command)).code).toBe("APPROVAL_REQUIRED");
    expect(manifestCount(unapproved.dataDir)).toBe(beforeUnapproved);

    const f = fixture();
    const before = manifestCount(f.dataDir);
    f.approve("audio", f.mixId, f.store.read.getAudioMixRevision(f.mixId)!.contentHash, "audio-mix-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    expect(failOf(() => compileManifest(f.store, f.command)).code).toBe("APPROVAL_REQUIRED");
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("rejects a mix bound to a different story revision", () => {
    const f = fixture();
    const before = manifestCount(f.dataDir);
    const foreignStory = StoryRevisionSchema.parse({ version: 1, id: "story-foreign", projectId: f.project.id, parentRevisionId: null, scriptText: "Unrelated script.", beats: [{ id: "beat_1", action: "Unrelated action.", narration: "", dialogue: [], order: 0 }], canonRevisionIds: [], contentHash: hashCanonicalJson({ fixture: "story-foreign" }), createdAt: f.clock() });
    const mix = f.store.read.getAudioMixRevision(f.mixId)!;
    const foreignMix = { ...mix, id: "audio-mix-foreign", storyRevisionId: foreignStory.id, contentHash: hashCanonicalJson({ fixture: "audio-mix-foreign" }) };
    f.store.transaction((tx) => {
      tx.insertStoryRevision(foreignStory);
      tx.insertAudioMixRevision(foreignMix);
      const project = tx.getProject(f.project.id)!;
      if (!tx.compareAndSetAudioMix(f.project.id, foreignMix.id, project.audioMixVersion)) throw new Error("Fixture mix selection failed");
    });
    const error = failOf(() => compileManifest(f.store, { ...f.command, audioMixRevisionId: foreignMix.id }));
    expect(error.code).toBe("STALE_REVISION");
    expect(error.message).toMatch(/audio-mix-foreign/);
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("rejects media that contradicts the take", () => {
    const shortFramed = fixture({ assetFrames: 47 });
    const beforeFramed = manifestCount(shortFramed.dataDir);
    const framesError = failOf(() => compileManifest(shortFramed.store, shortFramed.command));
    expect(framesError.code).toBe("MEDIA_UNAVAILABLE");
    expect(framesError.message).toMatch(/take-0/);
    expect(manifestCount(shortFramed.dataDir)).toBe(beforeFramed);

    const dimensionless = fixture({ withDimensions: false });
    const beforeDims = manifestCount(dimensionless.dataDir);
    expect(failOf(() => compileManifest(dimensionless.store, dimensionless.command)).code).toBe("MEDIA_UNAVAILABLE");
    expect(manifestCount(dimensionless.dataDir)).toBe(beforeDims);
  });

  it("rejects a selected take bound to a shot revision outside the selected plan", () => {
    const f = fixture();
    const before = manifestCount(f.dataDir);
    const outsideTake = TakeSchema.parse({ version: 1, id: "take-outside", shotRevisionId: f.planned.shotRevisions[1]!.id, anchorId: f.takes[0]!.anchorId, approvalId: f.takes[0]!.approvalId, jobId: "anchor-job", assetId: "anchor-asset", actualFrames: 48, inputsHash: hashCanonicalJson({ fixture: "take-outside" }), receiptId: f.takes[0]!.receiptId, createdAt: f.clock() });
    f.store.transaction((tx) => tx.insertTake(outsideTake));
    expect(f.store.transaction((tx) => tx.compareAndSetSelectedTake(f.project.id, "shot_0", outsideTake.id, f.selectionVersion()))).toBe(true);
    const liveSelectionVersion = f.store.read.getProject(f.project.id)!.takeSelectionVersion;
    const error = failOf(() => compileManifest(f.store, { ...f.command, selectedTakeIds: [outsideTake.id, f.takes[1]!.id], expectedSelectionVersion: liveSelectionVersion }));
    expect(error.code).toBe("STALE_REVISION");
    expect(error.message).toMatch(/take-outside/);
    expect(manifestCount(f.dataDir)).toBe(before);
  });

  it("recompiles identically and enforces canon-only successor compatibility", () => {
    const f = fixture();
    const first = compileManifest(f.store, f.command, { now: () => 9_000 });
    expect(first.created).toBe(true);
    const replay = compileManifest(f.store, f.command, { now: () => 10_000 });
    expect(replay.created).toBe(false);
    expect(replay.manifest).toEqual(first.manifest);
    expect(replay.manifest.inputsHash).toBe(first.manifest.inputsHash);

    // Canon-only successor: a newly pinned prop while script and beats stay identical. The shot
    // revisions are compatible, so the successor plan reuses them and the compiler accepts it.
    let successorIds = 0;
    const prop = createCanonRevision(f.store, { projectId: f.project.id, entityId: "texture", expectedRevisionId: null, entityKind: "prop", description: "Extra surface texture", attributes: {}, assetIds: [] }, { now: f.clock, idFactory: () => `successor-${++successorIds}` });
    const successorStory = createStoryRevision(f.store, { projectId: f.project.id, expectedStoryRevisionId: f.story.id, scriptText: "A door opens.", beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [] }], canonRevisionIds: [f.store.read.getStoryRevision(f.story.id)!.canonRevisionIds[0]!, f.store.read.getStoryRevision(f.story.id)!.canonRevisionIds[1]!, prop.id] }, { now: f.clock, idFactory: () => `successor-${++successorIds}` });
    expect(successorStory.parentRevisionId).toBe(f.story.id);
    expect(successorStory.id).not.toBe(f.story.id);
    f.approve("story", successorStory.id, successorStory.contentHash, "successor-story-approval");
    const successorPlan = createShotPlan(f.store, { projectId: f.project.id, storyRevisionId: successorStory.id, approvedStoryHash: successorStory.contentHash, shots: [shotInput("shot_0", "A door opens.", successorStory.canonRevisionIds[0]!, successorStory.canonRevisionIds[1]!), shotInput("shot_1", "Rain begins.", successorStory.canonRevisionIds[0]!, successorStory.canonRevisionIds[1]!, "close")] }, { now: f.clock, maxShots: 10, idFactory: () => `successor-${++successorIds}` });
    expect(successorPlan.shotRevisions.map((shot) => shot.id)).toEqual(f.planned.shotRevisions.map((shot) => shot.id));
    f.approve("animatic", successorPlan.animaticRevision.id, successorPlan.animaticRevision.contentHash, "successor-animatic-approval");
    const successorCompile = compileManifest(f.store, { ...f.command, shotPlanRevisionId: successorPlan.shotPlanRevision.id, animaticRevisionId: successorPlan.animaticRevision.id, audioMixRevisionId: null });
    expect(successorCompile.created).toBe(true);
    expect(successorCompile.manifest.storyRevisionId).toBe(successorStory.id);
    expect(successorCompile.manifest.shots.map((shot) => shot.takeId)).toEqual(f.takes.map((take) => take.id));

    // A changed-script successor on the same shots breaks shot compatibility: approval required, no writes.
    const changedStory = createStoryRevision(f.store, { projectId: f.project.id, expectedStoryRevisionId: successorStory.id, scriptText: "A door slams.", beats: [{ id: "beat_1", action: "A door slams.", narration: "", dialogue: [] }], canonRevisionIds: successorStory.canonRevisionIds }, { now: f.clock, idFactory: () => `successor-${++successorIds}` });
    f.approve("story", changedStory.id, changedStory.contentHash, "changed-story-approval");
    const before = manifestCount(f.dataDir);
    const changedPlan = ShotPlanRevisionSchema.parse({ version: 1, id: "plan-changed", projectId: f.project.id, storyRevisionId: changedStory.id, orderedShotRevisionIds: f.planned.shotPlanRevision.orderedShotRevisionIds, beatCoverage: f.planned.shotPlanRevision.beatCoverage, contentHash: hashCanonicalJson({ fixture: "plan-changed" }), createdAt: f.clock() });
    const changedAnimatic = AnimaticRevisionSchema.parse({ version: 1, id: "animatic-changed", projectId: f.project.id, shotPlanRevisionId: changedPlan.id, slots: successorPlan.animaticRevision.slots, timingAnnotations: successorPlan.animaticRevision.timingAnnotations, totalFrames: successorPlan.animaticRevision.totalFrames, contentHash: hashCanonicalJson({ fixture: "animatic-changed" }), createdAt: f.clock() });
    f.store.transaction((tx) => {
      tx.insertShotPlanRevision(changedPlan);
      tx.insertAnimaticRevision(changedAnimatic);
      const current = tx.getProject(f.project.id)!;
      const next = ProjectSchema.parse({ ...current, activeStoryRevisionId: changedStory.id, activeShotPlanRevisionId: changedPlan.id, activeAnimaticRevisionId: changedAnimatic.id, updatedAt: f.clock(), saveVersion: current.saveVersion + 1 });
      if (!tx.compareAndSetProject(next, current.saveVersion)) throw new Error("Fixture project CAS failed");
    });
    f.approve("animatic", changedAnimatic.id, changedAnimatic.contentHash, "changed-animatic-approval");
    const changedError = failOf(() => compileManifest(f.store, { ...f.command, shotPlanRevisionId: changedPlan.id, animaticRevisionId: changedAnimatic.id, audioMixRevisionId: null }));
    expect(changedError.code).toBe("APPROVAL_REQUIRED");
    expect(changedError.message).toMatch(new RegExp(f.planned.shotRevisions[0]!.id));
    expect(manifestCount(f.dataDir)).toBe(before);
  });
});

describe("C11-FULL manifest and export route handlers", () => {
  const ORIGIN = "http://localhost";
  const request = (path: string, body: unknown) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

  function handlerFixture() {
    const f = fixture();
    const triggered: string[] = [];
    const withStore = async <T,>(work: (store: ProductionStore) => T | Promise<T>): Promise<T> => work(f.store);
    const manifestHandlers = createManifestRouteHandlers({ withStore, serviceOptions: { now: () => 9_000 } });
    const exportHandlers = createExportRouteHandlers({ withStore, scheduler: { trigger: (projectId) => triggered.push(projectId) }, serviceOptions: { now: () => 10_000 } });
    const postManifest = (command: CreateManifestCommand) =>
      manifestHandlers.POST(request(`/api/production/projects/${f.project.id}/manifests`, command), { params: Promise.resolve({ projectId: f.project.id }) });
    const postExport = (command: CreateExportCommand) =>
      exportHandlers.POST(request(`/api/production/projects/${f.project.id}/exports`, command), { params: Promise.resolve({ projectId: f.project.id }) });
    return { f, triggered, postManifest, postExport };
  }
  const exportCommandFor = (projectId: string, manifest: RenderManifest, idempotencyKey: string): CreateExportCommand =>
    ({ projectId, manifestId: manifest.id, expectedManifestHash: manifest.inputsHash, idempotencyKey });

  it("POST manifests compiles with 201 then replays 200 created:false", async () => {
    const { f, postManifest } = handlerFixture();
    const first = await postManifest(f.command);
    expect(first.status).toBe(201);
    const body = (await first.json()) as { manifest: RenderManifest; created: boolean };
    expect(body.created).toBe(true);
    expect(body.manifest.id).toBe(`manifest-${body.manifest.inputsHash}`);
    expect(body.manifest.createdAt).toBe(9_000);
    expect(f.store.read.getManifest(body.manifest.id)).toEqual(body.manifest);
    const replay = await postManifest(f.command);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { created: boolean }).created).toBe(false);
  });

  it("POST exports queues a durable export with a deterministic id and stays idempotent", async () => {
    const { f, triggered, postManifest, postExport } = handlerFixture();
    const { manifest } = compileManifest(f.store, f.command, { now: () => 9_000 });
    const command = exportCommandFor(f.project.id, manifest, "key-1");
    const response = await postExport(command);
    expect(response.status).toBe(202);
    const record = (await response.json()) as ExportRecord;
    expect(record).toMatchObject({ version: 1, id: `export-${hashCanonicalJson({ recipe: 1, projectId: f.project.id, idempotencyKey: "key-1" })}`, manifestId: manifest.id, jobId: null, assetId: null, qcReportId: null, status: "queued", approvedSha256: null, finalApprovalId: null });
    expect(f.store.read.getExport(record.id)).toEqual(record);
    expect(triggered).toEqual([f.project.id]);

    const replay = await postExport(command);
    expect(replay.status).toBe(200);
    expect((await replay.json()) as ExportRecord).toEqual(record);
    expect(triggered).toEqual([f.project.id, f.project.id]);

    const differentManifest = compileManifest(f.store, { ...f.command, audioMixRevisionId: null }, { now: () => 11_000 }).manifest;
    expect(differentManifest.id).not.toBe(manifest.id);
    const conflict = await postExport(exportCommandFor(f.project.id, differentManifest, "key-1"));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("STALE_REVISION");
    expect(f.store.read.getExport(record.id)?.manifestId).toBe(manifest.id);

    const unknown = await postExport(exportCommandFor(f.project.id, { ...manifest, id: "manifest-missing" }, "key-2"));
    expect(unknown.status).toBe(404);
    const staleHash = await postExport({ ...command, idempotencyKey: "key-3", expectedManifestHash: "0".repeat(64) });
    expect(staleHash.status).toBe(409);
    expect(triggered.every((projectId) => projectId === f.project.id)).toBe(true);
  });

  it("re-validates the manifest's own pins: unaccepted take 428 and stale take pin 409", async () => {
    const { f, postExport } = handlerFixture();
    const { manifest } = compileManifest(f.store, f.command, { now: () => 9_000 });
    const take = f.takes[0]!;
    f.approve("take", take.id, computeTakeApprovalHash(f.store.read, take), "later-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    const revoked = await postExport(exportCommandFor(f.project.id, manifest, "key-revoked"));
    expect(revoked.status).toBe(428);
    expect(((await revoked.json()) as { error: { code: string; message: string } }).error.message).toMatch(/take-0/);

    // A take bound to a shot revision outside the manifest is a stale pin.
    const outsideShot = ShotRevisionSchema.parse({ version: 1, id: "shot-rev-outside", shotId: "shot_outside", storyRevisionId: f.story.id, beatIds: ["beat_1"], order: 9, visualIntent: "Outside.", motionIntent: "Outside slowly.", castBindings: [], locationRevisionId: f.planned.shotRevisions[0]!.locationRevisionId, propRevisionIds: [], styleRevisionId: f.planned.shotRevisions[0]!.styleRevisionId, framing: "wide", targetFrames: 24, continuation: null, contentHash: hashCanonicalJson({ fixture: "shot-rev-outside" }), createdAt: f.clock() });
    const outsideTake = TakeSchema.parse({ version: 1, id: "take-missing", shotRevisionId: outsideShot.id, anchorId: f.takes[0]!.anchorId, approvalId: f.takes[0]!.approvalId, jobId: "anchor-job", assetId: "anchor-asset", actualFrames: 48, inputsHash: hashCanonicalJson({ fixture: "take-missing" }), receiptId: f.takes[0]!.receiptId, createdAt: f.clock() });
    const staleManifest = RenderManifestSchema.parse({
      ...manifest, id: `manifest-${hashCanonicalJson({ fixture: "stale-manifest" })}`, inputsHash: hashCanonicalJson({ fixture: "stale-manifest" }),
      shots: [ManifestShotSchema.parse({ ...manifest.shots[0]!, takeId: "take-missing" }), manifest.shots[1]!],
    });
    f.store.transaction((tx) => { tx.insertShotRevisions([outsideShot]); tx.insertTake(outsideTake); tx.insertManifest(staleManifest); });
    const stale = await postExport(exportCommandFor(f.project.id, staleManifest, "key-stale"));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { message: string } }).error.message).toMatch(/take-missing/);
  });

  it("re-validates cue media: an unprobed cue asset fails closed with 422", async () => {
    const { f, postExport } = handlerFixture();
    const { manifest } = compileManifest(f.store, f.command, { now: () => 9_000 });
    const unprobed = AssetSchema.parse({ version: 1, id: "asset-unprobed", sha256: hashCanonicalJson({ fixture: "asset-unprobed" }), mime: "audio/wav", byteSize: 10, vaultRef: "vault-unprobed", width: null, height: null, frames: null, fps: null, audioSamples: null, sourceKind: "upload", sourceJobId: null, rightsStatus: "creator_attested", createdAt: f.clock() });
    const cueManifest = RenderManifestSchema.parse({
      ...manifest, id: `manifest-${hashCanonicalJson({ fixture: "cue-manifest" })}`, inputsHash: hashCanonicalJson({ fixture: "cue-manifest" }),
      audioCues: [AudioCueSchema.parse({ id: "cue-unprobed", assetId: unprobed.id, sourceStartSample: 0, sourceEndSample: 100, timelineStartSample: 0, gainDb: 0, role: "narration", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested" })],
    });
    f.store.transaction((tx) => { tx.insertAsset({ asset: unprobed, verifiedAt: f.clock(), checksumVerified: true }); tx.insertManifest(cueManifest); });
    const missingCue = await postExport(exportCommandFor(f.project.id, cueManifest, "key-cue"));
    expect(missingCue.status).toBe(422);
    expect(((await missingCue.json()) as { error: { code: string } }).error.code).toBe("MEDIA_UNAVAILABLE");
  });

  it("re-exports a historical manifest whose pins are still alive, even after the selection moved on", async () => {
    const { f, triggered, postExport } = handlerFixture();
    const { manifest } = compileManifest(f.store, f.command, { now: () => 9_000 });
    const spare = f.createTake(f.planned.shotRevisions[0]!, "take-spare", true);
    expect(f.store.read.getSelectedTake(f.project.id, "shot_0")?.id).toBe("take-spare");
    const response = await postExport(exportCommandFor(f.project.id, manifest, "key-historical"));
    expect(response.status).toBe(202);
    expect(((await response.json()) as ExportRecord).manifestId).toBe(manifest.id);
    expect(triggered).toEqual([f.project.id]);
    expect(spare.take.id).toBe("take-spare");
  });
});

describe("C11-WIRE wired export assembly scheduler", () => {
  const ORIGIN = "http://localhost";
  const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");

  function stubAssemble(stub: { calls: number }): (manifest: RenderManifest, options: AssembleManifestOptions) => Promise<AssemblyOutput> {
    return async (manifest, options) => {
      stub.calls += 1;
      const outputPath = join(options.workDir, `export-${manifest.inputsHash}.mp4`);
      await writeFile(outputPath, Buffer.from("wired-output"), { mode: 0o600 });
      return {
        outputPath,
        sha256: sha("wired-output"),
        probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48, durationTs: 2359296, timeBaseNum: 1, timeBaseDen: 49152 }, audio: null },
        args: [], filterComplex: "", totalFrames: 48,
      };
    };
  }

  it("a POST exports through the wired scheduler drives queued -> rendering -> qc_pending in-process", async () => {
    const f = fixture();
    const mediaDir = await mkdtemp(join(tmpdir(), "perabyte-wired-")); dirs.push(mediaDir);
    // Seed readable vault bytes for the pinned shot assets and the narration cue asset.
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    const vaultRefs = [...f.assets.map((asset) => asset.vaultRef), "vault-audio"];
    for (const ref of vaultRefs) await writeFile(join(mediaDir, `${ref}.bin`), Buffer.from(`bytes:${ref}`), { mode: 0o600 });
    const vault = {
      async readVerified(vaultRef: string) { return readFile(join(mediaDir, `${vaultRef}.bin`)); },
      async putStream(stream: NodeJS.ReadableStream) {
        for await (const chunk of stream as AsyncIterable<Uint8Array>) void chunk;
        return { asset: AssetSchema.parse({ version: 1, id: `published-${randomUUID()}`, sha256: sha("published-wired"), mime: "video/mp4", byteSize: 16, vaultRef: `vault-published-${randomUUID()}`, width: 1080, height: 1920, frames: 48, fps: 24, audioSamples: null, sourceKind: "derived" as const, sourceJobId: null, rightsStatus: "unknown" as const, createdAt: 1_000 }), verifiedAt: 1_000, checksumVerified: true as const };
      },
    };
    const assemble = { calls: 0 };
    const scheduler = createExportAssemblyScheduler({
      dataDir: f.dataDir,
      vault,
      withStore: async (work) => work(f.store),
      assembleManifest: stubAssemble(assemble),
    });
    const triggered: string[] = [];
    const handlers = createExportRouteHandlers({ withStore: async (work) => work(f.store), scheduler: { trigger: (projectId) => { triggered.push(projectId); scheduler.trigger(projectId); } }, serviceOptions: { now: () => 9_000 } });
    const { manifest } = compileManifest(f.store, f.command, { now: () => 9_000 });
    const response = await handlers.POST(
      new Request(`${ORIGIN}/api/production/projects/${f.project.id}/exports`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ projectId: f.project.id, manifestId: manifest.id, expectedManifestHash: manifest.inputsHash, idempotencyKey: "key-wired" }) }),
      { params: Promise.resolve({ projectId: f.project.id }) },
    );
    expect(response.status).toBe(202);
    const record = (await response.json()) as ExportRecord;
    expect(record.status).toBe("queued");
    expect(triggered).toEqual([f.project.id]);
    await scheduler.whenIdle();
    expect(assemble.calls).toBe(1);
    const rendered = f.store.read.getExport(record.id)!;
    expect(rendered.status).toBe("qc_pending");
    expect(rendered.assetId).toBe(`export-asset-${sha("wired-output")}`);
    expect(f.store.read.getAsset(rendered.assetId!)?.id).toBe(`export-asset-${sha("wired-output")}`);
    await expect(readFile(join(f.dataDir, "exports", record.id, "failure.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
