import { isTextProvider, type TextProvider } from "../../providers/types";
import { listTextEngineOptions, resolveTextEngines } from "../text-engine-chain";

/**
 * Views the app's shared text-engine chain (Enhance/Writer order) as the
 * TextProvider the proposal planner and the Auto Draft story stage consume.
 * No new provider plumbing — this is the exact adapter the F1 proposals route
 * introduced, extracted so multiple routes share one implementation.
 *
 * No chain engine publishes a context window today, so the adapter declares a
 * conservative bound per model. The production planner compares raw UTF-8
 * bytes against this token count (byte >= token), so the bound errs on the
 * safe side and over-long plans fail visibly with model_limit instead of
 * silently truncating at the provider.
 */
export const CHAIN_CONTEXT_TOKENS = 16_384;

export function resolveChainTextProvider(providerId: string): TextProvider | null {
  const engines = resolveTextEngines(null).filter((engine) => engine.providerId === providerId);
  if (engines.length === 0) return null;
  const models = listTextEngineOptions()
    .filter((option) => option.providerId === providerId)
    .map((option) => ({ id: option.modelId, label: option.label, provider: option.providerId, contextTokens: CHAIN_CONTEXT_TOKENS }));
  if (models.length === 0) return null;
  const provider: TextProvider = {
    id: providerId,
    label: providerId,
    isConfigured: () => true,
    listTextModels: () => models,
    async generateText({ systemPrompt, userPrompt, modelId, maxTokens }) {
      const engine = (modelId ? engines.find((entry) => entry.modelId === modelId) : undefined) ?? engines[0]!;
      // Engine completion options carry no temperature; the planner's
      // determinism request degrades to the engine's default sampling.
      const text = await engine.complete(userPrompt, {
        ...(modelId ? { modelId } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      return { text, model: modelId ?? engine.modelId ?? `${providerId}:default`, provider: providerId };
    },
  };
  return isTextProvider(provider) ? provider : null;
}

/** First enabled chain provider, in the app's normal engine order. */
export function resolveFirstChainTextProvider(): TextProvider | null {
  for (const option of listTextEngineOptions()) {
    const provider = resolveChainTextProvider(option.providerId);
    if (provider) return provider;
  }
  return null;
}
