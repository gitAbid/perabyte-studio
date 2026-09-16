import type {
  ImageProvider,
  GeneratedArtifact,
  JobPollResult,
  JobProvider,
  ProviderContext,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { Logger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { isPlausibleMp4 } from "@/lib/media/mp4";
import { getMediaRepository } from "@/lib/repositories/media.repository";
import { createApiKeyFanClient } from "@/lib/providers/apikey-fan/client";
import { driveJobToDeadline } from "@/lib/providers/job-drive";
import {
  APIKEY_FAN_IMAGE_MODELS,
  APIKEY_FAN_VIDEO_MODELS,
  foldNegativePrompt,
  MAX_VIDEO_SECONDS,
  PROVIDER_ID,
  toImageEditsPayload,
  toImagePayload,
  toVideoPayload,
} from "@/lib/providers/apikey-fan/request-maps";

/**
 * apikey.fan (Grok) adapter. Image generation is a synchronous b64 call;
 * video is job-based: create → poll `request_id` → download the mp4.
 *
 * One object implements both capability interfaces because the relay exposes
 * both under a single credential; the registry still treats them as two
 * independent capabilities.
 */
export const apiKeyFanProvider: ImageProvider & VideoProvider & JobProvider = {
  id: PROVIDER_ID,
  label: "apikey.fan",

  isConfigured() {
    return getStudioEnv().apiKeyFanApiKey !== null;
  },

  listImageModels: () => APIKEY_FAN_IMAGE_MODELS,
  // Grok video takes only prompt + duration (no aspect/resolution params),
  // so ratio and resolution lists stay empty — the UI hides those pickers.
  listVideoModels: () =>
    APIKEY_FAN_VIDEO_MODELS.map((model) => ({
      ...model,
      videoLimits: {
        duration: { min: 1, max: MAX_VIDEO_SECONDS },
        ratios: [],
        resolutions: [],
      },
    })),

  /* ------------------------------- Image ------------------------------- */

  async generateImage(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    const env = getStudioEnv();
    const apiKey = env.apiKeyFanApiKey;
    if (!apiKey) {
      throw new ProviderError(
        "The apikey.fan provider is not configured. Set APIKEY_FAN_API_KEY or pick the free demo model.",
        { retryable: false, field: "model" },
      );
    }
    const client = createApiKeyFanClient({ baseUrl: env.apiKeyFanBaseUrl, apiKey });

    const prompt = foldNegativePrompt(request.prompt, request.negativePrompt);
    // Image generation is one synchronous b64 call — its HTTP budget is the
    // configured image render timeout (Settings → Render timeouts).
    const imageCallOptions = {
      logger: ctx.logger,
      signal: ctx.signal,
      timeoutMs: env.imageRenderTimeoutMs,
    };
    const generatePlain = async (): Promise<ImageResponse> => {
      const { payload, fallbackPayload } = toImagePayload(model.model, {
        prompt,
        count: request.count,
        aspect: request.aspect,
        resolution: request.resolution,
      });
      try {
        return await client.postJson<ImageResponse>("/images/generations", payload, imageCallOptions);
      } catch (error) {
        // The exact aspect-ratio field name is the one part of the relay's API
        // we could not verify without a key. If the strict payload is rejected
        // as malformed, retry once without image_config — the prompt still
        // carries the full composition.
        if (error instanceof ProviderError && error.status === 400) {
          ctx.logger.warn("image_config rejected — retrying without it", { model: model.model });
          return client.postJson<ImageResponse>("/images/generations", fallbackPayload, imageCallOptions);
        }
        throw error;
      }
    };

    let data: ImageResponse;
    let frameDropped = false;
    if (request.startImage) {
      // Img2img: Grok takes source images only on /images/edits (data URI or
      // public URL in image.url). A relay that refuses the flow degrades to a
      // plain prompt render rather than failing the scene.
      try {
        data = await client.postJson<ImageResponse>(
          "/images/edits",
          toImageEditsPayload(model.model, {
            prompt,
            image: request.startImage,
            count: request.count,
          }),
          imageCallOptions,
        );
      } catch (error) {
        if (error instanceof ProviderError && error.status === 400) {
          ctx.logger.warn("images/edits rejected the frame — retrying prompt-only");
          frameDropped = true;
          data = await generatePlain();
        } else {
          throw error;
        }
      }
    } else {
      data = await generatePlain();
    }

    const items = data.data ?? [];
    if (!items.length) {
      throw new ProviderError("The provider returned no images for this prompt.", {
        retryable: true,
      });
    }

    const baseSeed = request.seed ?? randomSeed();
    return items.map((item, index) => ({
      bytes: item.b64_json ? Buffer.from(item.b64_json, "base64") : null,
      url: item.url ?? null,
      ext: "png",
      seed: baseSeed + index,
      revisedPrompt: item.revised_prompt,
      ...(frameDropped ? { frameDropped: true } : {}),
    }));
  },

  /* ------------------------------- Video ------------------------------- */

  async generateVideo(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]> {
    return driveJobToDeadline({
      provider: apiKeyFanProvider,
      providerLabel: apiKeyFanProvider.label,
      request,
      model,
      ctx,
      kind: "video",
      deadlineMs: getStudioEnv().videoRenderDeadlineMs,
    });
  },

  async submitJob(request, model, ctx) {
    const env = getStudioEnv();
    const apiKey = env.apiKeyFanApiKey;
    if (!apiKey) {
      throw new ProviderError(
        "The apikey.fan provider is not configured. Set APIKEY_FAN_API_KEY or pick the free demo model.",
        { retryable: false, field: "model" },
      );
    }
    if (request.kind === "video") {
      // One relay job per requested variation, created sequentially (parallel
      // creates would double-bill on retry). The ref carries all of them plus
      // a per-job `~f` suffix when the relay made us drop the start frame —
      // stateless, so the flag survives restarts.
      const parts: string[] = [];
      for (let index = 0; index < request.count; index += 1) {
        const job = await createVideoJob(request, model, ctx, apiKey);
        parts.push(job.frameDropped ? `${job.requestId}~f` : job.requestId);
      }
      const ref = parts.join(",");
      ctx.logger.debug("relay video jobs submitted", { ref, count: request.count });
      return { ref };
    }
    // Images are one synchronous b64 call — they complete "at submit". The
    // artifacts park in memory for the executor's first poll; a restart
    // loses the parking spot, which the recover pass reports as retryable.
    const artifacts = await this.generateImage(request, model, ctx);
    const ref = `grokimg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    parkedImages.set(ref, artifacts);
    return { ref };
  },

  async pollJob(ref, request, _model, ctx): Promise<JobPollResult> {
    if (ref.startsWith(IMAGE_REF_PREFIX)) {
      const parked = parkedImages.get(ref);
      if (!parked) {
        return {
          status: "failed",
          retryable: true,
          message:
            "The server restarted while this render was in flight and the relay result could not be retrieved. Please re-run it.",
        };
      }
      parkedImages.delete(ref);
      return { status: "completed", artifacts: parked };
    }

    const env = getStudioEnv();
    const apiKey = env.apiKeyFanApiKey;
    if (!apiKey) {
      return {
        status: "failed",
        retryable: false,
        message: "The apikey.fan provider lost its API key while this render was in flight.",
      };
    }
    const client = createApiKeyFanClient({ baseUrl: env.apiKeyFanBaseUrl, apiKey });
    const parts = ref.split(",").filter(Boolean).map((part) => ({
      id: part.replace(/~f$/, ""),
      frameDropped: part.endsWith("~f"),
    }));

    const urls: (string | null)[] = [];
    for (const { id } of parts) {
      let status: VideoStatusResponse;
      try {
        status = await client.getJson<VideoStatusResponse>(
          `/videos/${encodeURIComponent(id)}`,
          { logger: ctx.logger, signal: ctx.signal, timeoutMs: 20_000 },
        );
      } catch (error) {
        // Transient relay hiccup — keep polling rather than failing the job.
        ctx.logger.debug("relay poll hiccup", { id, error: describeError(error) });
        return {
          status: "running",
          progress: { stage: "rendering", message: "The relay is rendering your video…" },
        };
      }
      if (status.status === "failed" || status.status === "expired") {
        return {
          status: "failed",
          retryable: status.status === "expired",
          message:
            status.status === "expired"
              ? "The video job expired before completing. Try again."
              : "The provider could not generate this video. Try rephrasing the prompt.",
        };
      }
      if (status.status !== "done" || !status.video?.url) {
        return {
          status: "running",
          progress: { stage: "rendering", message: "The relay is rendering your video…" },
        };
      }
      urls.push(new URL(status.video.url, env.apiKeyFanBaseUrl).toString());
    }

    // Only download once EVERY variation has finished — relay content urls
    // stay valid, so re-polling a finished job never re-downloads early.
    ctx.onProgress?.({
      stage: "downloading",
      message: parts.length === 1 ? "Downloading your video…" : "Downloading your videos…",
    });
    const artifacts: GeneratedArtifact[] = [];
    for (let index = 0; index < urls.length; index += 1) {
      const artifact = await downloadVideo(
        urls[index] as string, env.apiKeyFanBaseUrl, request, index, apiKey, ctx.logger, ctx.signal,
      );
      artifacts.push(parts[index]?.frameDropped ? { ...artifact, frameDropped: true } : artifact);
    }
    ctx.logger.info("relay video jobs completed", { ref, count: artifacts.length });
    return { status: "completed", artifacts };
  },
};

/** Parked completed image jobs, keyed by synthetic `grokimg_` refs. */
const IMAGE_REF_PREFIX = "grokimg_";
const parkedImages = new Map<string, GeneratedArtifact[]>();

/** Creates one relay video job; the id plus whether the frame was dropped. */
async function createVideoJob(
  request: NormalizedGenerationRequest,
  model: ModelDescriptor,
  ctx: ProviderContext,
  apiKey: string,
): Promise<{ requestId: string; frameDropped: boolean }> {
  const env = getStudioEnv();
  const client = createApiKeyFanClient({ baseUrl: env.apiKeyFanBaseUrl, apiKey });
  const log = ctx.logger.child({ provider: PROVIDER_ID, model: model.model });
  const prompt = foldNegativePrompt(request.prompt, request.negativePrompt);
  const buildPayload = (withImage: boolean) =>
    toVideoPayload(model.model, {
      prompt,
      durationSeconds: request.durationSeconds,
      ...(withImage && request.startImage ? { image: request.startImage } : {}),
    });
  try {
    const created = await client.postJson<VideoCreateResponse>("/videos/generations", buildPayload(true), {
      logger: log,
      signal: ctx.signal,
      timeoutMs: 90_000,
      retries: 1,
    });
    if (!created.request_id) {
      throw new ProviderError("The provider did not return a video job id.", { retryable: true });
    }
    return { requestId: created.request_id, frameDropped: false };
  } catch (error) {
    if (request.startImage && error instanceof ProviderError && error.status === 400) {
      // The relay may not forward Grok's image field (unverified) —
      // degrade to a prompt-only clip instead of failing the scene.
      log.warn("video create rejected the image field — retrying prompt-only");
      const created = await client.postJson<VideoCreateResponse>(
        "/videos/generations",
        buildPayload(false),
        { logger: log, signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
      );
      if (!created.request_id) {
        throw new ProviderError("The provider did not return a video job id.", { retryable: true });
      }
      return { requestId: created.request_id, frameDropped: true };
    }
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Response shapes (subset of the fields we consume)                    */
/* ------------------------------------------------------------------ */

interface ImageResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
}

interface VideoCreateResponse {
  request_id?: string;
}

interface VideoStatusResponse {
  status?: string;
  video?: { url?: string };
}

/**
 * Content endpoint quirks (both verified against the live relay):
 * - `video.url` can be a path relative to the relay base (`/v1/videos/<id>/content`),
 *   so it must be resolved before fetching — a relative path handed to the
 *   browser would resolve against our own origin and 404.
 * - The endpoint requires the Bearer key; an unauthenticated fetch 401s, and a
 *   raw URL is therefore useless to the client — download here or not at all.
 * - A job can report "done" while object storage still serves a placeholder,
 *   so bytes are validated and re-fetched once before failing loudly.
 */
const PROPAGATION_RETRY_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function downloadVideo(
  rawUrl: string,
  baseUrl: string,
  request: NormalizedGenerationRequest,
  index: number,
  apiKey: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<GeneratedArtifact> {
  const baseSeed = request.seed ?? randomSeed();
  const seed = request.count === 1 ? baseSeed : baseSeed + index;
  // A relative path resolves against the relay base; an absolute URL is kept.
  const url = new URL(rawUrl, baseUrl).toString();

  let bytes = await fetchVideoBytes(url, apiKey, signal);
  if (bytes && !isPlausibleMp4(bytes)) {
    log.warn("downloaded video failed validation — re-fetching once", {
      size: bytes.length,
    });
    await sleep(PROPAGATION_RETRY_MS, signal);
    bytes = await fetchVideoBytes(url, apiKey, signal);
  }

  if (!bytes || !isPlausibleMp4(bytes)) {
    // The client can never fetch this auth-gated URL itself, so there is no
    // useful degraded mode: fail loudly so the UI offers a retry.
    log.error("video download unusable", { size: bytes?.length ?? 0 });
    throw new ProviderError(
      "The provider finished the video but the file could not be retrieved. Please retry.",
      { retryable: true, status: 502 },
    );
  }

  return { bytes, url: null, ext: "mp4", seed };
}

async function fetchVideoBytes(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}
