import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AnchorCandidateSchema, AnimaticRevisionSchema, ApprovalSchema, AssetSchema, CanonRevisionSchema,
  ExportSchema, HonoredInputsReceiptSchema, JobSchema, ProjectSchema, RenderManifestSchema, SceneSchema,
  ShotPlanRevisionSchema, ShotRevisionSchema, StoryRevisionSchema, TakeSchema, WorkspaceSchema,
  type RenderManifest,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import {
  MANIFEST_MASTERING_RECIPE_VERSION, buildRenderProfile, compileManifestTimeline, manifestId,
  manifestInputsHash, type ManifestCompileModel, type ManifestShotSource,
} from "../../production/manifest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import { computeAnchorApprovalHash } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { hashCanonicalJson } from "../../production/hash";
import {
  PACKAGE_ENTRY_NAMES, buildChaptersDefault, buildExportPackage, buildPackageDescriptor,
  buildSidecarTexts, buildStoredZip, computePackageTimeline, crc32, createExportPackageRouteHandlers,
  extractThumbnailFrame, loadPackageOverrides, packageCacheKey, resolvePackageMetadata,
  savePackageOverrides, thumbnailScaleFilter, thumbnailSeekSeconds,
} from "./package";
import { LocalMediaVault } from "./vault";

const execFileAsync = promisify(execFile);
const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const localFfmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const dirs: string[] = [];
const stores: Array<SqliteProductionStore> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

// ---------------------------------------------------------------------------
// A minimal unzip reader: walks the central directory, verifies the stored
// method, sizes and CRC of every entry, and returns the entry bytes.
// ---------------------------------------------------------------------------

function readZipEntries(zip: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let offset = zip.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record found");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error(`bad central directory signature at entry ${index}`);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    if (view.getUint16(localOffset + 8, true) !== 0) throw new Error(`entry ${name} is not stored`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + extraLength;
    const data = zip.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    entries.push({ name, data });
    cursor += 46 + nameLength;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Fixtures: a real two-shot manifest with captions and an approved export.
// ---------------------------------------------------------------------------

const PRODUCTION_PROFILE = { id: "storybook-short-v1", format: "9:16" as const, language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null };
const profile = buildRenderProfile(PRODUCTION_PROFILE);
const CAPTIONS = [
  { text: "A lantern fox steps into the clearing.", startFrame: 0, endFrame: 24 },
  { text: "The child follows the light.", startFrame: 24, endFrame: 48 },
];

function manifestFixture(options: { shotFrames?: number[]; transitions?: Array<"cut" | "crossfade">; captions?: Array<{ text: string; startFrame: number; endFrame: number }>; projectId?: string } = {}): RenderManifest {
  const shotFrames = options.shotFrames ?? [24, 24];
  const transitions = options.transitions ?? ["cut", "cut"];
  const projectId = options.projectId ?? "project-package";
  const shots = shotFrames.map((frames, index) => ({
    shotRevisionId: `shot-rev-${index}`, takeId: `take-${index}`, assetId: `asset-shot-${index}`,
    startFrame: 0, endFrame: frames, crop: { x: 0, y: 0, width: 16, height: 16 }, transition: transitions[index]!,
  }));
  const modelShots: ManifestShotSource[] = shots.map((shot) => ({
    ...shot, shotHash: sha(shot.shotRevisionId), takeInputsHash: sha(shot.takeId), assetSha256: sha(shot.assetId),
    assetWidth: 16, assetHeight: 16, actualFrames: shot.endFrame,
  }));
  const totalFrames = compileManifestTimeline(modelShots);
  const model: ManifestCompileModel = {
    projectId, storyRevisionId: "story-1", storyHash: sha("story-1"),
    shotPlanRevisionId: "plan-1", shotPlanHash: sha("plan-1"), animaticRevisionId: "animatic-1", animaticHash: sha("animatic-1"),
    audioMixRevisionId: null, audioMixHash: null,
    profile, shots: modelShots, audioCues: [], captionCues: [],
    totalFrames, totalAudioSamples: totalFrames * 2000, selectionVersion: 1,
    masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
  };
  const inputsHash = manifestInputsHash(model);
  return RenderManifestSchema.parse({
    version: 1, id: manifestId(inputsHash), projectId, storyRevisionId: model.storyRevisionId,
    shotPlanRevisionId: model.shotPlanRevisionId, animaticRevisionId: model.animaticRevisionId,
    audioMixRevisionId: null, profile, shots, audioCues: [], captionCues: options.captions ?? CAPTIONS, inputsHash, createdAt: 1_000,
  });
}

interface PackageFixture { store: SqliteProductionStore; dataDir: string; vault: LocalMediaVault; projectId: string; master: { sha256: string; bytes: Uint8Array } }

async function storeFixture(manifest: RenderManifest, videoOptions: { width: number; height: number; frames: number }): Promise<PackageFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-package-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  const projectId = manifest.projectId;
  const project = ProjectSchema.parse({
    version: 1, id: projectId, name: "The Lantern Fox", profileId: PRODUCTION_PROFILE.id, profile: PRODUCTION_PROFILE,
    activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null,
    activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, workspaceId: "workspace-1",
    takeSelectionVersion: 1, audioMixVersion: 0, createdAt: 1, updatedAt: 2, saveVersion: 1,
  });
  const workspace = WorkspaceSchema.parse({
    version: 1, id: "workspace-1", name: "Lantern Studio", characterCanonIds: [], environmentCanonIds: [], styleCanonIds: [],
    worldBible: { version: 1, summary: "A lantern fox world.", entries: [{ id: "entry-1", title: "Origins", body: "The fox carries a lantern.", tags: ["mythology", "lantern-fox"] }] },
    productionRecipe: { version: 1, qualityStrategy: "balanced", aspectRatio: "9:16", language: "en", defaultShotTargetFrames: 48 },
    rating: "General", budgetPolicyId: null, createdAt: 1, updatedAt: 1, saveVersion: 1,
  });
  const plan = ShotPlanRevisionSchema.parse({ version: 1, id: "plan-1", projectId, storyRevisionId: "story-1", orderedShotRevisionIds: ["shot-rev-0", "shot-rev-1"], beatCoverage: [{ beatId: "beat_1", shotRevisionIds: ["shot-rev-0", "shot-rev-1"] }], contentHash: sha("plan-1"), createdAt: 130 });
  const animatic = AnimaticRevisionSchema.parse({ version: 1, id: "animatic-1", projectId, shotPlanRevisionId: "plan-1", slots: manifest.shots.map((shot) => ({ shotRevisionId: shot.shotRevisionId, anchorId: null, placeholderLabel: null })), timingAnnotations: [], totalFrames: manifest.shots.reduce((sum, shot) => sum + shot.endFrame - shot.startFrame, 0), contentHash: sha("animatic-1"), createdAt: 135 });
  const canon = (id: string, kind: "location" | "style") => CanonRevisionSchema.parse({ version: 1, id, entityId: id, entityKind: kind, revision: 1, description: `Package ${kind}`, attributes: {}, referenceAssetIds: [], contentHash: sha(id), createdAt: 100 });
  const story = StoryRevisionSchema.parse({ version: 1, id: "story-1", projectId, parentRevisionId: null, scriptText: "A lantern fox appears.", beats: [{ id: "beat_1", action: "A lantern fox appears.", narration: "A lantern fox appears.", dialogue: [], order: 0 }], canonRevisionIds: ["loc", "style"], contentHash: sha("story-1"), createdAt: 110 });
  const shotRevisions = manifest.shots.map((shot, index) => ShotRevisionSchema.parse({
    version: 1, id: shot.shotRevisionId, shotId: `shot_${index}`, storyRevisionId: "story-1", beatIds: ["beat_1"],
    order: index, visualIntent: index === 0 ? "A lantern fox steps into the clearing." : "The child follows the light.",
    motionIntent: "slow push in", castBindings: [], locationRevisionId: "loc", propRevisionIds: [], styleRevisionId: "style",
    framing: "wide", targetFrames: shot.endFrame - shot.startFrame, continuation: null, contentHash: sha(shot.shotRevisionId), createdAt: 10 + index,
  }));
  const scenes = [
    SceneSchema.parse({ version: 1, id: "scene-1", projectId, storyRevisionId: "story-1", order: 0, title: "The clearing", action: "A lantern fox appears.", dialogue: [], durationTargetMs: null, characterStates: [], environmentState: null, contentHash: sha("scene-1"), createdAt: 20 }),
    SceneSchema.parse({ version: 1, id: "scene-2", projectId, storyRevisionId: "story-1", order: 1, title: "The following", action: "The child follows.", dialogue: [], durationTargetMs: null, characterStates: [], environmentState: null, contentHash: sha("scene-2"), createdAt: 21 }),
  ];
  // The master: a real locally rendered mp4 so the ffmpeg thumbnail extract runs for real.
  const masterPath = join(dataDir, "fixture-master.mp4");
  await execFileAsync(localFfmpeg, [
    "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${videoOptions.width}x${videoOptions.height}:r=24`,
    "-frames:v", String(videoOptions.frames), "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", masterPath,
  ], { timeout: 30_000 });
  const masterBytes = new Uint8Array(await readFile(masterPath));
  await rm(masterPath, { force: true });
  const vault = new LocalMediaVault({ root: join(dataDir, "media") });
  const stored = await vault.put(masterBytes, { mime: "video/mp4", sourceKind: "fixture" });
  const exportRecord = ExportSchema.parse({
    version: 1, id: "export-pkg", manifestId: manifest.id, jobId: null, assetId: stored.asset.id, qcReportId: "qc-1",
    status: "approved", createdAt: 300, approvedSha256: stored.asset.sha256, finalApprovalId: "final-approval",
  });
  store.transaction((tx) => {
    tx.insertProject(project);
    tx.insertWorkspace(workspace);
    tx.insertCanonRevision(canon("loc", "location"));
    tx.insertCanonRevision(canon("style", "style"));
    tx.insertStoryRevision(story);
    tx.insertShotRevisions(shotRevisions);
    tx.insertShotPlanRevision(plan);
    tx.insertAnimaticRevision(animatic);
    // Minimal accepted anchor/take/approval chains so the fixture store stays structurally honest.
    const anchorAsset = AssetSchema.parse({ version: 1, id: "anchor-asset", sha256: sha("anchor-asset"), mime: "image/png", byteSize: 64, vaultRef: `sha256-${sha("anchor-asset")}`, width: null, height: null, frames: null, fps: null, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 140 });
    const shotAssets = manifest.shots.map((shot, index) => AssetSchema.parse({ version: 1, id: shot.assetId, sha256: sha(shot.assetId), mime: "video/mp4", byteSize: 8192, vaultRef: `sha256-${sha(shot.assetId)}`, width: 16, height: 16, frames: shot.endFrame - shot.startFrame, fps: 24, audioSamples: null, sourceKind: "fixture", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 180 + index }));
    tx.insertAsset({ asset: anchorAsset, verifiedAt: 140, checksumVerified: true });
    for (const asset of shotAssets) tx.insertAsset({ asset, verifiedAt: 181, checksumVerified: true });
    for (const scene of scenes) tx.upsertScene(scene);
    for (const index of [0, 1]) {
      const job = JobSchema.parse({ version: 1, id: `job-${index}`, projectId, operation: "take", status: "queued", idempotencyKey: `pkg-key-${index}`, requestSnapshot: {}, requestHash: sha(`job-${index}`), providerId: "sogni", modelId: "video-model", providerRef: `ref-${index}`, quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 150, updatedAt: 150 });
      tx.insertJob(job, { id: `outbox-${index}`, jobId: job.id, createdAt: job.createdAt, claimedAt: null, claimToken: null });
      tx.insertHonoredInputsReceipt(HonoredInputsReceiptSchema.parse({ version: 1, id: `receipt-${index}`, jobId: job.id, capabilityProvenance: "sdk_contract", capabilityObservedAt: 150, inputs: [], createdAt: 150 }));
    }
    let selectionVersion = project.takeSelectionVersion;
    for (const [index, shot] of manifest.shots.entries()) {
      const anchor = AnchorCandidateSchema.parse({ version: 1, id: `anchor-${index}`, shotRevisionId: shot.shotRevisionId, assetId: anchorAsset.id, inputsHash: sha(`anchor-${index}`), jobId: `job-${index}`, visionAssessment: null, receiptId: `receipt-${index}`, createdAt: 160 + index });
      tx.insertAnchor(anchor);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `anchor-${index}-approval`, targetKind: "anchor", targetId: anchor.id, targetHash: computeAnchorApprovalHash(tx, anchor), decision: "approved", actorId: "local-creator", createdAt: 210 + index, checklist: [{ id: "review", passed: true, note: "fixture" }], notes: "", advisoryAcknowledgements: [] }));
      const take = TakeSchema.parse({ version: 1, id: shot.takeId, shotRevisionId: shot.shotRevisionId, anchorId: anchor.id, approvalId: `anchor-${index}-approval`, jobId: `job-${index}`, assetId: shot.assetId, actualFrames: shot.endFrame - shot.startFrame, inputsHash: sha(shot.takeId), receiptId: `receipt-${index}`, createdAt: 170 + index });
      tx.insertTake(take);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: `${take.id}-approval`, targetKind: "take", targetId: take.id, targetHash: computeTakeApprovalHash(tx, take), decision: "approved", actorId: "local-creator", createdAt: 220 + index, checklist: [{ id: "review", passed: true, note: "fixture" }], notes: "", advisoryAcknowledgements: [] }));
      if (!tx.compareAndSetSelectedTake(projectId, `shot_${index}`, take.id, selectionVersion++)) throw new Error("fixture selection failed");
    }
    // The manifest pins its takes and shot assets, so it lands after them; the export follows.
    tx.insertManifest(manifest);
    tx.insertAsset({ asset: stored.asset, verifiedAt: 400, checksumVerified: true });
    tx.insertExport(exportRecord);
  });
  return { store, dataDir, vault, projectId, master: { sha256: stored.asset.sha256, bytes: masterBytes } };
}

let ffmpegUsable = false;
try {
  await execFileAsync(localFfmpeg, ["-version"], { timeout: 15_000 });
  ffmpegUsable = true;
} catch {
  console.info("[m4-5-package] local ffmpeg unavailable (set FFMPEG_PATH); zip build, thumbnail, and route end-to-end tests are skipped — nothing faked.");
}
const conditional = (name: string, fn: () => void, timeout?: number) => (ffmpegUsable ? it(name, fn, timeout) : it.skip(name, fn, timeout));

// ---------------------------------------------------------------------------

describe("stored zip writer", () => {
  it("matches the IEEE CRC-32 vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips entries in order with stored bytes and verified CRCs", () => {
    const encoder = new TextEncoder();
    const entries = [
      { name: "video.mp4", data: new Uint8Array([0, 1, 2, 3, 250, 251]) },
      { name: "title.txt", data: encoder.encode("The Lantern Fox\n") },
      { name: "captions.srt", data: encoder.encode("1\n00:00:00,000 --> 00:00:01,000\nHi\n") },
    ];
    const zip = buildStoredZip(entries);
    const parsed = readZipEntries(zip);
    expect(parsed.map((entry) => entry.name)).toEqual(["video.mp4", "title.txt", "captions.srt"]);
    expect(Buffer.from(parsed[0]!.data).equals(Buffer.from(entries[0]!.data))).toBe(true);
    expect(new TextDecoder().decode(parsed[1]!.data)).toBe("The Lantern Fox\n");
  });

  it("is byte-deterministic for identical entries", () => {
    const entries = [{ name: "a.bin", data: new Uint8Array([9, 8, 7]) }, { name: "b.txt", data: new TextEncoder().encode("x") }];
    expect(Buffer.from(buildStoredZip(entries)).equals(Buffer.from(buildStoredZip(entries)))).toBe(true);
  });

  it("rejects empty entry lists, duplicates, and unsafe names", () => {
    expect(() => buildStoredZip([])).toThrow(ProductionApplicationError);
    expect(() => buildStoredZip([{ name: "a", data: new Uint8Array([1]) }, { name: "a", data: new Uint8Array([2]) }])).toThrow(ProductionApplicationError);
    expect(() => buildStoredZip([{ name: "../escape", data: new Uint8Array([1]) }])).toThrow(ProductionApplicationError);
  });
});

describe("package timeline and sidecars", () => {
  it("computes crossfade-aware output start frames", () => {
    const cut = computePackageTimeline(manifestFixture(), new Map([["shot-rev-0", "A lantern fox steps into the clearing."]]));
    expect(cut.totalFrames).toBe(48);
    expect(cut.shots.map((shot) => shot.timelineStartFrame)).toEqual([0, 24]);
    expect(cut.shots[0]!.label).toBe("A lantern fox steps into the clearing.");
    expect(cut.shots[1]!.label).toBe("shot-rev-1");
    const crossfaded = computePackageTimeline(manifestFixture({ transitions: ["crossfade", "cut"] }));
    expect(crossfaded.totalFrames).toBe(40);
    expect(crossfaded.shots.map((shot) => shot.timelineStartFrame)).toEqual([0, 16]);
  });

  it("fails closed on a crossfading final shot or an overlap-too-short shot", () => {
    const base = manifestFixture();
    const crossfadeFinal = RenderManifestSchema.parse({ ...base, shots: [base.shots[0], { ...base.shots[1]!, transition: "crossfade" }] });
    expect(() => computePackageTimeline(crossfadeFinal)).toThrow(/is the final shot and must cut/);
    expect(() => computePackageTimeline(manifestFixture({ shotFrames: [4, 24], transitions: ["crossfade", "cut"] }))).toThrow(ProductionApplicationError);
  });

  it("builds chapters with frozen M:SS stamps and truncates labels to 100 characters", () => {
    const timeline = computePackageTimeline(manifestFixture(), new Map([["shot-rev-0", "x".repeat(120)]]));
    const chapters = buildChaptersDefault(timeline);
    expect(chapters).toBe(`${"0:00"} ${"x".repeat(100)}\n0:01 shot-rev-1`);
  });

  it("emits the six text sidecars from the effective metadata and descriptor", () => {
    const manifest = manifestFixture();
    const timeline = computePackageTimeline(manifest, new Map([
      ["shot-rev-0", "A lantern fox steps into the clearing."],
      ["shot-rev-1", "The child follows the light."],
    ]));
    const descriptor = buildPackageDescriptor({
      project: ProjectSchema.parse({ version: 1, id: "project-package", name: "The Lantern Fox", profileId: PRODUCTION_PROFILE.id, profile: PRODUCTION_PROFILE, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 2, saveVersion: 1 }),
      manifest, timeline,
      metadata: { title: "The Lantern Fox", description: "The clearing\nThe following", hashtags: "#Mythology", chapters: buildChaptersDefault(timeline) },
      workspace: { productionRecipe: { qualityStrategy: "balanced" } },
      overriddenFields: ["hashtags"], generatedAt: 5_000,
    });
    const texts = buildSidecarTexts({ metadata: descriptor.metadata, captions: manifest.captionCues, fps: timeline.fps, descriptor });
    expect(texts["title.txt"]).toBe("The Lantern Fox\n");
    expect(texts["description.txt"]).toBe("The clearing\nThe following\n");
    expect(texts["hashtags.txt"]).toBe("#Mythology\n");
    expect(texts["chapters.txt"]).toBe("0:00 A lantern fox steps into the clearing.\n0:01 The child follows the light.\n");
    expect(texts["captions.srt"]).toContain("1\n00:00:00,000 --> 00:00:01,000\nA lantern fox steps into the clearing.");
    const parsedDescriptor = JSON.parse(texts["production.json"]) as { production: { projectId: string; recipe: { qualityStrategy: string | null } }; manifest: { inputsHash: string; totalFrames: number }; generatedAt: number; disclaimer: string };
    expect(parsedDescriptor.production.projectId).toBe("project-package");
    expect(parsedDescriptor.production.recipe!.qualityStrategy).toBe("balanced");
    expect(parsedDescriptor.manifest.inputsHash).toBe(manifest.inputsHash);
    expect(parsedDescriptor.manifest.totalFrames).toBe(48);
    expect(parsedDescriptor.generatedAt).toBe(5_000);
    expect(parsedDescriptor.disclaimer).toMatch(/Manual upload only/);
  });

  it("nulls the recipe without a workspace and keeps selected take ids in plan order", () => {
    const manifest = manifestFixture();
    const descriptor = buildPackageDescriptor({
      project: ProjectSchema.parse({ version: 1, id: "project-package", name: "Solo", profileId: PRODUCTION_PROFILE.id, profile: PRODUCTION_PROFILE, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 2, saveVersion: 1 }),
      manifest, timeline: computePackageTimeline(manifest),
      metadata: { title: "Solo", description: "Solo", hashtags: "", chapters: "" },
      workspace: null, overriddenFields: [], generatedAt: 1,
    });
    expect(descriptor.production.recipe).toBeNull();
    expect(descriptor.production.selectedTakeIds).toEqual(["take-0", "take-1"]);
  });
});

describe("metadata overrides and cache key", () => {
  it("merges field by field: nonblank edits win, whitespace or null falls back", () => {
    const merged = resolvePackageMetadata(
      { version: 1, exportId: "export-pkg", title: "  My Title  ", description: null, hashtags: "   ", chapters: "0:00 One", updatedAt: 1 },
      { title: "Default", description: "Default", hashtags: "#Default", chapters: "0:00 Default" },
    );
    expect(merged).toEqual({ title: "My Title", description: "Default", hashtags: "#Default", chapters: "0:00 One" });
  });

  it("persists overrides atomically and merges partial saves with previous values", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "perabyte-overrides-")); dirs.push(dataDir);
    expect(await loadPackageOverrides(dataDir, "export-pkg")).toBeNull();
    await savePackageOverrides(dataDir, "export-pkg", { title: "Saved Title", description: "Saved description" }, { now: () => 10 });
    const first = await loadPackageOverrides(dataDir, "export-pkg");
    expect(first).toMatchObject({ version: 1, exportId: "export-pkg", title: "Saved Title", description: "Saved description", hashtags: null, chapters: null, updatedAt: 10 });
    await savePackageOverrides(dataDir, "export-pkg", { hashtags: "#Saved" }, { now: () => 20 });
    expect(await loadPackageOverrides(dataDir, "export-pkg")).toMatchObject({ title: "Saved Title", hashtags: "#Saved", updatedAt: 20 });
    await expect(savePackageOverrides(dataDir, "export-pkg", {}, { now: () => 30 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(savePackageOverrides(dataDir, "export-pkg", { title: "x".repeat(500) }, { now: () => 40 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await writeFileRaw(join(dataDir, "exports", "export-pkg", "package-overrides.json"), "{ not json");
    expect(await loadPackageOverrides(dataDir, "export-pkg")).toBeNull();
  });

  it("keys the cache on every package input", () => {
    const manifest = manifestFixture();
    const overrides = { version: 1 as const, exportId: "export-pkg", title: "T", description: null, hashtags: null, chapters: null, updatedAt: 1 };
    const base = { exportId: "export-pkg", manifest, assetSha256: sha("master"), overrides: null };
    expect(packageCacheKey(base)).toBe(packageCacheKey({ ...base }));
    expect(packageCacheKey(base)).not.toBe(packageCacheKey({ ...base, assetSha256: sha("other") }));
    expect(packageCacheKey(base)).not.toBe(packageCacheKey({ ...base, overrides }));
    expect(packageCacheKey(base)).not.toBe(packageCacheKey({ ...base, manifest: manifestFixture({ captions: [] }) }));
    expect(packageCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("thumbnail seek and scale helpers", () => {
  it("seeks ~10% into the runtime, clamped inside the duration", () => {
    expect(thumbnailSeekSeconds(240, 24)).toBe("1.000");
    expect(thumbnailSeekSeconds(25, 24)).toBe("0.083");
    expect(thumbnailSeekSeconds(5, 24)).toBe("0.000");
    expect(thumbnailSeekSeconds(1, 24)).toBe("0.000");
    expect(() => thumbnailSeekSeconds(0, 24)).toThrow(ProductionApplicationError);
  });

  it("scales only past the long-edge cap, never upscaling, with a probing fallback", () => {
    expect(thumbnailScaleFilter(1920, 1080)).toBeNull();
    expect(thumbnailScaleFilter(1080, 1920)).toBeNull();
    expect(thumbnailScaleFilter(1280, 720)).toBeNull();
    expect(thumbnailScaleFilter(2560, 1440)).toBe("scale=1920:1080");
    expect(thumbnailScaleFilter(3840, 2160)).toBe("scale=1920:1080");
    expect(thumbnailScaleFilter(2160, 3840)).toBe("scale=1080:1920");
    expect(thumbnailScaleFilter(1000, 1000)).toBeNull();
    const probing = thumbnailScaleFilter(null, null)!;
    expect(probing).toContain("min(1920,iw)");
    expect(probing).toContain("min(1920,ih)");
    expect(() => thumbnailScaleFilter(0, 100)).toThrow(ProductionApplicationError);
  });
});

function writeFileRaw(path: string, contents: string): Promise<void> {
  return writeFile(path, contents, "utf8");
}

describe("end-to-end package build on a real local render", () => {
  conditional("builds the complete package once, then serves the input-keyed cache", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 1280, height: 720, frames: 48 });
    let extractions = 0;
    const countExtract: typeof extractThumbnailFrame = async (options) => { extractions += 1; return extractThumbnailFrame(options); };
    const build = () => buildExportPackage("export-pkg", {
      store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir,
      paths: { ffmpeg: localFfmpeg, ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" }, now: () => 7_000,
      extractThumbnail: countExtract,
    });
    const first = await build();
    expect(first.cacheHit).toBe(false);
    expect(first.builtAt).toBe(7_000);
    const parsed = readZipEntries(first.zip);
    expect(parsed.map((entry) => entry.name)).toEqual([...PACKAGE_ENTRY_NAMES]);
    expect(Buffer.from(parsed[0]!.data).equals(Buffer.from(fixture.master.bytes))).toBe(true);
    expect(parsed[1]!.data.subarray(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const png = sharp(parsed[1]!.data);
    expect((await png.metadata()).width).toBe(1280);
    expect((await png.metadata()).height).toBe(720);
    expect(new TextDecoder().decode(parsed[2]!.data)).toContain("A lantern fox steps into the clearing.");
    expect(new TextDecoder().decode(parsed[3]!.data)).toBe("The Lantern Fox\n");
    expect(new TextDecoder().decode(parsed[4]!.data)).toBe("The clearing\nThe following\n");
    expect(new TextDecoder().decode(parsed[5]!.data)).toBe("#Lantern #Studio #Mythology #Fox\n");
    expect(new TextDecoder().decode(parsed[6]!.data)).toBe("0:00 A lantern fox steps into the clearing.\n0:01 The child follows the light.\n");
    const descriptor = JSON.parse(new TextDecoder().decode(parsed[7]!.data)) as { production: { selectedTakeIds: string[] }; manifest: { captionCues: unknown[] }; metadata: { chapters: string } };
    expect(descriptor.production.selectedTakeIds).toEqual(["take-0", "take-1"]);
    expect(descriptor.manifest.captionCues).toHaveLength(2);
    expect(extractions).toBe(1);
    expect(first.zipSha256).toBe(createHash("sha256").update(first.zip).digest("hex"));

    const second = await build();
    expect(second.cacheHit).toBe(true);
    expect(Buffer.from(second.zip).equals(Buffer.from(first.zip))).toBe(true);
    expect(second.zipSha256).toBe(first.zipSha256);
    expect(extractions).toBe(1);

    // Creator edits change the cache key: a fresh real build with the new words.
    await savePackageOverrides(fixture.dataDir, "export-pkg", { title: "Creator's Cut", chapters: "0:00 Custom chapter" }, { now: () => 8_000 });
    const third = await build();
    expect(third.cacheHit).toBe(false);
    expect(new TextDecoder().decode(readZipEntries(third.zip)[3]!.data)).toBe("Creator's Cut\n");
    expect(new TextDecoder().decode(readZipEntries(third.zip)[6]!.data)).toBe("0:00 Custom chapter\n");
    expect(extractions).toBe(2);
  }, 240_000);

  conditional("preserves the previous valid package when a rebuild fails", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 640, height: 360, frames: 48 });
    const first = await buildExportPackage("export-pkg", { store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => 7_000 });
    await savePackageOverrides(fixture.dataDir, "export-pkg", { title: "Rebuild" }, { now: () => 8_000 });
    const failer: typeof extractThumbnailFrame = async () => { throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "boom"); };
    await expect(buildExportPackage("export-pkg", { store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => 9_000, extractThumbnail: failer }))
      .rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE" });
    // The committed cache record still names the previous build, and reverting the edit serves it.
    const record = JSON.parse(await readFile(join(fixture.dataDir, "exports", "export-pkg", "package-cache.json"), "utf8")) as { key: string; zipSha256: string };
    expect(record.zipSha256).toBe(first.zipSha256);
    await rm(join(fixture.dataDir, "exports", "export-pkg", "package-overrides.json"), { force: true });
    const restored = await buildExportPackage("export-pkg", { store: fixture.store, vault: fixture.vault, dataDir: fixture.dataDir, now: () => 10_000 });
    expect(restored.cacheHit).toBe(true);
    expect(restored.zipSha256).toBe(first.zipSha256);
  }, 240_000);

  conditional("extracts a downscaled thumbnail through the scale filter past the long-edge cap", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "perabyte-thumbnail-")); dirs.push(workDir);
    const source = join(workDir, "wide.mp4");
    await execFileAsync(localFfmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=2560x1440:r=24", "-frames:v", "48",
      "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", source,
    ], { timeout: 30_000 });
    const output = join(workDir, "thumbnail.png");
    await extractThumbnailFrame({
      inputPath: source, outputPath: output, seekSeconds: thumbnailSeekSeconds(48, 24),
      scaleFilter: thumbnailScaleFilter(2560, 1440), paths: { ffmpeg: localFfmpeg, ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" },
    });
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(1920);
    expect(metadata.height).toBe(1080);
    expect(metadata.format).toBe("png");
  }, 120_000);

  conditional("refuses when the vault bytes fail checksum verification", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 640, height: 360, frames: 48 });
    const brokenVault = { readVerified: async () => { throw new Error("Vault checksum mismatch"); } };
    await expect(buildExportPackage("export-pkg", { store: fixture.store, vault: brokenVault, dataDir: fixture.dataDir }))
      .rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE" });
    await expect(readFile(join(fixture.dataDir, "exports", "export-pkg", "package-cache.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("package route handlers", () => {
  const routeOptions = (fixture: PackageFixture) => ({
    withStore: async <T,>(work: (store: PackageFixture["store"]) => T | Promise<T>): Promise<T> => work(fixture.store),
    dataDir: fixture.dataDir,
    vault: fixture.vault,
    paths: { ffmpeg: localFfmpeg, ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" },
  });
  const context = { params: Promise.resolve({ id: "export-pkg" }) };
  const url = (query: string) => `http://localhost/api/production/exports/export-pkg/package${query}`;

  it("meta: reads defaults and overrides for a scoped export without approval", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 640, height: 360, frames: 48 });
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-pkg")!;
      if (!tx.compareAndSetExport({ ...live, status: "ready_for_review", approvedSha256: null, finalApprovalId: null }, "approved")) throw new Error("fixture CAS failed");
    });
    const handlers = createExportPackageRouteHandlers(routeOptions(fixture));
    const meta = await handlers.GET(new Request(url("?projectId=project-package&meta=1")), context);
    expect(meta.status).toBe(200);
    const body = await meta.json() as { exportStatus: string; overrides: null; metadata: { title: string; description: string; hashtags: string } };
    expect(body.exportStatus).toBe("ready_for_review");
    expect(body.overrides).toBeNull();
    expect(body.metadata.title).toBe("The Lantern Fox");
    expect(body.metadata.description).toBe("The clearing\nThe following");
    expect(body.metadata.hashtags).toBe("#Lantern #Studio #Mythology #Fox");
  });

  it("meta: reflects persisted edits, and rejects bad scope, unknown ids, and invalid bodies", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 640, height: 360, frames: 48 });
    const handlers = createExportPackageRouteHandlers(routeOptions(fixture));
    const put = await handlers.PUT(new Request(url("?projectId=project-package"), {
      method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Edited Title", chapters: "0:00 Edited" }),
    }), context);
    expect(put.status).toBe(200);
    const putBody = await put.json() as { overrides: { title: string | null; hashtags: string | null } };
    expect(putBody.overrides.title).toBe("Edited Title");
    expect(putBody.overrides.hashtags).toBeNull();
    const meta = await handlers.GET(new Request(url("?projectId=project-package&meta=1")), context);
    const metaBody = await meta.json() as { metadata: { title: string; hashtags: string }; overriddenFields: string[] };
    expect(metaBody.metadata.title).toBe("Edited Title");
    expect(metaBody.metadata.hashtags).toBe("#Lantern #Studio #Mythology #Fox");
    expect(metaBody.overriddenFields).toEqual(["title", "chapters"]);
    await expect(handlers.PUT(new Request(url("?projectId=project-package"), { method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({}) }), context)).resolves.toMatchObject({ status: 400 });
    await expect(handlers.PUT(new Request(url("?projectId=project-package"), { method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ title: 5 }) }), context)).resolves.toMatchObject({ status: 400 });
    await expect(handlers.PUT(new Request(url("?projectId=project-package"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }), context)).resolves.toMatchObject({ status: 400 });
    await expect(handlers.GET(new Request(url("?projectId=project-other&meta=1")), context)).resolves.toMatchObject({ status: 400 });
    await expect(handlers.GET(new Request(url("&meta=1")), context)).resolves.toMatchObject({ status: 400 });
    await expect(handlers.GET(new Request(url("?projectId=project-package&meta=1")), { params: Promise.resolve({ id: "export-nope" }) })).resolves.toMatchObject({ status: 404 });
  });

  conditional("zip: 428 until approved, then the complete package with final-download headers", async () => {
    const manifest = manifestFixture();
    const fixture = await storeFixture(manifest, { width: 1280, height: 720, frames: 48 });
    const handlers = createExportPackageRouteHandlers(routeOptions(fixture));
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-pkg")!;
      if (!tx.compareAndSetExport({ ...live, status: "ready_for_review", approvedSha256: null, finalApprovalId: null }, "approved")) throw new Error("fixture CAS failed");
    });
    const locked = await handlers.GET(new Request(url("?projectId=project-package")), context);
    expect(locked.status).toBe(428);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("APPROVAL_REQUIRED");
    // The human gate re-approves: restore the approved record with its bound checksum.
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-pkg")!;
      if (!tx.compareAndSetExport({ ...live, status: "approved", approvedSha256: fixture.master.sha256, finalApprovalId: "final-approval" }, "ready_for_review")) throw new Error("fixture CAS failed");
    });
    const approved = await handlers.GET(new Request(url("?projectId=project-package")), context);
    expect(approved.status).toBe(200);
    expect(approved.headers.get("content-type")).toBe("application/zip");
    expect(approved.headers.get("cache-control")).toBe("no-store");
    expect(approved.headers.get("x-perabyte-package")).toBe("1");
    const zipBytes = new Uint8Array(await approved.arrayBuffer());
    const digest = createHash("sha256").update(zipBytes).digest("hex");
    expect(approved.headers.get("etag")).toBe(`"${digest}"`);
    expect(approved.headers.get("content-disposition")).toBe('attachment; filename="package-export-export-pkg.zip"');
    expect(readZipEntries(zipBytes).map((entry) => entry.name)).toEqual([...PACKAGE_ENTRY_NAMES]);
    // A stale approved checksum refuses with 409, exactly like the final download route.
    fixture.store.transaction((tx) => {
      const live = tx.getExport("export-pkg")!;
      if (!tx.compareAndSetExport({ ...live, approvedSha256: sha("stale") }, "approved")) throw new Error("fixture CAS failed");
    });
    await expect(handlers.GET(new Request(url("?projectId=project-package")), context)).resolves.toMatchObject({ status: 409 });
  }, 240_000);
});

// The route tests rely on the shared fixtures; keep a direct hash sanity check here so the file
// documents the exact key material in one place.
describe("cache key material", () => {
  it("is a canonical-json sha over the documented inputs", () => {
    const manifest = manifestFixture();
    const key = packageCacheKey({ exportId: "e", manifest, assetSha256: "a".repeat(64), overrides: null });
    expect(key).toBe(hashCanonicalJson({
      recipeVersion: 1,
      exportId: "e",
      inputsHash: manifest.inputsHash,
      profile: manifest.profile,
      shots: manifest.shots,
      audioCues: manifest.audioCues,
      captionCues: manifest.captionCues,
      assetSha256: "a".repeat(64),
      overrides: null,
    }));
  });
});
