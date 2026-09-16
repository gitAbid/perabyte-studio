import type {
  GeneratedArtifact,
  JobPollResult,
  ProviderContext,
  TextGenerationRequest,
  TextGenerationResult,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import type { AspectKey } from "@/lib/constants";
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { isPlausibleMp4 } from "@/lib/media/mp4";
import { classifyModelId } from "./classify";
import type { DiscoveredModel, ProviderFormat, VideoJobPair } from "./types";
import { httpBytes, httpJson, type FetchImpl } from "../http";

/**
 * OpenAI-compatible wire format. One adapter serves OpenAI, xAI/Grok,
 * OpenRouter, sub2api relays (apikey.fan's family), and local servers with
 * OpenAI shims (Ollama, LM Studio, vLLM).
 *
 * Image is a synchronous b64 call (/images/generations, /images/edits for
 * start frames). Video has no single standard: the create call tries the
 * relay family's /videos/generations first and falls back to OpenAI's Sora
 * /videos shape; both are polled via GET /videos/{id}.
 */

interface OpenAiModelList {
  data?: { id?: string }[];
}

interface OpenAiImageResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
}

interface VideoCreateRelay {
  request_id?: string;
}

interface VideoCreateSora {
  id?: string;
}

interface VideoStatusResponse {
  status?: string;
  video?: { url?: string };
}

/** Aspect presets mapped onto explicit pixel sizes (widely understood). */
const ASPECT_SIZE: Record<AspectKey, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "1:1": "1024x1024",
  "4:5": "896x1120",
  "3:2": "1200x800",
};

/** Appends /v1 when the base URL carries no version segment already. */
export function resolveOpenAiBase(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!/\/v\d+/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function frameToDataUri(image: NonNullable<NormalizedGenerationRequest["startImage"]>): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}

function clampDuration(seconds: number): number {
  return Math.min(15, Math.max(1, Math.round(seconds)));
}

export function createOpenAiFormat(fetchImpl?: FetchImpl): ProviderFormat {
  // Resolved per call so a stubbed global fetch (tests) is always picked up.
  const doFetch: FetchImpl = (...args) => (fetchImpl ?? fetch)(...args);
  async function postJson<T>(
    cfg: CustomProviderEntry,
    path: string,
    body: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number; retries?: number },
  ): Promise<T> {
    return httpJson<T>(
      { baseUrl: resolveOpenAiBase(cfg.baseUrl), apiKey: cfg.apiKey, label: cfg.label },
      { method: "POST", path, body, ...options },
      doFetch,
    );
  }

  async function getJson<T>(
    cfg: CustomProviderEntry,
    path: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    return httpJson<T>(
      { baseUrl: resolveOpenAiBase(cfg.baseUrl), apiKey: cfg.apiKey, label: cfg.label },
      { path, ...options },
      doFetch,
    );
  }

  function imageTarget(cfg: CustomProviderEntry) {
    return { baseUrl: resolveOpenAiBase(cfg.baseUrl), apiKey: cfg.apiKey, label: cfg.label };
  }

  async function downloadVideoBytes(
    cfg: CustomProviderEntry,
    rawUrl: string,
    id: string,
    log: ProviderContext["logger"],
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    const target = imageTarget(cfg);
    const url = new URL(rawUrl, `${resolveOpenAiBase(cfg.baseUrl)}/`).toString();
    let bytes = await httpBytes(target, url, { signal }, doFetch);
    if (bytes && !isPlausibleMp4(bytes)) {
      // Object storage can serve a placeholder right after "done" — one
      // propagation retry before failing loudly.
      log.debug("custom video download failed validation — retrying once", { id });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      bytes = await httpBytes(target, url, { signal }, doFetch);
    }
    if (!bytes) {
      log.warn("custom provider video download failed", { id });
    }
    return bytes;
  }

  const format: ProviderFormat = {
    id: "openai",
    label: "OpenAI-compatible",
    capabilities: { image: true, video: true, text: true },

    async listModels(cfg) {
      const list = await getJson<OpenAiModelList>(cfg, "/models", { timeoutMs: 20_000 });
      return (list.data ?? [])
        .filter((item): item is { id: string } => typeof item.id === "string" && item.id.length > 0)
        .map((item) => ({ model: item.id, kind: classifyModelId(item.id) }));
    },

    async generateImage(cfg, request, model, ctx) {
      const prompt = request.negativePrompt.trim()
        ? `${request.prompt}. Avoid: ${request.negativePrompt.trim()}.`
        : request.prompt;
      const count = Math.min(10, Math.max(1, request.count));
      const timeoutMs = getStudioEnv().imageRenderTimeoutMs;
      const callOptions = { signal: ctx.signal, timeoutMs, retries: 1 };

      const generationsPayload = {
        model: model.model,
        prompt,
        n: count,
        size: ASPECT_SIZE[request.aspect] ?? ASPECT_SIZE["1:1"],
        response_format: "b64_json",
      };
      const generationsFallback = {
        model: model.model,
        prompt,
        n: count,
        response_format: "b64_json",
      };

      let data: OpenAiImageResponse;
      let frameDropped = false;
      if (request.startImage) {
        try {
          data = await postJson<OpenAiImageResponse>(
            cfg,
            "/images/edits",
            {
              model: model.model,
              prompt,
              n: count,
              response_format: "b64_json",
              image: { url: frameToDataUri(request.startImage) },
            },
            callOptions,
          );
        } catch (error) {
          if (error instanceof ProviderError && error.status === 400) {
            ctx.logger.warn("custom provider rejected the start frame — retrying prompt-only");
            frameDropped = true;
            data = await postJsonWithFallback(cfg, generationsPayload, generationsFallback, callOptions);
          } else {
            throw error;
          }
        }
      } else {
        data = await postJsonWithFallback(cfg, generationsPayload, generationsFallback, callOptions);
      }

      const items = (data.data ?? []).filter(
        (item) => item.b64_json || item.url,
      );
      if (!items.length) {
        throw new ProviderError(`The ${cfg.label} provider returned no images for this prompt.`, {
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

      async function postJsonWithFallback(
        c: CustomProviderEntry,
        primary: Record<string, unknown>,
        fallback: Record<string, unknown>,
        options: { signal?: AbortSignal; timeoutMs?: number; retries?: number },
      ): Promise<OpenAiImageResponse> {
        try {
          return await postJson<OpenAiImageResponse>(c, "/images/generations", primary, options);
        } catch (error) {
          // Not every OpenAI-shaped gateway accepts `size` — degrade to the
          // plain prompt rather than failing the scene.
          if (error instanceof ProviderError && error.status === 400) {
            ctx.logger.warn("custom provider rejected image payload fields — retrying plain");
            return postJson<OpenAiImageResponse>(c, "/images/generations", fallback, options);
          }
          throw error;
        }
      }
    },

    videoJobs(cfg): VideoJobPair {
      async function createJob(
        request: NormalizedGenerationRequest,
        model: ModelDescriptor,
        ctx: ProviderContext,
      ): Promise<{ id: string; frameDropped: boolean }> {
        const prompt = request.negativePrompt.trim()
          ? `${request.prompt}. Avoid: ${request.negativePrompt.trim()}.`
          : request.prompt;
        const duration = clampDuration(request.durationSeconds || 5);
        const base = { model: model.model, prompt };
        try {
          const created = await postJson<VideoCreateRelay>(
            cfg,
            "/videos/generations",
            {
              ...base,
              duration,
              ...(request.startImage
                ? { image: { url: frameToDataUri(request.startImage) } }
                : {}),
            },
            { signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
          );
          if (!created.request_id) {
            throw new ProviderError(`The ${cfg.label} provider did not return a video job id.`, {
              retryable: true,
            });
          }
          return { id: created.request_id, frameDropped: false };
        } catch (error) {
          const status = error instanceof ProviderError ? error.status : undefined;
          if (status !== 404) throw error;
          // Sora-style fallback: POST /videos with JSON (no frame input in
          // this shape — a requested start frame degrades, flagged).
          const created = await postJson<VideoCreateSora>(
            cfg,
            "/videos",
            { ...base, seconds: String(duration) },
            { signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
          );
          if (!created.id) {
            throw new ProviderError(`The ${cfg.label} provider did not return a video job id.`, {
              retryable: true,
            });
          }
          return { id: created.id, frameDropped: Boolean(request.startImage) };
        }
      }

      return {
        async submit(request, model, ctx) {
          // One relay job per requested variation, created sequentially —
          // parallel creates would double-bill on retry.
          const parts: string[] = [];
          for (let index = 0; index < request.count; index += 1) {
            const job = await createJob(request, model, ctx);
            parts.push(job.frameDropped ? `${job.id}~f` : job.id);
          }
          return { ref: parts.join(",") };
        },

        async poll(ref, request, _model, ctx): Promise<JobPollResult> {
          const parts = ref.split(",").filter(Boolean).map((part) => ({
            id: part.replace(/~f$/, ""),
            frameDropped: part.endsWith("~f"),
          }));

          const targets: { url: string }[] = [];
          for (const { id } of parts) {
            let status: VideoStatusResponse;
            try {
              status = await getJson<VideoStatusResponse>(cfg, `/videos/${encodeURIComponent(id)}`, {
                signal: ctx.signal,
                timeoutMs: 20_000,
              });
            } catch (error) {
              ctx.logger.debug("custom provider poll hiccup", {
                id,
                message: (error as Error)?.message,
              });
              return { status: "running", progress: { stage: "rendering", message: `${cfg.label} is rendering your video…` } };
            }
            const state = status.status;
            if (state === "failed" || state === "expired") {
              return {
                status: "failed",
                retryable: state === "expired",
                message: state === "expired"
                  ? "The video job expired before completing. Try again."
                  : `The ${cfg.label} provider could not generate this video. Try rephrasing the prompt.`,
              };
            }
            if (state !== "done" && state !== "completed") {
              return { status: "running", progress: { stage: "rendering", message: `${cfg.label} is rendering your video…` } };
            }
            // Sora has no body URL — its content endpoint hangs off the
            // resolved base (string concat, NOT URL-resolve: a relative
            // reference would drop the base's /v1 segment).
            const rawUrl =
              status.video?.url ??
              `${resolveOpenAiBase(cfg.baseUrl)}/videos/${encodeURIComponent(id)}/content`;
            targets.push({
              url: new URL(rawUrl, `${resolveOpenAiBase(cfg.baseUrl)}/`).toString(),
            });
          }

          ctx.onProgress?.({
            stage: "downloading",
            message: parts.length === 1 ? "Downloading your video…" : "Downloading your videos…",
          });
          const baseSeed = request.seed ?? randomSeed();
          const artifacts: GeneratedArtifact[] = [];
          for (let index = 0; index < targets.length; index += 1) {
            const bytes = await downloadVideoBytes(
              cfg,
              targets[index].url,
              parts[index].id,
              ctx.logger,
              ctx.signal,
            );
            if (!bytes || !isPlausibleMp4(bytes)) {
              throw new ProviderError(
                `The ${cfg.label} provider finished the video but the file could not be retrieved. Please retry.`,
                { retryable: true, status: 502 },
              );
            }
            artifacts.push({
              bytes,
              url: null,
              ext: "mp4",
              seed: request.count === 1 ? baseSeed : baseSeed + index,
              ...(parts[index].frameDropped ? { frameDropped: true } : {}),
            });
          }
          return { status: "completed", artifacts };
        },
      };
    },

    async generateText(cfg, request: TextGenerationRequest): Promise<TextGenerationResult> {
      let model = request.modelId ?? "";
      const sep = model.indexOf(":");
      if (sep > 0) model = model.slice(sep + 1);
      if (!model) {
        throw new ProviderError("No text model was selected for this provider.", {
          retryable: false,
          field: "model",
        });
      }
      const messages: { role: string; content: string }[] = [];
      if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
      messages.push({ role: "user", content: request.userPrompt });
      const reply = await postJson<{ choices?: { message?: { content?: string } }[] }>(
        cfg,
        "/chat/completions",
        {
          model,
          messages,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        { signal: request.signal, timeoutMs: 25_000, retries: 1 },
      );
      const text = reply.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new ProviderError(`The ${cfg.label} text model returned an empty reply.`, {
          retryable: true,
        });
      }
      return { text, model, provider: cfg.id };
    },
  };
  return format;
}
