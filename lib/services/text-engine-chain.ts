import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import {
  sogniTextComplete,
  SOGNI_TEXT_MODELS,
  DEFAULT_SOGNI_TEXT_MODEL,
} from "@/lib/providers/sogni/sogni.text";
import {
  pollinationsTextComplete,
  POLLINATIONS_TEXT_MODELS,
} from "@/lib/providers/pollinations/pollinations.text";
import { customTextComplete } from "@/lib/providers/custom/custom.text";

/**
 * The text-engine chain shared by every AI-writing task (prompt enhancement,
 * story writer): the configured task model first — when its owning provider is
 * enabled and the model isn't disabled — then the free built-ins (Sogni, then
 * Pollinations), then each enabled custom provider's first text model.
 * Extracted from enhancement.service so both callers share one order; the
 * custom-provider branches came in with the custom-providers feature.
 */
export interface TextEngineEntry {
  providerId: string;
  modelId?: string;
  complete: (
    instruction: string,
    options?: {
      signal?: AbortSignal;
      modelId?: string;
      maxTokens?: number;
      systemPrompt?: string;
    },
  ) => Promise<string>;
}

/** The enabled custom provider + text model owning `modelId`, if any. */
function customEngineFor(
  config: ReturnType<typeof getProviderConfig>,
  modelId: string,
): TextEngineEntry | null {
  const sep = modelId.indexOf(":");
  if (sep <= 0) return null;
  const providerId = modelId.slice(0, sep);
  const rawModel = modelId.slice(sep + 1);
  const entry = config.customProviders.find(
    (e) =>
      e.id === providerId &&
      e.enabled &&
      e.models.some((m) => m.kind === "text" && m.enabled && m.model === rawModel),
  );
  if (!entry) return null;
  return {
    providerId: entry.id,
    modelId,
    complete: (instruction, options) =>
      customTextComplete(entry.id, instruction, {
        signal: options?.signal,
        modelId: options?.modelId ?? modelId,
        ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      }),
  };
}

/** First enabled text engine of each enabled custom provider, in list order. */
function customFallbackEngines(
  config: ReturnType<typeof getProviderConfig>,
): TextEngineEntry[] {
  const engines: TextEngineEntry[] = [];
  for (const entry of config.customProviders) {
    if (!entry.enabled) continue;
    const model = entry.models.find((m) => m.kind === "text" && m.enabled);
    if (!model) continue;
    const modelId = `${entry.id}:${model.model}`;
    engines.push({
      providerId: entry.id,
      modelId,
      complete: (instruction, options) =>
        customTextComplete(entry.id, instruction, {
          signal: options?.signal,
          modelId,
          ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        }),
    });
  }
  return engines;
}

function sogniUncensoredModelId(modelId: string): string {
  const meta = SOGNI_TEXT_MODELS.find((model) => model.id === modelId);
  if (meta?.uncensored) return modelId;
  return `sogni:${DEFAULT_SOGNI_TEXT_MODEL}`;
}

export function resolveTextEngines(
  taskModel: string | null,
  options: { preferUncensored?: boolean } = {},
): TextEngineEntry[] {
  const config = getProviderConfig();
  const selectedModel = taskModel;
  const preferUncensored = options.preferUncensored === true;

  const sogniEnabled =
    config.providers.sogni?.enabled !== false &&
    !config.providers.sogni?.disabledModels?.includes(selectedModel ?? "");
  const pollinationsEnabled =
    config.providers.pollinations?.enabled !== false &&
    !config.providers.pollinations?.disabledModels?.includes(selectedModel ?? "");

  const sogniModels = SOGNI_TEXT_MODELS.map((m) => m.id);
  const pollinationsModels = POLLINATIONS_TEXT_MODELS.map((m) => m.id);

  const engines: TextEngineEntry[] = [];

  if (selectedModel) {
    const customSelected = preferUncensored ? null : customEngineFor(config, selectedModel);
    if (customSelected) {
      engines.push(customSelected);
    } else if (sogniModels.includes(selectedModel) && sogniEnabled) {
      engines.push({
        providerId: "sogni",
        modelId: preferUncensored ? sogniUncensoredModelId(selectedModel) : selectedModel,
        complete: sogniTextComplete,
      });
    } else if (
      !preferUncensored &&
      pollinationsModels.includes(selectedModel) &&
      pollinationsEnabled
    ) {
      engines.push({
        providerId: "pollinations",
        modelId: selectedModel,
        complete: pollinationsTextComplete,
      });
    }
  }

  // Fallback chain in priority order (excluding the already-selected engine):
  // the free built-ins first, then the user's keyed custom providers.
  // Uncensored Mode stays on Sogni's abliterated default — aligned engines
  // (Pollinations, custom Grok) rewrite adult prompts toward SFW.
  if (config.providers.sogni?.enabled !== false && !engines.some((e) => e.providerId === "sogni")) {
    engines.push({
      providerId: "sogni",
      complete: sogniTextComplete,
    });
  }
  if (
    !preferUncensored &&
    config.providers.pollinations?.enabled !== false &&
    !engines.some((e) => e.providerId === "pollinations")
  ) {
    engines.push({
      providerId: "pollinations",
      complete: pollinationsTextComplete,
    });
  }
  if (!preferUncensored) {
    for (const engine of customFallbackEngines(config)) {
      if (!engines.some((e) => e.providerId === engine.providerId)) {
        engines.push(engine);
      }
    }
  }

  return engines;
}
