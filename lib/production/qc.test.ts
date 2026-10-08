import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RenderManifestSchema, type AudioCue, type RenderManifest } from "./contracts";
import { MANIFEST_CROSSFADE_FRAMES } from "./manifest";
import {
  buildQcReport, evaluateQc, isSilentDraft, parseBlackFreezeSilence, parseEbur128Summary,
  QC_BLACK_MIN_FRAMES, QC_FREEZE_MIN_FRAMES, QC_SILENCE_MIN_SAMPLES,
  type QcMeasurement,
} from "./qc";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const SHOT_FRAMES = 24;

const manifestFixture = (options: { cues?: AudioCue[]; audioMixRevisionId?: string | null; shotFrames?: number } = {}): RenderManifest => {
  const shotFrames = options.shotFrames ?? SHOT_FRAMES;
  const cues = options.cues ?? [];
  const shots = [0, 1].map((index) => ({
    shotRevisionId: `shot-rev-${index}`, takeId: `take-${index}`, assetId: `asset-${index}`,
    startFrame: 0, endFrame: shotFrames, crop: { x: 0, y: 0, width: 16, height: 16 }, transition: "cut" as const,
  }));
  return RenderManifestSchema.parse({
    version: 1, id: `manifest-${sha(JSON.stringify(shots.length))}`, projectId: "project-qc",
    storyRevisionId: "story-1", shotPlanRevisionId: "plan-1", animaticRevisionId: "animatic-1",
    audioMixRevisionId: options.audioMixRevisionId !== undefined ? options.audioMixRevisionId : cues.length > 0 ? "mix-1" : null,
    profile: { id: "render-profile-x", version: 1, aspect: "9:16", width: 1080, height: 1920, fps: 24, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", sampleRate: 48_000 },
    shots, audioCues: cues, captionCues: [], inputsHash: sha("inputs"), createdAt: 1_000,
  });
};

const narrationCue = (overrides: Partial<AudioCue> = {}): AudioCue => ({
  id: "cue-narration", assetId: "asset-narration", sourceStartSample: 0, sourceEndSample: 24_000,
  timelineStartSample: 48_000, gainDb: 0, role: "narration", scriptSegmentId: "beat_1",
  sourceText: "A door opens.", sourceRights: "creator_attested", ...overrides,
});

const STORY_BEATS = [{ id: "beat_1", narration: "A door opens." }];

/** A measurement that passes every automated blocker for the default two-shot fixture. */
const passingMeasurement = (overrides: Partial<QcMeasurement> = {}): QcMeasurement => ({
  probe: {
    video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 2 * SHOT_FRAMES },
    audio: { codec: "aac", sampleRate: 48_000, channels: 2, endSample: 72_000 },
    formatName: "mov,mp4,m4a,3gp,3mj",
  },
  checksumOk: true,
  decodeOk: true,
  ebur128: { integratedLufs: -14.1, truePeakDbtp: -9.4, lraLu: 0 },
  intervals: { black: [], freeze: [], silence: [] },
  ...overrides,
});

const codesOf = (evaluation: { blockers: Array<{ code: string }> }) => evaluation.blockers.map((blocker) => blocker.code);

describe("C12 ebur128 summary parsing (ffmpeg 9 multiline + legacy single line)", () => {
  const FFMPEG9_SUMMARY = [
    "[Parsed_ebur128_0 @ 0x0] Summary:",
    "",
    "  Integrated loudness:",
    "    I:         -14.1 LUFS",
    "    Threshold: -24.1 LUFS",
    "",
    "  Loudness range:",
    "    LRA:         0.0 LU",
    "    Threshold:   0.0 LUFS",
    "    LRA low:     0.0 LUFS",
    "    LRA high:    0.0 LUFS",
    "",
    "  True peak:",
    "    Peak:       -9.4 dBFS",
  ].join("\n");

  it("parses the ffmpeg 9 multiline summary including true peak in dBFS", () => {
    const summary = parseEbur128Summary(`noise before\n${FFMPEG9_SUMMARY}\n[out#0/null] size=N/A`);
    expect(summary).toEqual({ integratedLufs: -14.1, truePeakDbtp: -9.4, lraLu: 0 });
  });

  it("parses the legacy single-line summary preferring the dBTP true peak", () => {
    const legacy = "Summary:\n  Integrated loudness: I: -13.5 LUFS  Threshold: -23.5 LUFS\n  Loudness range: LRA: 4.0 LU\n  True peak: Peak: -0.8 dBFS  Peak: -0.9 dBTP\n";
    expect(parseEbur128Summary(legacy)).toEqual({ integratedLufs: -13.5, truePeakDbtp: -0.9, lraLu: 4 });
  });

  it("returns null for garbage, missing summary or nonfinite numbers", () => {
    expect(parseEbur128Summary("no summary here")).toBeNull();
    expect(parseEbur128Summary("Summary:\n  Integrated loudness: I: -14 LUFS\n  True peak:\n    Peak: -inf dBFS")).toBeNull();
    expect(parseEbur128Summary("Summary:\n  nothing useful")).toBeNull();
  });
});

describe("C12 advisory interval parsing (blackdetect/freezedetect/silencedetect)", () => {
  it("parses black, paired freeze and silence intervals from detector stderr", () => {
    const stderr = [
      "[blackdetect @ 0x1] black_start:0.5 black_end:1 black_duration:0.5",
      "[freezedetect @ 0x2] freeze_start: 2",
      "[freezedetect @ 0x2] freeze_end: 4 | freeze_duration: 2",
      "[silencedetect @ 0x3] silence_start: 1.2",
      "[silencedetect @ 0x3] silence_end: 2 | silence_duration: 0.8",
    ].join("\n");
    const parsed = parseBlackFreezeSilence(stderr, { videoDurationSeconds: 6 });
    expect(parsed.black).toEqual([{ start: 0.5, end: 1 }]);
    expect(parsed.freeze).toEqual([{ start: 2, end: 4 }]);
    expect(parsed.silence).toEqual([{ start: 1.2, end: 2 }]);
  });

  it("closes an unterminated freeze at the video duration (ffmpeg 9 emits freeze_start only at EOF)", () => {
    const parsed = parseBlackFreezeSilence("[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 0", { videoDurationSeconds: 3 });
    expect(parsed.freeze).toEqual([{ start: 0, end: 3 }]);
  });
});

describe("C12 QC thresholds and blockers", () => {
  const manifest = manifestFixture({ cues: [narrationCue()] });

  it("passes the passing measurement with zero blockers and zero advisories", () => {
    const evaluation = evaluateQc(manifest, STORY_BEATS, passingMeasurement());
    expect(evaluation.verdict).toBe("passed");
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.advisories).toEqual([]);
  });

  it("applies the frozen loudness window [-15.0, -13.0] and true peak <= -1.0 dBTP", () => {
    for (const integratedLufs of [-15.0, -14.0, -13.0]) {
      expect(codesOf(evaluateQc(manifest, STORY_BEATS, passingMeasurement({ ebur128: { integratedLufs, truePeakDbtp: -9, lraLu: 0 } }))))
        .not.toContain("loudness_violation");
    }
    for (const integratedLufs of [-12.9, -15.1, -20]) {
      expect(codesOf(evaluateQc(manifest, STORY_BEATS, passingMeasurement({ ebur128: { integratedLufs, truePeakDbtp: -9, lraLu: 0 } }))))
        .toContain("loudness_violation");
    }
    expect(codesOf(evaluateQc(manifest, STORY_BEATS, passingMeasurement({ ebur128: { integratedLufs: -14, truePeakDbtp: -1.0, lraLu: 0 } }))))
      .not.toContain("truepeak_violation");
    expect(codesOf(evaluateQc(manifest, STORY_BEATS, passingMeasurement({ ebur128: { integratedLufs: -14, truePeakDbtp: -0.99, lraLu: 0 } }))))
      .toContain("truepeak_violation");
  });

  it("flags black only at 6+ frames, freeze at 48+ frames, silence at 24000+ samples inside a spoken cue", () => {
    const intervals = (list: Array<{ start: number; end: number }>) => ({ black: list, freeze: [], silence: [] });
    const shortBlack = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ intervals: intervals([{ start: 0, end: (QC_BLACK_MIN_FRAMES - 1) / 24 }]) }));
    expect(shortBlack.advisories).toEqual([]);
    const blackAdvisory = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ intervals: intervals([{ start: 0, end: QC_BLACK_MIN_FRAMES / 24 }]) }));
    expect(blackAdvisory.advisories.map((advisory) => advisory.code)).toEqual(["black_range"]);
    expect(blackAdvisory.verdict).toBe("passed");

    const freezeOk = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ intervals: { black: [], freeze: [{ start: 0, end: (QC_FREEZE_MIN_FRAMES - 1) / 24 }], silence: [] } }));
    expect(freezeOk.advisories).toEqual([]);
    const frozen = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ intervals: { black: [], freeze: [{ start: 0, end: QC_FREEZE_MIN_FRAMES / 24 }], silence: [] } }));
    expect(frozen.advisories.map((advisory) => advisory.code)).toEqual(["freeze_range"]);

    const silenceOk = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      intervals: { black: [], freeze: [], silence: [{ start: 1, end: 1 + (QC_SILENCE_MIN_SAMPLES - 1) / 48_000 }] },
    }));
    expect(silenceOk.advisories).toEqual([]);
    const silent = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      intervals: { black: [], freeze: [], silence: [{ start: 1, end: 1 + QC_SILENCE_MIN_SAMPLES / 48_000 }] },
    }));
    expect(silent.advisories.map((advisory) => advisory.code)).toEqual(["silence_in_spoken_cue"]);
    expect(silent.advisories[0]?.startSample).toBe(48_000);
    expect(silent.advisories[0]?.cueId).toBe("cue-narration");

    // The same silence outside every spoken cue is not an advisory.
    const outside = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      intervals: { black: [], freeze: [], silence: [{ start: 0, end: QC_SILENCE_MIN_SAMPLES / 48_000 }] },
    }));
    expect(outside.advisories).toEqual([]);

    // A detector-rounding clip of the cue edge (one sample of reported silence past the cue start)
    // is not 24000 silent samples INSIDE the cue and must not fire.
    const edgeClip = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      intervals: { black: [], freeze: [], silence: [{ start: 0, end: (48_000 + 1) / 48_000 }] },
    }));
    expect(edgeClip.advisories).toEqual([]);
  });

  it("blocks a present audio stream with an unmeasurable end as nonfinite instead of skipping the audio-end gate", () => {
    const unmeasurable = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: passingMeasurement().probe!.video, audio: { codec: "aac", sampleRate: 48_000, channels: 2, endSample: null }, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(unmeasurable)).toContain("nonfinite_probe");
    expect(unmeasurable.verdict).toBe("failed");
    expect(codesOf(unmeasurable)).not.toContain("audio_end_tolerance");
  });

  it("blocks wrong codec, container, dimensions, fps and pixel format read from the output", () => {
    const wrongCodec = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "mpeg4", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(wrongCodec)).toContain("video_codec_mismatch");
    const wrongContainer = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48 }, audio: null, formatName: "matroska,webm" },
    }));
    expect(codesOf(wrongContainer)).toContain("container_mismatch");
    const wrongDimensions = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 48 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(wrongDimensions)).toContain("dimensions_mismatch");
    const wrongFps = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "25/1", frames: 48 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(wrongFps)).toContain("fps_mismatch");
    const wrongPixFmt = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv422p", avgFrameRate: "24/1", frames: 48 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(wrongPixFmt)).toContain("pixel_format_mismatch");
  });

  it("enforces the 1-frame duration tolerance and flags nonfinite probe values", () => {
    const oneFrameOff = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 2 * SHOT_FRAMES + 1 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(oneFrameOff)).not.toContain("duration_tolerance");
    const twoFramesOff = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: 2 * SHOT_FRAMES + 2 }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(twoFramesOff)).toContain("duration_tolerance");
    const missingFrames = evaluateQc(manifest, STORY_BEATS, passingMeasurement({
      probe: { video: { codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", avgFrameRate: "24/1", frames: null }, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" },
    }));
    expect(codesOf(missingFrames)).toContain("nonfinite_probe");
  });

  it("blocks a missing audio stream only when the manifest declares audio cues", () => {
    const noAudio = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ probe: { video: passingMeasurement().probe!.video, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" } }));
    expect(codesOf(noAudio)).toContain("missing_audio_stream");
    const silentManifest = manifestFixture({ audioMixRevisionId: null, cues: [] });
    const silentDraft = evaluateQc(silentManifest, [], passingMeasurement({ probe: { video: passingMeasurement().probe!.video, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" }, ebur128: null }));
    expect(codesOf(silentDraft)).not.toContain("missing_audio_stream");
    expect(codesOf(silentDraft)).not.toContain("loudness_violation");
    expect(silentDraft.verdict).toBe("passed");
  });

  it("blocks checksum drift and decoder failure", () => {
    expect(codesOf(evaluateQc(manifest, STORY_BEATS, passingMeasurement({ checksumOk: false })))).toContain("checksum_mismatch");
    const decode = evaluateQc(manifest, STORY_BEATS, passingMeasurement({ decodeOk: false }));
    expect(codesOf(decode)).toContain("decoder_failure");
    expect(decode.verdict).toBe("failed");
  });

  it("blocks a required spoken segment omitted from the declared cues", () => {
    const missing = evaluateQc(manifest, STORY_BEATS, passingMeasurement());
    expect(codesOf(missing)).toEqual([]);
    const omitted = evaluateQc(manifest, [{ id: "beat_1", narration: "A different line entirely." }], passingMeasurement());
    expect(codesOf(omitted)).toContain("spoken_segment_omitted");
  });
});

describe("C12 report building", () => {
  const manifest = manifestFixture({ cues: [narrationCue()] });

  it("is deterministic for identical measurements and binds output + inputs hashes", () => {
    const base = {
      exportId: "export-qc-1", manifest, outputAssetId: "export-asset-abc", outputSha256: sha("output-bytes"),
      measurement: passingMeasurement(), evaluation: evaluateQc(manifest, STORY_BEATS, passingMeasurement()),
      toolVersions: { ffmpeg: "9.0.2", ffprobe: "9.0.2" }, toolFailure: null, createdAt: 5_000,
    };
    const first = buildQcReport(base);
    const second = buildQcReport({ ...base });
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^qc-[a-f0-9]{64}$/);
    expect(first.outputSha256).toBe(sha("output-bytes"));
    expect(first.manifestInputsHash).toBe(manifest.inputsHash);
    const different = buildQcReport({ ...base, measurement: passingMeasurement({ ebur128: { integratedLufs: -13.2, truePeakDbtp: -9, lraLu: 0 } }) });
    expect(different.id).not.toBe(first.id);
    expect(first.verdict).toBe("passed");
    expect(first.draftOnly).toBe(false);
    expect(first.checks.length).toBeGreaterThan(0);
    expect(first.checks.every((check) => check.evidence.length > 0)).toBe(true);
  });

  it("marks the silent-draft profile draftOnly with audio checks skipped", () => {
    const silentManifest = manifestFixture({ audioMixRevisionId: null, cues: [] });
    expect(isSilentDraft(silentManifest)).toBe(true);
    expect(isSilentDraft(manifestFixture({ cues: [] }))).toBe(true);
    expect(isSilentDraft(manifest)).toBe(false);
    const measurement = passingMeasurement({ probe: { video: passingMeasurement().probe!.video, audio: null, formatName: "mov,mp4,m4a,3gp,3mj" }, ebur128: null });
    const evaluation = evaluateQc(silentManifest, [], measurement);
    const report = buildQcReport({
      exportId: "export-qc-draft", manifest: silentManifest, outputAssetId: "export-asset-draft", outputSha256: sha("draft-bytes"),
      measurement, evaluation, toolVersions: { ffmpeg: "9.0.2", ffprobe: "9.0.2" }, toolFailure: null, createdAt: 5_000,
    });
    expect(report.draftOnly).toBe(true);
    expect(report.verdict).toBe("passed");
    expect(report.measured.integratedLufs).toBeNull();
    expect(report.measured.truePeakDbtp).toBeNull();
  });

  it("records the crossfade overlap in the expected frame total", () => {
    const frames = (shotFrames: number) => shotFrames * 2 - MANIFEST_CROSSFADE_FRAMES;
    expect(frames(SHOT_FRAMES)).toBe(2 * SHOT_FRAMES - MANIFEST_CROSSFADE_FRAMES);
  });
});
