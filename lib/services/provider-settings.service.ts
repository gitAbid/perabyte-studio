import { getStudioEnv, invalidateStudioEnv } from "@/lib/config/env";
import type { ModelDescriptor } from "@/lib/domain/models";
import { getRegisteredProviders } from "@/lib/providers/registry";
import { isTextProvider } from "@/lib/providers/types";
import {
  PROVIDER_IDS,
  getProviderConfig,
  mergeProviderConfigPatch,
  updateProviderConfig,
  type ProviderConfigPatch,
  type ProviderId,
} from "@/lib/repositories/provider-config.repository";

/**
 * Provider settings orchestration (Facade): assembles the full provider
 * inventory for the /settings page (never exposing raw keys) and validates +
 * applies updates. Validation lives here rather than in the repository so the
 * repository stays a thin, dependency-free persistence layer.
 */

export interface ProviderModelView {
  id: string;
  kind: "image" | "video";
  label: string;
  hint?: string;
  enabled: boolean;
  frameInput?: ModelDescriptor["frameInput"];
}

export interface ProviderTextModelView {
  id: string;
  label: string;
  enabled: boolean;
}

export interface ProviderView {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /** Whether this provider takes an API key at all (Pollinations is keyless). */
  keySupported: boolean;
  keySource: "settings" | "env" | null;
  keyMasked: string | null;
  models: ProviderModelView[];
  textModels: ProviderTextModelView[];
}

export interface ProviderSettingsPayload {
  providers: ProviderView[];
  tasks: { enhance: string | null };
  /** Overall render deadlines in seconds (Settings → Render timeouts). */
  renderTimeouts: { image: number; video: number; staleness: number };
}

export interface ProviderSettingsUpdate {
  providers?: Record<
    string,
    { enabled?: boolean; apiKey?: string | null; disabledModels?: string[] }
  >;
  tasks?: { enhance?: string | null };
  renderTimeouts?: { image?: number; video?: number; staleness?: number };
}

export class ProviderSettingsError extends Error {
  readonly status = 400;
  readonly field?: string;

  constructor(message: string, options?: { field?: string }) {
    super(message);
    this.name = "ProviderSettingsError";
    this.field = options?.field;
  }
}

const KEY_ENV_FIELD: Partial<Record<ProviderId, "apiKeyFanApiKey" | "sogniApiKey">> = {
  "apikey-fan": "apiKeyFanApiKey",
  sogni: "sogniApiKey",
};

function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

function keyView(
  id: ProviderId,
): Pick<ProviderView, "keySupported" | "keySource" | "keyMasked"> {
  const envField = KEY_ENV_FIELD[id];
  const stored = getProviderConfig().providers[id]?.apiKey;
  if (stored) return { keySupported: true, keySource: "settings", keyMasked: maskKey(stored) };
  const envKey = envField ? getStudioEnv()[envField] : null;
  if (envKey) return { keySupported: true, keySource: "env", keyMasked: maskKey(envKey) };
  return { keySupported: envField !== undefined, keySource: null, keyMasked: null };
}

type RegisteredProvider = ReturnType<typeof getRegisteredProviders>[number];

/** Picker models plus hidden models a picker can surface (frame-capable). */
function listableModels(provider: RegisteredProvider): ModelDescriptor[] {
  const visible = [
    ...provider.listImageModels(),
    ...(provider.listVideoModels?.() ?? []),
  ];
  const hidden = provider.listHiddenModels?.() ?? [];
  return [...visible, ...hidden.filter((model) => model.frameInput)];
}

export function getProviderSettings(): ProviderSettingsPayload {
  const config = getProviderConfig();
  const providers: ProviderView[] = [];
  for (const id of PROVIDER_IDS) {
    const provider = getRegisteredProviders().find((p) => p.id === id);
    if (!provider) continue;
    const entry = config.providers[id];
    const disabled = entry?.disabledModels ?? [];
    const models: ProviderModelView[] = listableModels(provider).map((model) => ({
      id: model.id,
      kind: model.kind === "video" ? "video" : "image",
      label: model.label,
      hint: model.hint,
      enabled: !disabled.includes(model.id),
      frameInput: model.frameInput,
    }));
    const textModels: ProviderTextModelView[] = isTextProvider(provider)
      ? provider.listTextModels().map((model) => ({
          id: model.id,
          label: model.label,
          enabled: !disabled.includes(model.id),
        }))
      : [];
    providers.push({
      id,
      label: provider.label,
      enabled: entry?.enabled ?? true,
      ...keyView(id),
      models,
      textModels,
    });
  }
  return {
    providers,
    tasks: { enhance: config.tasks.enhance },
    renderTimeouts: {
      image: config.renderTimeouts.image,
      video: config.renderTimeouts.video,
      staleness: config.renderTimeouts.staleness,
    },
  };
}

function knownModelIds(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const provider of getRegisteredProviders()) {
    const generation = listableModels(provider).map((model) => model.id);
    const text = isTextProvider(provider)
      ? provider.listTextModels().map((model) => model.id)
      : [];
    map.set(provider.id, new Set([...generation, ...text]));
  }
  return map;
}

function allTextModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const provider of getRegisteredProviders()) {
    if (isTextProvider(provider)) {
      provider.listTextModels().forEach((model) => ids.add(model.id));
    }
  }
  return ids;
}

export function applyProviderSettingsUpdate(body: unknown): ProviderSettingsPayload {
  if (typeof body !== "object" || body === null) {
    throw new ProviderSettingsError("Invalid settings payload.");
  }
  const raw = body as ProviderSettingsUpdate;
  const patch: ProviderConfigPatch = {};
  const knownModels = knownModelIds();

  if (raw.providers !== undefined) {
    if (typeof raw.providers !== "object" || raw.providers === null) {
      throw new ProviderSettingsError("Invalid providers payload.", { field: "providers" });
    }
    const providerPatch: NonNullable<ProviderConfigPatch["providers"]> = {};
    for (const [id, change] of Object.entries(raw.providers)) {
      if (!PROVIDER_IDS.includes(id as ProviderId)) {
        throw new ProviderSettingsError(`Unknown provider "${id}".`, { field: "providers" });
      }
      if (typeof change !== "object" || change === null) {
        throw new ProviderSettingsError(`Invalid update for "${id}".`, { field: "providers" });
      }
      const entry: {
        enabled?: boolean;
        apiKey?: string | null;
        disabledModels?: string[];
      } = {};
      if (change.enabled !== undefined) {
        if (typeof change.enabled !== "boolean") {
          throw new ProviderSettingsError("Enabled must be true or false.", {
            field: "providers",
          });
        }
        entry.enabled = change.enabled;
      }
      if (change.apiKey !== undefined) {
        if (change.apiKey !== null && typeof change.apiKey !== "string") {
          throw new ProviderSettingsError("The API key must be text.", { field: "providers" });
        }
        entry.apiKey = change.apiKey === "" ? null : change.apiKey;
      }
      if (change.disabledModels !== undefined) {
        if (!Array.isArray(change.disabledModels)) {
          throw new ProviderSettingsError("Invalid model list.", { field: "providers" });
        }
        const known = knownModels.get(id) ?? new Set<string>();
        for (const modelId of change.disabledModels) {
          if (!known.has(modelId)) {
            throw new ProviderSettingsError(`Unknown model "${modelId}".`, {
              field: "providers",
            });
          }
        }
        entry.disabledModels = change.disabledModels.filter(
          (m) => typeof m === "string",
        );
      }
      providerPatch[id as ProviderId] = entry;
    }
    patch.providers = providerPatch;
  }

  if (raw.tasks !== undefined) {
    if (typeof raw.tasks !== "object" || raw.tasks === null) {
      throw new ProviderSettingsError("Invalid tasks payload.", { field: "tasks" });
    }
    if (raw.tasks.enhance !== undefined) {
      const enhance = raw.tasks.enhance;
      if (enhance !== null && typeof enhance !== "string") {
        throw new ProviderSettingsError("Invalid enhancement model.", { field: "tasks" });
      }
      if (typeof enhance === "string" && !allTextModelIds().has(enhance)) {
        throw new ProviderSettingsError(`Unknown enhancement model "${enhance}".`, {
          field: "tasks",
        });
      }
      patch.tasks = { enhance };
    }
  }

  if (raw.renderTimeouts !== undefined) {
    if (typeof raw.renderTimeouts !== "object" || raw.renderTimeouts === null) {
      throw new ProviderSettingsError("Invalid render timeouts payload.", {
        field: "renderTimeouts",
      });
    }
    const timeoutPatch: NonNullable<ProviderConfigPatch["renderTimeouts"]> = {};
    for (const kind of ["image", "video"] as const) {
      const value = raw.renderTimeouts[kind];
      if (value === undefined) continue;
      // The UI sends minutes as decimals; seconds arrive pre-multiplied.
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ProviderSettingsError(
          `The ${kind} render timeout must be a positive number of seconds.`,
          { field: "renderTimeouts" },
        );
      }
      // Out-of-range values clamp to the sane band instead of failing the save.
      timeoutPatch[kind] = Math.round(value);
    }
    patch.renderTimeouts = timeoutPatch;
  }

  // The last enabled provider is load-bearing: renders need at least one.
  const preview = mergeProviderConfigPatch(patch);
  const enabledCount = PROVIDER_IDS.filter((id) => preview.providers[id].enabled).length;
  if (enabledCount === 0) {
    throw new ProviderSettingsError("Keep at least one provider enabled.", {
      field: "providers",
    });
  }

  updateProviderConfig(patch);
  invalidateStudioEnv();
  return getProviderSettings();
}
