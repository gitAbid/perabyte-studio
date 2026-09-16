import type {
  GeneratedArtifact,
  ImageProvider,
  JobPollResult,
  JobProvider,
  ProviderContext,
  ProviderProgress,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelDescriptor,
  TextProvider,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { Logger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { getSogniClient, type SogniProject } from "@/lib/providers/sogni/client";
import { getSogniCatalog } from "@/lib/providers/sogni/catalog";
import { sogniVideoLimits } from "@/lib/providers/sogni/video-limits";
import { SOGNI_TEXT_MODELS, sogniTextComplete } from "@/lib/providers/sogni/sogni.text";
import {
  PROVIDER_ID,
  toImageParams,
  toVideoParams,
} from "@/lib/providers/sogni/request-maps";
import { driveJobToDeadline } from "@/lib/providers/job-drive";

/**
 * Sogni AI adapter. Image, Video, and Text capabilities.
 *
 * Renders are durable provider jobs (Phase B): `submitJob` creates the
 * Sogni project and returns its id as a persistent ref; `pollJob` reports
 * state from the live project getters and settles with artifacts once the
 * completion continuation resolves. After a server restart the continuation
 * is rebuilt from the persisted ref via the SDK's project lookup. The
 * `generateImage/generateVideo` capability methods are thin wrappers that
 * drive submit/poll to a deadline for the legacy request-scoped path.
 */
export const sogniProvider: ImageProvider &
  VideoProvider &
  TextProvider &
  JobProvider = {
  id: PROVIDER_ID,
  label: "Sogni AI",

  isConfigured() {
    return getStudioEnv().sogniApiKey !== null;
  },

  listImageModels: () => getSogniCatalog().images,
  listVideoModels: () =>
    getSogniCatalog().videos.map((model) => ({
      ...model,
      videoLimits: sogniVideoLimits(model.model),
    })),
  listHiddenModels: () =>
    getSogniCatalog().hidden.map((model) => ({
      ...model,
      videoLimits: sogniVideoLimits(model.model),
    })),
  listTextModels: (): TextModelDescriptor[] => SOGNI_TEXT_MODELS,

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await sogniTextComplete(request.userPrompt, {
      signal: request.signal,
      modelId: request.modelId,
      systemPrompt: request.systemPrompt,
    });
    return {
      text,
      model: request.modelId ?? SOGNI_TEXT_MODELS[0].id,
      provider: PROVIDER_ID,
    };
  },

  async generateImage(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    return driveJobToDeadline({
      provider: sogniProvider, providerLabel: sogniProvider.label, request, model, ctx,
      kind: "image", deadlineMs: imageDeadlineMs(),
    });
  },

  async generateVideo(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    return driveJobToDeadline({
      provider: sogniProvider, providerLabel: sogniProvider.label, request, model, ctx,
      kind: "video", deadlineMs: videoDeadlineMs(),
    });
  },

  async submitJob(request, model, ctx) {
    const continuation = await submitProject(request, model, ctx, request.kind);
    const ref = continuation.project.id;
    if (!ref) {
      // Should not happen with the real SDK; keeps the contract total.
      throw new ProviderError("Sogni AI did not return a project id.", {
        retryable: true,
      });
    }
    continuations.set(ref, continuation);
    ctx.logger.debug("sogni project submitted", { ref, kind: request.kind });
    return { ref };
  },

  async pollJob(ref, request, _model, ctx): Promise<JobPollResult> {
    const continuation = continuations.get(ref);
    if (continuation) {
      if (!continuation.settled) {
        const progress = describeProjectProgress(continuation.project);
        return { status: "running", ...(progress ? { progress } : {}) };
      }
      continuations.delete(ref);
      if (continuation.failed) {
        return {
          status: "failed",
          retryable: true,
          message: `Sogni AI could not finish this render: ${describe(continuation.error)}`,
        };
      }
      ctx.logger.info("sogni project completed", { ref });
      return {
        status: "completed",
        artifacts: toArtifacts(
          continuation.urls ?? [],
          request.kind === "video" ? "mp4" : "png",
          request,
          continuation.lastFrameUrl,
        ),
      };
    }

    // No in-memory continuation — this process restarted after the submit.
    // Re-derive state from the provider's server-side project record.
    return pollProjectRemote(ref, request, ctx);
  },

  async cancelJob(ref) {
    const continuation = continuations.get(ref);
    continuations.delete(ref);
    await continuation?.project.cancel?.().catch(() => {});
  },
};

/**
 * Per-project deadlines, derived from the configurable render timeouts
 * (Settings → Render timeouts — default 5 min images / 10 min videos) with
 * the download headroom already subtracted. Functions, not constants: a
 * Settings save applies to the very next render. The durable job engine
 * does not use these — it owns time via staleness and absolute caps.
 */
export function imageDeadlineMs(): number {
  return getStudioEnv().imageRenderDeadlineMs;
}

export function videoDeadlineMs(): number {
  return getStudioEnv().videoRenderDeadlineMs;
}

/* ------------------------------------------------------------------ */
/* Submit                                                              */
/* ------------------------------------------------------------------ */

interface Continuation {
  project: SogniProject;
  /** Exact final frame (Seedance returnLastFrame) captured per job. */
  lastFrameUrl: string | null;
  settled: boolean;
  failed: boolean;
  error?: unknown;
  urls?: string[];
}

const continuations = new Map<string, Continuation>();

async function submitProject(
  request: NormalizedGenerationRequest,
  model: ModelDescriptor,
  ctx: ProviderContext,
  kind: "image" | "video",
): Promise<Continuation> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError(
      "The Sogni AI provider is not configured. Pick another model or set SOGNI_API_KEY.",
      { retryable: false, field: "model" },
    );
  }

  const client = await getSogniClient();
  const log = ctx.logger.child({ provider: PROVIDER_ID, model: model.model });
  const params =
    kind === "image"
      ? toImageParams(model.model, request)
      : toVideoParams(model.model, request);

  const project = await client.projects.create(params);
  log.debug("sogni project created", { count: request.count });

  // Seedance 2.5 (returnLastFrame) exports the exact final frame per job —
  // capture it as soon as any job completes so the story chain can use it.
  // Registered BEFORE waitForCompletion, matching the SDK's event order.
  const continuation: Continuation = {
    project,
    lastFrameUrl: null,
    settled: false,
    failed: false,
  };
  project.on("jobCompleted", (job) => {
    if (job.lastFrameUrl) continuation.lastFrameUrl = job.lastFrameUrl;
  });

  const completion = project.waitForCompletion();
  void completion.then(
    (urls) => {
      continuation.urls = urls;
      continuation.settled = true;
    },
    (error) => {
      continuation.error = error;
      continuation.failed = true;
      continuation.settled = true;
    },
  );
  return continuation;
}

/**
 * Restart re-attach: no continuation exists in this process, so read the
 * project's server-side record. `errored`/`cancelled` map to failed;
 * `completed` maps to the per-job result URLs; everything else is still
 * running (progress detail is best-effort from the raw record).
 */
async function pollProjectRemote(
  ref: string,
  request: NormalizedGenerationRequest,
  ctx: ProviderContext,
): Promise<JobPollResult> {
  const client = await getSogniClient();
  const get = client.projects.get;
  const downloadUrl = client.projects.downloadUrl;
  const mediaDownloadUrl = client.projects.mediaDownloadUrl;
  if (!get || !downloadUrl || !mediaDownloadUrl) {
    return {
      status: "failed",
      retryable: true,
      message:
        "The server restarted while this render was in flight and Sogni's state could not be re-read. Please re-run it.",
    };
  }
  let raw: Awaited<NonNullable<ReturnType<NonNullable<typeof get>>>>;
  try {
    raw = await get.call(client.projects, ref);
  } catch (error) {
    return {
      status: "failed",
      retryable: true,
      message: `The render reference could not be read after the restart: ${describe(error)}`,
    };
  }
  const status = raw.status;
  if (status === "completed") {
    // Finished projects move their jobs into completedWorkerJobs; scan both.
    const jobs = [...(raw.completedWorkerJobs ?? []), ...(raw.workerJobs ?? [])];
    const urls: string[] = [];
    for (const job of jobs) {
      // A filtered job has no media to chase — the SDK withholds likewise.
      if (job.triggeredNSFWFilter === true) continue;
      const imgId = job.imgID ?? job.id;
      if (!imgId) continue;
      try {
        const url =
          request.kind === "video"
            ? await mediaDownloadUrl.call(client.projects, { jobId: ref, id: imgId, type: "complete" })
            : await downloadUrl.call(client.projects, { jobId: ref, imageId: imgId, type: "complete" });
        if (url) urls.push(url);
      } catch (error) {
        ctx.logger.warn("media url mint failed for a recovered job", {
          ref,
          imgId,
          error: describe(error),
        });
      }
    }
    if (!urls.length) {
      return {
        status: "failed",
        retryable: true,
        message:
          "The render finished on Sogni AI while the server was down, but its media could not be retrieved. Please re-run it.",
      };
    }
    ctx.logger.info("sogni project re-attached after restart", { ref, urls: urls.length });
    return {
      status: "completed",
      artifacts: toArtifacts(urls, request.kind === "video" ? "mp4" : "png", request),
    };
  }
  if (status === "errored" || status === "cancelled") {
    return {
      status: "failed",
      retryable: status === "errored",
      message:
        status === "errored"
          ? "Sogni AI could not finish this render (project errored)."
          : "This render was cancelled on Sogni AI.",
    };
  }
  return {
    status: "running",
    progress: {
      stage: "rendering",
      message: "Re-attached after restart — the render is still running on Sogni AI…",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Legacy request-scoped drive (generateImage/generateVideo)           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Progress readout (pure — one project state → one tick)              */
/* ------------------------------------------------------------------ */

/**
 * Maps the project's live getters to one progress tick, or null when the
 * project reached a terminal state (the completion continuation settles
 * the job). Callers dedupe unchanged ticks.
 */
export function describeProjectProgress(
  project: SogniProject,
): ProviderProgress | null {
  let message: string;
  let percent: number | undefined;
  let stage: "submitted" | "rendering" = "submitted";
  const status = project.status;

  if (!status || status === "pending") {
    message = "Sogni AI accepted the render — waiting for authorization…";
  } else if (status === "queued") {
    if (project.queueStatus === "no-workers") {
      message =
        "No free Sogni worker for this model yet — the render starts when one comes online…";
    } else {
      const startIn = minutesUntil(project.estimatedStartAt);
      message =
        startIn !== undefined
          ? `Queued on Sogni AI — expected to start in about ${startIn} min…`
          : project.queuePosition !== undefined
            ? `Queued on Sogni AI — position ${project.queuePosition}…`
            : "Queued on Sogni AI — waiting for a free worker…";
    }
  } else if (status === "processing") {
    stage = "rendering";
    percent = clampPercent(project.progress);
    const etaIn = minutesUntil(project.eta);
    message =
      etaIn !== undefined
        ? `Sogni AI is rendering — ${percent}% · about ${etaIn} min left`
        : `Sogni AI is rendering — ${percent}%`;
  } else {
    return null; // completed/failed/canceled — the continuation settles it.
  }

  return { stage, message, ...(percent !== undefined ? { percent } : {}) };
}

function clampPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function minutesUntil(date: Date | undefined): number | undefined {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.ceil((date.getTime() - Date.now()) / 60_000);
  return minutes > 0 ? minutes : undefined;
}

/** Best-effort reason extraction — Sogni rejections arrive as Error objects,
 * plain objects ({status, message, ...}) and occasionally strings. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message || "unknown provider error";
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "detail", "description", "error", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      // Circular structure — fall through to the generic below.
    }
  }
  return "unknown provider error";
}

function toArtifacts(
  urls: string[],
  ext: string,
  request: NormalizedGenerationRequest,
  companionFrameUrl: string | null = null,
): GeneratedArtifact[] {
  if (!urls.length) {
    throw new ProviderError("The provider returned no media for this prompt.", {
      retryable: true,
    });
  }
  const baseSeed = request.seed ?? randomSeed();
  return urls.map((url, index) => ({
    bytes: null,
    url,
    ext,
    seed: request.count === 1 ? baseSeed : baseSeed + index,
    ...(index === 0 && companionFrameUrl ? { companionFrameUrl } : {}),
  }));
}
