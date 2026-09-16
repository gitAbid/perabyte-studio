import { getStudioEnv, invalidateStudioEnv } from "@/lib/config/env";
import type { ModelDescriptor } from "@/lib/domain/models";
import { getRegisteredProviders } from "@/lib/providers/registry";
import { isTextProvider } from "@/lib/providers/types";
import {
  CUSTOM_FORMATS,
  PROVIDER_IDS,
  getProviderConfig,
  isValidCustomSlug,
  mergeProviderConfigPatch,
  updateProviderConfig,
  type CustomModelEntry,
  type CustomModelKind,
  type CustomProviderEntry,
  type CustomProviderFormat,
  type CustomProvidersPatch,
  type KnownProviderId,
  type ProviderConfigPatch,
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
  /** Built-in ids or a custom provider's slug. */
  id: string;
  label: string;
  enabled: boolean;
  /** Wire format — set on custom provider views only. */
  format?: CustomProviderFormat;
  /** Whether this provider takes an API key at all (Pollinations is keyless). */
  keySupported: boolean;
  /** True when the provider works without a key (OpenAI-compatible local
   * servers); the status badge shows Active instead of Needs API key. */
  keyOptional?: boolean;
  keySource: "settings" | "env" | null;
  keyMasked: string | null;
  models: ProviderModelView[];
  textModels: ProviderTextModelView[];
}

/** Full-fidelity view of a custom provider for the management UI. */
export interface CustomProviderView {
  id: string;
  label: string;
  format: CustomProviderFormat;
  baseUrl: string;
  enabled: boolean;
  keyMasked: string | null;
  models: CustomModelEntry[];
  lastDiscoveredAt?: string;
}

export interface ProviderSettingsPayload {
  providers: ProviderView[];
  customProviders: CustomProviderView[];
  tasks: { enhance: string | null; writer: string | null };
  /** Overall render deadlines in seconds (Settings → Render timeouts). */
  renderTimeouts: { image: number; video: number; staleness: number };
}

export interface ProviderSettingsUpdate {
  providers?: Record<
    string,
    { enabled?: boolean; apiKey?: string | null; disabledModels?: string[] }
  >;
  customProviders?: CustomProvidersPatch;
  tasks?: { enhance?: string | null; writer?: string | null };
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

const KEY_ENV_FIELD: Partial<Record<KnownProviderId, "apiKeyFanApiKey" | "sogniApiKey">> = {
  "apikey-fan": "apiKeyFanApiKey",
  sogni: "sogniApiKey",
};

function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

function keyView(
  id: KnownProviderId,
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

function customKeyView(entry: CustomProviderEntry): {
  keyMasked: string | null;
  keySource: "settings" | null;
  keyOptional: boolean;
} {
  return {
    keyMasked: entry.apiKey ? maskKey(entry.apiKey) : null,
    keySource: entry.apiKey ? "settings" : null,
    // OpenAI-compatible servers are often keyless (Ollama, LM Studio, vLLM).
    keyOptional: entry.format === "openai",
  };
}

function customProviderView(entry: CustomProviderEntry): ProviderView {
  const textModels: ProviderTextModelView[] = entry.models
    .filter((m) => m.kind === "text")
    .map((m) => ({
      id: `${entry.id}:${m.model}`,
      label: m.label ?? m.model,
      enabled: m.enabled,
    }));
  const models: ProviderModelView[] = entry.models
    .filter((m) => m.kind === "image" || m.kind === "video")
    .map((m) => ({
      id: `${entry.id}:${m.model}`,
      kind: m.kind === "video" ? "video" : "image",
      label: m.label ?? m.model,
      enabled: m.enabled,
      frameInput: { start: true, end: false },
    }));
  return {
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled,
    format: entry.format,
    keySupported: true,
    ...customKeyView(entry),
    models,
    textModels,
  };
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
  const customProviders: CustomProviderView[] = config.customProviders.map((entry) => ({
    id: entry.id,
    label: entry.label,
    format: entry.format,
    baseUrl: entry.baseUrl,
    enabled: entry.enabled,
    ...customKeyView(entry),
    models: entry.models,
    ...(entry.lastDiscoveredAt ? { lastDiscoveredAt: entry.lastDiscoveredAt } : {}),
  }));
  for (const entry of config.customProviders) {
    providers.push(customProviderView(entry));
  }
  return {
    providers,
    customProviders,
    tasks: { enhance: config.tasks.enhance, writer: config.tasks.writer },
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
  for (const entry of getProviderConfig().customProviders) {
    entry.models
      .filter((model) => model.kind === "text")
      .forEach((model) => ids.add(`${entry.id}:${model.model}`));
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* customProviders op validation                                       */
/* ------------------------------------------------------------------ */

function parseCustomModels(raw: unknown, providerId: string): CustomModelEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProviderSettingsError(`Invalid model list for "${providerId}".`, {
      field: "customProviders",
    });
  }
  const seen = new Set<string>();
  const models: CustomModelEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new ProviderSettingsError(`Invalid model entry for "${providerId}".`, {
        field: "customProviders",
      });
    }
    const m = item as Record<string, unknown>;
    if (typeof m.model !== "string" || !m.model.trim() || m.model.trim().length > 200) {
      throw new ProviderSettingsError(`Invalid model id for "${providerId}".`, {
        field: "customProviders",
      });
    }
    const model = m.model.trim();
    if (seen.has(model)) {
      throw new ProviderSettingsError(
        `Duplicate model "${model}" on provider "${providerId}".`,
        { field: "customProviders" },
      );
    }
    seen.add(model);
    const kind: CustomModelKind =
      m.kind === "image" || m.kind === "video" || m.kind === "text" || m.kind === "off"
        ? m.kind
        : "off";
    models.push({
      model,
      ...(typeof m.label === "string" && m.label.trim()
        ? { label: m.label.trim().slice(0, 120) }
        : {}),
      kind,
      enabled: m.enabled === true,
    });
  }
  return models;
}

function parseCustomUpsert(raw: unknown, config: ReturnType<typeof getProviderConfig>): CustomProviderEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new ProviderSettingsError("Invalid custom provider payload.", {
      field: "customProviders",
    });
  }
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id.trim() : "";
  if (!isValidCustomSlug(id)) {
    throw new ProviderSettingsError(
      "The provider id must be 2–32 lowercase letters, digits, or dashes.",
      { field: "customProviders" },
    );
  }
  if ((PROVIDER_IDS as readonly string[]).includes(id)) {
    throw new ProviderSettingsError(`"${id}" is a built-in provider id.`, {
      field: "customProviders",
    });
  }
  const existing = config.customProviders.find((entry) => entry.id === id);
  // Partial re-upserts (e.g. {id, models} after discovery) inherit the rest.
  const formatRaw = typeof e.format === "string" ? e.format : existing?.format;
  if (
    typeof formatRaw !== "string" ||
    !CUSTOM_FORMATS.includes(formatRaw as CustomProviderFormat)
  ) {
    throw new ProviderSettingsError(
      `The format must be one of: ${CUSTOM_FORMATS.join(", ")}.`,
      { field: "customProviders" },
    );
  }
  const baseUrl = typeof e.baseUrl === "string" && e.baseUrl.trim() ? e.baseUrl.trim() : existing?.baseUrl ?? "";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ProviderSettingsError("Enter a valid http(s) base URL.", {
      field: "customProviders",
    });
  }
  const models =
    e.models === undefined && existing
      ? existing.models
      : parseCustomModels(e.models ?? [], id);
  return {
    id,
    label:
      typeof e.label === "string" && e.label.trim()
        ? e.label.trim().slice(0, 80)
        : (existing?.label ?? id),
    format: formatRaw as CustomProviderFormat,
    baseUrl,
    apiKey:
      e.apiKey === undefined
        ? (existing?.apiKey ?? null)
        : typeof e.apiKey === "string" && e.apiKey.trim()
          ? e.apiKey.trim()
          : null,
    enabled: e.enabled === undefined ? (existing?.enabled ?? true) : e.enabled === true,
    models,
    ...(typeof e.lastDiscoveredAt === "string" && e.lastDiscoveredAt
      ? { lastDiscoveredAt: e.lastDiscoveredAt }
      : existing?.lastDiscoveredAt
        ? { lastDiscoveredAt: existing.lastDiscoveredAt }
        : {}),
  };
}

function parseCustomProvidersPatch(
  raw: unknown,
  config: ReturnType<typeof getProviderConfig>,
): CustomProvidersPatch {
  if (typeof raw !== "object" || raw === null) {
    throw new ProviderSettingsError("Invalid custom providers payload.", {
      field: "customProviders",
    });
  }
  const ops = raw as CustomProvidersPatch;
  const patch: CustomProvidersPatch = {};
  if (ops.upsert !== undefined) {
    patch.upsert = parseCustomUpsert(ops.upsert, config);
  }
  if (ops.remove !== undefined) {
    if (typeof ops.remove !== "string") {
      throw new ProviderSettingsError("Invalid remove op.", { field: "customProviders" });
    }
    patch.remove = ops.remove;
  }
  if (ops.setModel !== undefined) {
    const op = ops.setModel;
    if (
      typeof op !== "object" ||
      op === null ||
      typeof (op as CustomProvidersPatch["setModel"])?.providerId !== "string" ||
      typeof (op as CustomProvidersPatch["setModel"])?.model !== "string"
    ) {
      throw new ProviderSettingsError("Invalid model update.", { field: "customProviders" });
    }
    const entry = config.customProviders.find((e) => e.id === op.providerId);
    if (!entry) {
      throw new ProviderSettingsError(`Unknown provider "${op.providerId}".`, {
        field: "customProviders",
      });
    }
    if (!entry.models.some((m) => m.model === op.model)) {
      throw new ProviderSettingsError(
        `Unknown model "${op.model}" on "${op.providerId}".`,
        { field: "customProviders" },
      );
    }
    patch.setModel = {
      providerId: op.providerId,
      model: op.model,
      ...(op.kind !== undefined ? { kind: op.kind } : {}),
      ...(op.enabled !== undefined ? { enabled: op.enabled } : {}),
    };
  }
  return patch;
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
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
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
      providerPatch[id as KnownProviderId] = entry;
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
    if (raw.tasks.writer !== undefined) {
      // Same contract as enhance: null clears, otherwise must be a known
      // text model — Story Writer reads from the same text pool.
      const writer = raw.tasks.writer;
      if (writer !== null && typeof writer !== "string") {
        throw new ProviderSettingsError("Invalid writer model.", { field: "tasks" });
      }
      if (typeof writer === "string" && !allTextModelIds().has(writer)) {
        throw new ProviderSettingsError(`Unknown writer model "${writer}".`, {
          field: "tasks",
        });
      }
      patch.tasks = { ...(patch.tasks ?? {}), writer };
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

  if (raw.customProviders !== undefined) {
    patch.customProviders = parseCustomProvidersPatch(raw.customProviders, getProviderConfig());
  }

  // The last enabled provider is load-bearing: renders need at least one.
  const preview = mergeProviderConfigPatch(patch);
  const enabledCount =
    PROVIDER_IDS.filter((id) => preview.providers[id].enabled).length +
    preview.customProviders.filter((entry) => entry.enabled).length;
  if (enabledCount === 0) {
    throw new ProviderSettingsError("Keep at least one provider enabled.", {
      field: "providers",
    });
  }

  updateProviderConfig(patch);
  invalidateStudioEnv();
  return getProviderSettings();
}
