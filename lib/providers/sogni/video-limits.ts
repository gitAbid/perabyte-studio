/**
 * Per-family render limits for Sogni video models, mirroring the SDK's
 * `VideoProjectParams` validation (which mirrors the server):
 *
 * | family       | duration (s)        | fps | notes                              |
 * |--------------|---------------------|-----|------------------------------------|
 * | wan_v2.2     | 1–10                | 16 gen | `duration*16+1` frames          |
 * | ltx25        | 2–20                | free | frames snap to `1 + n*8`          |
 * | ltx23        | 4–20                | free | frames snap to `1 + n*8`          |
 * | seedance-2-5 | 4–30                | 24  |                                    |
 * | seedance-2-0 | 4–15                | 24  |                                    |
 * | happyhorse   | 3–15                | 24  |                                    |
 * | minimax-h3   | 124/24–362/24 ≈ 5.167–15.083 | 24 | frames snap to `124 + n*17` |
 *
 * Aspect: `4:5` / `3:2` snap to `3:4` / `4:3` (see request-maps VIDEO_RATIOS).
 * Resolution: only MiniMax H3 takes explicit dimensions (32px grid, ≤1344px
 * per axis, ≤1,032,192 px total); every other family renders at a server-side
 * default with no resolution input, so those report `resolutions: []`.
 */
import type { AspectKey, ResolutionKey } from "@/lib/constants";

export interface VideoLimits {
  duration: { min: number; max: number };
  /** Aspect presets the model accepts; empty = model has no ratio input. */
  ratios: readonly AspectKey[];
  /** Resolution presets the model can honor; empty = server-side default. */
  resolutions: readonly ResolutionKey[];
}

/** All studio aspect presets — these are the boxes our ratio map covers. */
const ALL_RATIOS: readonly AspectKey[] = ["16:9", "9:16", "1:1", "4:5", "3:2"];

/** MiniMax H3 hard caps from the SDK (Projects/utils constants). */
const MINIMAX_H3 = {
  fps: 24,
  minFrames: 124,
  maxFrames: 362,
  frameStep: 17,
  dimensionStep: 32,
  maxDimension: 1344,
  maxPixels: 1_032_192,
} as const;

export function isMinimaxH3(model: string): boolean {
  return model.startsWith("minimax-h3");
}

/** Duration range per model family; the SDK rejects anything outside it. */
export function sogniVideoLimits(model: string): VideoLimits {
  if (isMinimaxH3(model)) {
    return {
      duration: { min: MINIMAX_H3.minFrames / MINIMAX_H3.fps, max: MINIMAX_H3.maxFrames / MINIMAX_H3.fps },
      ratios: ALL_RATIOS,
      resolutions: ["720p", "1080p"],
    };
  }
  if (model.startsWith("seedance-2-5")) {
    return { duration: { min: 4, max: 30 }, ratios: ALL_RATIOS, resolutions: [] };
  }
  if (model.startsWith("seedance")) {
    return { duration: { min: 4, max: 15 }, ratios: ALL_RATIOS, resolutions: [] };
  }
  if (model.startsWith("happyhorse")) {
    return { duration: { min: 3, max: 15 }, ratios: ALL_RATIOS, resolutions: [] };
  }
  if (model.startsWith("ltx23")) {
    return { duration: { min: 4, max: 20 }, ratios: ALL_RATIOS, resolutions: [] };
  }
  if (model.startsWith("ltx")) {
    return { duration: { min: 2, max: 20 }, ratios: ALL_RATIOS, resolutions: [] };
  }
  // wan_v2.2 and anything new until Sogni widens the default.
  return { duration: { min: 1, max: 10 }, ratios: ALL_RATIOS, resolutions: [] };
}

/**
 * MiniMax H3 canvas for an aspect + resolution preset: scale the preset box
 * onto the 32px grid, clamped to both hard caps (≤1344px per axis, ≤ max
 * pixels). Returns undefined for models without explicit dimensions.
 */
export function minimaxH3Dimensions(
  aspect: AspectKey,
  resolution: ResolutionKey,
): { width: number; height: number } | undefined {
  const boxes: Record<AspectKey, [number, number]> = {
    "16:9": [1280, 720],
    "9:16": [720, 1280],
    "1:1": [1024, 1024],
    "4:5": [896, 1120],
    "3:2": [1200, 800],
  };
  const scale: Record<ResolutionKey, number> = { "720p": 0.75, "1080p": 1, "1440p": 1.25, "4K": 1.5 };
  const snap = (v: number) =>
    Math.max(MINIMAX_H3.dimensionStep, Math.round(v / MINIMAX_H3.dimensionStep) * MINIMAX_H3.dimensionStep);
  let [w, h] = boxes[aspect];
  w = snap(w * scale[resolution]);
  h = snap(h * scale[resolution]);
  // Overshoot caps: scale down proportionally until both are satisfied.
  while (
    (w > MINIMAX_H3.maxDimension || h > MINIMAX_H3.maxDimension ||
      w * h > MINIMAX_H3.maxPixels) &&
    w > MINIMAX_H3.dimensionStep && h > MINIMAX_H3.dimensionStep
  ) {
    w = snap(w * 0.9);
    h = snap(h * 0.9);
  }
  return { width: w, height: h };
}
