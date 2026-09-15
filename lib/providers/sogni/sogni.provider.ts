import type {
  GeneratedArtifact,
  ImageProvider,
  ProviderContext,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { getSogniClient } from "@/lib/providers/sogni/client";
import { getSogniCatalog } from "@/lib/providers/sogni/catalog";
import {
  PROVIDER_ID,
  toImageParams,
  toVideoParams,
} from "@/lib/providers/sogni/request-maps";

/**
 * Sogni AI adapter. Both capabilities run through one Supernet project:
 * `projects.create` fans out into provider jobs and `waitForCompletion()`
 * resolves with hosted result URLs (encrypted storage, 24-hour retention).
 * URLs are returned rather than downloaded here — the service layer's
 * `materializeArtifact` step caches non-allowlisted hosts server-side, the
 * same route apikey.fan's object-storage links take.
 */
export const sogniProvider: ImageProvider & VideoProvider = {
  id: PROVIDER_ID,
  label: "Sogni AI",

  isConfigured() {
    return getStudioEnv().sogniApiKey !== null;
  },

  // The live Sogni catalog, stale-while-revalidate (curated set until the
  // first refresh lands) — see catalog.ts.
  listImageModels: () => getSogniCatalog().images,
  listVideoModels: () => getSogniCatalog().videos,
  // i2v siblings + flf2v keyframe models: resolvable, never in the picker.
  listHiddenModels: () => getSogniCatalog().hidden,

  async generateImage(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    const completion = await createProject(request, model, ctx, IMAGE_DEADLINE_MS, "image");
    const urls = await completion;
    return toArtifacts(urls, "png", request);
  },

  async generateVideo(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    const completion = await createProject(request, model, ctx, VIDEO_DEADLINE_MS, "video");
    const urls = await completion;
    return toArtifacts(urls, "mp4", request);
  },
};

/**
 * Per-project deadline. Must leave room inside the route's `maxDuration = 300`
 * for the service layer to download and cache the finished files.
 */
export const IMAGE_DEADLINE_MS = 120_000;
export const VIDEO_DEADLINE_MS = 180_000;

async function createProject(
  request: NormalizedGenerationRequest,
  model: ModelDescriptor,
  ctx: ProviderContext,
  deadlineMs: number,
  kind: "image" | "video",
): Promise<string[]> {
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
  log.debug("sogni project created", { count: request.count });

  let lastPercent = -1;
  project.on("progress", (percent) => {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    if (rounded === lastPercent) return;
    lastPercent = rounded;
    ctx.onProgress?.({
      stage: "rendering",
      message: `Sogni AI is rendering — ${rounded}%`,
      percent: rounded,
    });
  });
  ctx.onProgress?.({
    stage: "submitted",
    message: "Sogni AI accepted the render — waiting for a free GPU…",
  });

  try {
    const urls = await withDeadline(project.waitForCompletion(), deadlineMs, ctx.signal);
    log.info("sogni project completed", { elapsedMs: Date.now() - started, urls: urls.length });
    return urls;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Caller cancellation propagates untouched so the route can unwind.
    if (ctx.signal?.aborted || (error as Error)?.name === "AbortError") throw error;
    throw new ProviderError(
      `Sogni AI could not finish this render: ${describe(error)}`,
      { retryable: true, status: 502 },
    );
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "unknown provider error";
}

/**
 * Races the SDK's completion promise against the route deadline and the
 * caller's abort signal. On abort the rejection propagates untouched so the
 * route can unwind cleanly; on timeout the error is retryable — the project
 * keeps running on Sogni and its results stay downloadable for 24h.
 */
function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new ProviderError("Sogni AI took too long to finish this render. Please retry.", {
          retryable: true,
        }),
      );
    }, deadlineMs);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
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

function toArtifacts(
  urls: string[],
  ext: string,
  request: NormalizedGenerationRequest,
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
  }));
}
