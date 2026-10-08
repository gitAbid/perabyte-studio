import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AssetSchema, type AudioCue, type ExportRecord, type RenderManifest,
} from "../../production/contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import {
  MANIFEST_CROSSFADE_FRAMES, MANIFEST_SAMPLES_PER_FRAME, compileManifestTimeline, validateAudioExactness,
  type ManifestAudioExactness, type ManifestShotSource,
} from "../../production/manifest";
import type { ProductionStore } from "../../repositories/production/ports";
import { withProductionStore } from "../../production/runtime";
import type { VaultStoredMedia } from "./vault";
import {
  ASSEMBLY_ENCODER_RECIPE, ASSEMBLY_LOUDNORM, ASSEMBLY_MAX_INPUTS, ASSEMBLY_MAX_STAGED_BYTES,
  ASSEMBLY_RENDER_TIMEOUT_MS, EXPORT_HEARTBEAT_MS, EXPORT_LEASE_MS, EXPORT_REDRIVE_LIMIT,
} from "./profiles";

/** Resolved local media tool paths; resolution honors FFMPEG_PATH/FFPROBE_PATH like the media vault. */
export interface MediaToolPaths { readonly ffmpeg: string; readonly ffprobe: string }
/** One staged source file inside the private assembly temp dir, with the pinned source metadata. */
export interface StagedAssemblyAsset {
  readonly path: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: number | null;
}
export interface AssemblyPlan {
  readonly filterComplex: string;
  readonly args: readonly string[];
  readonly totalFrames: number;
  readonly audioCueCount: number;
  readonly audioExactness: ManifestAudioExactness | null;
}
export interface AssemblyOutputProbe {
  readonly video: {
    readonly codec: string; readonly width: number; readonly height: number; readonly pixFmt: string;
    readonly avgFrameRate: string; readonly frames: number; readonly durationTs: number; readonly timeBaseNum: number; readonly timeBaseDen: number;
  };
  readonly audio: { readonly codec: string; readonly sampleRate: number; readonly channels: number } | null;
}
export interface AssemblyOutput {
  readonly outputPath: string;
  readonly sha256: string;
  readonly probe: AssemblyOutputProbe;
  readonly args: readonly string[];
  readonly filterComplex: string;
  readonly totalFrames: number;
}
export interface AssembleManifestOptions {
  workDir: string;
  paths?: MediaToolPaths;
  stageAsset: (assetId: string, tempDir: string) => Promise<StagedAssemblyAsset>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ExportAssemblyVault {
  readVerified(vaultRef: string, expectedSha256: string): Promise<Uint8Array>;
  putStream(stream: NodeJS.ReadableStream, options: { mime: string; sourceKind: "derived"; rightsStatus?: "unknown" }): Promise<VaultStoredMedia>;
}
export interface ExportAssemblyOptions {
  store: ProductionStore;
  vault: ExportAssemblyVault;
  dataDir: string;
  paths?: MediaToolPaths;
  now?: () => number;
  signal?: AbortSignal;
  /** Test seam: shrink the ASSEMBLY_MAX_STAGED_BYTES bound. */
  maxStagedBytes?: number;
  /** Test seam: override the render work directory. */
  workDir?: string;
  /** Test seam: override the renderer (defaults to the real local FFmpeg assembly). */
  assembleManifest?: (manifest: RenderManifest, options: AssembleManifestOptions) => Promise<AssemblyOutput>;
}
export interface ExportAssemblySchedulerDeps {
  dataDir: string;
  vault: ExportAssemblyVault;
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  paths?: MediaToolPaths;
  now?: () => number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  assembleManifest?: (manifest: RenderManifest, options: AssembleManifestOptions) => Promise<AssemblyOutput>;
}
export interface ExportAssemblyScheduler { trigger(projectId: string): void; whenIdle(): Promise<void> }

/** Thrown when the render is canceled through its abort signal; no failure artifact is written. */
export class AssemblyAbortedError extends Error {
  constructor() { super("Assembly was aborted before completion"); this.name = "AssemblyAbortedError"; }
}

function fail(code: ProductionErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new ProductionApplicationError(code, message, details ? { details: details as ProductionApplicationError["details"] } : {});
}

/** Resolves the local media tools exactly like LocalMediaVault (vault.ts): env override or PATH name. */
export function resolveMediaTools(env: Readonly<Record<string, string | undefined>> = process.env): MediaToolPaths {
  return { ffmpeg: env.FFMPEG_PATH?.trim() || "ffmpeg", ffprobe: env.FFPROBE_PATH?.trim() || "ffprobe" };
}

/** Fail-closed version probe of both local tools; missing tools name the environment variable at fault. */
export async function probeMediaTools(paths: MediaToolPaths): Promise<void> {
  const checks: Array<{ tool: keyof MediaToolPaths; env: "FFMPEG_PATH" | "FFPROBE_PATH" }> = [
    { tool: "ffprobe", env: "FFPROBE_PATH" }, { tool: "ffmpeg", env: "FFMPEG_PATH" },
  ];
  for (const { tool, env } of checks) {
    const result = await runChild(paths[tool], ["-version"], { timeoutMs: 15_000 }).catch(() => null);
    if (!result || result.code !== 0) {
      fail("MEDIA_UNAVAILABLE", `The local ${tool} tool named by ${env} is unavailable; local FFmpeg tools are required for export assembly.`);
    }
  }
}

/** Frames -> deterministic decimal seconds on the 24 fps grid (9 digits, integer-derived, never float seconds). */
function framesToSeconds(frames: number): string {
  if (!Number.isSafeInteger(frames) || frames < 0 || !Number.isSafeInteger(frames * 1_000_000_000)) {
    fail("INVALID_INPUT", `Frame count ${String(frames)} cannot be represented on the fixed 24 fps encoder grid.`);
  }
  const scaled = Math.round((frames * 1_000_000_000) / 24);
  return `${Math.floor(scaled / 1_000_000_000)}.${String(scaled % 1_000_000_000).padStart(9, "0")}`;
}

/** Round-half-up sample -> millisecond delay at the fixed 48000 Hz (48 samples per millisecond). */
function adelayMilliseconds(timelineStartSample: number): number {
  if (!Number.isSafeInteger(timelineStartSample) || timelineStartSample < 0) {
    fail("INVALID_INPUT", `Audio cue start sample ${String(timelineStartSample)} is not a nonnegative safe integer.`);
  }
  const ms = Math.floor((timelineStartSample + 24) / 48);
  if (!Number.isSafeInteger(ms)) fail("INVALID_INPUT", `Audio cue start sample ${String(timelineStartSample)} exceeds the adelay millisecond range.`);
  return ms;
}

/** Scale-to-cover then center-crop geometry, computed in integers from the approved crop and profile. */
function coverGeometry(cropWidth: number, cropHeight: number, targetWidth: number, targetHeight: number): { scaleWidth: number; scaleHeight: number; cropX: number; cropY: number } {
  const evenCeil = (value: number) => (value % 2 === 0 ? value : value + 1);
  if (cropWidth * targetHeight >= cropHeight * targetWidth) {
    const scaleHeight = targetHeight;
    const scaleWidth = evenCeil(Math.ceil((cropWidth * targetHeight) / cropHeight));
    return { scaleWidth, scaleHeight, cropX: Math.floor((scaleWidth - targetWidth) / 2), cropY: 0 };
  }
  const scaleWidth = targetWidth;
  const scaleHeight = evenCeil(Math.ceil((cropHeight * targetWidth) / cropWidth));
  return { scaleWidth, scaleHeight, cropX: 0, cropY: Math.floor((scaleHeight - targetHeight) / 2) };
}

/**
 * Pure, deterministic assembly plan: re-derives totals through the accepted domain functions, then
 * emits the per-shot trim/crop/scale/fps chains, the 8-frame xfade chain with frame-exact offsets,
 * the concat, and the per-cue mix with loudnorm. Identical manifests produce byte-identical output.
 */
export function buildAssemblyPlan(manifest: RenderManifest, staged: Readonly<Record<string, StagedAssemblyAsset>>): AssemblyPlan {
  const inputCount = manifest.shots.length + manifest.audioCues.length;
  if (inputCount > ASSEMBLY_MAX_INPUTS) {
    fail("INVALID_INPUT", `Assembly requires ${inputCount} media inputs for manifest ${manifest.id}, over the ASSEMBLY_MAX_INPUTS bound of ${ASSEMBLY_MAX_INPUTS}.`);
  }
  for (const shot of manifest.shots) {
    const source = staged[shot.assetId];
    if (!source) fail("INVALID_INPUT", `Shot revision ${shot.shotRevisionId} pins unstaged asset ${shot.assetId}.`);
  }
  for (const cue of manifest.audioCues) {
    if (!staged[cue.assetId]) fail("INVALID_INPUT", `Audio cue ${cue.id} pins unstaged asset ${cue.assetId}.`);
  }
  const sourceShots: ManifestShotSource[] = manifest.shots.map((shot) => ({
    shotRevisionId: shot.shotRevisionId, shotHash: "assembly", takeId: shot.takeId, takeInputsHash: "assembly",
    assetId: shot.assetId, assetSha256: "assembly",
    assetWidth: staged[shot.assetId]!.width ?? 0, assetHeight: staged[shot.assetId]!.height ?? 0,
    actualFrames: staged[shot.assetId]!.frames ?? 0,
    startFrame: shot.startFrame, endFrame: shot.endFrame, crop: shot.crop, transition: shot.transition,
  }));
  const totalFrames = compileManifestTimeline(sourceShots);
  const audioExactness = manifest.audioCues.length > 0 ? validateAudioExactness(totalFrames, manifest.audioCues) : null;
  const { width: profileWidth, height: profileHeight, fps } = manifest.profile;

  const parts: string[] = [];
  const lengths = manifest.shots.map((shot) => shot.endFrame - shot.startFrame);
  for (const [index, shot] of manifest.shots.entries()) {
    const geometry = coverGeometry(shot.crop.width, shot.crop.height, profileWidth, profileHeight);
    const chain = [
      `trim=start_frame=${shot.startFrame}:end_frame=${shot.endFrame}`,
      `crop=w=${shot.crop.width}:h=${shot.crop.height}:x=${shot.crop.x}:y=${shot.crop.y}`,
      `scale=${geometry.scaleWidth}:${geometry.scaleHeight}`,
      `crop=w=${profileWidth}:h=${profileHeight}:x=${geometry.cropX}:y=${geometry.cropY}`,
      `fps=${fps}`,
      "setpts=PTS-STARTPTS",
    ].join(",");
    parts.push(`[${index}:v]${chain}[v${index}]`);
  }
  // Crossfade consecutive shots where the earlier shot's transition is crossfade; concat at cuts.
  let current = "v0";
  let combined = lengths[0]!;
  let totalCombined = lengths[0]!;
  let crossfadeCount = 0;
  const segmentLabels: string[] = [];
  for (let index = 1; index < manifest.shots.length; index += 1) {
    totalCombined += lengths[index]!;
    if (manifest.shots[index - 1]!.transition === "crossfade") {
      crossfadeCount += 1;
      const offsetFrames = combined - MANIFEST_CROSSFADE_FRAMES;
      parts.push(`[${current}][v${index}]xfade=transition=fade:duration=${framesToSeconds(MANIFEST_CROSSFADE_FRAMES)}:offset=${framesToSeconds(offsetFrames)}[x${index}]`);
      current = `x${index}`;
      combined = combined + lengths[index]! - MANIFEST_CROSSFADE_FRAMES;
    } else {
      segmentLabels.push(current);
      current = `v${index}`;
      combined = lengths[index]!;
    }
  }
  segmentLabels.push(current);
  if (totalCombined - crossfadeCount * MANIFEST_CROSSFADE_FRAMES !== totalFrames) {
    fail("INVALID_INPUT", `Assembly filtergraph totals ${totalCombined - crossfadeCount * MANIFEST_CROSSFADE_FRAMES} frames but the manifest timeline pins ${totalFrames}.`);
  }
  const videoOut = segmentLabels.length > 1 ? "vout" : current;
  if (segmentLabels.length > 1) {
    parts.push(`${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=1:a=0[${videoOut}]`);
  }
  if (manifest.audioCues.length > 0) {
    const cueLabels: string[] = [];
    for (const [index, cue] of manifest.audioCues.entries()) {
      const inputIndex = manifest.shots.length + index;
      const ms = adelayMilliseconds(cue.timelineStartSample);
      const channelLayout = `aformat=sample_fmts=fltp:sample_rates=${ASSEMBLY_ENCODER_RECIPE.sampleRate}:channel_layouts=stereo`;
      parts.push(`[${inputIndex}:a]atrim=start_sample=${cue.sourceStartSample}:end_sample=${cue.sourceEndSample},asetpts=PTS-STARTPTS,volume=${cue.gainDb}dB,aresample=${ASSEMBLY_ENCODER_RECIPE.sampleRate},${channelLayout},adelay=${ms}|${ms}[c${index}]`);
      cueLabels.push(`c${index}`);
    }
    parts.push(`${cueLabels.map((label) => `[${label}]`).join("")}amix=inputs=${cueLabels.length}:normalize=0:dropout_transition=0,loudnorm=I=${ASSEMBLY_LOUDNORM.integratedLufs}:TP=${ASSEMBLY_LOUDNORM.truePeakDbtp}:LRA=${ASSEMBLY_LOUDNORM.lra},aresample=${ASSEMBLY_ENCODER_RECIPE.sampleRate},aformat=sample_fmts=fltp:sample_rates=${ASSEMBLY_ENCODER_RECIPE.sampleRate}:channel_layouts=stereo[aout]`);
  }
  const filterComplex = parts.join(";");

  const args: string[] = ["-nostdin", "-v", "error", "-xerror", "-y"];
  for (const shot of manifest.shots) args.push("-i", staged[shot.assetId]!.path);
  for (const cue of manifest.audioCues) args.push("-i", staged[cue.assetId]!.path);
  args.push("-filter_complex", filterComplex, "-map", `[${videoOut}]`);
  if (manifest.audioCues.length === 0) args.push("-an");
  else args.push("-map", "[aout]");
  args.push(
    "-c:v", ASSEMBLY_ENCODER_RECIPE.videoCodec, "-profile:v", ASSEMBLY_ENCODER_RECIPE.profile, "-preset", ASSEMBLY_ENCODER_RECIPE.preset,
    "-crf", String(ASSEMBLY_ENCODER_RECIPE.crf), "-pix_fmt", ASSEMBLY_ENCODER_RECIPE.pixelFormat,
    "-color_primaries", ASSEMBLY_ENCODER_RECIPE.colorPrimaries, "-color_trc", ASSEMBLY_ENCODER_RECIPE.colorTrc, "-colorspace", ASSEMBLY_ENCODER_RECIPE.colorspace,
    "-movflags", ASSEMBLY_ENCODER_RECIPE.movFlags,
  );
  if (manifest.audioCues.length > 0) {
    args.push("-c:a", ASSEMBLY_ENCODER_RECIPE.audioCodec, "-b:a", ASSEMBLY_ENCODER_RECIPE.audioBitrate, "-ar", String(ASSEMBLY_ENCODER_RECIPE.sampleRate), "-ac", String(ASSEMBLY_ENCODER_RECIPE.channels));
  }
  return { filterComplex, args, totalFrames, audioCueCount: manifest.audioCues.length, audioExactness };
}

export const exportOutputName = (manifest: RenderManifest): string => `export-${manifest.inputsHash}.mp4`;

/** Strips local paths and credential assignments from tool output (worker.ts redaction precedent). */
export function redactStderr(text: string, options: { dataDir: string }): string {
  let redacted = typeof text === "string" ? text : "";
  redacted = redacted.replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]");
  if (options.dataDir) redacted = redacted.split(options.dataDir).join("[local-path]");
  redacted = redacted.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"'`<>|;,)\]\\]+)+/g, "[local-path]");
  return redacted.slice(0, 2000);
}

interface ChildResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }
function runChild(executable: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ChildResult> {
  return new Promise<ChildResult>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: child.exitCode, stdout, stderr, timedOut, aborted });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    timer.unref?.();
    const onAbort = () => { aborted = true; child.kill("SIGKILL"); };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 1024 * 1024) { child.kill("SIGKILL"); } });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 64_000) stderr = stderr.slice(-64_000); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rejectPromise(new ProductionApplicationError("MEDIA_UNAVAILABLE", `The local media tool named by FFMPEG_PATH could not be started: ${error.code === "ENOENT" ? "tool not found" : error.message}.`));
    });
    child.once("close", () => finish());
  });
}

function childFailure(manifest: RenderManifest, result: ChildResult, tempDir: string): Error {
  if (result.aborted) return new AssemblyAbortedError();
  const decodeMatch = /error while decoding stream #(\d+)|invalid data found|error parsing|corrupt(?:ed)?|moov atom|could not find codec parameters|no such file or directory/i.exec(result.stderr);
  const stage = decodeMatch ? "decode-input" : "encode";
  let shotRevisionId: string | undefined;
  let cueId: string | undefined;
  const inputMatch = /#(\d+)/.exec(decodeMatch?.[0] ?? "");
  if (stage === "decode-input" && inputMatch) {
    const inputIndex = Number(inputMatch[1]);
    if (Number.isInteger(inputIndex)) {
      if (inputIndex < manifest.shots.length) shotRevisionId = manifest.shots[inputIndex]?.shotRevisionId;
      else cueId = manifest.audioCues[inputIndex - manifest.shots.length]?.id;
    }
  }
  const where = shotRevisionId ? ` at shot revision ${shotRevisionId}` : cueId ? ` at audio cue ${cueId}` : "";
  const reason = result.timedOut ? ` after the ${Math.round(ASSEMBLY_RENDER_TIMEOUT_MS / 60_000)}-minute render timeout` : "";
  return new ProductionApplicationError("MEDIA_UNAVAILABLE", `FFmpeg ${stage === "encode" ? "encoding" : "input decoding"} failed for manifest ${manifest.id}${where}${reason}.`, {
    details: { stage, ...(shotRevisionId ? { shotRevisionId } : {}), ...(cueId ? { cueId } : {}), stderr: redactStderr(result.stderr, { dataDir: tempDir }) },
  });
}

interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; sample_rate?: string; channels?: number; nb_read_frames?: string; duration_ts?: string; time_base?: string }

async function verifyOutput(paths: MediaToolPaths, outputPath: string, manifest: RenderManifest, totalFrames: number, options: { timeoutMs: number; signal?: AbortSignal; tempDir: string }): Promise<AssemblyOutputProbe> {
  const verifyFailure = (message: string, stderr: string): ProductionApplicationError =>
    new ProductionApplicationError("MEDIA_UNAVAILABLE", message, { details: { stage: "verify", stderr: redactStderr(stderr, { dataDir: options.tempDir }) } });
  const probe = await runChild(paths.ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,nb_read_frames,duration_ts,time_base",
    "-of", "json", outputPath,
  ], { timeoutMs: Math.min(options.timeoutMs, 120_000), signal: options.signal });
  if (probe.code !== 0) throw verifyFailure(`ffprobe could not verify the rendered manifest ${manifest.id}.`, probe.stderr);
  let parsed: { streams?: ProbeStream[] };
  try { parsed = JSON.parse(probe.stdout) as { streams?: ProbeStream[] }; } catch { throw verifyFailure(`ffprobe returned invalid metadata for manifest ${manifest.id}.`, probe.stderr); }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const expect = (condition: boolean, detail: string): void => { if (!condition) throw verifyFailure(`Rendered manifest ${manifest.id} failed output verification: ${detail}`, probe.stderr); };
  expect(video?.codec_name === "h264", `video codec is ${String(video?.codec_name)}, expected h264`);
  expect(video?.width === manifest.profile.width && video?.height === manifest.profile.height, `dimensions are ${String(video?.width)}x${String(video?.height)}, expected ${manifest.profile.width}x${manifest.profile.height}`);
  expect(video?.pix_fmt === "yuv420p", `pixel format is ${String(video?.pix_fmt)}, expected yuv420p`);
  expect(video?.avg_frame_rate === `${manifest.profile.fps}/1`, `average frame rate is ${String(video?.avg_frame_rate)}, expected ${manifest.profile.fps}/1`);
  expect(video?.nb_read_frames === String(totalFrames), `decoded frame count is ${String(video?.nb_read_frames)}, expected ${totalFrames}`);
  const [timeBaseNum, timeBaseDen] = (video?.time_base ?? "0/0").split("/").map(Number);
  const durationTs = Number(video?.duration_ts ?? "NaN");
  expect(Number.isSafeInteger(timeBaseNum) && Number.isSafeInteger(timeBaseDen) && timeBaseNum > 0 && timeBaseDen > 0 && Number.isSafeInteger(durationTs) && durationTs >= 0, "stream duration is not a rational value");
  expect(Math.abs(durationTs * timeBaseNum * 24 - totalFrames * timeBaseDen) <= timeBaseDen, `duration ${durationTs}x${timeBaseNum}/${timeBaseDen} is more than one frame from the ${totalFrames}-frame timeline`);
  if (manifest.audioCues.length > 0) {
    expect(audio?.codec_name === "aac", `audio codec is ${String(audio?.codec_name)}, expected aac`);
    expect(audio?.sample_rate === String(manifest.profile.sampleRate), `audio sample rate is ${String(audio?.sample_rate)}, expected ${manifest.profile.sampleRate}`);
    expect(audio?.channels === ASSEMBLY_ENCODER_RECIPE.channels, `audio channel count is ${String(audio?.channels)}, expected ${ASSEMBLY_ENCODER_RECIPE.channels}`);
  } else {
    expect(audio === undefined, "silent-draft render must not carry an audio stream");
  }
  const decode = await runChild(paths.ffmpeg, ["-v", "error", "-xerror", "-i", outputPath, "-f", "null", "-"], { timeoutMs: Math.min(options.timeoutMs, 120_000), signal: options.signal });
  if (decode.code !== 0) throw verifyFailure(`Rendered manifest ${manifest.id} failed full decode verification.`, decode.stderr);
  const [num, den] = (video?.time_base ?? "0/1").split("/").map(Number);
  return {
    video: { codec: "h264", width: video!.width!, height: video!.height!, pixFmt: "yuv420p", avgFrameRate: video!.avg_frame_rate!, frames: totalFrames, durationTs, timeBaseNum: num, timeBaseDen: den },
    audio: manifest.audioCues.length > 0 ? { codec: "aac", sampleRate: Number(audio?.sample_rate ?? 0), channels: audio?.channels ?? 0 } : null,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Renders one accepted manifest with the local FFmpeg toolchain: stages pinned assets into a
 * private 0700 temp dir, spawns ffmpeg with argument arrays only, verifies the output shape with
 * ffprobe and a full decode, and always cleans the staging dir, including on abort and timeout.
 */
export async function assembleManifest(manifest: RenderManifest, options: AssembleManifestOptions): Promise<AssemblyOutput> {
  const paths = options.paths ?? resolveMediaTools();
  const timeoutMs = options.timeoutMs ?? ASSEMBLY_RENDER_TIMEOUT_MS;
  if (options.signal?.aborted) throw new AssemblyAbortedError();
  await probeMediaTools(paths);
  const tempDir = await mkdtemp(join(options.workDir, "staging-"));
  try {
    const staged: Record<string, StagedAssemblyAsset> = {};
    for (const assetId of new Set([...manifest.shots.map((shot) => shot.assetId), ...manifest.audioCues.map((cue) => cue.assetId)])) {
      if (options.signal?.aborted) throw new AssemblyAbortedError();
      staged[assetId] = await options.stageAsset(assetId, tempDir);
    }
    const plan = buildAssemblyPlan(manifest, staged);
    const outputPath = join(options.workDir, exportOutputName(manifest));
    const result = await runChild(paths.ffmpeg, [...plan.args, outputPath], { timeoutMs, signal: options.signal });
    if (result.code !== 0) throw childFailure(manifest, result, tempDir);
    if (options.signal?.aborted) throw new AssemblyAbortedError();
    const probe = await verifyOutput(paths, outputPath, manifest, plan.totalFrames, { timeoutMs, signal: options.signal, tempDir });
    return { outputPath, sha256: await sha256File(outputPath), probe, args: [...plan.args, outputPath], filterComplex: plan.filterComplex, totalFrames: plan.totalFrames };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface ExportLeaseFile { version: 1; exportId: string; leaseToken: string; leaseUntil: number; heartbeatAt: number }

async function acquireLease(exportDir: string, exportId: string, nowMs: number): Promise<ExportLeaseFile | null> {
  const leasePath = join(exportDir, "lease.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease: ExportLeaseFile = { version: 1, exportId, leaseToken: `lease-${randomUUID()}`, leaseUntil: nowMs + EXPORT_LEASE_MS, heartbeatAt: nowMs };
    try {
      await writeFile(leasePath, JSON.stringify(lease), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { leaseUntil?: unknown } | null = null;
      try { existing = JSON.parse(await readFile(leasePath, "utf8")) as { leaseUntil?: unknown }; } catch { existing = null; }
      if (typeof existing?.leaseUntil === "number" && existing.leaseUntil > nowMs) return null;
      await rm(leasePath, { force: true });
    }
  }
  return null;
}

/**
 * Export execution state machine over the durable ExportRecord: claim via lease file + CAS,
 * heartbeat the lease during the render, publish through the vault, then commit asset + CAS to
 * qc_pending in one transaction. Failures are attributed in failure.json; cancels leave no asset.
 */
export async function runExportAssembly(exportId: string, options: ExportAssemblyOptions): Promise<ExportRecord> {
  const now = options.now ?? Date.now;
  const store = options.store;
  const initial = store.read.getExport(exportId);
  if (!initial) fail("UNKNOWN_REFERENCE", `Export ${exportId} not found`);
  if (initial.status !== "queued" && initial.status !== "rendering") return initial;
  const assemble = options.assembleManifest ?? assembleManifest;
  const exportDir = join(options.dataDir, "exports", exportId);
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const lease = await acquireLease(exportDir, exportId, now());
  if (!lease) return store.read.getExport(exportId)!;
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  let timer: ReturnType<typeof setInterval> | null = null;
  let workDir: string | null = null;
  try {
    let current = store.read.getExport(exportId)!;
    if (current.status === "rendering") {
      const queued = { ...current, status: "queued" as const };
      if (!store.transaction((tx) => tx.compareAndSetExport(queued, "rendering"))) return store.read.getExport(exportId)!;
      current = queued;
    }
    if (current.status === "queued") {
      const rendering = { ...current, status: "rendering" as const };
      if (!store.transaction((tx) => tx.compareAndSetExport(rendering, "queued"))) return store.read.getExport(exportId)!;
      current = rendering;
    }
    if (current.status !== "rendering") return store.read.getExport(exportId)!;

    const heartbeat = async (): Promise<boolean> => {
      const at = now();
      const next: ExportLeaseFile = { version: 1, exportId, leaseToken: lease.leaseToken, leaseUntil: at + EXPORT_LEASE_MS, heartbeatAt: at };
      const temp = join(exportDir, `lease.json.tmp-${randomUUID()}`);
      try {
        await writeFile(temp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
        await rename(temp, join(exportDir, "lease.json"));
        const check = JSON.parse(await readFile(join(exportDir, "lease.json"), "utf8")) as { leaseToken?: string };
        return check.leaseToken === lease.leaseToken;
      } catch {
        await rm(temp, { force: true });
        return false;
      }
    };
    timer = setInterval(() => { void heartbeat().then((alive) => { if (!alive) controller.abort(); }).catch(() => controller.abort()); }, EXPORT_HEARTBEAT_MS);
    timer.unref?.();

    const manifest = store.read.getManifest(current.manifestId);
    if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${current.manifestId} pinned by export ${exportId} is missing.`);
    const stagedLimit = options.maxStagedBytes ?? ASSEMBLY_MAX_STAGED_BYTES;
    let stagedBytes = 0;
    const stageAsset = async (assetId: string, tempDir: string): Promise<StagedAssemblyAsset> => {
      if (controller.signal.aborted) throw new AssemblyAbortedError();
      const asset = store.read.getAsset(assetId);
      if (!asset) throw new ProductionApplicationError("MEDIA_UNAVAILABLE", `Asset ${assetId} pinned by manifest ${manifest!.id} is missing from local records.`, { details: { stage: "stage" } });
      stagedBytes += asset.byteSize;
      if (!Number.isSafeInteger(stagedBytes) || stagedBytes > stagedLimit) {
        throw new ProductionApplicationError("INVALID_INPUT", `Assembly staging exceeds the ${stagedLimit}-byte staged-size bound (ASSEMBLY_MAX_STAGED_BYTES).`, { details: { stage: "stage" } });
      }
      let bytes: Uint8Array;
      try {
        bytes = await options.vault.readVerified(asset.vaultRef, asset.sha256);
      } catch (error) {
        throw new ProductionApplicationError("MEDIA_UNAVAILABLE", `Asset ${assetId} failed checksum verification for manifest ${manifest!.id}: ${error instanceof Error ? error.message : "unknown vault error"}.`, { details: { stage: "stage" } });
      }
      const target = join(tempDir, `${assetId.replace(/[^A-Za-z0-9_.-]/g, "_")}.staged`);
      await writeFile(target, bytes, { mode: 0o600 });
      return { path: target, width: asset.width, height: asset.height, frames: asset.frames };
    };
    workDir = options.workDir ?? join(exportDir, `render-${randomUUID()}`);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    try {
      const output = await assemble(manifest, { workDir, paths: options.paths ?? resolveMediaTools(), stageAsset, signal: controller.signal, timeoutMs: ASSEMBLY_RENDER_TIMEOUT_MS });
      const stored = await options.vault.putStream(createReadStream(output.outputPath), { mime: "video/mp4", sourceKind: "derived", rightsStatus: "unknown" });
      const asset = AssetSchema.parse({ ...stored.asset, id: `export-asset-${output.sha256}` });
      const committed = store.transaction((tx) => {
        if (!tx.getAsset(asset.id)) tx.insertAsset({ asset, verifiedAt: now(), checksumVerified: true });
        const live = tx.getExport(exportId)!;
        const updated = { ...live, status: "qc_pending" as const, assetId: asset.id };
        return tx.compareAndSetExport(updated, "rendering") ? updated : null;
      });
      return committed ?? store.read.getExport(exportId)!;
    } catch (error) {
      if (controller.signal.aborted || error instanceof AssemblyAbortedError) {
        const canceled = store.transaction((tx) => {
          const live = tx.getExport(exportId)!;
          const updated = { ...live, status: "canceled" as const };
          return tx.compareAndSetExport(updated, "rendering") ? updated : null;
        });
        return canceled ?? store.read.getExport(exportId)!;
      }
      const known = error instanceof ProductionApplicationError;
      const code: ProductionErrorCode = known ? error.code : "INTERNAL_ERROR";
      const details = (known ? error.details : undefined) ?? {};
      const stage = typeof details.stage === "string" ? details.stage : "assemble";
      const rawStderr = typeof details.stderr === "string" ? details.stderr : error instanceof Error ? error.message : "unknown assembly error";
      const failure = {
        version: 1 as const, exportId, code, stage,
        ...(typeof details.shotRevisionId === "string" ? { shotRevisionId: details.shotRevisionId } : {}),
        ...(typeof details.cueId === "string" ? { cueId: details.cueId } : {}),
        redactedStderr: redactStderr(rawStderr, { dataDir: options.dataDir }),
        at: now(),
      };
      await writeFile(join(exportDir, "failure.json"), JSON.stringify(failure), { encoding: "utf8", mode: 0o600 });
      const failed = store.transaction((tx) => {
        const live = tx.getExport(exportId)!;
        const updated = { ...live, status: "failed" as const };
        return tx.compareAndSetExport(updated, "rendering") ? updated : null;
      });
      return failed ?? store.read.getExport(exportId)!;
    }
  } finally {
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener("abort", relayAbort);
    await rm(join(exportDir, "lease.json"), { force: true }).catch(() => undefined);
    if (workDir && !options.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const schedulerInstances = new Map<string, ExportAssemblyScheduler>();

/**
 * Per-process export assembly scheduler with exactly one render slot: trigger(projectId) is
 * fire-and-forget and never throws; it re-drives stale non-terminal exports (bounded) and then
 * queued ones, strictly one at a time.
 */
export function createExportAssemblyScheduler(deps: ExportAssemblySchedulerDeps): ExportAssemblyScheduler {
  const existing = schedulerInstances.get(deps.dataDir);
  if (existing) return existing;
  const withStore: NonNullable<ExportAssemblySchedulerDeps["withStore"]> = deps.withStore ??
    ((work) => withProductionStore((store) => work(store), { env: { PERABYTE_STUDIO_DATA_DIR: deps.dataDir } }));
  const onError = deps.onError ?? ((error: unknown) => { console.error(`[c11-export-assembly] ${error instanceof Error ? error.message : String(error)}`); });
  const pending: string[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;
  const pump = async (): Promise<void> => {
    while (!deps.signal?.aborted) {
      const projectId = pending.shift();
      if (projectId === undefined) break;
      try {
        await withStore(async (store) => {
          const drives = store.read.listProjectExports(projectId)
            .filter((record) => record.status === "queued" || record.status === "rendering")
            .slice(0, EXPORT_REDRIVE_LIMIT);
          for (const record of drives) {
            try {
              await runExportAssembly(record.id, { store, vault: deps.vault, dataDir: deps.dataDir, paths: deps.paths, now: deps.now, signal: deps.signal, assembleManifest: deps.assembleManifest });
            } catch (error) { onError(error); }
          }
        });
      } catch (error) { onError(error); }
    }
  };
  const startPump = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try { await pump(); } finally {
        running = false;
        if (pending.length > 0) startPump();
        else { const waiters = idleWaiters.splice(0); for (const waiter of waiters) waiter(); }
      }
    })();
  };
  const scheduler: ExportAssemblyScheduler = {
    trigger(projectId: string): void {
      pending.push(projectId);
      startPump();
    },
    whenIdle(): Promise<void> {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
  };
  schedulerInstances.set(deps.dataDir, scheduler);
  return scheduler;
}
