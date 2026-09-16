import type {
  TextGenerationRequest,
  TextGenerationResult,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import type { DiscoveredModel, ProviderFormat } from "./types";
import { httpJson, type FetchImpl } from "../http";

/**
 * Anthropic Messages API wire format. Text only — Anthropic exposes no
 * image or video generation surface.
 */

interface AnthropicModelList {
  data?: { id?: string; display_name?: string }[];
}

interface AnthropicMessageResponse {
  content?: { type?: string; text?: string }[];
}

const ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicFormat(fetchImpl?: FetchImpl): ProviderFormat {
  // Resolved per call so a stubbed global fetch (tests) is always picked up.
  const doFetch: FetchImpl = (...args) => (fetchImpl ?? fetch)(...args);
  function target(cfg: CustomProviderEntry) {
    return {
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      apiKey: null,
      label: cfg.label,
    };
  }

  function headers(cfg: CustomProviderEntry): Record<string, string> {
    return {
      ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  return {
    id: "anthropic",
    label: "Anthropic",
    capabilities: { image: false, video: false, text: true },

    async listModels(cfg) {
      const list = await httpJson<AnthropicModelList>(
        target(cfg),
        { path: "/v1/models", headers: headers(cfg), timeoutMs: 20_000 },
        doFetch,
      );
      return (list.data ?? [])
        .filter((model): model is { id: string; display_name?: string } =>
          typeof model.id === "string" && model.id.length > 0)
        .map((model) => {
          const discovered: DiscoveredModel = { model: model.id, kind: "text" };
          if (model.display_name) discovered.label = model.display_name;
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
      const reply = await httpJson<AnthropicMessageResponse>(
        target(cfg),
        {
          method: "POST",
          path: "/v1/messages",
          headers: headers(cfg),
          body: {
            model,
            max_tokens: request.maxTokens ?? 1024,
            ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
            messages: [{ role: "user", content: request.userPrompt }],
          },
          signal: request.signal,
          timeoutMs: 25_000,
          retries: 1,
        },
        doFetch,
      );
      const text = (reply.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        throw new ProviderError(`The ${cfg.label} text model returned an empty reply.`, {
          retryable: true,
        });
      }
      return { text, model, provider: cfg.id };
    },
  };
}
