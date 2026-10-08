import { z } from "zod";
import { ManifestShotSchema, RenderProfileSchema, type AudioCue, type ProductionProfile } from "./contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "./errors";
import { hashCanonicalJson } from "./hash";

/**
 * Manifest domain: the deterministic manifest fingerprint recipe, integer-only timeline arithmetic
 * (24 fps frames, 2000-sample audio frames, 8-frame crossfade overlap), legal trim/crop/transition
 * validation, audio exactness against the video timeline, and the frozen v1 render profile. Pure
 * functions only; persistence and store access live in the manifest service.
 */
export const MANIFEST_MASTERING_RECIPE_VERSION = 1;
export const MANIFEST_CROSSFADE_FRAMES = 8;
export const MANIFEST_SAMPLES_PER_FRAME = 2_000;
export type ManifestTransition = "cut" | "crossfade";
export type ManifestRenderProfile = z.infer<typeof RenderProfileSchema>;
export type ManifestShot = z.infer<typeof ManifestShotSchema>;
export type ManifestShotSource = Readonly<{
  shotRevisionId: string; shotHash: string; takeId: string; takeInputsHash: string;
  assetId: string; assetSha256: string; assetWidth: number; assetHeight: number;
  actualFrames: number; startFrame: number; endFrame: number;
  crop: Readonly<{ x: number; y: number; width: number; height: number }>;
  transition: ManifestTransition;
}>;
export type ManifestCompileModel = Readonly<{
  projectId: string; storyRevisionId: string; storyHash: string;
  shotPlanRevisionId: string; shotPlanHash: string; animaticRevisionId: string; animaticHash: string;
  audioMixRevisionId: string | null; audioMixHash: string | null;
  profile: ManifestRenderProfile;
  shots: readonly ManifestShotSource[];
  audioCues: readonly AudioCue[];
  captionCues: readonly [];
  totalFrames: number; totalAudioSamples: number; selectionVersion: number;
  masteringRecipeVersion: typeof MANIFEST_MASTERING_RECIPE_VERSION;
}>;
export interface ManifestAudioExactness { readonly sampleRate: number; readonly totalSamples: number; readonly totalEndSample: number }

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }

/**
 * SHA-256 over exactly the semantically pinned manifest inputs (recipe version, mastering recipe,
 * revision identities and hashes, selection version, profile, per-shot accepted media and trims in
 * plan order, crossfade rule, and full cue content in mix revision order). Excludes the manifest id,
 * createdAt, derived totals and every other non-pinned field; deterministic across object key order
 * by construction of the canonical JSON.
 */
export function manifestInputsHash(model: ManifestCompileModel): string {
  return hashCanonicalJson({
    recipeVersion: 1,
    masteringRecipeVersion: model.masteringRecipeVersion,
    projectId: model.projectId,
    storyRevisionId: model.storyRevisionId,
    storyHash: model.storyHash,
    shotPlanRevisionId: model.shotPlanRevisionId,
    shotPlanHash: model.shotPlanHash,
    animaticRevisionId: model.animaticRevisionId,
    animaticHash: model.animaticHash,
    selectionVersion: model.selectionVersion,
    profile: model.profile,
    shots: model.shots.map((shot) => ({
      shotRevisionId: shot.shotRevisionId, shotHash: shot.shotHash, takeId: shot.takeId,
      takeInputsHash: shot.takeInputsHash, assetSha256: shot.assetSha256,
      startFrame: shot.startFrame, endFrame: shot.endFrame, crop: shot.crop, transition: shot.transition,
    })),
    crossfadeFrames: MANIFEST_CROSSFADE_FRAMES,
    audioMixRevisionId: model.audioMixRevisionId,
    audioMixHash: model.audioMixHash,
    audioCues: model.audioCues.map(({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights }) =>
      ({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights })),
    captionCues: [],
  });
}

export const manifestId = (inputsHash: string): string => `manifest-${inputsHash}`;

/**
 * Validates every shot's legal trim (half-open [startFrame,endFrame) inside the actual source
 * frames), crop (inside the positive integer source dimensions) and transition (crossfade only
 * toward a following shot; the last shot must cut), then totals the timeline: one shot's trim
 * length each, minus exactly 8 frames per internal crossfade boundary. Fails closed naming the
 * offending shot revision; expectedTotalFrames, when given, must match the computed total.
 */
export function compileManifestTimeline(shots: readonly ManifestShotSource[], options: { expectedTotalFrames?: number } = {}): number {
  let sumFrames = 0;
  let crossfades = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]!;
    const isLast = index === shots.length - 1;
    if (!Number.isSafeInteger(shot.assetWidth) || shot.assetWidth <= 0 || !Number.isSafeInteger(shot.assetHeight) || shot.assetHeight <= 0) {
      fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} requires positive integer source dimensions, received ${String(shot.assetWidth)}x${String(shot.assetHeight)}.`);
    }
    if (!Number.isSafeInteger(shot.actualFrames) || shot.actualFrames <= 0) {
      fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} requires a positive safe integer actual frame count, received ${String(shot.actualFrames)}.`);
    }
    if (!Number.isSafeInteger(shot.startFrame) || !Number.isSafeInteger(shot.endFrame) || shot.startFrame < 0 || shot.endFrame <= shot.startFrame || shot.endFrame > shot.actualFrames) {
      fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} trim [${String(shot.startFrame)},${String(shot.endFrame)}) is not a half-open integer range inside its ${shot.actualFrames}-frame source.`);
    }
    const { x, y, width, height } = shot.crop;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > shot.assetWidth || y + height > shot.assetHeight) {
      fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} crop ${JSON.stringify(shot.crop)} does not fit inside its ${shot.assetWidth}x${shot.assetHeight} source.`);
    }
    if (isLast && shot.transition !== "cut") {
      fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} is the final shot and must cut, not ${shot.transition}.`);
    }
    if (shot.transition === "crossfade") crossfades += 1;
    sumFrames += shot.endFrame - shot.startFrame;
    if (!Number.isSafeInteger(sumFrames)) fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} pushes the timeline frame sum outside the safe integer range.`);
  }
  const totalFrames = sumFrames - crossfades * MANIFEST_CROSSFADE_FRAMES;
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) {
    fail("INVALID_INPUT", `Compiled timeline totals ${totalFrames} frames; a positive safe integer timeline is required.`);
  }
  if (options.expectedTotalFrames !== undefined && options.expectedTotalFrames !== totalFrames) {
    fail("INVALID_INPUT", `Compiled timeline totals ${totalFrames} frames but the approved animatic pins ${String(options.expectedTotalFrames)} frames.`);
  }
  return totalFrames;
}

/**
 * Integer-exact audio exactness: the timeline holds totalFrames * 2000 samples and every cue must
 * end at or before that bound, else the cue id is named. The returned totalEndSample mirrors the
 * accepted serializeAudioTimeline ordering result (max cue end, zero when empty).
 */
export function validateAudioExactness(totalFrames: number, cues: readonly AudioCue[], options: { sampleRate?: number } = {}): ManifestAudioExactness {
  const sampleRate = options.sampleRate ?? 48_000;
  if (sampleRate !== 48_000) fail("INVALID_INPUT", `Audio exactness requires the fixed 48000 Hz production sample rate, received ${String(sampleRate)}.`);
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) fail("INVALID_INPUT", `Total frame count must be a positive safe integer, received ${String(totalFrames)}.`);
  const totalSamples = totalFrames * MANIFEST_SAMPLES_PER_FRAME;
  if (!Number.isSafeInteger(totalSamples)) fail("INVALID_INPUT", `The ${totalFrames}-frame timeline needs an unsafe ${String(totalSamples)}-sample audio bound.`);
  let totalEndSample = 0;
  for (const cue of cues) {
    const timelineEndSample = cue.timelineStartSample + (cue.sourceEndSample - cue.sourceStartSample);
    if (!Number.isSafeInteger(timelineEndSample) || timelineEndSample > totalSamples) {
      fail("INVALID_INPUT", `Audio cue ${cue.id} ends at sample ${String(timelineEndSample)}, past the ${totalSamples}-sample (${totalFrames}-frame) video timeline.`);
    }
    if (timelineEndSample > totalEndSample) totalEndSample = timelineEndSample;
  }
  return { sampleRate, totalSamples, totalEndSample };
}

/** Builds the frozen v1 export profile for the project's production profile: 1080x1920 (9:16) or 1920x1080 (16:9), 24 fps H.264/yuv420p with 48 kHz AAC. */
export function buildRenderProfile(profile: ProductionProfile): ManifestRenderProfile {
  const portrait = profile.format === "9:16";
  return Object.freeze(RenderProfileSchema.parse({
    id: `render-profile-${profile.id}`,
    version: 1,
    aspect: profile.format,
    width: portrait ? 1080 : 1920,
    height: portrait ? 1920 : 1080,
    fps: 24,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    sampleRate: 48_000,
  }));
}
