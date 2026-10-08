import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { serializeAudioTimeline } from "./audio";
import { AudioCueSchema, IdSchema, type AudioCue } from "./contracts";
import { ProductionApplicationError } from "./errors";
import {
  MANIFEST_CROSSFADE_FRAMES,
  MANIFEST_MASTERING_RECIPE_VERSION,
  MANIFEST_SAMPLES_PER_FRAME,
  buildRenderProfile,
  compileManifestTimeline,
  manifestId,
  manifestInputsHash,
  validateAudioExactness,
  type ManifestCompileModel,
  type ManifestShotSource,
} from "./manifest";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const MIX_SETTINGS = { sampleRate: 48_000 as const, channels: 2 as const, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true };
const SHORT_PROFILE = { id: "storybook-short-v1", format: "9:16" as const, language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null };
const cue = (overrides: Record<string, unknown> = {}): AudioCue => AudioCueSchema.parse({
  id: "cue-1", assetId: "audio-asset-1", sourceStartSample: 0, sourceEndSample: 96_000, timelineStartSample: 0,
  gainDb: -22, role: "music", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested", ...overrides,
});
function shotSource(overrides: Partial<ManifestShotSource> = {}): ManifestShotSource {
  return {
    shotRevisionId: "shot-rev-1", shotHash: sha("shot-rev-1"), takeId: "take-1", takeInputsHash: sha("take-1"),
    assetId: "asset-1", assetSha256: sha("asset-1"), assetWidth: 640, assetHeight: 960, actualFrames: 48,
    startFrame: 0, endFrame: 24, crop: { x: 0, y: 0, width: 640, height: 960 }, transition: "cut",
    ...overrides,
  };
}
const secondShotSource = (overrides: Partial<ManifestShotSource> = {}) => shotSource({ shotRevisionId: "shot-rev-2", shotHash: sha("shot-rev-2"), takeId: "take-2", takeInputsHash: sha("take-2"), assetId: "asset-2", assetSha256: sha("asset-2"), ...overrides });
const thirdShotSource = (overrides: Partial<ManifestShotSource> = {}) => shotSource({ shotRevisionId: "shot-rev-3", shotHash: sha("shot-rev-3"), takeId: "take-3", takeInputsHash: sha("take-3"), assetId: "asset-3", assetSha256: sha("asset-3"), ...overrides });
function compileModel(fields: Partial<ManifestCompileModel> = {}): ManifestCompileModel {
  return {
    projectId: "project-1", storyRevisionId: "story-1", storyHash: sha("story-1"),
    shotPlanRevisionId: "plan-1", shotPlanHash: sha("plan-1"), animaticRevisionId: "animatic-1", animaticHash: sha("animatic-1"),
    audioMixRevisionId: "audio-mix-1", audioMixHash: sha("audio-mix-1"),
    profile: buildRenderProfile(SHORT_PROFILE), shots: [shotSource(), secondShotSource()], audioCues: [cue()], captionCues: [],
    totalFrames: 48, totalAudioSamples: 96_000, selectionVersion: 2, masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
    ...fields,
  };
}
function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("Expected the fixture operation to fail closed");
}

describe("C11-PRE manifest fingerprint and timeline arithmetic", () => {
  it("hashes the pinned inputs identically regardless of object key order", () => {
    const base = compileModel();
    // Same semantic content as `base`, written with every object literal in reversed key order.
    const reordered: ManifestCompileModel = {
      masteringRecipeVersion: base.masteringRecipeVersion,
      selectionVersion: base.selectionVersion,
      totalAudioSamples: base.totalAudioSamples,
      totalFrames: base.totalFrames,
      captionCues: base.captionCues,
      audioCues: [AudioCueSchema.parse({ sourceRights: "creator_attested", sourceText: null, scriptSegmentId: null, role: "music", gainDb: -22, timelineStartSample: 0, sourceEndSample: 96_000, sourceStartSample: 0, assetId: "audio-asset-1", id: "cue-1" })],
      shots: [
        { transition: "cut" as const, crop: { height: 960, width: 640, y: 0, x: 0 }, endFrame: 24, startFrame: 0, actualFrames: 48, assetHeight: 960, assetWidth: 640, assetSha256: sha("asset-1"), assetId: "asset-1", takeInputsHash: sha("take-1"), takeId: "take-1", shotHash: sha("shot-rev-1"), shotRevisionId: "shot-rev-1" },
        { transition: "cut" as const, crop: { height: 960, width: 640, y: 0, x: 0 }, endFrame: 24, startFrame: 0, actualFrames: 48, assetHeight: 960, assetWidth: 640, assetSha256: sha("asset-2"), assetId: "asset-2", takeInputsHash: sha("take-2"), takeId: "take-2", shotHash: sha("shot-rev-2"), shotRevisionId: "shot-rev-2" },
      ],
      profile: buildRenderProfile(SHORT_PROFILE),
      audioMixHash: base.audioMixHash,
      audioMixRevisionId: base.audioMixRevisionId,
      animaticHash: base.animaticHash,
      animaticRevisionId: base.animaticRevisionId,
      shotPlanHash: base.shotPlanHash,
      shotPlanRevisionId: base.shotPlanRevisionId,
      storyHash: base.storyHash,
      storyRevisionId: base.storyRevisionId,
      projectId: base.projectId,
    };
    expect(manifestInputsHash(reordered)).toBe(manifestInputsHash(base));
    expect(manifestInputsHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the fingerprint when any pinned semantic input changes", () => {
    const base = compileModel();
    const variants: ReadonlyArray<readonly [string, () => ManifestCompileModel]> = [
      ["trim end", () => compileModel({ shots: [shotSource({ endFrame: 30 }), secondShotSource()] })],
      ["trim start", () => compileModel({ shots: [shotSource({ startFrame: 6 }), secondShotSource()] })],
      ["crop", () => compileModel({ shots: [shotSource({ crop: { x: 0, y: 0, width: 600, height: 960 } }), secondShotSource()] })],
      ["transition", () => compileModel({ shots: [shotSource({ transition: "crossfade" }), secondShotSource()] })],
      ["gainDb", () => compileModel({ audioCues: [cue({ gainDb: -20 })] })],
      ["cue text", () => compileModel({ audioCues: [cue({ sourceText: "updated narration" })] })],
      ["assetSha256", () => compileModel({ shots: [shotSource({ assetSha256: sha("other-bytes") }), secondShotSource()] })],
      ["profile", () => compileModel({ profile: buildRenderProfile({ ...SHORT_PROFILE, format: "16:9" }) })],
      ["masteringRecipeVersion", () => ({ ...compileModel(), masteringRecipeVersion: 2 }) as unknown as ManifestCompileModel],
      ["selectionVersion", () => compileModel({ selectionVersion: 3 })],
      ["storyHash", () => compileModel({ storyHash: sha("story-2") })],
      ["audioMixHash", () => compileModel({ audioMixHash: sha("audio-mix-2") })],
      ["shot order", () => compileModel({ shots: [secondShotSource(), shotSource()] })],
    ];
    for (const [label, build] of variants) {
      expect(manifestInputsHash(build()), `fingerprint must change on ${label}`).not.toBe(manifestInputsHash(base));
    }
  });

  it("excludes non-pinned record fields and derives the content-addressed manifest id", () => {
    const base = compileModel();
    expect(manifestInputsHash({ ...base, id: "manifest-other", createdAt: 4_242_424 } as unknown as ManifestCompileModel)).toBe(manifestInputsHash(base));
    expect(manifestInputsHash({ ...base, totalFrames: 999, totalAudioSamples: 123 } as ManifestCompileModel)).toBe(manifestInputsHash(base));
    expect(manifestId(manifestInputsHash(base))).toBe(`manifest-${manifestInputsHash(base)}`);
    expect(IdSchema.safeParse(manifestId(manifestInputsHash(base))).success).toBe(true);
  });

  it("computes totals with exact 8-frame subtraction per internal crossfade boundary", () => {
    expect(MANIFEST_CROSSFADE_FRAMES).toBe(8);
    expect(compileManifestTimeline([shotSource()])).toBe(24);
    expect(compileManifestTimeline([shotSource(), secondShotSource()], { expectedTotalFrames: 48 })).toBe(48);
    const crossfaded = [shotSource({ transition: "crossfade" }), secondShotSource({ transition: "crossfade" }), thirdShotSource()];
    expect(compileManifestTimeline(crossfaded)).toBe(72 - 2 * MANIFEST_CROSSFADE_FRAMES);
    expect(Number.isInteger(compileManifestTimeline(crossfaded))).toBe(true);
    // Only internal boundaries subtract: a trailing cut keeps both shots' full lengths.
    expect(compileManifestTimeline([shotSource({ transition: "crossfade" }), secondShotSource()])).toBe(48 - MANIFEST_CROSSFADE_FRAMES);
  });

  it("rejects illegal trims, crops, dimensions, transitions and totals naming the shot", () => {
    const rejects = (shots: readonly ManifestShotSource[], match: RegExp, options: { expectedTotalFrames?: number } = {}) => {
      const error = failOf(() => compileManifestTimeline(shots, options));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(match);
    };
    rejects([shotSource({ endFrame: 49 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ startFrame: 24, endFrame: 24 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ endFrame: 12, startFrame: 24 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ startFrame: -1, endFrame: 12 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ startFrame: 0.5, endFrame: 12 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ actualFrames: Number.NaN }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ assetWidth: null as unknown as number }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ assetHeight: null as unknown as number }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ assetWidth: 0 }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ crop: { x: 1, y: 0, width: 640, height: 960 } }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ crop: { x: 0, y: 1, width: 640, height: 960 } }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ crop: { x: 0, y: 0, width: 0, height: 960 } }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource({ crop: { x: -1, y: 0, width: 640, height: 960 } }), secondShotSource()], /shot-rev-1/);
    rejects([shotSource(), secondShotSource({ transition: "crossfade" })], /shot-rev-2/);
    rejects([shotSource(), secondShotSource()], /47/, { expectedTotalFrames: 47 });
    const mismatch = failOf(() => compileManifestTimeline([shotSource(), secondShotSource()], { expectedTotalFrames: 47 }));
    expect(mismatch.message).toMatch(/48/);
  });
});

describe("C11-PRE audio exactness against the video timeline", () => {
  it("converts frames to samples exactly on the 2000-sample frame grid", () => {
    expect(MANIFEST_SAMPLES_PER_FRAME).toBe(2000);
    const exact = validateAudioExactness(48, [cue()]);
    expect(exact.sampleRate).toBe(48_000);
    expect(exact.totalSamples).toBe(48 * MANIFEST_SAMPLES_PER_FRAME);
    expect(exact.totalEndSample).toBe(96_000);
    expect(validateAudioExactness(48, []).totalEndSample).toBe(0);
    for (const frames of [1, 7, 13, 101, 192, 1152]) {
      const result = validateAudioExactness(frames, []);
      expect(result.totalSamples).toBe(frames * MANIFEST_SAMPLES_PER_FRAME);
      expect(Number.isInteger(result.totalSamples)).toBe(true);
    }
  });

  it("accepts a cue ending exactly at the timeline and rejects one sample past, naming the cue", () => {
    expect(validateAudioExactness(48, [cue({ timelineStartSample: 94_000, sourceEndSample: 2_000 })]).totalEndSample).toBe(96_000);
    const late = failOf(() => validateAudioExactness(48, [cue({ id: "cue-late", timelineStartSample: 96_000, sourceEndSample: 2_000 })]));
    expect(late.code).toBe("INVALID_INPUT");
    expect(late.message).toMatch(/cue-late/);
    const onePast = failOf(() => validateAudioExactness(48, [cue({ id: "cue-over", timelineStartSample: 1 })]));
    expect(onePast.code).toBe("INVALID_INPUT");
    expect(onePast.message).toMatch(/cue-over/);
  });

  it("mirrors the accepted serializeAudioTimeline totalEndSample ordering", () => {
    const cues = [
      cue({ id: "cue-music", timelineStartSample: 48_000, sourceEndSample: 4_000 }),
      cue({ id: "cue-narration", timelineStartSample: 0, sourceEndSample: 2_000, role: "narration", gainDb: 0 }),
      cue({ id: "cue-sfx", timelineStartSample: 92_000, sourceEndSample: 2_000, role: "sfx", gainDb: -12 }),
    ];
    const exactness = validateAudioExactness(48, cues);
    const serialized = serializeAudioTimeline({ mixSettings: MIX_SETTINGS, cues });
    expect(serialized.overlapPolicy).toBe("layered");
    expect(exactness.totalEndSample).toBe(serialized.totalEndSample);
    expect(exactness.totalEndSample).toBe(94_000);
  });
});
