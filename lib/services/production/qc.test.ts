import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import { LocalMediaVault } from "../../media/production/vault";
import {
  assembleManifest, resolveMediaTools, type MediaToolPaths, type StagedAssemblyAsset,
} from "../../media/production/assembly";
import {
  AnchorCandidateSchema, AnimaticRevisionSchema, ApprovalSchema, AssetSchema, AudioCueSchema,
  AudioMixRevisionSchema, CanonRevisionSchema, ExportSchema, HonoredInputsReceiptSchema, JobSchema,
  ProjectSchema, RenderManifestSchema, ShotPlanRevisionSchema, ShotRevisionSchema,
  StoryRevisionSchema, TakeSchema,
  type AudioCue, type ExportRecord, type RenderManifest,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { computeAnchorApprovalHash } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { buildRenderProfile, compileManifestTimeline, manifestId, manifestInputsHash, MANIFEST_MASTERING_RECIPE_VERSION, type ManifestCompileModel, type ManifestShotSource } from "../../production/manifest";
import { FINAL_REVIEW_CHECKLIST_IDS, QcReportSchema, type FinalReviewCommand } from "../../production/qc";
import { createExportDownloadRouteHandlers, createExportDraftRouteHandlers, createExportItemRouteHandlers, createQcService } from "./qc";

const execFileAsync = promisify(execFile);
const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const dirs: string[] = [];
const stores: Array<SqliteProductionStore> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

const PRODUCTION_PROFILE = { id: "storybook-short-v1", format: "9:16" as const, language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null };
const profile = buildRenderProfile(PRODUCTION_PROFILE);
const SHOT_FRAMES = 24;
const localTools = (): MediaToolPaths => ({ ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" });

function manifestFixture(options: { cues?: AudioCue[]; audioMixRevisionId?: string | null; shotFrames?: number; shotCount?: number; projectId?: string } = {}): RenderManifest {
  const shotFrames = options.shotFrames ?? SHOT_FRAMES;
  const shotCount = options.shotCount ?? 2;
  const cues = options.cues ?? [];
  const projectId = options.projectId ?? "project-qc";
  const shots = Array.from({ length: shotCount }, (_v, index) => ({
    shotRevisionId: index === 0 ? "shot-rev-0" : `shot-rev-${index}`, takeId: `take-${index}`, assetId: `asset-shot-${index}`,
    startFrame: 0, endFrame: shotFrames, crop: { x: 0, y: 0, width: 16, height: 16 }, transition: "cut" as const,
  }));
  const modelShots: ManifestShotSource[] = shots.map((shot) => ({
    ...shot, shotHash: sha(shot.shotRevisionId), takeInputsHash: sha(shot.takeId), assetSha256: sha(shot.assetId),
    assetWidth: 16, assetHeight: 16, actualFrames: shotFrames,
  }));
  const totalFrames = compileManifestTimeline(modelShots);
  const audioMixRevisionId = options.audioMixRevisionId !== undefined ? options.audioMixRevisionId : cues.length > 0 ? "mix-1" : null;
  const model: ManifestCompileModel = {
    projectId, storyRevisionId: "story-1", storyHash: sha("story-1"),
    shotPlanRevisionId: "plan-1", shotPlanHash: sha("plan-1"), animaticRevisionId: "animatic-1", animaticHash: sha("animatic-1"),
    audioMixRevisionId, audioMixHash: audioMixRevisionId ? sha(audioMixRevisionId) : null,
    profile, shots: modelShots, audioCues: cues, captionCues: [],
    totalFrames, totalAudioSamples: totalFrames * 2000, selectionVersion: 1,
    masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
  };
  const inputsHash = manifestInputsHash(model);
  return RenderManifestSchema.parse({
    version: 1, id: manifestId(inputsHash), projectId, storyRevisionId: model.storyRevisionId,
    shotPlanRevisionId: model.shotPlanRevisionId, animaticRevisionId: model.animaticRevisionId,
    audioMixRevisionId, profile, shots, audioCues: cues, captionCues: [], inputsHash, createdAt: 1_000,
  });
}

const narrationCue = (overrides: Partial<AudioCue> = {}): AudioCue => AudioCueSchema.parse({
  id: "cue-narration", assetId: "asset-narration", sourceStartSample: 0, sourceEndSample: 24_000,
  timelineStartSample: 48_000, gainDb: 0, role: "narration", scriptSegmentId: "beat_1",
  sourceText: "A door opens.", sourceRights: "creator_attested", ...overrides,
});

async function videoFixture(path: string, color: string, frames: number): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=16x16:r=24`, "-frames:v", String(frames), "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path], { timeout: 30_000 });
}
async function wavFixture(path: string): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", path], { timeout: 30_000 });
}

interface StoreFixture {
  store: SqliteProductionStore;
  dataDir: string;
  vault: LocalMediaVault;
  projectId: string;
  manifestWithAudio: RenderManifest;
  manifestSilent: RenderManifest;
}

function storeFixture(): StoreFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-qc-service-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  const projectId = "project-qc";
  const project = ProjectSchema.parse({ version: 1, id: projectId, name: "QC Service", profileId: PRODUCTION_PROFILE.id, profile: PRODUCTION_PROFILE, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 90, updatedAt: 90, saveVersion: 1 });
  const canon = (id: string, kind: "location" | "style") => CanonRevisionSchema.parse({ version: 1, id, entityId: id, entityKind: kind, revision: 1, description: `QC ${kind}`, attributes: {}, referenceAssetIds: [], contentHash: sha(id), createdAt: 100 });
  const story = StoryRevisionSchema.parse({ version: 1, id: "story-1", projectId, parentRevisionId: null, scriptText: "A door opens.", beats: [{ id: "beat_1", action: "A door opens.", narration: "A door opens.", dialogue: [], order: 0 }], canonRevisionIds: [], contentHash: sha("story-1"), createdAt: 110 });
  const shots = [0, 1].map((index) => ShotRevisionSchema.parse({ version: 1, id: `shot-rev-${index}`, shotId: `shot_${index}`, storyRevisionId: "story-1", beatIds: ["beat_1"], order: index, visualIntent: "A door opens.", motionIntent: "A door opens slowly.", castBindings: [], locationRevisionId: "loc", propRevisionIds: [], styleRevisionId: "style", framing: "wide", targetFrames: SHOT_FRAMES, continuation: null, contentHash: sha(`shot-rev-${index}`), createdAt: 120 + index }));
  const plan = ShotPlanRevisionSchema.parse({ version: 1, id: "plan-1", projectId, storyRevisionId: "story-1", orderedShotRevisionIds: shots.map((shot) => shot.id), beatCoverage: [{ beatId: "beat_1", shotRevisionIds: shots.map((shot) => shot.id) }], contentHash: sha("plan-1"), createdAt: 130 });
  const animatic = AnimaticRevisionSchema.parse({ version: 1, id: "animatic-1", projectId, shotPlanRevisionId: "plan-1", slots: shots.map((shot) => ({ shotRevisionId: shot.id, anchorId: null, placeholderLabel: null })), timingAnnotations: [], totalFrames: 2 * SHOT_FRAMES, contentHash: sha("animatic-1"), createdAt: 135 });
  const anchorAsset = AssetSchema.parse({ version: 1, id: "anchor-asset", sha256: sha("anchor-asset"), mime: "image/png", byteSize: 1024, vaultRef: `sha256-${sha("anchor-asset")}`, width: null, height: null, frames: null, fps: null, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 140 });
  const job = JobSchema.parse({ version: 1, id: "take-job", projectId, operation: "take", status: "queued", idempotencyKey: "take-job-key", requestSnapshot: {}, requestHash: sha("take-job"), providerId: "sogni", modelId: "video-model", providerRef: "take-ref", quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 150, updatedAt: 150 });
  const receipt = HonoredInputsReceiptSchema.parse({ version: 1, id: "take-receipt", jobId: job.id, capabilityProvenance: "sdk_contract", capabilityObservedAt: job.createdAt, inputs: [], createdAt: job.createdAt });
  const anchor = AnchorCandidateSchema.parse({ version: 1, id: "anchor-1", shotRevisionId: "shot-rev-0", assetId: anchorAsset.id, inputsHash: sha("anchor-1"), jobId: job.id, visionAssessment: null, receiptId: null, createdAt: 160 });
  const takes = [0, 1].map((index) => TakeSchema.parse({ version: 1, id: `take-${index}`, shotRevisionId: `shot-rev-${index}`, anchorId: anchor.id, approvalId: "anchor-approval", jobId: job.id, assetId: `asset-shot-${index}`, actualFrames: SHOT_FRAMES, inputsHash: sha(`take-${index}`), receiptId: receipt.id, createdAt: 170 + index }));
  const shotAssets = [0, 1].map((index) => AssetSchema.parse({ version: 1, id: `asset-shot-${index}`, sha256: sha(`asset-shot-${index}`), mime: "video/mp4", byteSize: 8192, vaultRef: `sha256-${sha(`asset-shot-${index}`)}`, width: 16, height: 16, frames: SHOT_FRAMES, fps: 24, audioSamples: null, sourceKind: "fixture", sourceJobId: job.id, rightsStatus: "creator_attested", createdAt: 180 + index }));
  const narrationAsset = AssetSchema.parse({ version: 1, id: "asset-narration", sha256: sha("asset-narration"), mime: "audio/wav", byteSize: 4096, vaultRef: `sha256-${sha("asset-narration")}`, width: null, height: null, frames: null, fps: null, audioSamples: 48_000, sourceKind: "upload", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 190 });
  store.transaction((tx) => {
    tx.insertProject(project);
    tx.insertCanonRevision(canon("loc", "location"));
    tx.insertCanonRevision(canon("style", "style"));
    tx.insertStoryRevision(story);
    tx.insertShotRevisions(shots);
    tx.insertShotPlanRevision(plan);
    tx.insertAnimaticRevision(animatic);
    tx.insertAsset({ asset: anchorAsset, verifiedAt: 140, checksumVerified: true });
    tx.insertJob(job, { id: "take-job-outbox", jobId: job.id, createdAt: job.createdAt, claimedAt: null, claimToken: null });
    tx.insertHonoredInputsReceipt(receipt);
    for (const index of [0, 1]) tx.insertAsset({ asset: shotAssets[index]!, verifiedAt: 180 + index, checksumVerified: true });
    tx.insertAsset({ asset: narrationAsset, verifiedAt: 190, checksumVerified: true });
    tx.insertAnchor(anchor);
    tx.appendApproval(ApprovalSchema.parse({ version: 1, id: "anchor-approval", targetKind: "anchor", targetId: anchor.id, targetHash: computeAnchorApprovalHash(tx, anchor), decision: "approved", actorId: "local-creator", createdAt: 210, checklist: [{ id: "review", passed: true, note: "QC fixture" }], notes: "", advisoryAcknowledgements: [] }));
    for (const index of [0, 1]) {
      tx.insertTake(takes[index]!);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `take-${index}-approval`, targetKind: "take", targetId: takes[index]!.id, targetHash: computeTakeApprovalHash(tx, takes[index]!), decision: "approved", actorId: "local-creator", createdAt: 200 + index, checklist: [{ id: "review", passed: true, note: "QC fixture" }], notes: "", advisoryAcknowledgements: [] }));
    }
  });
  const manifestWithAudio = manifestFixture({ cues: [narrationCue()] });
  const manifestSilent = manifestFixture({ audioMixRevisionId: null, cues: [] });
  const mix = AudioMixRevisionSchema.parse({ version: 1, id: "mix-1", projectId, storyRevisionId: "story-1", cues: [narrationCue()], mixSettings: { sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true }, contentHash: sha("mix-1"), createdAt: 195 });
  store.transaction((tx) => { tx.insertAudioMixRevision(mix); tx.insertManifest(manifestWithAudio); tx.insertManifest(manifestSilent); });
  return { store, dataDir, vault: new LocalMediaVault({ root: join(dataDir, "media") }), projectId, manifestWithAudio, manifestSilent };
}

/** Renders a manifest with the real local toolchain and commits the export into qc_pending. */
async function renderToQcPending(fixture: StoreFixture, manifest: RenderManifest, exportId: string): Promise<{ outputSha256: string; vaultRef: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "perabyte-qc-render-")); dirs.push(workDir);
  const files: Record<string, string> = {};
  const uniqueShots = new Set(manifest.shots.map((shot) => shot.assetId));
  let shotIndex = 0;
  for (const assetId of uniqueShots) {
    const path = join(workDir, `shot-${shotIndex}.mp4`);
    await videoFixture(path, ["red", "green", "yellow"][shotIndex % 3]!, manifest.shots[0]!.endFrame - manifest.shots[0]!.startFrame);
    files[assetId] = path;
    shotIndex += 1;
  }
  for (const cue of manifest.audioCues) {
    const path = join(workDir, `cue-${cue.id}.wav`);
    await wavFixture(path);
    files[cue.assetId] = path;
  }
  const stage = async (assetId: string, tempDir: string): Promise<StagedAssemblyAsset> => {
    const source = files[assetId];
    if (!source) throw new Error(`fixture did not stage ${assetId}`);
    const target = join(tempDir, `${assetId.replace(/[^A-Za-z0-9_.-]/g, "_")}.staged`);
    await copyFile(source, target);
    const isShot = assetId.startsWith("asset-shot");
    return { path: target, width: isShot ? 16 : null, height: isShot ? 16 : null, frames: isShot ? manifest.shots[0]!.endFrame : null };
  };
  const output = await assembleManifest(manifest, { workDir, paths: localTools(), stageAsset: stage });
  const stored = await fixture.vault.putStream(createReadStream(output.outputPath), { mime: "video/mp4", sourceKind: "derived" });
  const asset = AssetSchema.parse({ ...stored.asset, id: `export-asset-${output.sha256}` });
  fixture.store.transaction((tx) => {
    tx.insertAsset({ asset, verifiedAt: 1_000, checksumVerified: true });
    const live = tx.getExport(exportId);
    if (!live) throw new Error("missing export fixture");
    if (!tx.compareAndSetExport({ ...live, status: "qc_pending", assetId: asset.id }, "queued")) throw new Error("fixture CAS failed");
  });
  return { outputSha256: output.sha256, vaultRef: asset.vaultRef };
}

function insertExport(fixture: StoreFixture, manifest: RenderManifest, id: string, at: number): ExportRecord {
  const record = ExportSchema.parse({ version: 1, id, manifestId: manifest.id, jobId: null, assetId: null, qcReportId: null, status: "queued", createdAt: at, approvedSha256: null, finalApprovalId: null });
  fixture.store.transaction((tx) => tx.insertExport(record));
  return record;
}

const happyChecklist = () => FINAL_REVIEW_CHECKLIST_IDS.map((id) => ({ id, passed: true, note: `Checked ${id} on the exact bytes.` }));
const reviewCommand = (overrides: Partial<FinalReviewCommand> = {}): FinalReviewCommand => ({
  idempotencyKey: "review-1", decision: "approved", checklist: happyChecklist(), notes: "Watched end to end.",
  advisoryAcknowledgements: [], expectedOutputSha256: "0".repeat(64), ...overrides,
});

describe("C12 QC service end-to-end on a real local render", () => {
  it("runs QC on a passing render: ready_for_review, id-named qc-report file 0600, CAS sets the report id", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-pass", 300);
    const { outputSha256 } = await renderToQcPending(fixture, fixture.manifestWithAudio, "export-pass");
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => 5_000 });
    const result = await service.runQc("export-pass");
    console.info(`[c12-qc-happy] blockers=${JSON.stringify(result.report.blockers)} advisories=${JSON.stringify(result.report.advisories)} measured=${JSON.stringify(result.report.measured)}`);
    expect(result.exportRecord.status).toBe("ready_for_review");
    expect(result.exportRecord.qcReportId).toBe(result.report.id);
    expect(result.report.verdict).toBe("passed");
    expect(result.report.draftOnly).toBe(false);
    expect(result.report.outputSha256).toBe(outputSha256);
    expect(result.report.manifestInputsHash).toBe(fixture.manifestWithAudio.inputsHash);
    expect(result.report.blockers).toEqual([]);
    expect(result.report.measured.integratedLufs).not.toBeNull();
    expect(result.report.measured.integratedLufs!).toBeGreaterThanOrEqual(-15);
    expect(result.report.measured.integratedLufs!).toBeLessThanOrEqual(-13);
    expect(result.report.measured.truePeakDbtp!).toBeLessThanOrEqual(-1);
    expect(result.report.toolVersions.ffmpeg.length).toBeGreaterThan(0);
    const reportPath = join(fixture.dataDir, "exports", "export-pass", `qc-report-${result.report.id}.json`);
    const onDisk = QcReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
    expect(onDisk.id).toBe(result.report.id);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    // The recorded id resolves to its own artifact through the service reader.
    expect(await service.readReport("export-pass", result.exportRecord.qcReportId!)).not.toBeNull();
    // QC is a one-shot transition from qc_pending.
    await expect(service.runQc("export-pass")).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(service.runQc("export-unknown")).rejects.toMatchObject({ code: "UNKNOWN_REFERENCE" });
  }, 180_000);

  it("never clobbers the committed report under concurrent run_qc: the CAS winner's qcReportId always resolves", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-race", 300);
    await renderToQcPending(fixture, fixture.manifestWithAudio, "export-race");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1) });
    // Both racers pass the qc_pending read gate before either CAS lands; each writes its own
    // id-named artifact, so the committed record always resolves no matter which CAS wins.
    const settled = await Promise.allSettled([service.runQc("export-race"), service.runQc("export-race")]);
    const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof service.runQc>>> => entry.status === "fulfilled");
    expect(fulfilled.length).toBe(2);
    const committed = fixture.store.read.getExport("export-race")!;
    expect(committed.status).toBe("ready_for_review");
    // Exactly one racer's CAS won: the committed qcReportId resolves to its own on-disk report.
    const winner = fulfilled.find((entry) => entry.value.report.id === committed.qcReportId);
    expect(winner).toBeTruthy();
    const resolved = await service.readReport("export-race", committed.qcReportId!);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(committed.qcReportId);
    expect(resolved!.verdict).toBe("passed");
    // Each racer's artifact exists under its own id-derived name (the loser's is a harmless orphan).
    for (const entry of fulfilled) {
      const path = join(fixture.dataDir, "exports", "export-race", `qc-report-${entry.value.report.id}.json`);
      await expect(stat(path)).resolves.toMatchObject({ mode: expect.anything() });
    }
  }, 180_000);

  it("sends mutated vault bytes to qc_failed with a checksum blocker", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-drift", 300);
    const { outputSha256 } = await renderToQcPending(fixture, fixture.manifestWithAudio, "export-drift");
    // A different mp4 sits behind the ref the export asset record names, while the record still pins the render sha.
    const other = join(dirs[0]!, "other.mp4");
    await videoFixture(join(dirs[0]!, "other-src.mp4"), "white", 4);
    await copyFile(join(dirs[0]!, "other-src.mp4"), other);
    const stored = await fixture.vault.putStream(createReadStream(other), { mime: "video/mp4", sourceKind: "derived" });
    const drifted = AssetSchema.parse({ ...stored.asset, id: "export-asset-drifted", sha256: outputSha256 });
    fixture.store.transaction((tx) => {
      tx.insertAsset({ asset: drifted, verifiedAt: 1_000, checksumVerified: true });
      const live = tx.getExport("export-drift")!;
      if (!tx.compareAndSetExport({ ...live, assetId: drifted.id }, "qc_pending")) throw new Error("fixture CAS failed");
    });
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir });
    const result = await service.runQc("export-drift");
    expect(result.exportRecord.status).toBe("qc_failed");
    expect(result.report.verdict).toBe("failed");
    expect(result.report.blockers.map((blocker) => blocker.code)).toContain("checksum_mismatch");
  }, 180_000);

  it("writes a failed report naming the stage with redacted stderr when ffprobe is unavailable", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-toolfail", 300);
    await renderToQcPending(fixture, fixture.manifestWithAudio, "export-toolfail");
    const service = createQcService({
      store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir,
      paths: { ffmpeg: localTools().ffmpeg, ffprobe: "/nonexistent/c12/ffprobe" },
    });
    const result = await service.runQc("export-toolfail");
    expect(result.exportRecord.status).toBe("qc_failed");
    expect(result.report.verdict).toBe("failed");
    expect(result.report.toolFailure?.stage).toBe("probe");
    expect(result.report.toolFailure?.redactedStderr).not.toContain("/nonexistent");
    expect(result.report.blockers.map((blocker) => blocker.code)).toContain("measurement_failed");
  }, 180_000);

  it("approves a final review in one transaction and unlocks the exact checksum", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-approve", 300);
    const { outputSha256 } = await renderToQcPending(fixture, fixture.manifestWithAudio, "export-approve");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1_000) });
    await service.runQc("export-approve");
    const review = await service.finalReview("export-approve", reviewCommand({ expectedOutputSha256: outputSha256 }));
    expect(review.created).toBe(true);
    expect(review.approval.targetKind).toBe("final");
    expect(review.approval.targetId).toBe("export-approve");
    expect(review.approval.targetHash).toBe(outputSha256);
    expect(review.approval.decision).toBe("approved");
    expect(review.exportRecord.status).toBe("approved");
    expect(review.exportRecord.approvedSha256).toBe(outputSha256);
    expect(review.exportRecord.finalApprovalId).toBe(review.approval.id);
    // Exact replay returns the same decision without a second approval.
    const replay = await service.finalReview("export-approve", reviewCommand({ expectedOutputSha256: outputSha256 }));
    expect(replay.created).toBe(false);
    expect(replay.approval.id).toBe(review.approval.id);
    // A different command under the same key conflicts.
    await expect(service.finalReview("export-approve", reviewCommand({ expectedOutputSha256: outputSha256, notes: "different" }))).rejects.toMatchObject({ code: "STALE_REVISION" });
  }, 180_000);

  it("marks a silent draft draftOnly, keeps it unapprovable, and still allows the draft download", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestSilent, "export-draft", 300);
    await renderToQcPending(fixture, fixture.manifestSilent, "export-draft");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1_000) });
    const result = await service.runQc("export-draft");
    expect(result.exportRecord.status).toBe("ready_for_review");
    expect(result.report.draftOnly).toBe(true);
    expect(result.report.verdict).toBe("passed");
    expect(result.report.measured.integratedLufs).toBeNull();
    await expect(service.finalReview("export-draft", reviewCommand({ expectedOutputSha256: result.report.outputSha256 })))
      .rejects.toMatchObject({ code: "QC_BLOCKED" });
    // The draft route still serves the bytes below (route matrix test).
  }, 180_000);

  it("requires every advisory acknowledged before approval and accepts the acked review", async () => {
    const fixture = storeFixture();
    // One 72-frame solid-color shot freezes for 3s >= 48 frames: a named advisory, never an auto-fail.
    const advisoryManifest = manifestFixture({ cues: [narrationCue({ timelineStartSample: 0 })], shotFrames: 72, shotCount: 1 });
    fixture.store.transaction((tx) => tx.insertManifest(advisoryManifest));
    insertExport(fixture, advisoryManifest, "export-advisory", 300);
    await renderToQcPending(fixture, advisoryManifest, "export-advisory");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1_000) });
    const result = await service.runQc("export-advisory");
    expect(result.report.verdict).toBe("passed");
    expect(result.report.advisories.map((advisory) => advisory.code)).toContain("freeze_range");
    await expect(service.finalReview("export-advisory", reviewCommand({ expectedOutputSha256: result.report.outputSha256 })))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    const approved = await service.finalReview("export-advisory", reviewCommand({
      expectedOutputSha256: result.report.outputSha256,
      advisoryAcknowledgements: [{ code: "freeze_range", reason: "Planned static title card, reviewed at 0-72." }],
    }));
    expect(approved.exportRecord.status).toBe("approved");
  }, 180_000);

  it("keeps a rejected review on ready_for_review with the decision recorded", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-reject", 300);
    const { outputSha256 } = await renderToQcPending(fixture, fixture.manifestWithAudio, "export-reject");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1_000) });
    await service.runQc("export-reject");
    const rejected = await service.finalReview("export-reject", reviewCommand({
      decision: "rejected", notes: "Narration is clipped in shot 2.", expectedOutputSha256: outputSha256,
      checklist: happyChecklist().map((item) => item.id === "audio" ? { ...item, passed: false, note: "Clipped word." } : item),
    }));
    expect(rejected.created).toBe(true);
    expect(rejected.approval.decision).toBe("rejected");
    expect(rejected.exportRecord.status).toBe("ready_for_review");
    // A later approval of the same checksum is still possible.
    const later = await service.finalReview("export-reject", reviewCommand({ idempotencyKey: "review-2", expectedOutputSha256: outputSha256 }));
    expect(later.exportRecord.status).toBe("approved");
  }, 180_000);
});

describe("C12 download and draft route gating", () => {
  async function approvedFixture() {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-gate", 300);
    const { outputSha256 } = await renderToQcPending(fixture, fixture.manifestWithAudio, "export-gate");
    let clock = 5_000;
    const service = createQcService({ store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => (clock += 1_000) });
    await service.runQc("export-gate");
    return { fixture, outputSha256, service };
  }

  const routeOptions = (fixture: StoreFixture) => ({
    withStore: async <T,>(work: (store: StoreFixture["store"]) => T | Promise<T>): Promise<T> => work(fixture.store),
    dataDir: fixture.dataDir,
    vault: fixture.vault,
  });

  it("final download: 428 until approved, then 200 with exact headers and no path exposure", async () => {
    const { fixture, outputSha256, service } = await approvedFixture();
    const download = createExportDownloadRouteHandlers(routeOptions(fixture));
    const context = { params: Promise.resolve({ id: "export-gate" }) };
    const url = (projectId: string | null) => `http://localhost/api/production/exports/export-gate/download${projectId === null ? "" : `?projectId=${projectId}`}`;
    for (const status of ["qc_pending", "qc_failed", "ready_for_review"] as const) {
      // Walk the export back through the gateable statuses; each CAS names the status it leaves.
      fixture.store.transaction((tx) => {
        const live = tx.getExport("export-gate")!;
        expect(tx.compareAndSetExport({ ...live, status }, live.status)).toBe(true);
      });
      const response = await download.GET(new Request(url("project-qc")), context);
      expect(response.status).toBe(428);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("APPROVAL_REQUIRED");
      expect(body.error.message).toMatch(/final (review|approval)|human/i);
    }
    // The walk ends at ready_for_review, exactly where the human gate re-approves.
    await service.finalReview("export-gate", reviewCommand({ idempotencyKey: "review-gate-1", expectedOutputSha256: outputSha256 }));
    const ok = await download.GET(new Request(url("project-qc")), context);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect(ok.headers.get("x-perabyte-final")).toBe("1");
    expect(ok.headers.get("etag")).toBe(`"${outputSha256}"`);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("content-disposition")).toBe(`attachment; filename="export-${outputSha256.slice(0, 12)}.mp4"`);
    expect(Number(ok.headers.get("content-length"))).toBe(await ok.clone().arrayBuffer().then((buffer) => buffer.byteLength));
    const headerText = JSON.stringify([...ok.headers.entries()]);
    expect(headerText).not.toMatch(/vault|\/tmp|dataDir/);
    // Scope and unknown handling.
    await expect(download.GET(new Request(url(null)), context)).resolves.toMatchObject({ status: 400 });
    await expect(download.GET(new Request(url("project-other")), context)).resolves.toMatchObject({ status: 400 });
    await expect(download.GET(new Request(url("project-qc")), { params: Promise.resolve({ id: "export-nope" }) })).resolves.toMatchObject({ status: 404 });
  }, 240_000);

  it("final download returns 409 when the approved checksum no longer matches the current asset", async () => {
    const { fixture, outputSha256, service } = await approvedFixture();
    await service.finalReview("export-gate", reviewCommand({ idempotencyKey: "review-gate-2", expectedOutputSha256: outputSha256 }));
    const other = await fixture.vault.putStream(createReadStream(await mp4Bytes(fixture)), { mime: "video/mp4", sourceKind: "derived" });
    fixture.store.transaction((tx) => {
      tx.insertAsset({ asset: other.asset, verifiedAt: 1_000, checksumVerified: true });
      const live = tx.getExport("export-gate")!;
      if (!tx.compareAndSetExport({ ...live, assetId: other.asset.id }, "approved")) throw new Error("fixture CAS failed");
    });
    const download = createExportDownloadRouteHandlers(routeOptions(fixture));
    const response = await download.GET(new Request("http://localhost/api/production/exports/export-gate/download?projectId=project-qc"), { params: Promise.resolve({ id: "export-gate" }) });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("STALE_REVISION");
  }, 240_000);

  it("draft matrix: draft-eligible states serve labeled bytes, approved 409s to the final route, failed embeds the failure summary", async () => {
    const { fixture, outputSha256, service } = await approvedFixture();
    const draft = createExportDraftRouteHandlers(routeOptions(fixture));
    const download = createExportDownloadRouteHandlers(routeOptions(fixture));
    const context = { params: Promise.resolve({ id: "export-gate" }) };
    const url = "http://localhost/api/production/exports/export-gate/draft?projectId=project-qc";
    for (const [status, prefix] of [["qc_pending", "DRAFT-"], ["qc_failed", "QC-FAILED-"], ["ready_for_review", "DRAFT-"]] as const) {
      fixture.store.transaction((tx) => {
        const live = tx.getExport("export-gate")!;
        expect(tx.compareAndSetExport({ ...live, status, approvedSha256: null, finalApprovalId: null }, live.status)).toBe(true);
      });
      const response = await draft.GET(new Request(url), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-perabyte-draft")).toBe("1");
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${prefix}export-${outputSha256.slice(0, 12)}.mp4"`);
      expect(await response.arrayBuffer()).toBeTruthy();
    }
    // Approved exports point at the final route.
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-gate")!;
      expect(tx.compareAndSetExport({ ...live, status: "approved", approvedSha256: outputSha256, finalApprovalId: "approval-x" }, live.status)).toBe(true);
    });
    const approvedDraft = await draft.GET(new Request(url), context);
    expect(approvedDraft.status).toBe(409);
    expect((await approvedDraft.json() as { error: { message: string } }).error.message).toMatch(/download/);
    // Failed export with no asset embeds failure.json.
    writeFileSync(join(fixture.dataDir, "exports", "export-gate", "failure.json"), JSON.stringify({ version: 1, exportId: "export-gate", code: "MEDIA_UNAVAILABLE", stage: "encode", redactedStderr: "encode failed at [local-path]", at: 999 }), { encoding: "utf8", mode: 0o600 });
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-gate")!;
      expect(tx.compareAndSetExport({ ...live, status: "failed", assetId: null, approvedSha256: null, finalApprovalId: null }, live.status)).toBe(true);
    });
    const failedDraft = await draft.GET(new Request(url), context);
    expect(failedDraft.status).toBe(409);
    const failedBody = await failedDraft.json() as { error: { details: { failureCode?: string; stage?: string; redactedStderr?: string } } };
    expect(failedBody.error.details).toMatchObject({ failureCode: "MEDIA_UNAVAILABLE", stage: "encode" });
    // Final download on a non-approved export stays 428.
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-gate")!;
      expect(tx.compareAndSetExport({ ...live, status: "qc_failed" }, live.status)).toBe(true);
    });
    await expect(download.GET(new Request("http://localhost/api/production/exports/export-gate/download?projectId=project-qc"), context)).resolves.toMatchObject({ status: 428 });
  }, 240_000);

  it("GET export detail includes the report and failure artifacts only when present, with the owning project scope", async () => {
    const { fixture } = await approvedFixture();
    const item = createExportItemRouteHandlers(routeOptions(fixture));
    const context = { params: Promise.resolve({ id: "export-gate" }) };
    const response = await item.GET(new Request("http://localhost/api/production/exports/export-gate?projectId=project-qc"), context);
    expect(response.status).toBe(200);
    const detail = await response.json() as {
      export: ExportRecord; manifestSummary: { shotCount: number; audioCueCount: number; inputsHash: string; profile: { width: number } };
      qcReport: { id: string } | null; failure: { code: string } | null; owningProjectId: string;
    };
    expect(detail.owningProjectId).toBe("project-qc");
    expect(detail.manifestSummary).toMatchObject({ shotCount: 2, audioCueCount: 1, inputsHash: fixture.manifestWithAudio.inputsHash, profile: { width: 1080 } });
    expect(detail.qcReport).not.toBeNull();
    expect(detail.failure).toBeNull();
    expect(JSON.stringify(detail)).not.toMatch(/vaultRef|\/tmp/);
    // A failure artifact shows up only when the C11 runner wrote one.
    writeFileSync(join(fixture.dataDir, "exports", "export-gate", "failure.json"), JSON.stringify({ version: 1, exportId: "export-gate", code: "MEDIA_UNAVAILABLE", stage: "verify", redactedStderr: "boom", at: 1_234 }), { encoding: "utf8", mode: 0o600 });
    const withFailure = await item.GET(new Request("http://localhost/api/production/exports/export-gate?projectId=project-qc"), context);
    expect(((await withFailure.json() as { failure: { code: string } | null }).failure)?.code).toBe("MEDIA_UNAVAILABLE");
    // Unknown id and scope mismatch.
    await expect(item.GET(new Request("http://localhost/api/production/exports/export-nope?projectId=project-qc"), { params: Promise.resolve({ id: "export-nope" }) })).resolves.toMatchObject({ status: 404 });
    await expect(item.GET(new Request("http://localhost/api/production/exports/export-gate"), context)).resolves.toMatchObject({ status: 400 });
  }, 240_000);

  it("run_qc and final_review POST commands flow through the item route", async () => {
    const fixture = storeFixture();
    insertExport(fixture, fixture.manifestWithAudio, "export-route", 300);
    await renderToQcPending(fixture, fixture.manifestWithAudio, "export-route");
    let clock = 5_000;
    const serviceDeps = { ...routeOptions(fixture), serviceOptions: { now: () => (clock += 1_000) } };
    const item = createExportItemRouteHandlers(serviceDeps);
    const context = { params: Promise.resolve({ id: "export-route" }) };
    const post = (body: unknown) => new Request("http://localhost/api/production/exports/export-route", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body),
    });
    const qcResponse = await item.POST(post({ kind: "run_qc" }), context);
    expect(qcResponse.status).toBe(200);
    const qcBody = await qcResponse.json() as { exportRecord: ExportRecord; report: { verdict: string; outputSha256: string } };
    expect(qcBody.exportRecord.status).toBe("ready_for_review");
    expect(qcBody.report.verdict).toBe("passed");
    const reviewResponse = await item.POST(post({
      kind: "final_review", idempotencyKey: "review-route-1", decision: "approved",
      checklist: happyChecklist(), notes: "Watched end to end.", advisoryAcknowledgements: [],
      expectedOutputSha256: qcBody.report.outputSha256,
    }), context);
    expect(reviewResponse.status).toBe(201);
    const reviewBody = await reviewResponse.json() as { exportRecord: ExportRecord; approval: { targetKind: string } };
    expect(reviewBody.exportRecord.status).toBe("approved");
    expect(reviewBody.approval.targetKind).toBe("final");
  }, 240_000);
});

async function mp4Bytes(fixture: StoreFixture): Promise<string> {
  const path = join(dirs[0]!, `extra-${Math.random().toString(36).slice(2)}.mp4`);
  await videoFixture(path, "teal", 4);
  return path;
}
