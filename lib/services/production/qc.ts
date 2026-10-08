import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalSchema, ExportSchema, IdSchema, type Approval, type ExportRecord, type RenderManifest,
} from "../../production/contracts";
import { redactStderr, resolveMediaTools, type MediaToolPaths } from "../../media/production/assembly";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import {
  buildQcReport, evaluateQc, FINAL_REVIEW_CHECKLIST_IDS,
  parseBlackFreezeSilence, parseEbur128Summary, QcReportSchema, FailureRecordSchema,
  ExportActionCommandSchema, ExportDetailResponseSchema, FinalReviewCommandSchema,
  QC_BLACKDETECT_FILTER, QC_FREEZEDETECT_FILTER, QC_SAMPLE_RATE, QC_SILENCEDETECT_FILTER, QC_TOOL_TIMEOUT_MS,
  type ExportDetailResponse, type FinalReviewCommand, type QcEvaluation,
  type QcMeasurement, type QcReport,
} from "../../production/qc";
import { resolveProductionDataDir, withProductionStore } from "../../production/runtime";
import type { ProductionStore } from "../../repositories/production/ports";

/**
 * C12 export QC service: measured QC runs over the exact vault bytes (never trusting the render),
 * the QC report is a filesystem artifact written before the state CAS, and the human G09 final
 * review is the only path that can approve an export's exact checksum. Final and draft downloads
 * are strictly separated; silent drafts can never become release-ready. No response from this
 * module ever exposes a vaultRef or filesystem path.
 */

export interface QcVault { readVerified(vaultRef: string, expectedSha256: string): Promise<Uint8Array> }

export interface QcServiceOptions {
  store: ProductionStore;
  vault: QcVault;
  dataDir: string;
  paths?: MediaToolPaths;
  now?: () => number;
  signal?: AbortSignal;
  /** Wall-clock bound per QC tool invocation; defaults to QC_TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Thrown when QC is aborted through its signal; no report is written and no CAS happens. */
export class QcAbortedError extends Error {
  constructor() { super("QC was aborted before completion"); this.name = "QcAbortedError"; }
}

function fail(code: ProductionErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new ProductionApplicationError(code, message, details ? { details: details as ProductionApplicationError["details"] } : {});
}

interface ToolResult { code: number | null; stdout: string; stderr: string; failedToStart: boolean; timedOut: boolean; aborted: boolean }

/** Spawn wrapper mirroring the accepted assembly runner: argument arrays only, bounded timeout, abort relay, capped output. */
function runTool(executable: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ToolResult> {
  return new Promise<ToolResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolvePromise({ code: null, stdout: "", stderr: `${executable} could not be started`, failedToStart: true, timedOut: false, aborted: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        code: child.exitCode, stdout, stderr: spawnError ? `${spawnError}\n${stderr}` : stderr,
        failedToStart: Boolean(spawnError), timedOut, aborted,
      });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    timer.unref?.();
    const onAbort = () => { aborted = true; child.kill("SIGKILL"); };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(0, 2_000_000); });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 512_000) stderr = stderr.slice(-256_000); });
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = `${executable} could not be started: ${error.code === "ENOENT" ? "tool not found" : error.message}`; });
    child.once("close", () => finish());
  });
}

const toolVersion = async (executable: string, timeoutMs: number): Promise<string> => {
  const result = await runTool(executable, ["-version"], { timeoutMs: Math.min(timeoutMs, 15_000) });
  const match = /version\s+(\S+)/.exec(result.stderr.split("\n")[0] ?? "");
  return match?.[1] ?? "unknown";
};

interface ProbeJson { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; sample_rate?: string; channels?: number; nb_read_frames?: string; duration_ts?: string; time_base?: string }>; format?: { format_name?: string } }

const streamFrames = (value: string | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const streamSamples = (durationTs: string | undefined, timeBase: string | undefined, sampleRate: number): number | null => {
  const [num, den] = (timeBase ?? "0/0").split("/").map(Number);
  const ts = Number(durationTs ?? NaN);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0 || !Number.isFinite(ts)) return null;
  const samples = Math.round(((ts * num) / den) * sampleRate);
  return Number.isSafeInteger(samples) && samples >= 0 ? samples : null;
};

export function createQcService(options: QcServiceOptions) {
  const paths = options.paths ?? resolveMediaTools();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? QC_TOOL_TIMEOUT_MS;
  const exportDir = (exportId: string): string => join(options.dataDir, "exports", exportId);
  // The artifact filename is derived from the content-addressed report id, so two racing run_qc
  // passes never clobber each other's file: the CAS winner's committed qcReportId always resolves
  // to exactly the bytes that report id names (a lost racer's file remains as a harmless orphan,
  // same rationale as the freeze's write-then-CAS decision).
  const reportPath = (exportId: string, reportId: string): string => join(exportDir(exportId), `qc-report-${reportId}.json`);

  /** Reads and schema-checks the report file named by the recorded report id; null when absent, unparsable, or id-mismatched. */
  const readReport = async (exportId: string, reportId: string): Promise<QcReport | null> => {
    let raw: string;
    try { raw = await readFile(reportPath(exportId, reportId), "utf8"); } catch { return null; }
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw); } catch { return null; }
    const parsed = QcReportSchema.safeParse(parsedJson);
    if (!parsed.success) return null;
    if (parsed.data.id !== reportId) return null;
    return parsed.data;
  };

  const persistReportAndCas = async (exportId: string, report: QcReport, targetStatus: "ready_for_review" | "qc_failed"): Promise<ExportRecord> => {
    // Filesystem artifact first (mirrors the accepted failure.json flow), then the single CAS;
    // an orphaned report from a lost CAS race is harmless.
    await mkdir(exportDir(exportId), { recursive: true, mode: 0o700 });
    await writeFile(reportPath(exportId, report.id), JSON.stringify(report), { encoding: "utf8", mode: 0o600 });
    const committed = options.store.transaction((tx) => {
      const live = tx.getExport(exportId);
      if (!live) return null;
      const updated = { ...live, status: targetStatus, qcReportId: report.id };
      return tx.compareAndSetExport(updated, "qc_pending") ? updated : null;
    });
    return committed ?? options.store.read.getExport(exportId)!;
  };

  const runQcReportPair = async (
    exportId: string, manifest: RenderManifest, assetId: string, outputSha256: string,
    measurement: QcMeasurement | null, evaluation: QcEvaluation, toolFailure: { stage: string; redactedStderr: string } | null,
  ): Promise<{ exportRecord: ExportRecord; report: QcReport }> => {
    const report = buildQcReport({
      manifest, exportId, outputAssetId: assetId, outputSha256,
      measurement, evaluation,
      toolVersions: { ffmpeg: await toolVersion(paths.ffmpeg, timeoutMs), ffprobe: await toolVersion(paths.ffprobe, timeoutMs) },
      toolFailure, createdAt: now(),
    });
    const exportRecord = await persistReportAndCas(exportId, report, evaluation.verdict === "passed" ? "ready_for_review" : "qc_failed");
    return { exportRecord, report };
  };

  const checksumFailureReport = (manifest: RenderManifest, message: string): QcEvaluation => ({
    verdict: "failed",
    blockers: [{ code: "checksum_mismatch" as const, message }],
    advisories: [],
  });

  const runQc = async (rawExportId: string): Promise<{ exportRecord: ExportRecord; report: QcReport }> => {
    if (!IdSchema.safeParse(rawExportId).success) fail("INVALID_INPUT", "Invalid export ID");
    const exportRecord = options.store.read.getExport(rawExportId);
    if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${rawExportId} not found`);
    if (exportRecord.status !== "qc_pending") fail("STALE_REVISION", `Export ${rawExportId} is in status ${exportRecord.status}; technical QC runs only from qc_pending.`);
    const manifest = options.store.read.getManifest(exportRecord.manifestId);
    if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${rawExportId} is missing.`);
    if (!exportRecord.assetId) fail("STALE_REVISION", `Export ${rawExportId} has no rendered asset to inspect; re-run the export assembly.`);
    const asset = options.store.read.getAsset(exportRecord.assetId);
    if (!asset) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${rawExportId} is missing from local records.`);
    const story = options.store.read.getStoryRevision(manifest.storyRevisionId);
    const storyBeats = (story?.beats ?? []).map((beat) => ({ id: beat.id, narration: beat.narration }));

    // Never trust the render: read the exact bytes back through the checksum-enforced vault.
    let bytes: Uint8Array;
    try {
      bytes = await options.vault.readVerified(asset.vaultRef, asset.sha256);
    } catch {
      return runQcReportPair(rawExportId, manifest, asset.id, asset.sha256, null,
        checksumFailureReport(manifest, "The rendered output failed checksum verification against the recorded export asset; the bytes are not the rendered artifact."), null);
    }

    if (options.signal?.aborted) throw new QcAbortedError();
    await mkdir(exportDir(rawExportId), { recursive: true, mode: 0o700 });
    const stagedPath = join(exportDir(rawExportId), `qc-input.tmp-${randomUUID()}`);
    await writeFile(stagedPath, bytes, { mode: 0o600 });
    const measurementFailed = async (stage: string, stderr: string) =>
      runQcReportPair(rawExportId, manifest, asset.id, asset.sha256, null,
        {
          verdict: "failed",
          blockers: [{ code: "measurement_failed" as const, message: `The ${stage} measurement pass failed; the output could not be verified. Inspect the redacted tool output and retry QC.` }],
          advisories: [],
        },
        { stage, redactedStderr: redactStderr(stderr, { dataDir: options.dataDir }) || "tool output was empty" });
    try {
      const bounds = { timeoutMs, signal: options.signal };
      const assertLive = () => { if (options.signal?.aborted) throw new QcAbortedError(); };

      // Pass 1: structural probe.
      assertLive();
      const probeRun = await runTool(paths.ffprobe, [
        "-v", "error", "-count_frames", "-show_entries",
        "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,nb_read_frames,duration_ts,time_base:format=format_name",
        "-of", "json", stagedPath,
      ], bounds);
      if (probeRun.aborted) throw new QcAbortedError();
      if (probeRun.failedToStart || probeRun.timedOut || probeRun.code !== 0) {
        return measurementFailed("probe", probeRun.stderr);
      }
      let parsed: ProbeJson;
      try { parsed = JSON.parse(probeRun.stdout) as ProbeJson; } catch {
        return measurementFailed("probe", probeRun.stderr);
      }
      const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video") ?? null;
      const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio") ?? null;
      const videoDurationSeconds = (() => {
        const [num, den] = (videoStream?.time_base ?? "0/0").split("/").map(Number);
        const ts = Number(videoStream?.duration_ts ?? NaN);
        if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0 || !Number.isFinite(ts)) return null;
        const seconds = (ts * num) / den;
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      })();
      const measurement: QcMeasurement = {
        probe: {
          video: videoStream ? {
            codec: videoStream.codec_name ?? "unknown",
            width: Number(videoStream.width ?? NaN), height: Number(videoStream.height ?? NaN),
            pixFmt: videoStream.pix_fmt ?? "unknown", avgFrameRate: videoStream.avg_frame_rate ?? "0/0",
            frames: streamFrames(videoStream.nb_read_frames),
          } : null,
          audio: audioStream ? {
            codec: audioStream.codec_name ?? "unknown",
            sampleRate: Number(audioStream.sample_rate ?? NaN), channels: Number(audioStream.channels ?? NaN),
            endSample: streamSamples(audioStream.duration_ts, audioStream.time_base, QC_SAMPLE_RATE),
          } : null,
          formatName: parsed.format?.format_name ?? null,
        },
        checksumOk: true,
        decodeOk: false,
        ebur128: null,
        intervals: { black: [], freeze: [], silence: [] },
      };

      // Pass 2: full decode.
      assertLive();
      const decodeRun = await runTool(paths.ffmpeg, ["-v", "error", "-xerror", "-i", stagedPath, "-f", "null", "-"], bounds);
      if (decodeRun.aborted) throw new QcAbortedError();
      measurement.decodeOk = decodeRun.code === 0 && !decodeRun.failedToStart;
      const decodeFailedToRun = decodeRun.failedToStart || decodeRun.timedOut;

      // Pass 3: loudness summary (only with declared cues and a present audio stream).
      if (manifest.audioCues.length > 0 && audioStream && !decodeFailedToRun) {
        assertLive();
        const loudnessRun = await runTool(paths.ffmpeg, ["-v", "info", "-i", stagedPath, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], bounds);
        if (loudnessRun.aborted) throw new QcAbortedError();
        if (loudnessRun.failedToStart || loudnessRun.timedOut || loudnessRun.code !== 0) {
          return measurementFailed("loudness", loudnessRun.stderr);
        }
        measurement.ebur128 = parseEbur128Summary(loudnessRun.stderr);
      }

      // Pass 4: advisory detectors (video filters always; the silence filter only with audio).
      // Filter strings come verbatim from the frozen threshold constants that also feed the
      // report's detectorThresholds, so the executed detectors can never drift from the report.
      if (!decodeFailedToRun) {
        assertLive();
        const args = ["-v", "info", "-i", stagedPath, "-vf", `${QC_BLACKDETECT_FILTER},${QC_FREEZEDETECT_FILTER}`];
        if (audioStream) args.push("-af", QC_SILENCEDETECT_FILTER);
        args.push("-f", "null", "-");
        const advisoryRun = await runTool(paths.ffmpeg, args, bounds);
        if (advisoryRun.aborted) throw new QcAbortedError();
        if (advisoryRun.failedToStart || advisoryRun.timedOut || advisoryRun.code !== 0) {
          return measurementFailed("advisory", advisoryRun.stderr);
        }
        measurement.intervals = parseBlackFreezeSilence(advisoryRun.stderr, { videoDurationSeconds });
      }

      // Re-hash the staged bytes after the passes: drift mid-QC is a checksum blocker.
      const stagedBytes = await readFile(stagedPath);
      measurement.checksumOk = createHash("sha256").update(stagedBytes).digest("hex") === asset.sha256;

      const evaluation: QcEvaluation = measurement.checksumOk
        ? evaluateQc(manifest, storyBeats, measurement)
        : checksumFailureReport(manifest, "The rendered output changed underneath the QC pass; the staged bytes no longer match the recorded export asset checksum.");
      return runQcReportPair(rawExportId, manifest, asset.id, asset.sha256, measurement, evaluation, null);
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
    }
  };

  const finalReview = async (rawExportId: string, rawCommand: FinalReviewCommand): Promise<{ approval: Approval; exportRecord: ExportRecord; created: boolean }> => {
    if (!IdSchema.safeParse(rawExportId).success) fail("INVALID_INPUT", "Invalid export ID");
    const parsedCommand = FinalReviewCommandSchema.safeParse(rawCommand);
    if (!parsedCommand.success) fail("INVALID_INPUT", `Invalid final review command: ${parsedCommand.error.issues.map((issue) => issue.message).join("; ")}`);
    const command = parsedCommand.data;
    const exportRecord = options.store.read.getExport(rawExportId);
    if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${rawExportId} not found`);
    const manifest = options.store.read.getManifest(exportRecord.manifestId);
    if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${rawExportId} is missing.`);
    const projectId = manifest.projectId;
    const asset = exportRecord.assetId ? options.store.read.getAsset(exportRecord.assetId) : null;
    if (!asset) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${rawExportId} is missing from local records.`);
    const approvalId = `approval:${hashCanonicalJson({ schemaVersion: 1, operation: "final_review", projectId, idempotencyKey: command.idempotencyKey })}`;
    const actorId = "local-creator";
    const sameDecision = (existing: Approval): boolean =>
      existing.actorId === actorId && existing.targetKind === "final" && existing.targetId === rawExportId &&
      existing.targetHash === asset.sha256 && existing.decision === command.decision &&
      existing.checklist.length === command.checklist.length && existing.checklist.every((item, index) => {
        const requested = command.checklist[index];
        return !!requested && item.id === requested.id && item.passed === requested.passed && item.note === requested.note;
      }) && existing.notes === command.notes && existing.advisoryAcknowledgements.length === command.advisoryAcknowledgements.length &&
      existing.advisoryAcknowledgements.every((item, index) => {
        const requested = command.advisoryAcknowledgements[index];
        return !!requested && item.code === requested.code && item.reason === requested.reason;
      });

    // Exact replay is answered before any state gate so replays stay idempotent after approval.
    const existing = options.store.read.getApproval(approvalId);
    if (existing) {
      if (!sameDecision(existing)) fail("STALE_REVISION", "This command key already belongs to a different final review decision.");
      return { approval: existing, exportRecord: options.store.read.getExport(rawExportId)!, created: false };
    }
    if (exportRecord.status !== "ready_for_review") {
      fail("STALE_REVISION", `Export ${rawExportId} is in status ${exportRecord.status}; the human final review runs only from ready_for_review.`);
    }
    const report = exportRecord.qcReportId ? await readReport(rawExportId, exportRecord.qcReportId) : null;
    if (!report) fail("STALE_REVISION", `The QC report for export ${rawExportId} is missing or unreadable; run technical QC again.`);
    if (report.verdict !== "passed") fail("STALE_REVISION", `Technical QC did not pass for export ${rawExportId}; the human final review requires a passed report.`);
    if (report.draftOnly) {
      // A silent draft can NEVER be approved (or rejected into approval): QC_BLOCKED envelope.
      fail("QC_BLOCKED", "This export is a silent draft (draftOnly): it can never be approved or become release-ready. Use the clearly labeled draft download instead.");
    }
    const requiredChecklist = [...FINAL_REVIEW_CHECKLIST_IDS];
    if (command.checklist.length !== requiredChecklist.length || new Set(command.checklist.map((item) => item.id)).size !== command.checklist.length ||
        requiredChecklist.some((id) => !command.checklist.some((item) => item.id === id))) {
      fail("INVALID_INPUT", `The final review checklist must contain exactly the required checks: ${requiredChecklist.join(", ")}.`);
    }
    if (command.decision === "approved") {
      for (const advisory of report.advisories) {
        const acknowledgement = command.advisoryAcknowledgements.find((item) => item.code === advisory.code);
        if (!acknowledgement || !acknowledgement.reason.trim()) {
          fail("INVALID_INPUT", `Advisory ${advisory.code} requires an explicit acknowledgement with a nonempty reason before approval.`);
        }
      }
      if (command.checklist.some((item) => !item.passed)) fail("INVALID_INPUT", "An approval cannot include failed required checklist items.");
      if (command.expectedOutputSha256 !== asset.sha256) {
        fail("STALE_REVISION", `The reviewed checksum ${command.expectedOutputSha256} does not match the current output asset sha256 ${asset.sha256}; the output was re-encoded and needs a new technical QC and review.`);
      }
    } else if (!command.notes.trim() && !command.checklist.some((item) => !item.passed && item.note.trim())) {
      fail("INVALID_INPUT", "A rejected final review requires notes or a failed checklist reason.");
    }
    const priorFinals = options.store.read.listApprovals("final", rawExportId);
    const latestAt = priorFinals.reduce((latest, item) => Math.max(latest, item.createdAt), -1);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail("INTERNAL_ERROR", "Final review clock returned an invalid UTC timestamp.");
    if (createdAt <= latestAt) fail("STALE_REVISION", "Final review order has not advanced; retry when the system clock is later.");

    return options.store.transaction((tx) => {
      const prior = tx.getApproval(approvalId);
      if (prior) {
        if (!sameDecision(prior)) fail("STALE_REVISION", "This command key already belongs to a different final review decision.");
        return { approval: prior, exportRecord: tx.getExport(rawExportId)!, created: false };
      }
      const approval = ApprovalSchema.parse({
        version: 1, id: approvalId, targetKind: "final", targetId: rawExportId, targetHash: asset.sha256,
        decision: command.decision, actorId, createdAt, checklist: command.checklist, notes: command.notes,
        advisoryAcknowledgements: command.advisoryAcknowledgements,
      });
      tx.appendApproval(approval);
      let current = tx.getExport(rawExportId)!;
      if (command.decision === "approved") {
        const updated = { ...current, status: "approved" as const, approvedSha256: asset.sha256, finalApprovalId: approvalId };
        if (!tx.compareAndSetExport(updated, "ready_for_review")) {
          // Throwing rolls the whole transaction (including the approval append) back.
          fail("STALE_REVISION", `Export ${rawExportId} changed during the final review; the approval was rolled back.`);
        }
        current = updated;
      }
      return { approval, exportRecord: current, created: true };
    });
  };

  return { runQc, finalReview, readReport };
}

/* ---------------------------------------------------------------------------
 * Route handler factories (same conventions as the accepted C07/C10/C11 routes).
 * ------------------------------------------------------------------------- */

export interface QcRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  dataDir?: string;
  vault?: QcVault;
  paths?: MediaToolPaths;
  serviceOptions?: { now?: () => number; timeoutMs?: number };
}

interface QcRouteContext { params: Promise<{ id: string }> }

const parseExportId = async (context: QcRouteContext): Promise<string> => {
  const { id } = await context.params;
  if (!IdSchema.safeParse(id).success) fail("INVALID_INPUT", "Invalid export ID");
  return id;
};

const requireProjectScope = (request: Request, owningProjectId: string): void => {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId || !IdSchema.safeParse(projectId).success) {
    fail("INVALID_INPUT", "This download is scoped to the owning project; pass ?projectId=<owning project id>.");
  }
  if (projectId !== owningProjectId) fail("INVALID_INPUT", `This export is owned by project ${owningProjectId}; the given project scope does not match.`);
};

function toResponseBody(bytes: Uint8Array): BodyInit {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Uint8Array.from(bytes);
}

const dispositionName = (sha256: string, prefix: string): string => `attachment; filename="${prefix}export-${sha256.slice(0, 12)}.mp4"`;

async function loadScopedExport(store: ProductionStore, exportId: string, request: Request): Promise<{ exportRecord: ExportRecord; manifest: RenderManifest }> {
  const exportRecord = store.read.getExport(exportId);
  if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${exportId} not found`);
  const manifest = store.read.getManifest(exportRecord.manifestId);
  if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${exportId} is missing.`);
  requireProjectScope(request, manifest.projectId);
  return { exportRecord, manifest };
}

const buildService = (store: ProductionStore, routeOptions: QcRouteHandlerOptions, dataDir: string, vault: QcVault) =>
  createQcService({ store, vault, dataDir, paths: routeOptions.paths ?? resolveMediaTools(), ...routeOptions.serviceOptions });

/**
 * Export detail + QC action handlers: GET returns the export with its manifest summary, the QC
 * report and failure artifacts (each only when present) and the owning project id; POST accepts
 * {kind:"run_qc"} or {kind:"final_review", ...} behind the same-origin guard.
 */
export function createExportItemRouteHandlers(routeOptions: QcRouteHandlerOptions = {}) {
  const withStore: NonNullable<QcRouteHandlerOptions["withStore"]> = routeOptions.withStore ?? (work => withProductionStore(store => work(store)));
  return {
    async GET(request: Request, context: QcRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const exportId = await parseExportId(context);
        const dataDir = routeOptions.dataDir ?? resolveProductionDataDir();
        const vault = routeOptions.vault ?? new (await import("../../media/production/vault")).LocalMediaVault({ root: join(dataDir, "media") });
        const detail = await withStore(async (store) => {
          const service = buildService(store, routeOptions, dataDir, vault);
          const exportRecord = store.read.getExport(exportId);
          if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${exportId} not found`);
          const manifest = store.read.getManifest(exportRecord.manifestId);
          if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${exportRecord.manifestId} pinned by export ${exportId} is missing.`);
          requireProjectScope(request, manifest.projectId);
          const qcReport = exportRecord.qcReportId ? await service.readReport(exportId, exportRecord.qcReportId) : null;
          let failure: ExportDetailResponse["failure"] = null;
          try {
            const parsed = FailureRecordSchema.safeParse(JSON.parse(await readFile(join(dataDir, "exports", exportId, "failure.json"), "utf8")));
            if (parsed.success) failure = parsed.data;
          } catch { /* absent artifact stays null */ }
          return ExportDetailResponseSchema.parse({
            export: exportRecord,
            manifestSummary: {
              profile: manifest.profile, shotCount: manifest.shots.length,
              audioCueCount: manifest.audioCues.length, inputsHash: manifest.inputsHash,
            },
            qcReport: qcReport ?? null, failure, owningProjectId: manifest.projectId,
          });
        });
        return Response.json(detail, { status: 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
    async POST(request: Request, context: QcRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const exportId = await parseExportId(context);
        const command = await readProductionJson(request, ExportActionCommandSchema);
        const dataDir = routeOptions.dataDir ?? resolveProductionDataDir();
        const vault = routeOptions.vault ?? new (await import("../../media/production/vault")).LocalMediaVault({ root: join(dataDir, "media") });
        const result = await withStore(async (store) => {
          const service = buildService(store, routeOptions, dataDir, vault);
          if (command.kind === "run_qc") return { kind: "run_qc" as const, value: await service.runQc(exportId) };
          const { kind: _kind, ...reviewCommand } = command;
          return { kind: "final_review" as const, value: await service.finalReview(exportId, reviewCommand) };
        });
        if (result.kind === "run_qc") {
          return Response.json({ exportRecord: result.value.exportRecord, report: result.value.report }, { status: 200, headers: { "cache-control": "no-store" } });
        }
        return Response.json(
          { approval: result.value.approval, exportRecord: result.value.exportRecord, created: result.value.created },
          { status: result.value.created ? 201 : 200, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}

/** Final download: 200 only for approved exports whose checksum still matches; 428 otherwise. */
export function createExportDownloadRouteHandlers(routeOptions: QcRouteHandlerOptions = {}) {
  const withStore: NonNullable<QcRouteHandlerOptions["withStore"]> = routeOptions.withStore ?? (work => withProductionStore(store => work(store)));
  const dataDir = routeOptions.dataDir ?? resolveProductionDataDir();
  return {
    async GET(request: Request, context: QcRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const exportId = await parseExportId(context);
        const vault = routeOptions.vault ?? new (await import("../../media/production/vault")).LocalMediaVault({ root: join(dataDir, "media") });
        const asset = await withStore(async (store) => {
          const { exportRecord } = await loadScopedExport(store, exportId, request);
          if (exportRecord.status !== "approved") {
            fail("APPROVAL_REQUIRED", `Final download is blocked while the export is in status ${exportRecord.status}: technical QC plus the human G09 final review and approval of the exact output checksum are required. Technical QC alone never unlocks the final download.`);
          }
          const record = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
          if (!record) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${exportId} is missing from local records.`);
          if (exportRecord.approvedSha256 !== record.sha256) {
            fail("STALE_REVISION", `The approved checksum ${String(exportRecord.approvedSha256)} no longer matches the current output asset sha256 ${record.sha256}; the output was re-encoded and requires a new technical QC, review, and approval.`);
          }
          return record;
        });
        let bytes: Uint8Array;
        try { bytes = await vault.readVerified(asset.vaultRef, asset.sha256); }
        catch { fail("MEDIA_UNAVAILABLE", "The approved export bytes could not be checksum verified in the local vault."); }
        return new Response(toResponseBody(bytes), {
          status: 200,
          headers: {
            "content-type": asset.mime,
            "content-length": String(bytes.byteLength),
            "content-disposition": dispositionName(asset.sha256, ""),
            etag: `"${asset.sha256}"`,
            "cache-control": "no-store",
            "x-perabyte-final": "1",
          },
        });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}

/** Draft download: clearly labeled draft/QC-failed bytes; never serves an approved export. */
export function createExportDraftRouteHandlers(routeOptions: QcRouteHandlerOptions = {}) {
  const withStore: NonNullable<QcRouteHandlerOptions["withStore"]> = routeOptions.withStore ?? (work => withProductionStore(store => work(store)));
  const dataDir = routeOptions.dataDir ?? resolveProductionDataDir();
  return {
    async GET(request: Request, context: QcRouteContext): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const exportId = await parseExportId(context);
        const vault = routeOptions.vault ?? new (await import("../../media/production/vault")).LocalMediaVault({ root: join(dataDir, "media") });
        const target = await withStore(async (store) => {
          const { exportRecord } = await loadScopedExport(store, exportId, request);
          if (exportRecord.status === "approved") {
            fail("STALE_REVISION", "This export is approved; its final download lives at GET /api/production/exports/<id>/download?projectId=... — the draft route never serves approved exports.");
          }
          if (exportRecord.status === "failed" || exportRecord.status === "canceled") {
            let failureSummary: Record<string, string> | undefined;
            try {
              const parsed = FailureRecordSchema.parse(JSON.parse(await readFile(join(dataDir, "exports", exportId, "failure.json"), "utf8")));
              failureSummary = { failureCode: parsed.code, stage: parsed.stage, redactedStderr: parsed.redactedStderr };
            } catch { /* no failure artifact recorded */ }
            fail("STALE_REVISION", `This export has no rendered artifact (status ${exportRecord.status}); inspect the recorded failure and retry the export. A draft download never exists for it.`, failureSummary);
          }
          if (exportRecord.status === "queued" || exportRecord.status === "rendering") {
            fail("STALE_REVISION", `This export is still ${exportRecord.status}; no draft artifact exists yet.`);
          }
          const asset = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
          if (!asset) fail("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${exportId} is missing from local records.`);
          return { asset, status: exportRecord.status };
        });
        let bytes: Uint8Array;
        try { bytes = await vault.readVerified(target.asset.vaultRef, target.asset.sha256); }
        catch { fail("MEDIA_UNAVAILABLE", "The draft export bytes could not be checksum verified in the local vault."); }
        const prefix = target.status === "qc_failed" ? "QC-FAILED-" : "DRAFT-";
        return new Response(toResponseBody(bytes), {
          status: 200,
          headers: {
            "content-type": target.asset.mime,
            "content-length": String(bytes.byteLength),
            "content-disposition": dispositionName(target.asset.sha256, prefix),
            etag: `"${target.asset.sha256}"`,
            "cache-control": "no-store",
            "x-perabyte-draft": "1",
          },
        });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}
