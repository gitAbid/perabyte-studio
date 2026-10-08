import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  IdSchema, ManifestShotSchema, RenderManifestSchema, RenderProfileSchema, Sha256Schema, UtcMillisSchema,
  type Project, type RenderManifest,
} from "../../production/contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { MANIFEST_CROSSFADE_FRAMES } from "../../production/manifest";
import {
  MANUAL_UPLOAD_DISCLAIMER, buildSrt, derivePackageMetadataDefaults, formatChapterTimestamp,
} from "../../production/publishing";
import { resolveProductionDataDir, withProductionStore } from "../../production/runtime";
import { redactStderr, resolveMediaTools, type MediaToolPaths } from "./assembly";
import type { ProductionStore } from "../../repositories/production/ports";

/**
 * M4-5 manual export package (spec 15): assembles the complete manual-upload bundle —
 * `video.mp4, thumbnail.png, captions.srt, title.txt, description.txt, hashtags.txt,
 * chapters.txt, production.json` — as a stored (uncompressed) zip with a deterministic entry
 * order. The master MP4 is only ever the approved bytes, read back through the checksum-enforced
 * vault; the thumbnail is a real ffmpeg frame extract from those bytes; captions are the
 * manifest's frame-ranged cues via the frozen SRT builder; chapter stamps use the frozen
 * formatChapterTimestamp. Built packages are cached under the export directory keyed by a hash
 * of every package input, written temp-then-rename so a failed build preserves the previous
 * valid package. Metadata defaults are deterministic; the creator's edits persist server-side in
 * `package-overrides.json` beside the export record. Manual package is complete without any
 * platform connection: nothing here uploads, contacts a platform, or fabricates an outcome.
 */

export const PACKAGE_SCHEMA_VERSION = 1;
/** Deterministic zip entry order, verbatim per spec 15's manual package file list. */
export const PACKAGE_ENTRY_NAMES = [
  "video.mp4", "thumbnail.png", "captions.srt", "title.txt", "description.txt", "hashtags.txt", "chapters.txt", "production.json",
] as const;
export type PackageEntryName = (typeof PACKAGE_ENTRY_NAMES)[number];
export const THUMBNAIL_MAX_LONG_EDGE = 1920;
export const THUMBNAIL_TIME_FRACTION = 0.1;
export const PACKAGE_TOOL_TIMEOUT_MS = 120_000;
export const PACKAGE_METADATA_LIMITS = { title: 200, description: 5000, hashtags: 1000, chapters: 5000 } as const;

function fail(code: ProductionErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new ProductionApplicationError(code, message, details ? { details: details as ProductionApplicationError["details"] } : {});
}

// ---------------------------------------------------------------------------
// Creator metadata overrides: persisted server-side per export, additive only.
// ---------------------------------------------------------------------------

const overrideField = (max: number) => z.string().max(max);
export const PackageMetadataCommandSchema = z.strictObject({
  title: overrideField(PACKAGE_METADATA_LIMITS.title).optional(),
  description: overrideField(PACKAGE_METADATA_LIMITS.description).optional(),
  hashtags: overrideField(PACKAGE_METADATA_LIMITS.hashtags).optional(),
  chapters: overrideField(PACKAGE_METADATA_LIMITS.chapters).optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), { message: "At least one metadata field is required" });
export type PackageMetadataCommand = z.infer<typeof PackageMetadataCommandSchema>;

export const PackageOverridesRecordSchema = z.strictObject({
  version: z.literal(1),
  exportId: IdSchema,
  title: z.string().max(PACKAGE_METADATA_LIMITS.title).nullable(),
  description: z.string().max(PACKAGE_METADATA_LIMITS.description).nullable(),
  hashtags: z.string().max(PACKAGE_METADATA_LIMITS.hashtags).nullable(),
  chapters: z.string().max(PACKAGE_METADATA_LIMITS.chapters).nullable(),
  updatedAt: UtcMillisSchema,
});
export type PackageOverridesRecord = z.infer<typeof PackageOverridesRecordSchema>;

const exportDir = (dataDir: string, exportId: string): string => join(dataDir, "exports", exportId);
const overridesPath = (dataDir: string, exportId: string): string => join(exportDir(dataDir, exportId), "package-overrides.json");

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/** Reads the export's persisted overrides; a missing or corrupt sidecar reads as "no overrides" (defaults win, media stays gated). */
export async function loadPackageOverrides(dataDir: string, exportId: string): Promise<PackageOverridesRecord | null> {
  let raw: string;
  try { raw = await readFile(overridesPath(dataDir, exportId), "utf8"); } catch { return null; }
  try {
    const parsed = PackageOverridesRecordSchema.parse(JSON.parse(raw));
    return parsed.exportId === exportId ? parsed : null;
  } catch {
    return null;
  }
}

/** Persists the creator's edits temp-then-rename; unspecified fields keep their previously saved value. */
export async function savePackageOverrides(dataDir: string, exportId: string, command: PackageMetadataCommand, options: { now?: () => number } = {}): Promise<PackageOverridesRecord> {
  if (!IdSchema.safeParse(exportId).success) fail("INVALID_INPUT", "Invalid export ID");
  const parsed = PackageMetadataCommandSchema.safeParse(command);
  if (!parsed.success) fail("INVALID_INPUT", `Invalid package metadata command: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const previous = await loadPackageOverrides(dataDir, exportId);
  const record: PackageOverridesRecord = PackageOverridesRecordSchema.parse({
    version: 1,
    exportId,
    title: parsed.data.title ?? previous?.title ?? null,
    description: parsed.data.description ?? previous?.description ?? null,
    hashtags: parsed.data.hashtags ?? previous?.hashtags ?? null,
    chapters: parsed.data.chapters ?? previous?.chapters ?? null,
    updatedAt: (options.now ?? Date.now)(),
  });
  await mkdir(exportDir(dataDir, exportId), { recursive: true, mode: 0o700 });
  await atomicWriteJson(overridesPath(dataDir, exportId), record);
  return record;
}

export interface PackageMetadata { readonly title: string; readonly description: string; readonly hashtags: string; readonly chapters: string }

const effectiveField = (override: string | null | undefined, fallback: string): string => {
  const value = typeof override === "string" ? override.trim() : "";
  return value.length > 0 ? value : fallback;
};

/** Field-by-field merge: a nonblank saved edit wins, whitespace/null/absent falls back to the deterministic default. */
export function resolvePackageMetadata(overrides: PackageOverridesRecord | null, defaults: { title: string; description: string; hashtags: string; chapters: string }): PackageMetadata {
  return {
    title: effectiveField(overrides?.title, defaults.title),
    description: effectiveField(overrides?.description, defaults.description),
    hashtags: effectiveField(overrides?.hashtags, defaults.hashtags),
    chapters: effectiveField(overrides?.chapters, defaults.chapters),
  };
}

export const overriddenPackageFields = (overrides: PackageOverridesRecord | null): readonly ("title" | "description" | "hashtags" | "chapters")[] =>
  (["title", "description", "hashtags", "chapters"] as const).filter((field) => typeof overrides?.[field] === "string" && overrides[field]!.trim().length > 0);

// ---------------------------------------------------------------------------
// Manifest timeline math: crossfade-aware output start frames for chapters.
// ---------------------------------------------------------------------------

export interface PackageTimelineShot {
  readonly shotRevisionId: string;
  readonly takeId: string;
  readonly label: string;
  readonly timelineStartFrame: number;
  readonly durationFrames: number;
}
export interface PackageTimeline { readonly fps: number; readonly totalFrames: number; readonly shots: readonly PackageTimelineShot[] }

/**
 * Re-derives the rendered output timeline from the manifest (never trusted from a stored total):
 * each shot contributes its trim length minus the 8-frame crossfade overlap its transition
 * introduces toward the following shot, matching the assembly filtergraph exactly. Labels come
 * from the shot revision's visual intent (caller-supplied), truncated like the publication
 * package; the final shot must cut.
 */
export function computePackageTimeline(manifest: RenderManifest, labels: ReadonlyMap<string, string> = new Map()): PackageTimeline {
  const fps = manifest.profile.fps;
  if (manifest.shots.length === 0) fail("INVALID_INPUT", `Manifest ${manifest.id} lists no shots; a package timeline requires at least one shot.`);
  const shots: PackageTimelineShot[] = [];
  let elapsed = 0;
  for (const [index, shot] of manifest.shots.entries()) {
    const length = shot.endFrame - shot.startFrame;
    if (!Number.isSafeInteger(length) || length <= 0) fail("INVALID_INPUT", `Manifest shot ${shot.shotRevisionId} has a nonpositive trim length ${String(length)}.`);
    const isLast = index === manifest.shots.length - 1;
    if (isLast && shot.transition !== "cut") fail("INVALID_INPUT", `Manifest shot ${shot.shotRevisionId} is the final shot and must cut, not ${shot.transition}.`);
    if (shot.transition === "crossfade" && length <= MANIFEST_CROSSFADE_FRAMES) {
      fail("INVALID_INPUT", `Manifest shot ${shot.shotRevisionId} is ${String(length)} frames, too short for its ${MANIFEST_CROSSFADE_FRAMES}-frame crossfade.`);
    }
    const fallbackLabel = labels.get(shot.shotRevisionId) ?? shot.shotRevisionId;
    shots.push({
      shotRevisionId: shot.shotRevisionId,
      takeId: shot.takeId,
      label: fallbackLabel.trim().slice(0, 100) || shot.shotRevisionId,
      timelineStartFrame: elapsed,
      durationFrames: length,
    });
    elapsed += shot.transition === "crossfade" ? length - MANIFEST_CROSSFADE_FRAMES : length;
  }
  if (!Number.isSafeInteger(elapsed) || elapsed <= 0) fail("INVALID_INPUT", `The manifest timeline totals ${String(elapsed)} frames; a positive safe integer timeline is required.`);
  return { fps, totalFrames: elapsed, shots };
}

/** Default chapters.txt body: frozen M:SS stamps plus the truncated shot labels. */
export function buildChaptersDefault(timeline: PackageTimeline): string {
  return timeline.shots.map((shot) => `${formatChapterTimestamp(shot.timelineStartFrame, timeline.fps)} ${shot.label}`).join("\n");
}

// ---------------------------------------------------------------------------
// Thumbnail frame extract: real ffmpeg frame from the approved master bytes.
// ---------------------------------------------------------------------------

/** Seek timestamp ~10% into the runtime, clamped 1ms inside the duration, on the fps grid. */
export function thumbnailSeekSeconds(totalFrames: number, fps: number): string {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) fail("INVALID_INPUT", `Thumbnail seek requires a positive safe integer frame count, received ${String(totalFrames)}.`);
  if (!Number.isSafeInteger(fps) || fps <= 0) fail("INVALID_INPUT", `Thumbnail seek requires a positive safe integer frame rate, received ${String(fps)}.`);
  const durationMs = Math.floor((totalFrames * 1000) / fps);
  const frame = Math.max(0, Math.floor(totalFrames * THUMBNAIL_TIME_FRACTION));
  const millis = Math.max(0, Math.min(Math.floor((frame * 1000) / fps), durationMs - 1));
  return `${Math.floor(millis / 1000)}.${String(millis % 1000).padStart(3, "0")}`;
}

/**
 * Scale filter capping the long edge at 1920 without ever upscaling: null when the known
 * dimensions already fit (no filter at all), an integer even-dimension scale when they exceed the
 * cap, and a self-probing expression when the dimensions are unknown.
 */
export function thumbnailScaleFilter(width: number | null, height: number | null): string | null {
  if (width !== null && height !== null) {
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      fail("INVALID_INPUT", `Thumbnail scale requires positive safe integer dimensions, received ${String(width)}x${String(height)}.`);
    }
    if (Math.max(width, height) <= THUMBNAIL_MAX_LONG_EDGE) return null;
    const evenFloor = (value: number): number => { const floored = Math.floor(value); return floored % 2 === 0 ? floored : floored - 1; };
    return width >= height
      ? `scale=${THUMBNAIL_MAX_LONG_EDGE}:${evenFloor((height * THUMBNAIL_MAX_LONG_EDGE) / width)}`
      : `scale=${evenFloor((width * THUMBNAIL_MAX_LONG_EDGE) / height)}:${THUMBNAIL_MAX_LONG_EDGE}`;
  }
  return `scale='if(gt(iw,ih),min(${THUMBNAIL_MAX_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${THUMBNAIL_MAX_LONG_EDGE},ih))'`;
}

interface ExtractResult { code: number | null; stderr: string; failedToStart: boolean; timedOut: boolean }

/** Minimal spawn wrapper honoring FFMPEG_PATH via resolveMediaTools: argument arrays only, bounded timeout, abort relay. */
function runFfmpegTool(executable: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolvePromise({ code: null, stderr: "", failedToStart: true, timedOut: false });
      return;
    }
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let failedToStart = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: child.exitCode, stderr, failedToStart, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    timer.unref?.();
    const onAbort = () => { child.kill("SIGKILL"); };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
    child.once("error", (error: NodeJS.ErrnoException) => { failedToStart = true; stderr = `${executable} could not be started: ${error.code === "ENOENT" ? "tool not found" : error.message}`; });
    child.once("close", () => finish());
  });
}

export interface ExtractThumbnailOptions {
  inputPath: string;
  outputPath: string;
  seekSeconds: string;
  scaleFilter?: string | null;
  paths?: MediaToolPaths;
  timeoutMs?: number;
  signal?: AbortSignal;
  redactDataDir?: string;
}

/** Extracts one PNG frame from the source video at the given seek point via the local ffmpeg tool. */
export async function extractThumbnailFrame(options: ExtractThumbnailOptions): Promise<void> {
  const paths = options.paths ?? resolveMediaTools();
  const args = ["-nostdin", "-v", "error", "-xerror", "-y", "-ss", options.seekSeconds, "-i", options.inputPath, "-frames:v", "1"];
  if (options.scaleFilter) args.push("-vf", options.scaleFilter);
  args.push("-c:v", "png", options.outputPath);
  const result = await runFfmpegTool(paths.ffmpeg, args, { timeoutMs: options.timeoutMs ?? PACKAGE_TOOL_TIMEOUT_MS, signal: options.signal });
  if (result.failedToStart) fail("MEDIA_UNAVAILABLE", "The local ffmpeg tool named by FFMPEG_PATH could not be started; the package thumbnail could not be extracted.");
  if (result.timedOut) fail("MEDIA_UNAVAILABLE", "The package thumbnail extraction exceeded its time bound.");
  if (result.code !== 0) {
    fail("MEDIA_UNAVAILABLE", "FFmpeg could not extract the package thumbnail frame from the approved master.", { stderr: redactStderr(result.stderr, { dataDir: options.redactDataDir ?? "" }) });
  }
}

// ---------------------------------------------------------------------------
// Minimal stored-entry zip writer (no compression, deterministic bytes).
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xEDB88320 ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
})();

/** IEEE CRC-32 (zlib-compatible), computed byte-at-a-time over the exact entry bytes. */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < data.length; index += 1) crc = CRC32_TABLE[(crc ^ data[index]!) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntryInput { readonly name: string; readonly data: Uint8Array }

const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01, fixed so identical inputs build byte-identical zips.

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value, true); }

/**
 * Builds a stored (uncompressed) zip archive: local file headers + entry bytes, central
 * directory, end-of-central-directory. Fixed DOS timestamps keep the output byte-deterministic
 * for identical entries; anything beyond the zip's 32-bit bounds fails closed.
 */
export function buildStoredZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length === 0) fail("INVALID_INPUT", "A package zip requires at least one entry.");
  if (entries.length > 65_535) fail("INVALID_INPUT", `A package zip holds at most 65535 entries, received ${String(entries.length)}.`);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) fail("INVALID_INPUT", `Package entry name ${entry.name} contains unsupported characters.`);
    if (seen.has(entry.name)) fail("INVALID_INPUT", `Package entry ${entry.name} appears more than once.`);
    seen.add(entry.name);
    if (!Number.isSafeInteger(entry.data.byteLength) || entry.data.byteLength > 0xFFFFFFFF) fail("INVALID_INPUT", `Package entry ${entry.name} exceeds the 4 GiB zip entry bound.`);
  }
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => { chunks.push(bytes); offset += bytes.length; };
  const header = (size: number): { view: DataView; bytes: Uint8Array } => {
    const bytes = new Uint8Array(size);
    return { view: new DataView(bytes.buffer), bytes };
  };
  const localOffsets: number[] = [];
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const size = entry.data.byteLength;
    const crc = crc32(entry.data);
    localOffsets.push(offset);
    const local = header(30 + nameBytes.length);
    u32(local.view, 0, 0x04034b50);
    u16(local.view, 4, 20);
    u16(local.view, 6, 0);
    u16(local.view, 8, 0);
    u16(local.view, 10, DOS_TIME);
    u16(local.view, 12, DOS_DATE);
    u32(local.view, 14, crc);
    u32(local.view, 18, size);
    u32(local.view, 22, size);
    u16(local.view, 26, nameBytes.length);
    u16(local.view, 28, 0);
    local.bytes.set(nameBytes, 30);
    push(local.bytes);
    push(entry.data);
  }
  const centralStart = offset;
  for (const [index, entry] of entries.entries()) {
    const nameBytes = encoder.encode(entry.name);
    const size = entry.data.byteLength;
    const central = header(46 + nameBytes.length);
    u32(central.view, 0, 0x02014b50);
    u16(central.view, 4, 20);
    u16(central.view, 6, 20);
    u16(central.view, 8, 0);
    u16(central.view, 10, 0);
    u16(central.view, 12, DOS_TIME);
    u16(central.view, 14, DOS_DATE);
    u32(central.view, 16, crc32(entry.data));
    u32(central.view, 20, size);
    u32(central.view, 24, size);
    u16(central.view, 28, nameBytes.length);
    u16(central.view, 30, 0);
    u16(central.view, 32, 0);
    u16(central.view, 34, 0);
    u16(central.view, 36, 0);
    u32(central.view, 38, 0);
    u32(central.view, 42, localOffsets[index]!);
    central.bytes.set(nameBytes, 46);
    push(central.bytes);
  }
  const centralSize = offset - centralStart;
  const eocd = header(22);
  u32(eocd.view, 0, 0x06054b50);
  u16(eocd.view, 4, 0);
  u16(eocd.view, 6, 0);
  u16(eocd.view, 8, entries.length);
  u16(eocd.view, 10, entries.length);
  u32(eocd.view, 12, centralSize);
  u32(eocd.view, 16, centralStart);
  u16(eocd.view, 20, 0);
  push(eocd.bytes);
  const total = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) { total.set(chunk, cursor); cursor += chunk.length; }
  if (!Number.isSafeInteger(offset) || offset > 0xFFFFFFFF) fail("INVALID_INPUT", "The package zip exceeds the 4 GiB zip archive bound.");
  return total;
}

// ---------------------------------------------------------------------------
// Sidecar emitters and the production.json descriptor.
// ---------------------------------------------------------------------------

export interface PackageDescriptor {
  readonly schemaVersion: 1;
  readonly kind: "perabyte-production-package";
  readonly production: {
    readonly projectId: string;
    readonly title: string;
    readonly recipe: { readonly qualityStrategy: string | null; readonly aspectRatio: string } | null;
    readonly selectedTakeIds: readonly string[];
  };
  readonly manifest: {
    readonly id: string;
    readonly inputsHash: string;
    readonly profile: RenderManifest["profile"];
    readonly totalFrames: number;
    readonly fps: number;
    readonly shots: RenderManifest["shots"];
    readonly audioCueCount: number;
    readonly captionCues: RenderManifest["captionCues"];
  };
  readonly metadata: {
    readonly title: string;
    readonly description: string;
    readonly hashtags: string;
    readonly chapters: string;
    readonly overriddenFields: readonly string[];
  };
  readonly disclaimer: string;
  readonly generatedAt: number;
}

export const PackageDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("perabyte-production-package"),
  production: z.strictObject({
    projectId: IdSchema,
    title: z.string().min(1).max(PACKAGE_METADATA_LIMITS.title),
    recipe: z.strictObject({ qualityStrategy: z.string().max(40).nullable(), aspectRatio: z.string().max(10) }).nullable(),
    selectedTakeIds: z.array(IdSchema).max(10_000),
  }),
  manifest: z.strictObject({
    id: IdSchema,
    inputsHash: Sha256Schema,
    profile: RenderProfileSchema,
    totalFrames: z.number().int().safe().positive(),
    fps: z.number().int().safe().positive(),
    shots: z.array(ManifestShotSchema).max(10_000),
    audioCueCount: z.number().int().safe().nonnegative(),
    captionCues: z.array(RenderManifestSchema.shape.captionCues.element).max(100_000),
  }),
  metadata: z.strictObject({
    title: z.string().max(PACKAGE_METADATA_LIMITS.title),
    description: z.string().max(PACKAGE_METADATA_LIMITS.description),
    hashtags: z.string().max(PACKAGE_METADATA_LIMITS.hashtags),
    chapters: z.string().max(PACKAGE_METADATA_LIMITS.chapters),
    overriddenFields: z.array(z.enum(["title", "description", "hashtags", "chapters"])).max(4),
  }),
  disclaimer: z.string().min(1).max(4000),
  generatedAt: UtcMillisSchema,
});

export interface BuildDescriptorInput {
  project: Project;
  manifest: RenderManifest;
  timeline: PackageTimeline;
  metadata: PackageMetadata;
  workspace: { productionRecipe?: { qualityStrategy: string } } | null;
  overriddenFields: readonly string[];
  generatedAt: number;
}

/** Serializes the production descriptor: project identity, recipe, selected takes, manifest facts, effective metadata, generatedAt. */
export function buildPackageDescriptor(input: BuildDescriptorInput): PackageDescriptor {
  const parsed = PackageDescriptorSchema.parse({
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    kind: "perabyte-production-package",
    production: {
      projectId: input.project.id,
      title: input.metadata.title.slice(0, PACKAGE_METADATA_LIMITS.title),
      recipe: input.workspace
        ? { qualityStrategy: input.workspace.productionRecipe?.qualityStrategy ?? null, aspectRatio: input.project.profile.format }
        : null,
      selectedTakeIds: input.manifest.shots.map((shot) => shot.takeId),
    },
    manifest: {
      id: input.manifest.id,
      inputsHash: input.manifest.inputsHash,
      profile: input.manifest.profile,
      totalFrames: input.timeline.totalFrames,
      fps: input.timeline.fps,
      shots: input.manifest.shots,
      audioCueCount: input.manifest.audioCues.length,
      captionCues: input.manifest.captionCues,
    },
    metadata: { ...input.metadata, overriddenFields: input.overriddenFields },
    disclaimer: MANUAL_UPLOAD_DISCLAIMER,
    generatedAt: input.generatedAt,
  });
  return parsed;
}

export type PackageSidecarTexts = Record<Exclude<PackageEntryName, "video.mp4" | "thumbnail.png">, string>;

/** The six text sidecars, built from exactly the effective metadata, manifest captions, and descriptor. */
export function buildSidecarTexts(input: { metadata: PackageMetadata; captions: RenderManifest["captionCues"]; fps: number; descriptor: PackageDescriptor }): PackageSidecarTexts {
  return {
    "captions.srt": buildSrt(input.captions, input.fps),
    "title.txt": `${input.metadata.title.trim()}\n`,
    "description.txt": `${input.metadata.description.trim()}\n`,
    "hashtags.txt": `${input.metadata.hashtags.trim()}\n`,
    "chapters.txt": `${input.metadata.chapters.trim()}\n`,
    "production.json": `${JSON.stringify(PackageDescriptorSchema.parse(input.descriptor), null, 2)}\n`,
  };
}

// ---------------------------------------------------------------------------
// Build cache: content-keyed zip beside the export record, temp-then-rename.
// ---------------------------------------------------------------------------

export function packageCacheKey(input: { exportId: string; manifest: RenderManifest; assetSha256: string; overrides: PackageOverridesRecord | null }): string {
  return hashCanonicalJson({
    recipeVersion: PACKAGE_SCHEMA_VERSION,
    exportId: input.exportId,
    inputsHash: input.manifest.inputsHash,
    profile: input.manifest.profile,
    shots: input.manifest.shots,
    audioCues: input.manifest.audioCues,
    captionCues: input.manifest.captionCues,
    assetSha256: input.assetSha256,
    overrides: input.overrides
      ? { title: input.overrides.title, description: input.overrides.description, hashtags: input.overrides.hashtags, chapters: input.overrides.chapters }
      : null,
  });
}

export const PackageCacheRecordSchema = z.strictObject({
  version: z.literal(1),
  key: Sha256Schema,
  zipSha256: Sha256Schema,
  byteSize: z.number().int().safe().positive(),
  builtAt: UtcMillisSchema,
});
export type PackageCacheRecord = z.infer<typeof PackageCacheRecordSchema>;

const cacheRecordPath = (dataDir: string, exportId: string): string => join(exportDir(dataDir, exportId), "package-cache.json");
const cacheZipPath = (dataDir: string, exportId: string, key: string): string => join(exportDir(dataDir, exportId), "package-cache", `${key}.zip`);

interface CachedPackage { zip: Uint8Array; zipSha256: string; builtAt: number }

/** Serves the cached zip only when its key matches and its bytes still hash to the recorded digest. */
async function loadCachedPackage(dataDir: string, exportId: string, key: string): Promise<CachedPackage | null> {
  let record: PackageCacheRecord;
  try {
    record = PackageCacheRecordSchema.parse(JSON.parse(await readFile(cacheRecordPath(dataDir, exportId), "utf8")));
  } catch {
    return null;
  }
  if (record.key !== key) return null;
  let bytes: Buffer;
  try { bytes = await readFile(cacheZipPath(dataDir, exportId, key)); } catch { return null; }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.zipSha256 || bytes.byteLength !== record.byteSize) return null;
  return { zip: new Uint8Array(bytes), zipSha256: digest, builtAt: record.builtAt };
}

/** Writes the zip and its pointer record temp-then-rename; a throw leaves the previous valid package untouched. */
async function storeBuiltPackage(dataDir: string, exportId: string, key: string, zip: Uint8Array, zipSha256: string, builtAt: number): Promise<void> {
  const cacheDir = join(exportDir(dataDir, exportId), "package-cache");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const zipTemp = `${cacheZipPath(dataDir, exportId, key)}.tmp-${randomUUID()}`;
  await writeFile(zipTemp, zip, { mode: 0o600 });
  await rename(zipTemp, cacheZipPath(dataDir, exportId, key));
  await atomicWriteJson(cacheRecordPath(dataDir, exportId), PackageCacheRecordSchema.parse({
    version: 1, key, zipSha256, byteSize: zip.byteLength, builtAt,
  }));
}

// ---------------------------------------------------------------------------
// Package build orchestration.
// ---------------------------------------------------------------------------

export interface ExportPackageVault { readVerified(vaultRef: string, expectedSha256: string): Promise<Uint8Array> }

export interface ExportPackageBuildOptions {
  store: ProductionStore;
  vault: ExportPackageVault;
  dataDir: string;
  paths?: MediaToolPaths;
  now?: () => number;
  timeoutMs?: number;
  extractThumbnail?: typeof extractThumbnailFrame;
}

export interface ExportPackageArtifact {
  readonly zip: Uint8Array;
  readonly zipSha256: string;
  readonly cacheHit: boolean;
  readonly builtAt: number;
  readonly metadata: PackageMetadata;
  readonly descriptor: PackageDescriptor;
}

interface PackageContext {
  exportId: string;
  manifest: RenderManifest;
  project: Project;
  overrides: PackageOverridesRecord | null;
  timeline: PackageTimeline;
  metadata: PackageMetadata;
  overriddenFields: readonly string[];
}

/** Loads the export's pinned records and resolves the effective package context (fail-closed on any missing pin). */
function loadPackageContext(store: ProductionStore, rawExportId: string, dataDir: string, overrides: PackageOverridesRecord | null): { context: PackageContext; assetSha256: string } {
  if (!IdSchema.safeParse(rawExportId).success) fail("INVALID_INPUT", "Invalid export ID");
  const exportRecord = store.read.getExport(rawExportId);
  if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${rawExportId} not found`);
  const manifest = store.read.getManifest(exportRecord.manifestId);
  if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${rawExportId} is missing.`);
  const project = store.read.getProject(manifest.projectId);
  if (!project) fail("UNKNOWN_REFERENCE", `Project ${manifest.projectId} owning export ${rawExportId} is missing from local records.`);
  const labels = new Map<string, string>(manifest.shots.map((shot) => {
    const revision = store.read.getShotRevision(shot.shotRevisionId);
    return [shot.shotRevisionId, revision?.visualIntent ?? shot.shotRevisionId] as const;
  }));
  const timeline = computePackageTimeline(manifest, labels);
  const scenes = store.read.listProjectScenes(project.id).slice().sort((left, right) => left.order - right.order);
  const workspace = project.workspaceId ? store.read.getWorkspace(project.workspaceId) : null;
  const defaults = derivePackageMetadataDefaults({
    projectName: project.name,
    sceneTitles: scenes.map((scene) => scene.title),
    shotVisualIntents: timeline.shots.map((shot) => shot.label),
    workspaceName: workspace?.name ?? null,
    workspaceTags: workspace?.worldBible.entries.flatMap((entry) => entry.tags) ?? [],
  });
  const metadata = resolvePackageMetadata(overrides, { ...defaults, chapters: buildChaptersDefault(timeline) });
  return {
    context: {
      exportId: rawExportId,
      manifest,
      project,
      overrides,
      timeline,
      metadata,
      overriddenFields: overriddenPackageFields(overrides),
    },
    assetSha256: exportRecord.assetId ? store.read.getAsset(exportRecord.assetId)?.sha256 ?? "" : "",
  };
}

function descriptorFor(context: PackageContext, store: ProductionStore, generatedAt: number): PackageDescriptor {
  const workspace = context.project.workspaceId ? store.read.getWorkspace(context.project.workspaceId) : null;
  return buildPackageDescriptor({
    project: context.project,
    manifest: context.manifest,
    timeline: context.timeline,
    metadata: context.metadata,
    workspace,
    overriddenFields: context.overriddenFields,
    generatedAt,
  });
}

/**
 * Builds — or serves from the input-keyed cache — the complete manual package for one export.
 * The master MP4 is read back through the checksum-enforced vault (a mismatch refuses with
 * MEDIA_UNAVAILABLE); the thumbnail is a real ffmpeg extract; every write lands temp-then-rename
 * so a failed build preserves the previous valid package byte for byte.
 */
export async function buildExportPackage(exportId: string, options: ExportPackageBuildOptions): Promise<ExportPackageArtifact> {
  if (!IdSchema.safeParse(exportId).success) fail("INVALID_INPUT", "Invalid export ID");
  const store = options.store;
  const overrides = await loadPackageOverrides(options.dataDir, exportId);
  const contextProbe = loadPackageContext(store, exportId, options.dataDir, overrides);
  const exportRecord = store.read.getExport(exportId)!;
  const asset = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
  if (!asset || !contextProbe.assetSha256) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${exportId} is missing from local records.`);
  const key = packageCacheKey({ exportId, manifest: contextProbe.context.manifest, assetSha256: asset.sha256, overrides });
  const cached = await loadCachedPackage(options.dataDir, exportId, key);
  if (cached) {
    return {
      zip: cached.zip,
      zipSha256: cached.zipSha256,
      cacheHit: true,
      builtAt: cached.builtAt,
      metadata: contextProbe.context.metadata,
      descriptor: descriptorFor(contextProbe.context, store, cached.builtAt),
    };
  }

  let masterBytes: Uint8Array;
  try {
    masterBytes = await options.vault.readVerified(asset.vaultRef, asset.sha256);
  } catch {
    fail("MEDIA_UNAVAILABLE", "The approved master bytes could not be checksum verified in the local vault; the package was not built.");
  }
  await mkdir(exportDir(options.dataDir, exportId), { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(exportDir(options.dataDir, exportId), "package-build-"));
  try {
    const masterPath = join(workDir, "video.mp4");
    await writeFile(masterPath, masterBytes, { mode: 0o600 });
    const thumbnailPath = join(workDir, "thumbnail.png");
    await (options.extractThumbnail ?? extractThumbnailFrame)({
      inputPath: masterPath,
      outputPath: thumbnailPath,
      seekSeconds: thumbnailSeekSeconds(contextProbe.context.timeline.totalFrames, contextProbe.context.timeline.fps),
      scaleFilter: thumbnailScaleFilter(asset.width, asset.height),
      paths: options.paths ?? resolveMediaTools(),
      timeoutMs: options.timeoutMs ?? PACKAGE_TOOL_TIMEOUT_MS,
      redactDataDir: workDir,
    });
    const thumbnailBytes = await readFile(thumbnailPath);
    const generatedAt = Math.max(0, (options.now ?? Date.now)());
    const descriptor = descriptorFor(contextProbe.context, store, generatedAt);
    const texts = buildSidecarTexts({ metadata: contextProbe.context.metadata, captions: contextProbe.context.manifest.captionCues, fps: contextProbe.context.timeline.fps, descriptor });
    const encoder = new TextEncoder();
    const dataByName: Record<PackageEntryName, Uint8Array> = {
      "video.mp4": masterBytes,
      "thumbnail.png": new Uint8Array(thumbnailBytes),
      "captions.srt": encoder.encode(texts["captions.srt"]),
      "title.txt": encoder.encode(texts["title.txt"]),
      "description.txt": encoder.encode(texts["description.txt"]),
      "hashtags.txt": encoder.encode(texts["hashtags.txt"]),
      "chapters.txt": encoder.encode(texts["chapters.txt"]),
      "production.json": encoder.encode(texts["production.json"]),
    };
    const zip = buildStoredZip(PACKAGE_ENTRY_NAMES.map((name) => ({ name, data: dataByName[name] })));
    const zipSha256 = createHash("sha256").update(zip).digest("hex");
    await storeBuiltPackage(options.dataDir, exportId, key, zip, zipSha256, generatedAt);
    return { zip, zipSha256, cacheHit: false, builtAt: generatedAt, metadata: contextProbe.context.metadata, descriptor };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Route handler factory (same conventions as the accepted C12 download route).
// ---------------------------------------------------------------------------

export interface PackageRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  dataDir?: string;
  vault?: ExportPackageVault;
  paths?: MediaToolPaths;
  buildOptions?: { now?: () => number; timeoutMs?: number };
  buildExportPackage?: typeof buildExportPackage;
}

interface PackageRouteContext { params: Promise<{ id: string }> }

const parseExportId = async (context: PackageRouteContext): Promise<string> => {
  const { id } = await context.params;
  if (!IdSchema.safeParse(id).success) fail("INVALID_INPUT", "Invalid export ID");
  return id;
};

const requireProjectScope = (request: Request, owningProjectId: string): void => {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId || !IdSchema.safeParse(projectId).success) {
    fail("INVALID_INPUT", "This package route is scoped to the owning project; pass ?projectId=<owning project id>.");
  }
  if (projectId !== owningProjectId) fail("INVALID_INPUT", `This export is owned by project ${owningProjectId}; the given project scope does not match.`);
};

/**
 * Publication package routes. GET ?meta=1 returns the persisted overrides plus the deterministic
 * defaults for any known, project-scoped export (metadata is editable before approval). GET
 * serves the zip under exactly the final-download gate (approved export, checksum still matching,
 * 428 otherwise). PUT persists creator metadata edits behind the same-origin guard; the cache key
 * includes the overrides, so the next download rebuilds and no stale zip is ever served.
 */
export function createExportPackageRouteHandlers(routeOptions: PackageRouteHandlerOptions = {}) {
  const withStore: NonNullable<PackageRouteHandlerOptions["withStore"]> = routeOptions.withStore ?? (work => withProductionStore(store => work(store)));
  const dataDir = routeOptions.dataDir ?? resolveProductionDataDir();
  return {
    async GET(request: Request, context: PackageRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const exportId = await parseExportId(context);
        const wantsMeta = new URL(request.url).searchParams.get("meta") === "1";
        if (wantsMeta) {
          const meta = await withStore(async (store) => {
            const overrides = await loadPackageOverrides(dataDir, exportId);
            const { context: packageContext } = loadPackageContext(store, exportId, dataDir, overrides);
            requireProjectScope(request, packageContext.project.id);
            return {
              exportId,
              exportStatus: store.read.getExport(exportId)!.status,
              overrides,
              metadata: packageContext.metadata,
              overriddenFields: packageContext.overriddenFields,
            };
          });
          return Response.json(meta, { status: 200, headers: { "cache-control": "no-store" } });
        }
        const artifact = await withStore(async (store) => {
          const exportRecord = store.read.getExport(exportId);
          if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${exportId} not found`);
          const manifest = store.read.getManifest(exportRecord.manifestId);
          if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${exportId} is missing.`);
          requireProjectScope(request, manifest.projectId);
          if (exportRecord.status !== "approved") {
            fail("APPROVAL_REQUIRED", `The publication package is locked while the export is in status ${exportRecord.status}: the human final review must approve the exact output checksum first. Technical QC alone never unlocks the package.`);
          }
          const asset = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
          if (!asset) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${exportId} is missing from local records.`);
          if (exportRecord.approvedSha256 !== asset.sha256) {
            fail("STALE_REVISION", `The approved checksum ${String(exportRecord.approvedSha256)} no longer matches the current output asset sha256 ${asset.sha256}; the output was re-encoded and requires a new technical QC, review, and approval.`);
          }
          const vault = routeOptions.vault ?? new (await import("./vault")).LocalMediaVault({ root: join(dataDir, "media") });
          return (routeOptions.buildExportPackage ?? buildExportPackage)(exportId, {
            store, vault, dataDir, paths: routeOptions.paths ?? resolveMediaTools(), ...routeOptions.buildOptions,
          });
        });
        return new Response(toResponseBody(artifact.zip), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-length": String(artifact.zip.byteLength),
            "content-disposition": `attachment; filename="package-export-${exportId}.zip"`,
            etag: `"${artifact.zipSha256}"`,
            "cache-control": "no-store",
            "x-perabyte-package": "1",
          },
        });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
    async PUT(request: Request, context: PackageRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const exportId = await parseExportId(context);
        const command = await readProductionJson(request, PackageMetadataCommandSchema);
        const overrides = await withStore(async (store) => {
          const exportRecord = store.read.getExport(exportId);
          if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${exportId} not found`);
          const manifest = store.read.getManifest(exportRecord.manifestId);
          if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${exportId} is missing.`);
          requireProjectScope(request, manifest.projectId);
          return savePackageOverrides(dataDir, exportId, command, routeOptions.buildOptions);
        });
        return Response.json({ overrides }, { status: 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}

function toResponseBody(bytes: Uint8Array): BodyInit {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Uint8Array.from(bytes);
}
