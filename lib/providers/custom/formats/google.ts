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
import { getStudioEnv } from "@/lib/config/env";
import { randomSeed } from "@/lib/renderer";
import { isPlausibleMp4 } from "@/lib/media/mp4";
import type { DiscoveredModel, ProviderFormat, VideoJobPair } from "./types";
import { httpBytes, httpJson, type FetchImpl } from "../http";

/**
 * Google Gemini API wire format (generativelanguage.googleapis.com). Text
 * and image generation ride `:generateContent`; video rides Veo's
 * `:predictLongRunning` operations. Auth is the `x-goog-api-key` header.
 */

interface GoogleModelList {
  models?: {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }[];
}

interface GenerateContentResponse {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }[];
    };
  }[];
}

interface OperationResponse {
  done?: boolean;
  error?: { message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string } }[];
    };
    videos?: { uri?: string; bytesBase64Encoded?: string }[];
  };
}

function googleTarget(cfg: CustomProviderEntry) {
  return {
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    // Google authenticates via its own header, not a Bearer token.
    apiKey: null,
    label: cfg.label,
  };
}

function authHeaders(cfg: CustomProviderEntry): Record<string, string> {
  return cfg.apiKey ? { "x-goog-api-key": cfg.apiKey } : {};
}

function extForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

export function createGoogleFormat(fetchImpl: FetchImpl = fetch): ProviderFormat {
  async function postJson<T>(
    cfg: CustomProviderEntry,
    path: string,
    body: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number; retries?: number },
  ): Promise<T> {
    return httpJson<T>(
      googleTarget(cfg),
      { method: "POST", path, body, headers: authHeaders(cfg), ...options },
      fetchImpl,
    );
  }

  function imageParts(request: NormalizedGenerationRequest): unknown[] {
    const parts: unknown[] = [{ text: request.prompt }];
    if (request.startImage) {
      parts.push({
        inlineData: {
          mimeType: request.startImage.contentType,
          data: request.startImage.bytes.toString("base64"),
        },
      });
    }
    return parts;
  }

  const format: ProviderFormat = {
    id: "google",
    label: "Google Gemini",
    capabilities: { image: true, video: true, text: true },

    async listModels(cfg) {
      const list = await httpJson<GoogleModelList>(
        googleTarget(cfg),
        { path: "/v1beta/models?pageSize=200", headers: authHeaders(cfg), timeoutMs: 20_000 },
        fetchImpl,
      );
      return (list.models ?? [])
        .filter((model) => typeof model.name === "string" && model.name.includes("/"))
        .filter((model) => {
          const methods = model.supportedGenerationMethods ?? [];
          return (
            methods.includes("generateContent") || methods.includes("predictLongRunning")
          );
        })
        .map((model) => {
          const id = model.name!.replace(/^models\//, "");
          const methods = model.supportedGenerationMethods ?? [];
          const kind = methods.includes("predictLongRunning")
            ? "video"
            : /imagen|image|banana/i.test(id)
              ? "image"
              : "text";
          const discovered: DiscoveredModel = { model: id, kind };
          if (model.displayName) discovered.label = model.displayName;
          return discovered;
        });
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
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: request.userPrompt }] }],
        ...(request.systemPrompt
          ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } }
          : {}),
        ...(request.temperature !== undefined || request.maxTokens
          ? {
              generationConfig: {
                ...(request.temperature !== undefined
                  ? { temperature: request.temperature }
                  : {}),
                ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
              },
            }
          : {}),
      };
      const reply = await postJson<GenerateContentResponse>(
        cfg,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        body,
        { signal: request.signal, timeoutMs: 25_000, retries: 1 },
      );
      const text = (reply.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!text) {
        throw new ProviderError(`The ${cfg.label} text model returned an empty reply.`, {
          retryable: true,
        });
      }
      return { text, model, provider: cfg.id };
    },

    async generateImage(cfg, request, _model, ctx) {
      const reply = await postJson<GenerateContentResponse>(
        cfg,
        `/v1beta/models/${encodeURIComponent(_model.model)}:generateContent`,
        {
          contents: [{ parts: imageParts(request) }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        },
        { signal: ctx.signal, timeoutMs: getStudioEnv().imageRenderTimeoutMs, retries: 1 },
      );
      const images = (reply.candidates?.[0]?.content?.parts ?? []).filter(
        (part) => part.inlineData?.data,
      );
      if (!images.length) {
        throw new ProviderError(`The ${cfg.label} provider returned no images for this prompt.`, {
          retryable: true,
        });
      }
      const baseSeed = request.seed ?? randomSeed();
      return images.map((part, index) => ({
        bytes: Buffer.from(part.inlineData!.data!, "base64"),
        url: null,
        ext: extForMimeType(part.inlineData!.mimeType),
        seed: baseSeed + index,
      }));
    },

    videoJobs(cfg): VideoJobPair {
      async function createOperation(
        request: NormalizedGenerationRequest,
        model: ModelDescriptor,
        ctx: ProviderContext,
      ): Promise<string> {
        const instance: Record<string, unknown> = { prompt: request.prompt };
        if (request.startImage) {
          instance.image = {
            bytesBase64Encoded: request.startImage.bytes.toString("base64"),
            mimeType: request.startImage.contentType,
          };
        }
        // Veo only understands 16:9 and 9:16 aspect ratios.
        const aspect =
          request.aspect === "16:9" || request.aspect === "9:16" ? request.aspect : undefined;
        const created = await postJson<{ name?: string }>(
          cfg,
          `/v1beta/models/${encodeURIComponent(model.model)}:predictLongRunning`,
          {
            instances: [instance],
            ...(aspect ? { parameters: { aspectRatio: aspect } } : {}),
          },
          { signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
        );
        if (!created.name) {
          throw new ProviderError(`The ${cfg.label} provider did not return a video job id.`, {
            retryable: true,
          });
        }
        return created.name;
      }

      return {
        async submit(request, model, ctx) {
          const names: string[] = [];
          for (let index = 0; index < request.count; index += 1) {
            names.push(await createOperation(request, model, ctx));
          }
          return { ref: names.join(",") };
        },

        async poll(ref, request, _model, ctx): Promise<JobPollResult> {
          const names = ref.split(",").filter(Boolean);
          const sources: { uri?: string; base64?: string }[] = [];

          for (const name of names) {
            let operation: OperationResponse;
            try {
              operation = await httpJson<OperationResponse>(
                googleTarget(cfg),
                {
                  path: `/v1beta/${name}`,
                  headers: authHeaders(cfg),
                  signal: ctx.signal,
                  timeoutMs: 20_000,
                },
                fetchImpl,
              );
            } catch (error) {
              ctx.logger.debug("custom provider poll hiccup", {
                name,
                message: (error as Error)?.message,
              });
              return {
                status: "running",
                progress: { stage: "rendering", message: `${cfg.label} is rendering your video…` },
              };
            }
            if (!operation.done) {
              return {
                status: "running",
                progress: { stage: "rendering", message: `${cfg.label} is rendering your video…` },
              };
            }
            if (operation.error) {
              return {
                status: "failed",
                retryable: false,
                message: operation.error.message ?? `The ${cfg.label} provider could not generate this video.`,
              };
            }
            for (const sample of operation.response?.generateVideoResponse?.generatedSamples ?? []) {
              if (sample.video?.uri) sources.push({ uri: sample.video.uri });
            }
            for (const video of operation.response?.videos ?? []) {
              if (video.uri) sources.push({ uri: video.uri });
              else if (video.bytesBase64Encoded) sources.push({ base64: video.bytesBase64Encoded });
            }
          }

          if (!sources.length) {
            return {
              status: "running",
              progress: { stage: "rendering", message: `${cfg.label} is rendering your video…` },
            };
          }

          ctx.onProgress?.({
            stage: "downloading",
            message: sources.length === 1 ? "Downloading your video…" : "Downloading your videos…",
          });
          const baseSeed = request.seed ?? randomSeed();
          const artifacts: GeneratedArtifact[] = [];
          for (let index = 0; index < sources.length; index += 1) {
            let bytes: Buffer | null = null;
            if (sources[index].base64) {
              bytes = Buffer.from(sources[index].base64!, "base64");
            } else if (sources[index].uri) {
              bytes = await httpBytes(
                googleTarget(cfg),
                sources[index].uri!,
                { headers: authHeaders(cfg), signal: ctx.signal },
                fetchImpl,
              );
            }
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
            });
          }
          return { status: "completed", artifacts };
        },
      };
    },
  };
  return format;
}
