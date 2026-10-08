import { z } from "zod";
import {
  ApprovalChecklistItemSchema, ExportSchema, IdSchema, NonEmptyTextSchema, RenderProfileSchema,
  SchemaVersionSchema, Sha256Schema, UtcMillisSchema, JsonValueSchema, type RenderManifest,
} from "./contracts";
import { ProductionErrorCodeSchema } from "./errors";
import { hashCanonicalJson } from "./hash";
import { MANIFEST_CROSSFADE_FRAMES } from "./manifest";

/**
 * C12 export QC domain: measured G08 verification of a rendered export asset against the frozen
 * render profile, with strictly separated automated blockers (never waivable) and named advisory
 * warnings (evidence to inspect, never autonomous acceptance). Thresholds are frozen from
 * docs/production/QUALITY_GATES.md:19,35-37. Pure functions and schemas only.
 */

/* ------------------------------ frozen thresholds ------------------------------ */
export const QC_FPS = 24;
export const QC_SAMPLE_RATE = 48_000;
export const QC_LOUDNESS_TARGET_LUFS = -14;
export const QC_LOUDNESS_TOLERANCE_LU = 1.0;
export const QC_TRUE_PEAK_LIMIT_DBTP = -1.0;
export const QC_DURATION_TOLERANCE_FRAMES = 1;
export const QC_BLACK_MIN_FRAMES = 6;
export const QC_FREEZE_MIN_FRAMES = 48;
export const QC_SILENCE_MIN_SAMPLES = 24_000;
/** One timeline frame (2000 samples) plus one AAC encoder frame of container padding (1024). */
export const QC_AUDIO_END_TOLERANCE_SAMPLES = 3_024;
export const QC_DETECTOR_VERSION = "qc-detectors-v1";
/** Wall-clock bound per QC tool invocation; the child is SIGKILLed past it. */
export const QC_TOOL_TIMEOUT_MS = 10 * 60_000;
/** The four human G09 checklist ids every final review must answer exactly once. */
export const FINAL_REVIEW_CHECKLIST_IDS = ["narrative", "visual", "audio", "captions"] as const;

/** FFmpeg detector arguments derived from the frozen thresholds (24 fps video, 48 kHz audio). */
export const QC_BLACKDETECT_FILTER = `blackdetect=d=${QC_BLACK_MIN_FRAMES / QC_FPS}:pix_th=0.10`;
export const QC_FREEZEDETECT_FILTER = `freezedetect=n=-60dB:d=${QC_FREEZE_MIN_FRAMES / QC_FPS}`;
export const QC_SILENCEDETECT_FILTER = `silencedetect=n=-50dB:d=${QC_SILENCE_MIN_SAMPLES / QC_SAMPLE_RATE}`;

/* ---------------------------------- schemas ---------------------------------- */
export const QcAdvisorySchema = z.strictObject({
  code: z.enum(["black_range", "freeze_range", "silence_in_spoken_cue"]),
  detectorVersion: IdSchema,
  message: z.string().min(1).max(2000),
  startFrame: z.number().int().safe().nonnegative().nullable(),
  endFrame: z.number().int().safe().nonnegative().nullable(),
  startSample: z.number().int().safe().nonnegative().nullable(),
  endSample: z.number().int().safe().nonnegative().nullable(),
  cueId: IdSchema.nullable(),
  threshold: z.string().min(1).max(200),
});
export type QcAdvisory = z.infer<typeof QcAdvisorySchema>;

export const QcBlockerSchema = z.strictObject({
  code: z.enum([
    "checksum_mismatch", "decoder_failure", "measurement_failed", "video_stream_missing",
    "video_codec_mismatch", "container_mismatch", "dimensions_mismatch", "fps_mismatch",
    "pixel_format_mismatch", "missing_audio_stream", "nonfinite_probe", "duration_tolerance",
    "loudness_violation", "truepeak_violation", "audio_end_tolerance", "spoken_segment_omitted",
  ]),
  message: z.string().min(1).max(2000),
});
export type QcBlocker = z.infer<typeof QcBlockerSchema>;

export const QcCheckSchema = z.strictObject({
  id: IdSchema,
  expected: z.string().min(1).max(500),
  actual: z.string().min(1).max(500),
  passed: z.boolean(),
  evidence: z.string().min(1).max(500),
});
export type QcCheck = z.infer<typeof QcCheckSchema>;

export const QcMeasuredSchema = z.strictObject({
  integratedLufs: z.number().finite().nullable(),
  truePeakDbtp: z.number().finite().nullable(),
  lraLu: z.number().finite().nullable(),
  durationFrames: z.number().int().safe().nonnegative().nullable(),
  expectedDurationFrames: z.number().int().safe().nonnegative(),
  audioEndSample: z.number().int().safe().nonnegative().nullable(),
  expectedAudioEndSample: z.number().int().safe().nonnegative().nullable(),
  codec: z.string().min(1).max(100).nullable(),
  container: z.string().min(1).max(200).nullable(),
  width: z.number().int().safe().positive().nullable(),
  height: z.number().int().safe().positive().nullable(),
  fps: z.number().finite().positive().nullable(),
  pixFmt: z.string().min(1).max(100).nullable(),
});

export const QcReportSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: z.string().regex(/^qc-[a-f0-9]{64}$/, "QC report id must be qc-<sha256>"),
  exportId: IdSchema,
  manifestId: IdSchema,
  manifestInputsHash: Sha256Schema,
  outputAssetId: IdSchema,
  outputSha256: Sha256Schema,
  draftOnly: z.boolean(),
  verdict: z.enum(["passed", "failed"]),
  measured: QcMeasuredSchema,
  checks: z.array(QcCheckSchema).max(64),
  blockers: z.array(QcBlockerSchema).max(64),
  advisories: z.array(QcAdvisorySchema).max(10_000),
  toolVersions: z.strictObject({ ffmpeg: z.string().min(1).max(200), ffprobe: z.string().min(1).max(200) }),
  toolFailure: z.strictObject({ stage: z.string().min(1).max(100), redactedStderr: z.string().min(1).max(2000) }).nullable(),
  detectorThresholds: z.record(z.string(), JsonValueSchema),
  createdAt: UtcMillisSchema,
});
export type QcReport = z.infer<typeof QcReportSchema>;

/** The C11 runner's failure.json artifact, read back verbatim by the QC routes. */
export const FailureRecordSchema = z.strictObject({
  version: SchemaVersionSchema,
  exportId: IdSchema,
  code: ProductionErrorCodeSchema,
  stage: z.string().min(1).max(100),
  shotRevisionId: IdSchema.nullable().optional(),
  cueId: IdSchema.nullable().optional(),
  redactedStderr: z.string().min(1).max(4000),
  at: UtcMillisSchema,
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;

export const ManifestSummarySchema = z.strictObject({
  profile: RenderProfileSchema,
  shotCount: z.number().int().safe().nonnegative().max(10_000),
  audioCueCount: z.number().int().safe().nonnegative().max(100_000),
  inputsHash: Sha256Schema,
});
export type ManifestSummary = z.infer<typeof ManifestSummarySchema>;

export const ExportDetailResponseSchema = z.strictObject({
  export: ExportSchema,
  manifestSummary: ManifestSummarySchema,
  qcReport: QcReportSchema.nullable(),
  failure: FailureRecordSchema.nullable(),
  owningProjectId: IdSchema,
});
export type ExportDetailResponse = z.infer<typeof ExportDetailResponseSchema>;

export const RunQcCommandSchema = z.strictObject({ kind: z.literal("run_qc") });
export const FinalReviewCommandSchema = z.strictObject({
  idempotencyKey: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  checklist: z.array(ApprovalChecklistItemSchema).max(100),
  notes: z.string().max(10_000),
  advisoryAcknowledgements: z.array(z.strictObject({ code: IdSchema, reason: NonEmptyTextSchema })).max(100),
  expectedOutputSha256: Sha256Schema,
});
export type FinalReviewCommand = z.infer<typeof FinalReviewCommandSchema>;
export const ExportActionCommandSchema = z.discriminatedUnion("kind", [
  RunQcCommandSchema,
  FinalReviewCommandSchema.extend({ kind: z.literal("final_review") }),
]);

/* ------------------------------ pure derivations ------------------------------ */
export interface QcEbur128Summary { integratedLufs: number; truePeakDbtp: number; lraLu: number }

/**
 * Parses the ffmpeg ebur128 (peak=true) stderr summary. Handles the ffmpeg 9+ multiline format
 * (true peak reported in dBFS, the same true-peak quantity) and the legacy single-line format
 * (preferring an explicit dBTP value). Returns null when no finite summary can be read.
 */
export function parseEbur128Summary(stderr: string): QcEbur128Summary | null {
  const block = stderr.slice(stderr.lastIndexOf("Summary:"));
  const number = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const integrated = number(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(block)?.[1]);
  if (integrated === null) return null;
  const legacyDbtp = number(/True peak:[^\n]*?Peak:\s*(-?\d+(?:\.\d+)?)\s*dBTP/.exec(block)?.[1]);
  const multilineDbfs = number(/True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(block)?.[1]);
  const singleLineDbfs = number(/True peak:[^\n]*?Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(block)?.[1]);
  const truePeakDbtp = legacyDbtp ?? multilineDbfs ?? singleLineDbfs;
  if (truePeakDbtp === null) return null;
  const lraLu = number(/\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU/.exec(block)?.[1]) ?? 0;
  return { integratedLufs: integrated, truePeakDbtp, lraLu };
}

export interface QcTimeInterval { start: number; end: number }
export interface QcDetectorIntervals { black: QcTimeInterval[]; freeze: QcTimeInterval[]; silence: QcTimeInterval[] }

const numberPattern = "-?\\d+(?:\\.\\d+)?";
const globalNumbers = (stderr: string, pattern: string): number[] => {
  const regex = new RegExp(pattern, "g");
  const values: number[] = [];
  for (let match = regex.exec(stderr); match !== null; match = regex.exec(stderr)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  return values;
};
const pairIntervals = (starts: number[], ends: number[], tailEnd: number): QcTimeInterval[] =>
  starts.map((start, index) => ({ start, end: index < ends.length ? ends[index]! : tailEnd }));

/**
 * Parses blackdetect/freezedetect/silencedetect stderr into second-based intervals. An
 * unterminated freeze or silence (detector fired at stream end; ffmpeg 9 emits only the start
 * line) closes at the probed video duration.
 */
export function parseBlackFreezeSilence(stderr: string, options: { videoDurationSeconds: number | null }): QcDetectorIntervals {
  const tailEnd = options.videoDurationSeconds ?? 0;
  const black: QcTimeInterval[] = [];
  const blackRegex = new RegExp(`black_start:(${numberPattern})\\s+black_end:(${numberPattern})`, "g");
  for (let match = blackRegex.exec(stderr); match !== null; match = blackRegex.exec(stderr)) {
    const start = Number(match[1]); const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) black.push({ start, end });
  }
  return {
    black,
    freeze: pairIntervals(globalNumbers(stderr, `freeze_start:\\s*(${numberPattern})`), globalNumbers(stderr, `freeze_end:\\s*(${numberPattern})`), tailEnd),
    silence: pairIntervals(globalNumbers(stderr, `silence_start:\\s*(${numberPattern})`), globalNumbers(stderr, `silence_end:\\s*(${numberPattern})`), tailEnd),
  };
}

/** The explicitly silent draft profile: no pinned audio mix revision or no audio cues at all. */
export function isSilentDraft(manifest: RenderManifest): boolean {
  return manifest.audioMixRevisionId === null || manifest.audioCues.length === 0;
}

/** Expected video length: one shot's trim each minus exactly 8 frames per internal crossfade. */
export function expectedTimelineFrames(manifest: RenderManifest): number {
  const sum = manifest.shots.reduce((total, shot) => total + (shot.endFrame - shot.startFrame), 0);
  const crossfades = manifest.shots.slice(0, -1).filter((shot) => shot.transition === "crossfade").length;
  return sum - crossfades * MANIFEST_CROSSFADE_FRAMES;
}

/** Expected audio end: the last declared cue's timeline end sample (0 when silent). */
export function expectedAudioEndSample(manifest: RenderManifest): number {
  return manifest.audioCues.reduce((end, cue) => Math.max(end, cue.timelineStartSample + (cue.sourceEndSample - cue.sourceStartSample)), 0);
}

export interface QcMeasurement {
  probe: {
    video: { codec: string; width: number; height: number; pixFmt: string; avgFrameRate: string; frames: number | null } | null;
    audio: { codec: string; sampleRate: number; channels: number; endSample: number | null } | null;
    formatName: string | null;
  } | null;
  checksumOk: boolean;
  decodeOk: boolean;
  ebur128: QcEbur128Summary | null;
  intervals: QcDetectorIntervals;
}

export interface QcEvaluation { verdict: "passed" | "failed"; blockers: QcBlocker[]; advisories: QcAdvisory[] }

const fpsFromRate = (avgFrameRate: string): number | null => {
  const match = /^(\d+)\/(\d+)$/.exec(avgFrameRate);
  if (!match) return null;
  const denominator = Number(match[2]);
  if (!denominator) return null;
  const fps = Number(match[1]) / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
};

/**
 * The single QC verdict function: automated blockers (no waiver) decide pass/fail; advisory
 * detections are attached as named evidence with their exact intervals and detector version and
 * never change the verdict. Deterministic given identical measurements.
 */
export function evaluateQc(manifest: RenderManifest, storyBeats: ReadonlyArray<{ id: string; narration: string }>, measurement: QcMeasurement): QcEvaluation {
  const draftOnly = isSilentDraft(manifest);
  const blockers: QcBlocker[] = [];
  const advisories: QcAdvisory[] = [];
  const video = measurement.probe?.video ?? null;
  const audio = measurement.probe?.audio ?? null;

  if (!measurement.checksumOk) blockers.push({ code: "checksum_mismatch", message: "The rendered output failed checksum verification against the recorded export asset; the bytes are not the rendered artifact." });
  if (!measurement.decodeOk) blockers.push({ code: "decoder_failure", message: "The rendered output failed full-decode verification; the file is not end-to-end decodable." });
  if (!video) blockers.push({ code: "video_stream_missing", message: "The rendered output carries no probeable video stream." });

  if (video) {
    const expectedFrames = expectedTimelineFrames(manifest);
    if (video.frames === null || !Number.isSafeInteger(video.frames)) {
      blockers.push({ code: "nonfinite_probe", message: "ffprobe could not report a finite decoded frame count for the output video stream." });
    } else if (Math.abs(video.frames - expectedFrames) > QC_DURATION_TOLERANCE_FRAMES) {
      blockers.push({ code: "duration_tolerance", message: `Output duration is ${video.frames} frames but the manifest timeline pins ${expectedFrames} frames; the tolerance is ${QC_DURATION_TOLERANCE_FRAMES} frame at ${QC_FPS} fps.` });
    }
    if (video.codec !== manifest.profile.videoCodec) blockers.push({ code: "video_codec_mismatch", message: `Output video codec is ${video.codec}, expected ${manifest.profile.videoCodec}.` });
    const container = measurement.probe?.formatName ?? null;
    if (!container || !container.includes("mp4")) blockers.push({ code: "container_mismatch", message: `Output container is ${container ?? "unknown"}, expected an MP4 family container.` });
    if (video.width !== manifest.profile.width || video.height !== manifest.profile.height) blockers.push({ code: "dimensions_mismatch", message: `Output dimensions are ${String(video.width)}x${String(video.height)}, expected ${manifest.profile.width}x${manifest.profile.height}.` });
    if (video.pixFmt !== manifest.profile.pixelFormat) blockers.push({ code: "pixel_format_mismatch", message: `Output pixel format is ${video.pixFmt}, expected ${manifest.profile.pixelFormat}.` });
    const measuredFps = fpsFromRate(video.avgFrameRate);
    if (measuredFps === null || Math.abs(measuredFps - manifest.profile.fps) > 0.001) {
      blockers.push({ code: "fps_mismatch", message: `Output average frame rate is ${video.avgFrameRate}, expected ${manifest.profile.fps} fps.` });
    }
    if (manifest.audioCues.length > 0 && !audio) {
      blockers.push({ code: "missing_audio_stream", message: "The manifest declares audio cues but the rendered output carries no audio stream." });
    }
  }

  if (!draftOnly) {
    if (audio && audio.endSample === null) {
      // A present audio stream with an unmeasurable end is a nonfinite probe value — a frozen
      // automated blocker — never a silent skip of the audio-end gate.
      blockers.push({ code: "nonfinite_probe", message: "ffprobe could not report a finite duration for the output audio stream; the audio-end check cannot be measured." });
    } else if (audio && audio.endSample !== null) {
      const expectedEnd = expectedAudioEndSample(manifest);
      if (Math.abs(audio.endSample - expectedEnd) > QC_AUDIO_END_TOLERANCE_SAMPLES) {
        blockers.push({ code: "audio_end_tolerance", message: `Audio stream ends at sample ${audio.endSample} but the declared cues end at sample ${expectedEnd}; the tolerance is one frame (${QC_AUDIO_END_TOLERANCE_SAMPLES} samples including AAC container padding).` });
      }
    }
    if (!measurement.ebur128) {
      if (manifest.audioCues.length > 0) blockers.push({ code: "nonfinite_probe", message: "The ebur128 loudness summary could not be parsed from the measurement pass." });
    } else {
      const lower = QC_LOUDNESS_TARGET_LUFS - QC_LOUDNESS_TOLERANCE_LU;
      const upper = QC_LOUDNESS_TARGET_LUFS + QC_LOUDNESS_TOLERANCE_LU;
      if (measurement.ebur128.integratedLufs < lower || measurement.ebur128.integratedLufs > upper) {
        blockers.push({ code: "loudness_violation", message: `Measured integrated loudness is ${measurement.ebur128.integratedLufs} LUFS, outside the frozen ${QC_LOUDNESS_TARGET_LUFS} LUFS ±${QC_LOUDNESS_TOLERANCE_LU} window (pass range [${lower}, ${upper}]).` });
      }
      if (measurement.ebur128.truePeakDbtp > QC_TRUE_PEAK_LIMIT_DBTP) {
        blockers.push({ code: "truepeak_violation", message: `Measured true peak is ${measurement.ebur128.truePeakDbtp} dBTP, above the frozen ${QC_TRUE_PEAK_LIMIT_DBTP} dBTP limit (hard clipping guard).` });
      }
    }
    // Required spoken segment omitted from declared cues: every narrated story beat must appear
    // verbatim as the source text of a spoken (narration/dialogue) cue.
    const spokenCues = manifest.audioCues.filter((cue) => cue.role === "narration" || cue.role === "dialogue");
    const missingBeats = storyBeats
      .filter((beat) => beat.narration.trim().length > 0)
      .filter((beat) => !spokenCues.some((cue) => (cue.sourceText ?? "").trim() === beat.narration.trim()))
      .map((beat) => beat.id);
    if (missingBeats.length > 0) {
      blockers.push({ code: "spoken_segment_omitted", message: `Required spoken segments omitted from the declared cues: ${missingBeats.join(", ")}.` });
    }
  }

  // Advisories: detection is evidence to inspect, never autonomous acceptance.
  for (const interval of measurement.intervals.black) {
    const startFrame = Math.round(interval.start * QC_FPS);
    const endFrame = Math.round(interval.end * QC_FPS);
    if (endFrame - startFrame < QC_BLACK_MIN_FRAMES) continue;
    advisories.push({
      code: "black_range", detectorVersion: QC_DETECTOR_VERSION,
      message: `Black video detected from frame ${startFrame} to ${endFrame} (${endFrame - startFrame} frames); confirm this black is an approved fade, not a missing shot.`,
      startFrame, endFrame, startSample: null, endSample: null, cueId: null,
      threshold: `black >= ${QC_BLACK_MIN_FRAMES} frames outside approved fades`,
    });
  }
  for (const interval of measurement.intervals.freeze) {
    const startFrame = Math.round(interval.start * QC_FPS);
    const endFrame = Math.round(interval.end * QC_FPS);
    if (endFrame - startFrame < QC_FREEZE_MIN_FRAMES) continue;
    advisories.push({
      code: "freeze_range", detectorVersion: QC_DETECTOR_VERSION,
      message: `Frozen picture detected from frame ${startFrame} to ${endFrame} (${endFrame - startFrame} frames); confirm this is a planned static shot.`,
      startFrame, endFrame, startSample: null, endSample: null, cueId: null,
      threshold: `freeze >= ${QC_FREEZE_MIN_FRAMES} frames unless planned static shot`,
    });
  }
  const spoken = manifest.audioCues.filter((cue) => cue.role === "narration" || cue.role === "dialogue");
  for (const interval of measurement.intervals.silence) {
    const startSample = Math.round(interval.start * QC_SAMPLE_RATE);
    const endSample = Math.round(interval.end * QC_SAMPLE_RATE);
    if (endSample - startSample < QC_SILENCE_MIN_SAMPLES) continue;
    // The gate counts silence INSIDE a spoken cue: the overlap with the cue interval must itself
    // reach the threshold, so a rounding-level clip of the cue edge is not an advisory.
    const cue = spoken.find((candidate) => {
      const cueStart = candidate.timelineStartSample;
      const cueEnd = candidate.timelineStartSample + (candidate.sourceEndSample - candidate.sourceStartSample);
      return Math.min(endSample, cueEnd) - Math.max(startSample, cueStart) >= QC_SILENCE_MIN_SAMPLES;
    });
    if (!cue) continue;
    advisories.push({
      code: "silence_in_spoken_cue", detectorVersion: QC_DETECTOR_VERSION,
      message: `Unexplained silence from sample ${startSample} to ${endSample} inside spoken cue ${cue.id}; listen to this range before approving.`,
      startFrame: null, endFrame: null, startSample, endSample, cueId: cue.id,
      threshold: `unexplained silence >= ${QC_SILENCE_MIN_SAMPLES} samples inside a spoken cue`,
    });
  }

  return { verdict: blockers.length === 0 ? "passed" : "failed", blockers, advisories };
}

export interface BuildQcReportInput {
  manifest: RenderManifest;
  exportId: string;
  outputAssetId: string;
  outputSha256: string;
  measurement: QcMeasurement | null;
  evaluation: QcEvaluation;
  toolVersions: { ffmpeg: string; ffprobe: string };
  toolFailure: { stage: string; redactedStderr: string } | null;
  createdAt: number;
}

const describeExpected = (manifest: RenderManifest): string => `${manifest.profile.width}x${manifest.profile.height}`;

/**
 * Builds the deterministic, content-addressed QC report: id = "qc-" + sha256(canonical report
 * body). The report carries the output checksum AND the manifest inputs hash, per-check
 * expected/actual/evidence rows, and the frozen detector thresholds.
 */
export function buildQcReport(input: BuildQcReportInput): QcReport {
  const manifest = input.manifest;
  const draftOnly = isSilentDraft(manifest);
  const video = input.measurement?.probe?.video ?? null;
  const audio = input.measurement?.probe?.audio ?? null;
  const expectedFrames = expectedTimelineFrames(manifest);
  const expectedEnd = draftOnly ? null : expectedAudioEndSample(manifest);
  const checks: QcCheck[] = [
    {
      id: "checksum", expected: "output sha256 equals the recorded export asset sha256",
      actual: input.measurement === null ? "not measured" : input.measurement.checksumOk ? "verified" : "mismatch",
      passed: input.measurement?.checksumOk === true, evidence: "vault.readVerified + post-pass re-hash",
    },
    {
      id: "decode", expected: "full decode exits 0",
      actual: input.measurement === null ? "not measured" : input.measurement.decodeOk ? "exit 0" : "nonzero exit",
      passed: input.measurement?.decodeOk === true, evidence: "ffmpeg -xerror -f null decode pass",
    },
    {
      id: "container", expected: "mp4 family container",
      actual: input.measurement?.probe?.formatName ?? "unavailable",
      passed: (input.measurement?.probe?.formatName ?? "").includes("mp4"), evidence: "ffprobe format_name",
    },
  ];
  if (video) {
    checks.push(
      { id: "video_codec", expected: manifest.profile.videoCodec, actual: video.codec, passed: video.codec === manifest.profile.videoCodec, evidence: "ffprobe stream codec_name" },
      { id: "dimensions", expected: describeExpected(manifest), actual: `${String(video.width)}x${String(video.height)}`, passed: video.width === manifest.profile.width && video.height === manifest.profile.height, evidence: "ffprobe stream width/height" },
      { id: "pixel_format", expected: manifest.profile.pixelFormat, actual: video.pixFmt, passed: video.pixFmt === manifest.profile.pixelFormat, evidence: "ffprobe stream pix_fmt" },
      { id: "fps", expected: `${manifest.profile.fps} fps`, actual: video.avgFrameRate, passed: (() => { const fps = fpsFromRate(video.avgFrameRate); return fps !== null && Math.abs(fps - manifest.profile.fps) <= 0.001; })(), evidence: "ffprobe stream avg_frame_rate" },
      { id: "duration", expected: `${expectedFrames} frames ±${QC_DURATION_TOLERANCE_FRAMES}`, actual: video.frames === null ? "unavailable" : `${video.frames} frames`, passed: video.frames !== null && Math.abs(video.frames - expectedFrames) <= QC_DURATION_TOLERANCE_FRAMES, evidence: "ffprobe -count_frames nb_read_frames" },
    );
  }
  if (manifest.audioCues.length > 0) {
    checks.push({
      id: "audio_stream", expected: `aac ${manifest.profile.sampleRate} Hz stereo`,
      actual: audio ? `${audio.codec} ${audio.sampleRate} Hz ${audio.channels}ch` : "missing",
      passed: audio !== null, evidence: "ffprobe audio stream",
    });
  }
  if (!draftOnly) {
    const summary = input.measurement?.ebur128 ?? null;
    const lower = QC_LOUDNESS_TARGET_LUFS - QC_LOUDNESS_TOLERANCE_LU;
    const upper = QC_LOUDNESS_TARGET_LUFS + QC_LOUDNESS_TOLERANCE_LU;
    checks.push(
      { id: "integrated_loudness", expected: `${QC_LOUDNESS_TARGET_LUFS} LUFS ±${QC_LOUDNESS_TOLERANCE_LU} (pass [${lower}, ${upper}])`, actual: summary ? `${summary.integratedLufs} LUFS` : "unavailable", passed: summary !== null && summary.integratedLufs >= lower && summary.integratedLufs <= upper, evidence: "ffmpeg ebur128=peak=true summary" },
      { id: "true_peak", expected: `<= ${QC_TRUE_PEAK_LIMIT_DBTP} dBTP`, actual: summary ? `${summary.truePeakDbtp} dBTP` : "unavailable", passed: summary !== null && summary.truePeakDbtp <= QC_TRUE_PEAK_LIMIT_DBTP, evidence: "ffmpeg ebur128=peak=true summary" },
    );
    if (manifest.audioCues.length > 0) {
      checks.push({
        id: "audio_end", expected: `${String(expectedEnd)} samples ±${QC_AUDIO_END_TOLERANCE_SAMPLES}`,
        actual: audio?.endSample === null || audio === null ? "unavailable" : `${audio.endSample} samples`,
        passed: audio?.endSample != null && expectedEnd !== null && Math.abs(audio.endSample - expectedEnd) <= QC_AUDIO_END_TOLERANCE_SAMPLES,
        evidence: "ffprobe audio stream duration",
      });
    }
    checks.push({
      id: "spoken_segments", expected: "every narrated story beat declared as a spoken cue",
      actual: input.evaluation.blockers.some((blocker) => blocker.code === "spoken_segment_omitted") ? "omitted segments present" : "all declared",
      passed: !input.evaluation.blockers.some((blocker) => blocker.code === "spoken_segment_omitted"),
      evidence: "manifest audioCues vs story beats",
    });
  }
  const body = {
    version: 1 as const,
    exportId: input.exportId,
    manifestId: manifest.id,
    manifestInputsHash: manifest.inputsHash,
    outputAssetId: input.outputAssetId,
    outputSha256: input.outputSha256,
    draftOnly,
    verdict: input.evaluation.verdict,
    measured: {
      integratedLufs: draftOnly ? null : input.measurement?.ebur128?.integratedLufs ?? null,
      truePeakDbtp: draftOnly ? null : input.measurement?.ebur128?.truePeakDbtp ?? null,
      lraLu: draftOnly ? null : input.measurement?.ebur128?.lraLu ?? null,
      durationFrames: video?.frames ?? null,
      expectedDurationFrames: expectedFrames,
      audioEndSample: draftOnly ? null : audio?.endSample ?? null,
      expectedAudioEndSample: expectedEnd,
      codec: video?.codec ?? null,
      container: input.measurement?.probe?.formatName ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: video ? fpsFromRate(video.avgFrameRate) : null,
      pixFmt: video?.pixFmt ?? null,
    },
    checks,
    blockers: input.evaluation.blockers,
    advisories: input.evaluation.advisories,
    toolVersions: input.toolVersions,
    toolFailure: input.toolFailure,
    detectorThresholds: {
      detectorVersion: QC_DETECTOR_VERSION,
      fps: QC_FPS, sampleRate: QC_SAMPLE_RATE,
      loudnessTargetLufs: QC_LOUDNESS_TARGET_LUFS, loudnessToleranceLu: QC_LOUDNESS_TOLERANCE_LU,
      truePeakLimitDbtp: QC_TRUE_PEAK_LIMIT_DBTP,
      durationToleranceFrames: QC_DURATION_TOLERANCE_FRAMES,
      audioEndToleranceSamples: QC_AUDIO_END_TOLERANCE_SAMPLES,
      blackMinFrames: QC_BLACK_MIN_FRAMES, freezeMinFrames: QC_FREEZE_MIN_FRAMES,
      silenceMinSamples: QC_SILENCE_MIN_SAMPLES,
    },
    createdAt: input.createdAt,
  };
  const id = `qc-${hashCanonicalJson(body)}`;
  return QcReportSchema.parse({ ...body, id });
}
