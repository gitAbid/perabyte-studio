import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { sogniTextComplete, SOGNI_TEXT_MODELS } from "@/lib/providers/sogni/sogni.text";
import {
  pollinationsTextComplete,
  POLLINATIONS_TEXT_MODELS,
} from "@/lib/providers/pollinations/pollinations.text";

/**
 * The text-engine chain shared by every AI-writing task (prompt enhancement,
 * story writer): the configured task model first — when its owning provider is
 * enabled and the model isn't disabled — then Sogni, then Pollinations.
 * Extracted verbatim from enhancement.service so both callers share one order.
 */
export interface TextEngineEntry {
  providerId: "sogni" | "pollinations";
  modelId?: string;
  complete: (
    instruction: string,
    options?: { signal?: AbortSignal; modelId?: string },
  ) => Promise<string>;
}

export function resolveTextEngines(taskModel: string | null): TextEngineEntry[] {
  const config = getProviderConfig();
  const selectedModel = taskModel;

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
    if (sogniModels.includes(selectedModel) && sogniEnabled) {
      engines.push({
        providerId: "sogni",
        modelId: selectedModel,
        complete: sogniTextComplete,
      });
    } else if (pollinationsModels.includes(selectedModel) && pollinationsEnabled) {
      engines.push({
        providerId: "pollinations",
        modelId: selectedModel,
        complete: pollinationsTextComplete,
      });
    }
  }

  if (config.providers.sogni?.enabled !== false && !engines.some((e) => e.providerId === "sogni")) {
    engines.push({
      providerId: "sogni",
      complete: sogniTextComplete,
    });
  }
  if (
    config.providers.pollinations?.enabled !== false &&
    !engines.some((e) => e.providerId === "pollinations")
  ) {
    engines.push({
      providerId: "pollinations",
      complete: pollinationsTextComplete,
    });
  }

  return engines;
}
