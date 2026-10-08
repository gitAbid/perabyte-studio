/**
 * Encoder realization of the frozen v1 render profile (ARCHITECTURE.md "Export recipe v1") for the
 * local FFmpeg assembly. The single source of truth for the profile shape stays the accepted
 * manifest domain builder; this module only re-exports it and owns the concrete encoder arguments,
 * loudness targets, and assembly resource bounds used by ./assembly.
 */
export { buildRenderProfile, type ManifestRenderProfile } from "../../production/manifest";

/** Deterministic FFmpeg encoder arguments for recipe v1: H.264 High CRF 18, BT.709 SDR, AAC-LC stereo. */
export const ASSEMBLY_ENCODER_RECIPE: Readonly<{
  videoCodec: "libx264"; profile: "high"; preset: "medium"; crf: 18; pixelFormat: "yuv420p"; fps: 24;
  colorPrimaries: "bt709"; colorTrc: "bt709"; colorspace: "bt709"; movFlags: "+faststart";
  audioCodec: "aac"; audioBitrate: "192k"; sampleRate: 48000; channels: 2;
}> = Object.freeze({
  videoCodec: "libx264",
  profile: "high",
  preset: "medium",
  crf: 18,
  pixelFormat: "yuv420p",
  fps: 24,
  colorPrimaries: "bt709",
  colorTrc: "bt709",
  colorspace: "bt709",
  movFlags: "+faststart",
  audioCodec: "aac",
  audioBitrate: "192k",
  sampleRate: 48_000,
  channels: 2,
});

/** Loudness normalization applied to the mixed cue bus (measured enforcement is C12's gate). */
export const ASSEMBLY_LOUDNORM: Readonly<{ integratedLufs: -14; truePeakDbtp: -1; lra: 11 }> = Object.freeze({ integratedLufs: -14, truePeakDbtp: -1, lra: 11 });

/** Hard input cap for one FFmpeg invocation (shots plus audio cues). */
export const ASSEMBLY_MAX_INPUTS = 512;
/** Upper bound on total staged source bytes for one assembly run. */
export const ASSEMBLY_MAX_STAGED_BYTES = 8 * 1024 * 1024 * 1024;
/** Wall-clock bound for one FFmpeg render; the child is SIGKILLed past it. */
export const ASSEMBLY_RENDER_TIMEOUT_MS = 30 * 60 * 1000;
/** Export lease validity and heartbeat cadence, mirroring the accepted job-worker constants. */
export const EXPORT_LEASE_MS = 30_000;
export const EXPORT_HEARTBEAT_MS = 10_000;
/** Upper bound on stale non-terminal exports re-driven by one scheduler trigger. */
export const EXPORT_REDRIVE_LIMIT = 8;
