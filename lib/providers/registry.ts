import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import { apiKeyFanProvider } from "@/lib/providers/apikey-fan/apikey-fan.provider";
import { pollinationsProvider } from "@/lib/providers/pollinations/pollinations.provider";

/**
 * Provider registry (Factory). `createRegistry` accepts any provider list —
 * tests inject fakes; the app uses `getGenerationRegistry()`, which wires the
 * real adapters in priority order (keyed providers first, fallback last).
 */
export interface ResolvedModel {
  provider: ImageProvider | VideoProvider;
  model: ModelDescriptor;
}

export interface ProviderRegistry {
  /** Configured models for a kind, in default-preference order. */
  listModels(kind: ModelKind): ModelDescriptor[];
  /** The model selected when the user has not chosen one. */
  defaultModel(kind: ModelKind): ModelDescriptor;
  /** Look up a model id across *configured* providers. */
  resolve(modelId: string): ResolvedModel | null;
  /** Look up a model id across all providers, configured or not — used to
   * tell "unknown model" apart from "provider not configured". */
  findAnywhere(modelId: string): { provider: AnyProvider; model: ModelDescriptor } | null;
}

type AnyProvider = ImageProvider & Partial<VideoProvider>;

function modelsOf(provider: AnyProvider, kind: ModelKind): ModelDescriptor[] {
  return kind === "image"
    ? (provider as ImageProvider).listImageModels()
    : (provider as VideoProvider).listVideoModels?.() ?? [];
}

export function createRegistry(providers: AnyProvider[]): ProviderRegistry {
  return {
    listModels(kind) {
      return providers
        .filter((provider) => provider.isConfigured())
        .flatMap((provider) => modelsOf(provider, kind));
    },

    defaultModel(kind) {
      const models = this.listModels(kind);
      const fallback = models[0];
      if (!fallback) {
        throw new ProviderError("No render provider is available.", { retryable: false });
      }
      return fallback;
    },

    resolve(modelId) {
      const found = this.findAnywhere(modelId);
      if (found && found.provider.isConfigured()) {
        return { provider: found.provider, model: found.model };
      }
      return null;
    },

    findAnywhere(modelId) {
      for (const provider of providers) {
        const model = [...modelsOf(provider, "image"), ...modelsOf(provider, "video")].find(
          (candidate) => candidate.id === modelId,
        );
        if (model) return { provider, model };
      }
      return null;
    },
  };
}

let registry: ProviderRegistry | null = null;

export function getGenerationRegistry(): ProviderRegistry {
  registry ??= createRegistry([apiKeyFanProvider, pollinationsProvider]);
  return registry;
}

/** Test hook: swap the app registry. */
export function setRegistryForTests(fake: ProviderRegistry | null): void {
  registry = fake;
}
