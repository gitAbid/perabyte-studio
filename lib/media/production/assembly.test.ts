import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import {
  AnchorCandidateSchema, AnimaticRevisionSchema, ApprovalSchema, AssetSchema, AudioCueSchema,
  CanonRevisionSchema, ExportSchema, HonoredInputsReceiptSchema, JobSchema, ProjectSchema, RenderManifestSchema,
  ShotPlanRevisionSchema, ShotRevisionSchema, StoryRevisionSchema, TakeSchema,
  type AudioCue, type ExportRecord, type RenderManifest,
} from "../../production/contracts";
import { computeAnchorApprovalHash } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import {
  buildRenderProfile, compileManifestTimeline, manifestId, manifestInputsHash,
  type ManifestCompileModel, type ManifestShotSource,
} from "../../production/manifest";
import * as manifestDomain from "../../production/manifest";
import {
  assembleManifest, buildAssemblyPlan, createExportAssemblyScheduler, exportOutputName,
  probeMediaTools, redactStderr, resolveMediaTools, runExportAssembly,
  type AssemblyOutput, type MediaToolPaths, type StagedAssemblyAsset,
} from "./assembly";
import { ASSEMBLY_ENCODER_RECIPE, buildRenderProfile as profilesBuildRenderProfile } from "./profiles";

const execFileAsync = promisify(execFile);
const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const dirs: string[] = [];
const stores: Array<SqliteProductionStore> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

const PRODUCTION_PROFILE = { id: "storybook-short-v1", format: "9:16" as const, language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null };
const profile = buildRenderProfile(PRODUCTION_PROFILE);
const SHOT_FRAMES = 24;

function manifestFixture(options: { transitions?: Array<"cut" | "crossfade">; cues?: AudioCue[]; projectId?: string; audioMixRevisionId?: string | null } = {}): RenderManifest {
  const transitions = options.transitions ?? ["cut", "cut"];
  const cues = options.cues ?? [];
  const shots = transitions.map((transition, index) => ({
    shotRevisionId: `shot-rev-${index}`, takeId: `take-${index}`, assetId: `asset-shot-${index}`,
    startFrame: 0, endFrame: SHOT_FRAMES, crop: { x: 0, y: 0, width: 16, height: 16 }, transition,
  }));
  return renderManifestFromShots(shots, cues, options.projectId, options.audioMixRevisionId === undefined ? undefined : options.audioMixRevisionId);
}
/** A long all-cut manifest that reuses the fixture's first take/asset so it stays storable. */
function longManifestFixture(shotCount: number, projectId = "project-assembly"): RenderManifest {
  const shots = Array.from({ length: shotCount }, (_v, index) => ({
    shotRevisionId: `long-shot-rev-${index}`, takeId: "take-0", assetId: "asset-shot-0",
    startFrame: 0, endFrame: SHOT_FRAMES, crop: { x: 0, y: 0, width: 16, height: 16 }, transition: "cut" as const,
  }));
  return renderManifestFromShots(shots, [], projectId, null);
}
function renderManifestFromShots(shots: Array<{ shotRevisionId: string; takeId: string; assetId: string; startFrame: number; endFrame: number; crop: { x: number; y: number; width: number; height: number }; transition: "cut" | "crossfade" }>, cues: AudioCue[], projectId = "project-assembly", audioMixRevisionId?: string | null): RenderManifest {
  const modelShots: ManifestShotSource[] = shots.map((shot) => ({
    ...shot, shotHash: sha(shot.shotRevisionId), takeInputsHash: sha(shot.takeId), assetSha256: sha(shot.assetId),
    assetWidth: 16, assetHeight: 16, actualFrames: SHOT_FRAMES,
  }));
  const totalFrames = compileManifestTimeline(modelShots);
  const model: ManifestCompileModel = {
    projectId, storyRevisionId: "story-1", storyHash: sha("story-1"),
    shotPlanRevisionId: "plan-1", shotPlanHash: sha("plan-1"), animaticRevisionId: "animatic-1", animaticHash: sha("animatic-1"),
    audioMixRevisionId: audioMixRevisionId !== undefined ? audioMixRevisionId : cues.length > 0 ? "mix-1" : null,
    audioMixHash: audioMixRevisionId !== undefined ? (audioMixRevisionId ? sha(audioMixRevisionId) : null) : cues.length > 0 ? sha("mix-1") : null,
    profile, shots: modelShots, audioCues: cues, captionCues: [],
    totalFrames, totalAudioSamples: totalFrames * 2000, selectionVersion: 1,
    masteringRecipeVersion: manifestDomain.MANIFEST_MASTERING_RECIPE_VERSION,
  };
  const inputsHash = manifestInputsHash(model);
  return RenderManifestSchema.parse({
    version: 1, id: manifestId(inputsHash), projectId: model.projectId, storyRevisionId: model.storyRevisionId,
    shotPlanRevisionId: model.shotPlanRevisionId, animaticRevisionId: model.animaticRevisionId,
    audioMixRevisionId: model.audioMixRevisionId, profile, shots, audioCues: cues, captionCues: [], inputsHash, createdAt: 1_000,
  });
}
const narrationCue = (overrides: Record<string, unknown> = {}): AudioCue => AudioCueSchema.parse({
  id: "cue-narration", assetId: "asset-narration", sourceStartSample: 0, sourceEndSample: 24_000,
  timelineStartSample: 48_000, gainDb: 0, role: "narration", scriptSegmentId: null, sourceText: "A door opens.",
  sourceRights: "creator_attested", ...overrides,
});

async function videoFixture(path: string, color: string, frames: number): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=16x16:r=24`, "-frames:v", String(frames), "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path], { timeout: 30_000 });
}
async function wavFixture(path: string): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", path], { timeout: 30_000 });
}
type FixtureMedia = Record<string, string>;
async function stageFrom(files: FixtureMedia): Promise<(assetId: string, tempDir: string) => Promise<StagedAssemblyAsset>> {
  return async (assetId, tempDir) => {
    const source = files[assetId];
    if (!source) throw new Error(`Fixture did not stage ${assetId}`);
    const target = join(tempDir, `${assetId.replace(/[^A-Za-z0-9_.-]/g, "_")}.staged`);
    await copyFile(source, target);
    const isShot = assetId.startsWith("asset-shot");
    return { path: target, width: isShot ? 16 : null, height: isShot ? 16 : null, frames: isShot ? SHOT_FRAMES : null };
  };
}
const localTools = (): MediaToolPaths => ({ ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" });
const twoShotStaged = (prefix: string): Record<string, StagedAssemblyAsset> => ({
  "asset-shot-0": { path: `${prefix}/shot0.mp4`, width: 16, height: 16, frames: SHOT_FRAMES },
  "asset-shot-1": { path: `${prefix}/shot1.mp4`, width: 16, height: 16, frames: SHOT_FRAMES },
  "asset-narration": { path: `${prefix}/narration.wav`, width: null, height: null, frames: null },
});
function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("Expected the fixture operation to fail closed");
}

interface RunnerFixture { store: SqliteProductionStore; dataDir: string; exportId: string; manifest: RenderManifest; exportDir: string; priorExportId: string; vaultRoot: string }
function runnerFixture(): RunnerFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-assembly-runner-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  const projectId = "project-runner";
  // Active pointers stay null: the runner reads manifests/exports/assets only, and project_refs FKs resolve later.
  const project = ProjectSchema.parse({ version: 1, id: projectId, name: "Assembly Runner", profileId: PRODUCTION_PROFILE.id, profile: PRODUCTION_PROFILE, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 90, updatedAt: 90, saveVersion: 1 });
  const canon = (id: string, kind: "location" | "style") => CanonRevisionSchema.parse({ version: 1, id, entityId: id, entityKind: kind, revision: 1, description: `Runner ${kind}`, attributes: {}, referenceAssetIds: [], contentHash: sha(id), createdAt: 100 });
  const story = StoryRevisionSchema.parse({ version: 1, id: "story-1", projectId, parentRevisionId: null, scriptText: "A door opens.", beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [], order: 0 }], canonRevisionIds: [], contentHash: sha("story-1"), createdAt: 110 });
  const shots = [0, 1].map((index) => ShotRevisionSchema.parse({ version: 1, id: `shot-rev-${index}`, shotId: `shot_${index}`, storyRevisionId: "story-1", beatIds: ["beat_1"], order: index, visualIntent: "A door opens.", motionIntent: "A door opens slowly.", castBindings: [], locationRevisionId: "loc", propRevisionIds: [], styleRevisionId: "style", framing: "wide", targetFrames: SHOT_FRAMES, continuation: null, contentHash: sha(`shot-rev-${index}`), createdAt: 120 + index }));
  const plan = ShotPlanRevisionSchema.parse({ version: 1, id: "plan-1", projectId, storyRevisionId: "story-1", orderedShotRevisionIds: shots.map((shot) => shot.id), beatCoverage: [{ beatId: "beat_1", shotRevisionIds: shots.map((shot) => shot.id) }], contentHash: sha("plan-1"), createdAt: 130 });
  const animatic = AnimaticRevisionSchema.parse({ version: 1, id: "animatic-1", projectId, shotPlanRevisionId: "plan-1", slots: shots.map((shot) => ({ shotRevisionId: shot.id, anchorId: null, placeholderLabel: null })), timingAnnotations: [], totalFrames: 2 * SHOT_FRAMES, contentHash: sha("animatic-1"), createdAt: 135 });
  const anchorAsset = AssetSchema.parse({ version: 1, id: "anchor-asset", sha256: sha("anchor-asset"), mime: "image/png", byteSize: 1024, vaultRef: "vault-anchor", width: null, height: null, frames: null, fps: null, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 140 });
  const job = JobSchema.parse({ version: 1, id: "take-job", projectId, operation: "take", status: "queued", idempotencyKey: "take-job-key", requestSnapshot: {}, requestHash: sha("take-job"), providerId: "sogni", modelId: "video-model", providerRef: "take-ref", quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 150, updatedAt: 150 });
  const receipt = HonoredInputsReceiptSchema.parse({ version: 1, id: "take-receipt", jobId: job.id, capabilityProvenance: "sdk_contract", capabilityObservedAt: job.createdAt, inputs: [], createdAt: job.createdAt });
  const anchor = AnchorCandidateSchema.parse({ version: 1, id: "anchor-1", shotRevisionId: "shot-rev-0", assetId: anchorAsset.id, inputsHash: sha("anchor-1"), jobId: job.id, visionAssessment: null, receiptId: null, createdAt: 160 });
  // Take.approvalId pins the anchor approval (services-fixture precedent); take approvals are separate rows.
  const takes = [0, 1].map((index) => TakeSchema.parse({ version: 1, id: `take-${index}`, shotRevisionId: `shot-rev-${index}`, anchorId: anchor.id, approvalId: "anchor-approval", jobId: job.id, assetId: `asset-shot-${index}`, actualFrames: SHOT_FRAMES, inputsHash: sha(`take-${index}`), receiptId: receipt.id, createdAt: 170 + index }));
  const shotAssets = [0, 1].map((index) => AssetSchema.parse({ version: 1, id: `asset-shot-${index}`, sha256: sha(`asset-shot-${index}`), mime: "video/mp4", byteSize: 8192, vaultRef: `vault-shot-${index}`, width: 16, height: 16, frames: SHOT_FRAMES, fps: 24, audioSamples: null, sourceKind: "fixture", sourceJobId: job.id, rightsStatus: "creator_attested", createdAt: 180 + index }));
  const narrationAsset = AssetSchema.parse({ version: 1, id: "asset-narration", sha256: sha("asset-narration"), mime: "audio/wav", byteSize: 4096, vaultRef: "vault-narration", width: null, height: null, frames: null, fps: null, audioSamples: 48_000, sourceKind: "upload", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 190 });
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
    tx.appendApproval(ApprovalSchema.parse({ version: 1, id: "anchor-approval", targetKind: "anchor", targetId: anchor.id, targetHash: computeAnchorApprovalHash(tx, anchor), decision: "approved", actorId: "local-creator", createdAt: 210, checklist: [{ id: "review", passed: true, note: "Runner fixture" }], notes: "", advisoryAcknowledgements: [] }));
    for (const index of [0, 1]) {
      tx.insertTake(takes[index]!);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `take-${index}-approval`, targetKind: "take", targetId: takes[index]!.id, targetHash: computeTakeApprovalHash(tx, takes[index]!), decision: "approved", actorId: "local-creator", createdAt: 200 + index, checklist: [{ id: "review", passed: true, note: "Runner fixture" }], notes: "", advisoryAcknowledgements: [] }));
    }
  });
  const manifest = manifestFixture({ transitions: ["cut", "cut"], cues: [narrationCue()], projectId, audioMixRevisionId: null });
  store.transaction((tx) => tx.insertManifest(manifest));
  const insertExport = (id: string, at: number): ExportRecord => {
    const record = ExportSchema.parse({ version: 1, id, manifestId: manifest.id, jobId: null, assetId: null, qcReportId: null, status: "queued", createdAt: at, approvedSha256: null, finalApprovalId: null });
    store.transaction((tx) => tx.insertExport(record));
    return record;
  };
  const exportId = insertExport("export-runner", 300).id;
  const priorExportId = insertExport("export-runner-prior", 299).id;
  const vaultRoot = join(dataDir, "media-src");
  return { store, dataDir, exportId, manifest, exportDir: join(dataDir, "exports", exportId), priorExportId, vaultRoot };
}
async function seedVault(root: string, refs: string[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const ref of refs) await writeFile(join(root, `${ref}.bin`), Buffer.from(`bytes:${ref}`), { mode: 0o600 });
}
const stubVault = (root: string) => ({
  async readVerified(vaultRef: string, _expected: string) { return readFile(join(root, `${vaultRef}.bin`)); },
  async putStream(stream: NodeJS.ReadableStream) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) void chunk;
    return {
      asset: AssetSchema.parse({ version: 1, id: `published-${randomUUID()}`, sha256: sha("published-bytes"), mime: "video/mp4", byteSize: 16, vaultRef: `vault-published-${randomUUID()}`, width: 1080, height: 1920, frames: 48, fps: 24, audioSamples: null, sourceKind: "derived", sourceJobId: null, rightsStatus: "unknown", createdAt: 1_000 }),
      verifiedAt: 1_000, checksumVerified: true as const,
    };
  },
  async createReadStream(vaultRef: string) { const { createReadStream } = await import("node:fs"); return createReadStream(join(root, `${vaultRef}.bin`)); },
});

interface AssembleStub { calls: number; render: (manifest: RenderManifest, options: { workDir: string; signal?: AbortSignal }) => Promise<AssemblyOutput> }
function stubAssemble(behavior?: Partial<AssemblyOutput> | ((manifest: RenderManifest, workDir: string) => Promise<Partial<AssemblyOutput>>)): AssembleStub {
  const stub: AssembleStub = {
    calls: 0,
    async render(manifest, options) {
      stub.calls += 1;
      const partial = typeof behavior === "function" ? await behavior(manifest, options.workDir) : behavior ?? {};
      const outputPath = partial.outputPath ?? join(options.workDir, exportOutputName(manifest));
      await writeFile(outputPath, Buffer.from("stubbed-output"), { mode: 0o600 });
      return {
        outputPath, sha256: partial.sha256 ?? sha("stubbed-output"),
        probe: partial.probe ?? { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48, durationTs: 2359296, timeBaseNum: 1, timeBaseDen: 49152 }, audio: null },
        args: partial.args ?? [], filterComplex: partial.filterComplex ?? "", totalFrames: partial.totalFrames ?? 48,
      };
    },
  };
  return stub;
}

describe("C11-FULL assembly plan (pure)", () => {
  it("is byte-identical for identical manifests regardless of input key order", () => {
    const manifest = manifestFixture({ transitions: ["crossfade", "cut"], cues: [narrationCue()] });
    const shuffled = RenderManifestSchema.parse(JSON.parse(JSON.stringify({
      createdAt: 1_000, inputsHash: manifest.inputsHash, captionCues: [], audioCues: manifest.audioCues, shots: manifest.shots,
      profile: manifest.profile, audioMixRevisionId: manifest.audioMixRevisionId, animaticRevisionId: manifest.animaticRevisionId,
      shotPlanRevisionId: manifest.shotPlanRevisionId, storyRevisionId: manifest.storyRevisionId, projectId: manifest.projectId,
      id: manifest.id, version: 1,
    })));
    expect(shuffled).toEqual(manifest);
    const staged = twoShotStaged("/staged");
    const planA = buildAssemblyPlan(manifest, staged);
    const planB = buildAssemblyPlan(shuffled, { "asset-narration": staged["asset-narration"]!, "asset-shot-1": staged["asset-shot-1"]!, "asset-shot-0": staged["asset-shot-0"]! });
    expect(planB.filterComplex).toBe(planA.filterComplex);
    expect([...planB.args]).toEqual([...planA.args]);
    expect(planA.totalFrames).toBe(2 * SHOT_FRAMES - 8);
    expect(planA.audioCueCount).toBe(1);
  });

  it("derives trim, crop, gain, adelay and crossfade offsets exactly from manifest integers", () => {
    const manifest = manifestFixture({ transitions: ["crossfade", "cut"], cues: [narrationCue({ gainDb: -6 })] });
    const plan = buildAssemblyPlan(manifest, twoShotStaged("/staged"));
    const complex = plan.filterComplex;
    expect(complex).toContain("[0:v]trim=start_frame=0:end_frame=24,");
    expect(complex).toContain("crop=w=16:h=16:x=0:y=0");
    expect(complex).toContain("xfade=transition=fade:duration=0.333333333:offset=0.666666667");
    expect(complex).toContain("volume=-6dB");
    expect(complex).toContain("atrim=start_sample=0:end_sample=24000");
    expect(complex).toContain("adelay=1000|1000");
    expect(complex).toContain("amix=inputs=1:normalize=0:dropout_transition=0");
    expect(complex).toContain("loudnorm=I=-14:TP=-1:LRA=11");
    expect(plan.totalFrames).toBe(2 * SHOT_FRAMES - 8);
    const argv = plan.args.join(" ");
    expect(argv).toContain("-c:v libx264 -profile:v high -preset medium -crf 18 -pix_fmt yuv420p");
    expect(argv).toContain("-color_primaries bt709 -color_trc bt709 -colorspace bt709");
    expect(argv).toContain("-movflags +faststart");
    expect(argv).toContain("-c:a aac -b:a 192k -ar 48000 -ac 2");
    const silent = buildAssemblyPlan(manifestFixture(), {
      "asset-shot-0": { path: "/staged/shot0.mp4", width: 16, height: 16, frames: SHOT_FRAMES },
      "asset-shot-1": { path: "/staged/shot1.mp4", width: 16, height: 16, frames: SHOT_FRAMES },
    });
    expect(silent.audioCueCount).toBe(0);
    expect(silent.args).not.toContain("-c:a");
    expect(silent.args).toContain("-an");
  });

  it("rejects inputs over the assembly cap and binds the output name to the inputs hash", () => {
    const many = manifestFixture({ transitions: Array.from({ length: 513 }, () => "cut" as const) });
    const staged: Record<string, StagedAssemblyAsset> = {};
    for (const shot of many.shots) staged[shot.assetId] = { path: "/staged/x.mp4", width: 16, height: 16, frames: SHOT_FRAMES };
    const error = failOf(() => buildAssemblyPlan(many, staged));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toMatch(new RegExp(String(512)));
    const manifest = manifestFixture();
    expect(exportOutputName(manifest)).toBe(`export-${manifest.inputsHash}.mp4`);
  });

  it("redacts stderr paths and secret assignments", () => {
    const redacted = redactStderr("Error opening /Users/creator/films/take-0.mp4 with api_key=sk-123 and token: abc123; C:\\films\\secret\\out.mp4 done", { dataDir: "/Users/creator/films" });
    expect(redacted).not.toMatch(/Users|films|sk-123|abc123/);
    expect(redacted).toContain("[local-path]");
    expect(redacted).toContain("[redacted]");
    const capped = redactStderr(`x${"y".repeat(3_000)}`, { dataDir: "/nowhere" });
    expect(capped.length).toBeLessThanOrEqual(2_000);
  });

  it("profiles.ts re-exports the accepted domain builder and freezes the encoder recipe", () => {
    expect(profilesBuildRenderProfile).toBe(manifestDomain.buildRenderProfile);
    expect(Object.isFrozen(ASSEMBLY_ENCODER_RECIPE)).toBe(true);
    expect(ASSEMBLY_ENCODER_RECIPE).toMatchObject({ videoCodec: "libx264", profile: "high", preset: "medium", crf: 18, pixelFormat: "yuv420p", fps: 24, movFlags: "+faststart", audioCodec: "aac", audioBitrate: "192k", sampleRate: 48_000, channels: 2 });
  });
});

describe("C11-FULL fixture render (REQUIRED evidence)", () => {
  it("renders a 2-shot all-cut manifest with narration into a playable MP4 of the pinned shape", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "perabyte-assembly-render-")); dirs.push(workDir);
    const shot0 = join(workDir, "fixture-shot-0.mp4"); const shot1 = join(workDir, "fixture-shot-1.mp4"); const narration = join(workDir, "fixture-narration.wav");
    await videoFixture(shot0, "red", SHOT_FRAMES);
    await videoFixture(shot1, "blue", SHOT_FRAMES);
    await wavFixture(narration);
    const manifest = manifestFixture({ transitions: ["cut", "cut"], cues: [narrationCue()] });
    const stage = await stageFrom({ "asset-shot-0": shot0, "asset-shot-1": shot1, "asset-narration": narration });
    const output = await assembleManifest(manifest, { workDir, paths: localTools(), stageAsset: stage });
    expect(output.probe.video).toMatchObject({ codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48 });
    expect(output.probe.audio).toMatchObject({ codec: "aac", sampleRate: 48_000, channels: 2 });
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.args[0]).toBe("-nostdin");
    const probed = JSON.parse((await execFileAsync(localTools().ffprobe, ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,nb_read_frames,duration_ts,time_base", "-of", "json", output.outputPath])).stdout) as { streams: Array<Record<string, string>> };
    const video = probed.streams.find((stream) => stream.codec_name === "h264")!;
    const audio = probed.streams.find((stream) => stream.codec_name === "aac")!;
    expect(video).toMatchObject({ width: 1080, height: 1920, pix_fmt: "yuv420p", avg_frame_rate: "24/1", nb_read_frames: "48" });
    expect(audio).toMatchObject({ sample_rate: "48000", channels: 2 });
    const [, tbn] = video.time_base!.split("/").map(Number);
    expect(Math.abs(Number(video.duration_ts) * 24 - 48 * tbn!)).toBeLessThanOrEqual(tbn!);
    await execFileAsync(localTools().ffmpeg, ["-v", "error", "-xerror", "-i", output.outputPath, "-f", "null", "-"], { timeout: 60_000 });
    const rerun = await assembleManifest(manifest, { workDir, paths: localTools(), stageAsset: stage });
    expect(rerun.probe).toEqual(output.probe);
    console.info(`[c11-fixture-render] inputsHash=${manifest.inputsHash} sha256=${output.sha256} rerunSha256=${rerun.sha256}`);
    console.info(`[c11-fixture-render] ffmpeg ${output.args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  }, 120_000);

  it("renders the crossfade variant at the exact overlap total and honors the silent-draft shape", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "perabyte-assembly-xfade-")); dirs.push(workDir);
    const shot0 = join(workDir, "xfade-shot-0.mp4"); const shot1 = join(workDir, "xfade-shot-1.mp4");
    await videoFixture(shot0, "green", SHOT_FRAMES);
    await videoFixture(shot1, "yellow", SHOT_FRAMES);
    const manifest = manifestFixture({ transitions: ["crossfade", "cut"] });
    const output = await assembleManifest(manifest, { workDir, paths: localTools(), stageAsset: await stageFrom({ "asset-shot-0": shot0, "asset-shot-1": shot1 }) });
    expect(output.probe.video.frames).toBe(2 * SHOT_FRAMES - 8);
    expect(output.probe.audio).toBeNull();
    const probed = JSON.parse((await execFileAsync(localTools().ffprobe, ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,nb_read_frames", "-of", "json", output.outputPath])).stdout) as { streams: Array<Record<string, string>> };
    expect(probed.streams.some((stream) => stream.codec_type === "audio")).toBe(false);
    expect(probed.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ nb_read_frames: String(2 * SHOT_FRAMES - 8) });
  }, 120_000);

  it("fails closed when the local media tools named by the environment are unavailable", async () => {
    const error = await probeMediaTools({ ffmpeg: "/nonexistent/c11/ffmpeg", ffprobe: "/nonexistent/c11/ffprobe" }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductionApplicationError);
    expect((error as ProductionApplicationError).code).toBe("MEDIA_UNAVAILABLE");
    expect((error as ProductionApplicationError).message).toMatch(/FFPROBE_PATH/);
    await expect(probeMediaTools({ ffmpeg: localTools().ffmpeg, ffprobe: "/nonexistent/c11/ffprobe" })).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", message: expect.stringMatching(/FFPROBE_PATH/) });
    expect(resolveMediaTools({})).toEqual({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    expect(resolveMediaTools({ FFMPEG_PATH: "/opt/ffmpeg", FFPROBE_PATH: "/opt/ffprobe" })).toEqual({ ffmpeg: "/opt/ffmpeg", ffprobe: "/opt/ffprobe" });
  });
});

describe("C11-FULL export runner", () => {
  it("claims a queued export, publishes once with a content-derived asset id, and is idempotent", async () => {
    const f = runnerFixture();
    await seedVault(f.vaultRoot, ["vault-shot-0", "vault-shot-1", "vault-narration"]);
    const assemble = stubAssemble();
    const first = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, assembleManifest: assemble.render });
    expect(first.status).toBe("qc_pending");
    expect(first.assetId).toBe(`export-asset-${sha("stubbed-output")}`);
    expect(first.jobId).toBeNull();
    expect(f.store.read.getAsset(first.assetId!)?.id).toBe(`export-asset-${sha("stubbed-output")}`);
    expect(assemble.calls).toBe(1);
    const second = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, assembleManifest: assemble.render });
    expect(second.status).toBe("qc_pending");
    expect(assemble.calls).toBe(1);
    expect(f.store.read.getExport(f.priorExportId)?.status).toBe("queued");
    await expect(stat(join(f.exportDir, "lease.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to claim while a fresh lease exists and reclaims an expired rendering lease", async () => {
    const f = runnerFixture();
    const assemble = stubAssemble();
    f.store.transaction((tx) => {
      const current = tx.getExport(f.exportId)!;
      if (!tx.compareAndSetExport({ ...current, status: "rendering" }, "queued")) throw new Error("fixture CAS failed");
    });
    await mkdir(f.exportDir, { recursive: true, mode: 0o700 });
    const lease = (token: string, until: number) => JSON.stringify({ version: 1, exportId: f.exportId, leaseToken: token, leaseUntil: until, heartbeatAt: until - 30_000 });
    await writeFile(join(f.exportDir, "lease.json"), lease("lease-foreign", Date.now() + 60_000), { encoding: "utf8", mode: 0o600 });
    const blocked = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, assembleManifest: assemble.render });
    expect(blocked.status).toBe("rendering");
    expect(assemble.calls).toBe(0);
    await rm(join(f.exportDir, "lease.json"), { force: true });
    await writeFile(join(f.exportDir, "lease.json"), lease("lease-expired", Date.now() - 60_000), { encoding: "utf8", mode: 0o600 });
    const reclaimed = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, assembleManifest: assemble.render });
    expect(reclaimed.status).toBe("qc_pending");
    expect(assemble.calls).toBe(1);
  });

  it("attributes injected failures with stage, shot and redacted stderr without touching prior exports", async () => {
    const f = runnerFixture();
    const failing = stubAssemble(async () => {
      throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Decoding failed for staged input", { details: { stage: "decode-input", shotRevisionId: "shot-rev-0", stderr: "moov atom not found api_key=sk-9 in /private/tmp/render-1/x.mp4" } });
    });
    const failed = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, assembleManifest: failing.render });
    expect(failed.status).toBe("failed");
    const failure = JSON.parse(await readFile(join(f.exportDir, "failure.json"), "utf8")) as Record<string, unknown>;
    expect(failure).toMatchObject({ version: 1, exportId: f.exportId, code: "MEDIA_UNAVAILABLE", stage: "decode-input", shotRevisionId: "shot-rev-0" });
    expect(String(failure.redactedStderr)).not.toMatch(/sk-9|\/private\/tmp/);
    expect(f.store.read.getExport(f.priorExportId)?.status).toBe("queued");
    expect(failing.calls).toBe(1);
  });

  it("cancels an aborted render, kills the child, cleans temp dirs, and publishes no asset", async () => {
    const f = runnerFixture();
    const mediaDir = await mkdtemp(join(tmpdir(), "perabyte-assembly-cancel-")); dirs.push(mediaDir);
    const realShot = join(mediaDir, "real-shot.mp4");
    await videoFixture(realShot, "purple", SHOT_FRAMES);
    await mkdir(f.vaultRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(f.vaultRoot, "vault-shot-0.bin"), await readFile(realShot), { mode: 0o600 });
    // 120 shots = 2880 frames at 1080x1920: far longer than the 500 ms abort fuse, but well
    // under the local decoder-instance limit that 512 simultaneous inputs would hit.
    const long = longManifestFixture(120, "project-runner");
    f.store.transaction((tx) => tx.insertManifest(long));
    f.store.transaction((tx) => {
      const current = tx.getExport(f.exportId)!;
      if (!tx.compareAndSetExport({ ...current, manifestId: long.id }, "queued")) throw new Error("fixture CAS failed");
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const canceled = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, signal: controller.signal });
    expect(canceled.status).toBe("canceled");
    expect(canceled.assetId).toBeNull();
    expect(await readdir(f.exportDir)).toEqual([]);
  }, 60_000);

  it("enforces the staged byte bound before rendering", async () => {
    const f = runnerFixture();
    await seedVault(f.vaultRoot, ["vault-shot-0", "vault-shot-1", "vault-narration"]);
    const restricted = await runExportAssembly(f.exportId, { store: f.store, vault: stubVault(f.vaultRoot), dataDir: f.dataDir, maxStagedBytes: 8 });
    expect(restricted.status).toBe("failed");
    const failure = JSON.parse(await readFile(join(f.exportDir, "failure.json"), "utf8")) as Record<string, unknown>;
    expect(failure.code).toBe("INVALID_INPUT");
    expect(String(failure.stage)).toBe("stage");
  });

  it("drives queued exports one at a time through the per-process scheduler", async () => {
    const f = runnerFixture();
    const scheduling = stubAssemble(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { sha256: sha(`out-${Math.random()}`) }; });
    let peak = 0; let active = 0;
    const tracked = stubAssemble();
    tracked.render = async (manifest, options) => { active += 1; peak = Math.max(peak, active); try { return await scheduling.render(manifest, options); } finally { active -= 1; } };
    const scheduler = createExportAssemblyScheduler({ dataDir: f.dataDir, vault: stubVault(f.vaultRoot), withStore: async (work) => work(f.store), assembleManifest: tracked.render });
    scheduler.trigger("project-runner");
    scheduler.trigger("project-runner");
    await scheduler.whenIdle();
    expect(scheduling.calls).toBeGreaterThanOrEqual(2);
    expect(peak).toBe(1);
    expect(f.store.read.getExport(f.exportId)?.status).toBe("qc_pending");
    expect(f.store.read.getExport(f.priorExportId)?.status).toBe("qc_pending");
  });
});
