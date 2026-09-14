import type {
  ImageProvider,
  GeneratedArtifact,
  ProviderContext,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { Logger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { createApiKeyFanClient } from "@/lib/providers/apikey-fan/client";
import {
  APIKEY_FAN_IMAGE_MODELS,
  APIKEY_FAN_VIDEO_MODELS,
  foldNegativePrompt,
  PROVIDER_ID,
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
export const apiKeyFanProvider: ImageProvider & VideoProvider = {
  id: PROVIDER_ID,
  label: "apikey.fan",

  isConfigured() {
    return getStudioEnv().apiKeyFanApiKey !== null;
  },

  listImageModels: () => APIKEY_FAN_IMAGE_MODELS,
  listVideoModels: () => APIKEY_FAN_VIDEO_MODELS,

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

    const { payload, fallbackPayload } = toImagePayload(model.model, {
      prompt: foldNegativePrompt(request.prompt, request.negativePrompt),
      count: request.count,
      aspect: request.aspect,
      resolution: request.resolution,
    });

    let data: ImageResponse;
    try {
      data = await client.postJson<ImageResponse>("/images/generations", payload, {
        logger: ctx.logger,
        signal: ctx.signal,
      });
    } catch (error) {
      // The exact aspect-ratio field name is the one part of the relay's API
      // we could not verify without a key. If the strict payload is rejected
      // as malformed, retry once without image_config — the prompt still
      // carries the full composition.
      if (error instanceof ProviderError && error.status === 400) {
        ctx.logger.warn("image_config rejected — retrying without it", { model: model.model });
        data = await client.postJson<ImageResponse>("/images/generations", fallbackPayload, {
          logger: ctx.logger,
          signal: ctx.signal,
        });
      } else {
        throw error;
      }
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
    }));
  },

  /* ------------------------------- Video ------------------------------- */

  async generateVideo(
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
    const log = ctx.logger.child({ provider: PROVIDER_ID, model: model.model });

    // One job per requested variation, run sequentially: parallel creates
    // would double-bill on retry and the relay serialises media anyway.
    const artifacts: GeneratedArtifact[] = [];
    for (let index = 0; index < request.count; index += 1) {
      const created = await client.postJson<VideoCreateResponse>(
        "/videos/generations",
        toVideoPayload(model.model, {
          prompt: foldNegativePrompt(request.prompt, request.negativePrompt),
          durationSeconds: request.durationSeconds,
        }),
        { logger: log, signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
      );

      const requestId = created.request_id;
      if (!requestId) {
        throw new ProviderError("The provider did not return a video job id.", {
          retryable: true,
        });
      }

      const done = await pollVideo(client, requestId, log, ctx.signal);
      log.info("video job completed", { requestId, index, total: request.count });

      // Download the mp4 immediately: relay URLs are short-lived.
      artifacts.push(
        await downloadVideo(done.video.url, request, index, log, ctx.signal),
      );
    }
    return artifacts;
  },
};

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

/* ------------------------------------------------------------------ */
/* Job polling                                                         */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 3_000;
/**
 * Per-job poll budget. Must stay inside the route's `maxDuration = 300`:
 * 3 min polling + 1 min download leaves headroom, and video jobs normally
 * finish far sooner.
 */
export const POLL_DEADLINE_MS = 180_000;

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

async function pollVideo(
  client: ReturnType<typeof createApiKeyFanClient>,
  requestId: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<{ video: { url: string } }> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let ticks = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal);
    const status = await client.getJson<VideoStatusResponse>(
      `/videos/${encodeURIComponent(requestId)}`,
      { logger: log, signal, timeoutMs: 20_000 },
    );

    ticks += 1;
    if (ticks % 5 === 0) {
      log.debug("video job still running", { requestId, status: status.status, ticks });
    }

    if (status.status === "done" && status.video?.url) {
      return status as { video: { url: string } };
    }
    if (status.status === "failed" || status.status === "expired") {
      throw new ProviderError(
        status.status === "expired"
          ? "The video job expired before completing. Try again."
          : "The provider could not generate this video. Try rephrasing the prompt.",
        { retryable: status.status === "expired", status: 502 },
      );
    }
  }
  throw new ProviderError("Video generation timed out. Try a shorter duration.", {
    retryable: true,
  });
}

async function downloadVideo(
  url: string,
  request: NormalizedGenerationRequest,
  index: number,
  log: Logger,
  signal?: AbortSignal,
): Promise<GeneratedArtifact> {
  const baseSeed = request.seed ?? randomSeed();
  const seed = request.count === 1 ? baseSeed : baseSeed + index;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, url: null, ext: "mp4", seed };
  } catch (error) {
    // Serving the expiring URL directly is still better than losing the
    // render; log it so the degradation is visible.
    log.warn("video download failed — returning provider url", { error });
    return { bytes: null, url, ext: "mp4", seed };
  }
}
