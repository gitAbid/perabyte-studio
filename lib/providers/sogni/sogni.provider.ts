import type {
  GeneratedArtifact,
  ImageProvider,
  ProviderContext,
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
import {
  markRenderFailed,
  markRenderRecovered,
  materializeToMediaCache,
  recordDetachedRender,
} from "@/lib/providers/detached-renders";

/**
 * Sogni AI adapter. Image, Video, and Text capabilities.
 */
export const sogniProvider: ImageProvider & VideoProvider & TextProvider = {
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
    const { urls, lastFrameUrl } = await createProject(request, model, ctx, imageDeadlineMs(), "image");
    return toArtifacts(urls, "png", request, lastFrameUrl);
  },

  async generateVideo(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    const { urls, lastFrameUrl } = await createProject(request, model, ctx, videoDeadlineMs(), "video");
    return toArtifacts(urls, "mp4", request, lastFrameUrl);
  },
};

/**
 * Per-project deadlines, derived from the configurable render timeouts
 * (Settings → Render timeouts — default 5 min images / 10 min videos) with
 * the download headroom already subtracted. Functions, not constants: a
 * Settings save applies to the very next render.
 */
export function imageDeadlineMs(): number {
  return getStudioEnv().imageRenderDeadlineMs;
}

export function videoDeadlineMs(): number {
  return getStudioEnv().videoRenderDeadlineMs;
}

async function createProject(
  request: NormalizedGenerationRequest,
  model: ModelDescriptor,
  ctx: ProviderContext,
  deadlineMs: number,
  kind: "image" | "video",
): Promise<{ urls: string[]; lastFrameUrl: string | null }> {
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

  const started = Date.now();
  const project = await client.projects.create(params);
  // Seedance 2.5 (returnLastFrame) exports the exact final frame per job —
  // capture it as soon as any job completes so the story chain can use it.
  let lastFrameUrl: string | null = null;
  project.on("jobCompleted", (job) => {
    if (job.lastFrameUrl) lastFrameUrl = job.lastFrameUrl;
  });
  log.debug("sogni project created", { count: request.count });

  // Live readout keeps the studio in sync with Sogni even when the SDK's
  // progress events go silent during long renders.
  const stopReadout = startProgressReadout(project, ctx);

  const completion = project.waitForCompletion();
  // When the deadline wins the race below, the losing continuation must not
  // surface as an unhandled rejection — the detached registry owns it then.
  completion.catch(() => {});

  try {
    const urls = await raceCompletion(project, completion, {
      deadlineMs,
      signal: ctx.signal,
      onDeadline: () =>
        detachSogniCompletion(project, completion, { request, model, ctx, kind, log, started }),
    });
    log.info("sogni project completed", { elapsedMs: Date.now() - started, urls: urls.length });
    return { urls, lastFrameUrl };
  } catch (error) {
    if (error instanceof RenderCutOff) {
      throw new ProviderError(
        "Sogni AI needs more time — the render is still running on their side, so we detached it. It will be attached automatically when it finishes; you can also raise the limit in Settings → Render timeouts.",
        { retryable: true, status: 504 },
      );
    }
    if (error instanceof ProviderError) throw error;
    // Caller cancellation propagates untouched so the route can unwind —
    // but stop the project server-side (best effort) so Sogni doesn't keep
    // rendering (and billing) for a wait nobody is listening to.
    if (ctx.signal?.aborted || (error as Error)?.name === "AbortError") {
      void project.cancel?.().catch(() => {});
      throw error;
    }
    throw new ProviderError(
      `Sogni AI could not finish this render: ${describe(error)}`,
      { retryable: true, status: 502 },
    );
  } finally {
    stopReadout();
  }
}

/** Sent when our deadline wins the race — the caller has already detached the
 * still-running render by the time this rejection propagates. */
class RenderCutOff extends Error {
  constructor() {
    super("render deadline hit");
    this.name = "RenderCutOff";
  }
}

async function raceCompletion(
  project: SogniProject,
  completion: Promise<string[]>,
  options: { deadlineMs: number; signal?: AbortSignal; onDeadline: () => void },
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      options.onDeadline();
      reject(new RenderCutOff());
    }, options.deadlineMs);

    const onAbort = () => {
      cleanup();
      reject(options.signal?.reason ?? new Error("aborted"));
    };

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Keeps waiting for a render that outlived its request: registers it in the
 * pending-renders registry, then downloads the finished media into our cache
 * when Sogni eventually finishes (results stay downloadable for ~24h). The
 * studio UI polls the registry and attaches the recovered render.
 */
function detachSogniCompletion(
  project: SogniProject,
  completion: Promise<string[]>,
  meta: {
    request: NormalizedGenerationRequest;
    model: ModelDescriptor;
    ctx: ProviderContext;
    kind: "image" | "video";
    log: Logger;
    started: number;
  },
): void {
  const record = recordDetachedRender({
    provider: PROVIDER_ID,
    kind: meta.kind,
    modelId: meta.model.id,
    prompt: meta.request.prompt,
    clientTag: meta.ctx.clientTag,
  });
  meta.log.warn("render deadline hit — detaching the still-running sogni project", {
    projectId: project.id,
    pendingId: record.id,
    elapsedMs: Date.now() - meta.started,
  });
  void completion
    .then(async (urls) => {
      const url = urls[0];
      if (!url) {
        markRenderFailed(record.id, "provider returned no media");
        return;
      }
      const media = await materializeToMediaCache(url, meta.kind === "video" ? "mp4" : "png");
      markRenderRecovered(record.id, media);
      meta.log.info("detached sogni render recovered", {
        pendingId: record.id,
        url: media.url,
      });
    })
    .catch((error) => {
      markRenderFailed(record.id, describe(error));
      meta.log.warn("detached sogni render failed", {
        pendingId: record.id,
        error: describe(error),
      });
    });
}

const READOUT_INTERVAL_MS = 2_000;

/**
 * Polls the project's live getters every 2s and emits a progress tick only
 * when the visible state changes — the SDK dedupes/suppresses events during
 * long silent stretches, which left the studio progress frozen out of sync
 * with the real render.
 */
function startProgressReadout(project: SogniProject, ctx: ProviderContext): () => void {
  let lastMessage = "";
  let lastPercent: number | undefined;

  const tick = () => {
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
      return; // completed/failed/canceled — the completion promise settles it.
    }

    if (message === lastMessage && percent === lastPercent) return;
    lastMessage = message;
    lastPercent = percent;
    ctx.onProgress?.({ stage, message, percent });
  };

  tick();
  const interval = setInterval(tick, READOUT_INTERVAL_MS);
  return () => clearInterval(interval);
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
