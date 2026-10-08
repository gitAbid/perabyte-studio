import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { hashCanonicalJson } from "../../production/hash";

/**
 * Derivative exports (M6-2, spec 15 acceptance: "Export variants derive from
 * same manifest"). One approved master → aspect/quality variants by pure
 * ffmpeg scale+crop — no manifest recompilation, no re-generation, so every
 * variant is provably the same cut. Cached on disk keyed by
 * master-sha + aspect + quality; a failed encode preserves the previous valid
 * derivative (write-temp-then-rename).
 */

export const DERIVATIVE_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const DERIVATIVE_QUALITIES = ["high", "medium"] as const;

export const DerivativeRequestSchema = z.strictObject({
  aspect: z.enum(DERIVATIVE_ASPECTS),
  quality: z.enum(DERIVATIVE_QUALITIES),
});

export type DerivativeAspect = (typeof DERIVATIVE_ASPECTS)[number];
export type DerivativeQuality = (typeof DERIVATIVE_QUALITIES)[number];

const QUALITY_SETTINGS: Record<DerivativeQuality, { crf: number; preset: string }> = {
  high: { crf: 18, preset: "slow" },
  medium: { crf: 23, preset: "fast" },
};

/** Even-dimension center-crop target for one aspect from a source size (null when the source is unusable). */
export function deriveDerivativeDimensions(sourceWidth: number, sourceHeight: number, aspect: DerivativeAspect): { width: number; height: number } | null {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const [numerator, denominator] = aspect.split(":").map(Number) as [number, number];
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = numerator / denominator;
  // Fit INSIDE the source (cover the target frame, crop the spill): the
  // limiting dimension keeps its full size, the other crops to the ratio.
  let width: number;
  let height: number;
  if (sourceRatio > targetRatio) {
    height = sourceHeight;
    width = Math.round((sourceHeight * targetRatio));
  } else {
    width = sourceWidth;
    height = Math.round((sourceWidth / targetRatio));
  }
  // Encoders want even dimensions.
  width = Math.max(2, width - (width % 2));
  height = Math.max(2, height - (height % 2));
  return { width, height };
}

export function derivativeFilter(aspect: DerivativeAspect, sourceWidth: number, sourceHeight: number): string | null {
  const size = deriveDerivativeDimensions(sourceWidth, sourceHeight, aspect);
  if (!size) return null;
  return `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`;
}

/** Stable cache key: identical master + request → identical cached file. */
export function derivativeCacheKey(masterSha256: string, request: { aspect: DerivativeAspect; quality: DerivativeQuality }): string {
  return hashCanonicalJson({ masterSha256, ...request }).slice(0, 32);
}

export interface DerivativeBuildOptions {
  masterPath: string;
  outPath: string;
  aspect: DerivativeAspect;
  quality: DerivativeQuality;
  ffmpegPath: string;
  sourceWidth: number;
  sourceHeight: number;
  timeoutMs?: number;
}

/** Encodes one derivative atomically; resolves with the final path. */
export async function buildDerivative(options: DerivativeBuildOptions): Promise<string> {
  const filter = derivativeFilter(options.aspect, options.sourceWidth, options.sourceHeight);
  if (!filter) throw new Error("Derivative dimensions could not be derived from the master's probe.");
  const { crf, preset } = QUALITY_SETTINGS[options.quality];
  const temp = `${options.outPath}.${process.pid}.tmp.mp4`;
  await mkdir(dirname(resolve(options.outPath)), { recursive: true, mode: 0o700 });
  try {
    await runFfmpeg(options.ffmpegPath, [
      "-y", "-v", "error", "-xerror", "-i", options.masterPath,
      "-vf", filter,
      "-c:v", "libx264", "-crf", String(crf), "-preset", preset, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      temp,
    ], options.timeoutMs ?? 300_000);
    if (!existsSync(temp)) throw new Error("The derivative encode produced no output.");
    await rm(options.outPath, { force: true });
    await rename(temp, options.outPath);
    return options.outPath;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface MasterProbe { width: number; height: number }

/** Probes the master's video dimensions (first video stream); rejects unusable files. */
export async function probeMasterDimensions(ffprobePath: string, masterPath: string, timeoutMs = 30_000): Promise<MasterProbe> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", masterPath], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("The master probe timed out.")); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`ffprobe exited ${code ?? "signal"}`)); });
  });
  const parsed = JSON.parse(raw) as { streams?: Array<{ width?: number; height?: number }> };
  const stream = parsed.streams?.[0];
  if (!stream || typeof stream.width !== "number" || typeof stream.height !== "number" || stream.width <= 0 || stream.height <= 0) {
    throw new Error("The approved master has no readable video dimensions; a derivative cannot be derived.");
  }
  return { width: stream.width, height: stream.height };
}

function runFfmpeg(ffmpegPath: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The derivative encode exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? "signal"}: ${stderr.slice(-400)}`));
    });
  });
}
