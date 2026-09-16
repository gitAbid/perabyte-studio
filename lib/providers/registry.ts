import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import { apiKeyFanProvider } from "@/lib/providers/apikey-fan/apikey-fan.provider";
import { sogniProvider } from "@/lib/providers/sogni/sogni.provider";
import { pollinationsProvider } from "@/lib/providers/pollinations/pollinations.provider";
import { getProviderConfig, getConfigRevision } from "@/lib/repositories/provider-config.repository";
import { createCustomProvider } from "@/lib/providers/custom/custom-provider.factory";

/**
 * Gate interface for runtime provider/model enablement.
 * If omitted, all providers and models are enabled.
 */
export interface ProviderGate {
  isEnabled(providerId: string): boolean;
  isModelEnabled(providerId: string, modelId: string): boolean;
}

const defaultAllowGate: ProviderGate = {
  isEnabled: () => true,
  isModelEnabled: () => true,
};

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
  /** Picker models plus hidden capability models, configured providers only. */
  listAllModels(kind: ModelKind): ModelDescriptor[];
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

function hiddenModelsOf(provider: AnyProvider): ModelDescriptor[] {
  return provider.listHiddenModels?.() ?? [];
}

export function createRegistry(
  providers: AnyProvider[],
  gate: ProviderGate = defaultAllowGate,
): ProviderRegistry {
  return {
    listModels(kind) {
      return providers
        .filter((provider) => provider.isConfigured() && gate.isEnabled(provider.id))
        .flatMap((provider) =>
          modelsOf(provider, kind).filter((model) => gate.isModelEnabled(provider.id, model.id)),
        );
    },

    /** Picker models plus hidden capability models (i2v siblings, flf2v). */
    listAllModels(kind) {
      return providers
        .filter((provider) => provider.isConfigured() && gate.isEnabled(provider.id))
        .flatMap((provider) =>
          [...modelsOf(provider, kind), ...hiddenModelsOf(provider)].filter((model) =>
            gate.isModelEnabled(provider.id, model.id),
          ),
        );
    },

    defaultModel(kind) {
      const models = this.listModels(kind);
      const fallback = models.find((model) => model.tier === "recommended") ?? models[0];
      if (!fallback) {
        throw new ProviderError("No render provider is available.", { retryable: false });
      }
      return fallback;
    },

    resolve(modelId) {
      const found = this.findAnywhere(modelId);
      if (
        found &&
        found.provider.isConfigured() &&
        gate.isEnabled(found.provider.id) &&
        gate.isModelEnabled(found.provider.id, found.model.id)
      ) {
        return { provider: found.provider, model: found.model };
      }
      return null;
    },

    findAnywhere(modelId) {
      for (const provider of providers) {
        const model = [
          ...modelsOf(provider, "image"),
          ...modelsOf(provider, "video"),
          ...hiddenModelsOf(provider),
        ].find((candidate) => candidate.id === modelId);
        if (model) return { provider, model };
      }
      return null;
    },
  };
}

let registry: ProviderRegistry | null = null;

let registeredProviders: AnyProvider[] = [
  apiKeyFanProvider,
  sogniProvider,
  pollinationsProvider,
];

/** The app's provider adapters in priority order (keyed first, fallback last). */
export function getRegisteredProviders(): AnyProvider[] {
  return registeredProviders;
}

/**
 * Full adapter list for the registry: keyed built-ins, then the custom
 * providers from config (rebuilt when the config revision moves — a Settings
 * save applies instantly), then the keyless Pollinations fallback.
 */
function buildProviderList(): AnyProvider[] {
  const keyed = registeredProviders.filter((p) => p.id !== "pollinations");
  const fallback = registeredProviders.filter((p) => p.id === "pollinations");
  const customs = getProviderConfig().customProviders.map((entry) =>
    createCustomProvider(entry),
  );
  return [...keyed, ...customs, ...fallback];
}

let registryRevision = -1;

export function getGenerationRegistry(): ProviderRegistry {
  const dynamicGate: ProviderGate = {
    isEnabled: (providerId) => {
      const config = getProviderConfig();
      const p = config.providers[providerId as keyof typeof config.providers];
      return p ? p.enabled : true;
    },
    isModelEnabled: (providerId, modelId) => {
      const config = getProviderConfig();
      const p = config.providers[providerId as keyof typeof config.providers];
      return p ? !p.disabledModels.includes(modelId) : true;
    },
  };
  const revision = getConfigRevision();
  if (!registry || registryRevision !== revision) {
    registryRevision = revision;
    registry = createRegistry(buildProviderList(), dynamicGate);
  }
  return registry;
}

/** Test hook: swap the app registry. Marked current so the revision check
 * does not immediately rebuild over the injected fake. */
export function setRegistryForTests(fake: ProviderRegistry | null): void {
  registry = fake;
  registryRevision = fake ? getConfigRevision() : -1;
}

/** Test hook: swap the provider list and drop the cached registry. */
export function setProvidersForTests(list: AnyProvider[] | null): void {
  registeredProviders = list ?? [
    apiKeyFanProvider,
    sogniProvider,
    pollinationsProvider,
  ];
  registry = null;
  registryRevision = -1;
}
