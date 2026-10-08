import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore } from "../../repositories/production/sqlite";
import { APPROVAL_CHECKLISTS } from "../../production/approval";
import { AssetSchema, type Asset, type SaveAudioMixCommand, type StoryRevision } from "../../production/contracts";
import { audioAssetId, narrationAlignmentIssues, probeAudioBytes } from "../../production/audio";
import { createProductionApprovalService } from "./approval";
import { createCanonRevision, createProject, createStoryRevision } from "./revisions";
import { createAudioRouteHandlers, importAudioAsset, saveAudioMix, type AudioImportOptions } from "./audio";

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const u32le = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value, 0); return buffer; };
function wavBytes(samples: number, sampleRate = 48_000): Uint8Array {
  const blockAlign = 2;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8); fmt.writeUInt16LE(blockAlign, 12); fmt.writeUInt16LE(16, 14);
  const dataBytes = samples * blockAlign;
  return new Uint8Array(Buffer.concat([Buffer.from("RIFF"), u32le(36 + dataBytes), Buffer.from("WAVE"), Buffer.from("fmt "), u32le(16), fmt, Buffer.from("data"), u32le(dataBytes), Buffer.alloc(dataBytes, 7)]));
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fakeVaultPut = (at: number): NonNullable<AudioImportOptions["putMedia"]> => async (bytes, options) => {
  const digest = sha256(bytes);
  return { checksumVerified: true as const, verifiedAt: at, asset: AssetSchema.parse({ version: 1, id: "vault-generated-id", sha256: digest, mime: options.mime, byteSize: bytes.byteLength, vaultRef: `sha256-${digest}`, width: null, height: null, frames: null, fps: null, audioSamples: probeAudioBytes(bytes).audioSamples, sourceKind: options.sourceKind, sourceJobId: null, rightsStatus: options.rightsStatus ?? "unknown", createdAt: at }) };
};
function audioAsset(id: string, samples: number, checksum = "a".repeat(64)): Asset {
  return AssetSchema.parse({
    version: 1, id, sha256: checksum, mime: "audio/wav", byteSize: 9646, vaultRef: `sha256-${checksum}`,
    width: null, height: null, frames: null, fps: null, audioSamples: samples, sourceKind: "upload", sourceJobId: null,
    rightsStatus: "creator_attested", importProvenance: { source: "creator recording", rightsAttestation: "I own this recording.", actorId: "local-creator", createdAt: 1 }, createdAt: 1,
  });
}

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-audio-fixture-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  let n = 0; let clockValue = 100;
  const clock = () => ++clockValue;
  const idFactory = () => `fixture-${++n}`;
  const options = { now: clock, idFactory };
  const project = createProject(store, { name: "Audio fixture", profileId: "storybook-short-v1" }, options);
  const style = createCanonRevision(store, { projectId: project.id, entityId: "style", expectedRevisionId: null, entityKind: "style", description: "Paper cutout", attributes: {}, assetIds: [] }, options);
  const story = createStoryRevision(store, {
    projectId: project.id, expectedStoryRevisionId: null, scriptText: "A door opens. Someone enters.",
    beats: [
      { id: "beat_1", action: "A door opens.", narration: "A door opens.", dialogue: [] },
      { id: "beat_2", action: "Someone enters.", narration: "Someone enters.", dialogue: [] },
    ],
    canonRevisionIds: [style.id],
  }, options);
  const narration = audioAsset("asset-narration", 4800, "a".repeat(64));
  const music = audioAsset("asset-music", 9600, "b".repeat(64));
  const video = audioAsset("asset-video", 4800, "c".repeat(64));
  const videoNoAudio = { ...video, mime: "video/mp4", audioSamples: null };
  store.transaction(tx => {
    tx.insertAsset({ asset: narration, verifiedAt: clock(), checksumVerified: true });
    tx.insertAsset({ asset: music, verifiedAt: clock(), checksumVerified: true });
    tx.insertAsset({ asset: AssetSchema.parse(videoNoAudio), verifiedAt: clock(), checksumVerified: true });
  });
  const narrationCue = { assetId: narration.id, sourceStartSample: 0, sourceEndSample: 2400, timelineStartSample: 0, gainDb: -3, role: "narration" as const, scriptSegmentId: "beat_1", sourceText: "A door opens.", sourceRights: "creator_attested" as const };
  const musicCue = { assetId: music.id, sourceStartSample: 0, sourceEndSample: 9600, timelineStartSample: 0, gainDb: -12, role: "music" as const, scriptSegmentId: null, sourceText: null, sourceRights: "licensed" as const };
  const command = (overrides: Partial<SaveAudioMixCommand> = {}): SaveAudioMixCommand => ({
    projectId: project.id, expectedAudioVersion: 0, expectedStoryRevisionId: story.id,
    cues: [narrationCue, musicCue],
    mixSettings: { sampleRate: 48000, channels: 2, loudnessTargetLufs: -16, truePeakLimitDbtp: -1.5, muteNativeAudio: true },
    ...overrides,
  });
  const secondStory = () => createStoryRevision(store, {
    projectId: project.id, expectedStoryRevisionId: story.id, scriptText: "A door slams. Someone enters.",
    beats: [
      { id: "beat_1", action: "A door slams.", narration: "A door slams.", dialogue: [] },
      { id: "beat_2", action: "Someone enters.", narration: "Someone enters.", dialogue: [] },
    ],
    canonRevisionIds: [style.id],
  }, options);
  return { store, project, story, narration, music, video: videoNoAudio, narrationCue, musicCue, command, options, clock, idFactory, secondStory };
}

describe("audio mix save service", () => {
  it("saves an immutable mix bound to the exact story revision and selects it atomically", async () => {
    const f = await fixture();
    const result = saveAudioMix(f.store, f.command(), f.options);
    expect(result.created).toBe(true);
    expect(result.active).toBe(true);
    expect(result.revision.storyRevisionId).toBe(f.story.id);
    expect(result.revision.cues.find(cue => cue.role === "narration")?.sourceText).toBe("A door opens.");
    expect(result.revision.id).toBe(`audio-mix-${result.revision.contentHash}`);
    const project = f.store.read.getProject(f.project.id)!;
    expect(project.activeAudioMixRevisionId).toBe(result.revision.id);
    expect(project.audioMixVersion).toBe(1);
    expect(f.store.read.getAudioMixRevision(result.revision.id)!.cues).toEqual(result.revision.cues);
    expect(f.store.read.listProjectJobs(f.project.id)).toHaveLength(0);
  });

  it("retries the same command without duplicating cues or mix revisions", async () => {
    const f = await fixture();
    const first = saveAudioMix(f.store, f.command(), f.options);
    const replay = saveAudioMix(f.store, f.command(), f.options);
    expect(replay.created).toBe(false);
    expect(replay.revision.id).toBe(first.revision.id);
    expect(replay.active).toBe(true);
    expect(f.store.read.getProject(f.project.id)!.audioMixVersion).toBe(1);
    expect(f.store.read.getAudioMixRevision(first.revision.id)!.cues).toHaveLength(2);
  });

  it("appends a new immutable mix revision when a cue edit changes content", async () => {
    const f = await fixture();
    const first = saveAudioMix(f.store, f.command(), f.options);
    const edited = saveAudioMix(f.store, f.command({ expectedAudioVersion: 1, cues: [f.narrationCue, { ...f.musicCue, gainDb: -10 }] }), f.options);
    expect(edited.created).toBe(true);
    expect(edited.revision.id).not.toBe(first.revision.id);
    const project = f.store.read.getProject(f.project.id)!;
    expect(project.activeAudioMixRevisionId).toBe(edited.revision.id);
    expect(project.audioMixVersion).toBe(2);
    expect(f.store.read.getAudioMixRevision(first.revision.id)!.cues.find(cue => cue.role === "music")!.gainDb).toBe(-12);
    expect(edited.revision.cues.find(cue => cue.role === "music")!.gainDb).toBe(-10);
  });

  it("rejects invalid cues, bounds, provenance, and overlaps before any write", async () => {
    const f = await fixture();
    const cases: Array<[string, SaveAudioMixCommand]> = [
      ["gain above bound", f.command({ cues: [{ ...f.narrationCue, gainDb: 12.5 }, f.musicCue] })],
      ["gain below bound", f.command({ cues: [{ ...f.narrationCue, gainDb: -61 }, f.musicCue] })],
      ["negative timeline start", f.command({ cues: [{ ...f.narrationCue, timelineStartSample: -1 }, f.musicCue] })],
      ["cue beyond asset samples", f.command({ cues: [{ ...f.narrationCue, sourceEndSample: 9600 }, f.musicCue] })],
      ["unknown asset", f.command({ cues: [{ ...f.narrationCue, assetId: "asset-missing" }, f.musicCue] })],
      ["non-audio asset", f.command({ cues: [{ ...f.narrationCue, assetId: f.video.id }, f.musicCue] })],
      ["spoken overlap", f.command({ cues: [f.narrationCue, { ...f.musicCue, role: "narration", scriptSegmentId: "beat_2", sourceText: "Someone enters." }] })],
      ["drifted narration text", f.command({ cues: [{ ...f.narrationCue, sourceText: "A door closes." }, f.musicCue] })],
      ["unknown script segment", f.command({ cues: [{ ...f.narrationCue, scriptSegmentId: "beat_missing" }, f.musicCue] })],
      ["stale audio version", f.command({ expectedAudioVersion: 3 })],
      ["unknown story revision", f.command({ expectedStoryRevisionId: "story-missing" })],
    ];
    for (const [label, command] of cases) {
      const before = f.store.read.getProject(f.project.id)!;
      expect(() => saveAudioMix(f.store, command, f.options), label).toThrow(/./);
      const after = f.store.read.getProject(f.project.id)!;
      expect(after.audioMixVersion, label).toBe(before.audioMixVersion);
      expect(after.activeAudioMixRevisionId, label).toBe(before.activeAudioMixRevisionId);
      expect(after.saveVersion, label).toBe(before.saveVersion);
    }
  });

  it("refuses to save against a stale script and reports stale narration alignment", async () => {
    const f = await fixture();
    const first = saveAudioMix(f.store, f.command(), f.options);
    const story2 = f.secondStory();
    expect(() => saveAudioMix(f.store, f.command({ expectedStoryRevisionId: f.story.id, expectedAudioVersion: 1 }), f.options)).toThrow(/stale|story/i);
    const issues = narrationAlignmentIssues(first.revision, { id: story2.id, beats: story2.beats });
    expect(issues.some(issue => issue.code === "STALE_STORY")).toBe(true);
    expect(() => saveAudioMix(f.store, f.command({ expectedStoryRevisionId: story2.id, expectedAudioVersion: 1, cues: [{ ...f.narrationCue, sourceText: "A door opens." }, f.musicCue] }), f.options)).toThrow(/A door opens/);
    expect(f.store.read.getProject(f.project.id)!.audioMixVersion).toBe(1);
  });

  it("imports uploaded narration and music assets fail-closed with retained rights provenance and no generation provider", async () => {
    const f = await fixture();
    const bytes = wavBytes(2400);
    const options: AudioImportOptions = { now: f.clock, putMedia: fakeVaultPut(f.clock()) };
    const imported = await importAudioAsset(f.store, { bytes, source: "creator laptop mic", rightsAttestation: "Recorded by me; I hold all rights.", rightsStatus: "creator_attested", actorId: "local-creator" }, options);
    expect(imported.created).toBe(true);
    expect(imported.asset.id).toBe(audioAssetId(sha256(bytes)));
    expect(imported.asset.audioSamples).toBe(2400);
    expect(imported.asset.sourceKind).toBe("upload");
    expect(imported.asset.importProvenance?.source).toBe("creator laptop mic");
    expect(imported.asset.rightsStatus).toBe("creator_attested");
    const replay = await importAudioAsset(f.store, { bytes, source: "creator laptop mic", rightsAttestation: "Recorded by me; I hold all rights.", rightsStatus: "creator_attested" }, options);
    expect(replay.created).toBe(false);
    expect(replay.asset.id).toBe(imported.asset.id);
    const assetCount = () => (f.store.read.getAsset(imported.asset.id) === null ? 0 : 1);
    expect(assetCount()).toBe(1);
    const musicBytes = wavBytes(4800);
    const music = await importAudioAsset(f.store, { bytes: musicBytes, source: "licensed library track", rightsAttestation: "Licensed for this production under contract LIB-1.", rightsStatus: "licensed" }, options);
    expect(music.created).toBe(true);
    expect(music.asset.rightsStatus).toBe("licensed");
    const bound = saveAudioMix(f.store, f.command({ cues: [
      { ...f.narrationCue, assetId: imported.asset.id, sourceEndSample: 2400 },
      { ...f.musicCue, assetId: music.asset.id, sourceEndSample: 4800, sourceRights: "licensed" as const },
    ] }), f.options);
    expect(bound.created).toBe(true);
    expect(f.store.read.listProjectJobs(f.project.id)).toHaveLength(0);

    const corrupt = new Uint8Array(Buffer.from("definitely not audio"));
    await expect(importAudioAsset(f.store, { bytes: corrupt, source: "s", rightsAttestation: "a", rightsStatus: "creator_attested" }, options)).rejects.toMatchObject({ code: "INVALID_INPUT", details: { reason: "audio_corrupt" } });
    await expect(importAudioAsset(f.store, { bytes: wavBytes(2400, 44_100), source: "s", rightsAttestation: "a", rightsStatus: "creator_attested" }, options)).rejects.toMatchObject({ details: { reason: "audio_unsupported" } });
    await expect(importAudioAsset(f.store, { bytes: wavBytes(100), source: "s", rightsAttestation: "a", rightsStatus: "creator_attested" }, { ...options, maxProbeBytes: 64 })).rejects.toMatchObject({ details: { reason: "audio_oversize" } });
    await expect(importAudioAsset(f.store, { bytes: wavBytes(100), source: "", rightsAttestation: "a", rightsStatus: "creator_attested" }, options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(importAudioAsset(f.store, { bytes: wavBytes(100), source: "s", rightsAttestation: "a", rightsStatus: "unknown" }, options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(assetCount()).toBe(1);
    expect(f.store.read.getAsset(audioAssetId(sha256(corrupt)))).toBeNull();
  });
});

describe("audio mix route", () => {
  it("validates same-origin, envelope, project binding, and returns idempotent save results", async () => {
    const f = await fixture();
    const handlers = createAudioRouteHandlers({ withStore: async operation => operation(f.store), serviceOptions: f.options });
    const post = (body: unknown, origin = "http://localhost", projectId = f.project.id) => handlers.POST(
      new Request(`http://localhost/api/production/projects/${projectId}/audio`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ projectId }) },
    );
    expect((await post(f.command(), "https://evil.example")).status).toBe(400);
    expect((await post({ ...f.command(), projectId: "project-other" })).status).toBe(400);
    const malformed = handlers.POST(new Request(`http://localhost/api/production/projects/${f.project.id}/audio`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" }), { params: Promise.resolve({ projectId: f.project.id }) });
    expect((await malformed).status).toBe(400);
    expect((await post({ ...f.command(), projectId: "project-missing" }, "http://localhost", "project-missing")).status).toBe(404);
    expect((await post(f.command({ cues: [{ ...f.narrationCue, gainDb: 99 }, f.musicCue] }))).status).toBe(400);
    const created = await post(f.command());
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdBody = await created.json() as { created: boolean; revision: { id: string; cues: unknown[] } };
    expect(createdBody.created).toBe(true);
    expect(createdBody.revision.cues).toHaveLength(2);
    const replay = await post(f.command());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, active: true, revision: { id: createdBody.revision.id } });
    const edited = saveAudioMix(f.store, f.command({ expectedAudioVersion: 1, cues: [f.narrationCue, { ...f.musicCue, gainDb: -9 }] }), f.options);
    const supersededReplay = await post(f.command());
    expect(supersededReplay.status).toBe(409);
    const reselected = saveAudioMix(f.store, f.command({ expectedAudioVersion: 2 }), f.options);
    expect(reselected.revision.id).toBe(createdBody.revision.id);
    const reselectReplay = await post(f.command());
    expect(reselectReplay.status).toBe(200);
    expect(await reselectReplay.json()).toMatchObject({ created: false, active: true, revision: { id: createdBody.revision.id } });
    expect(edited.revision.id).not.toBe(createdBody.revision.id);
  });
});

describe("audio approval binding", () => {
  it("binds Approval.targetKind=audio to the exact mix revision and invalidates on cue and script changes", async () => {
    const f = await fixture();
    const approvalService = createProductionApprovalService({ store: f.store, now: f.clock, idFactory: f.idFactory, readAssetVerified: async () => undefined });
    const approve = (targetId: string, expectedHash: string, key: string) => approvalService.create({
      projectId: f.project.id, idempotencyKey: key,
      command: { targetKind: "audio", targetId, expectedHash, decision: "approved", checklist: APPROVAL_CHECKLISTS.audio.map(id => ({ id, passed: true, note: "checked" })), notes: "", advisoryAcknowledgements: [] },
    });
    const first = saveAudioMix(f.store, f.command(), f.options);
    const approval = await approve(first.revision.id, first.revision.contentHash, "mix-approval-1");
    expect(approval.created).toBe(true);
    expect(approval.approval.targetKind).toBe("audio");
    expect(approval.approval.targetHash).toBe(first.revision.contentHash);
    expect((await approve(first.revision.id, first.revision.contentHash, "mix-approval-1")).created).toBe(false);
    const edited = saveAudioMix(f.store, f.command({ expectedAudioVersion: 1, cues: [f.narrationCue, { ...f.musicCue, gainDb: -8 }] }), f.options);
    expect(edited.created).toBe(true);
    await expect(approve(first.revision.id, first.revision.contentHash, "mix-approval-2")).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(saveAudioMix(f.store, f.command({ expectedAudioVersion: 2 }), f.options).active).toBe(true);
    f.secondStory();
    await expect(approve(first.revision.id, first.revision.contentHash, "mix-approval-3")).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(f.store.read.listApprovals("audio", first.revision.id)).toHaveLength(1);
  });
});
