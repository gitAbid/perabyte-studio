import * as fs from "node:fs";
import * as path from "node:path";

import { PROMPT_MAX, PROMPT_MAX_RANGE } from "@/lib/constants";

export type KnownProviderId = "apikey-fan" | "sogni" | "pollinations";

/** Alias used by consumers that validate user-supplied provider ids. */
export type ProviderId = KnownProviderId;

/** Priority order — keyed providers first, keyless fallback last. */
export const PROVIDER_IDS: readonly KnownProviderId[] = [
  "apikey-fan",
  "sogni",
  "pollinations",
] as const;

export interface ProviderEntryConfig {
  enabled: boolean;
  apiKey: string | null;
  disabledModels: string[];
}

export interface TaskModelConfig {
  enhance: string | null;
  /** Story Writer default text model (`<provider>:<model>`), null = chain order. */
  writer: string | null;
}

/* ------------------------------------------------------------------ */
/* Custom (user-registered) providers                                  */
/* ------------------------------------------------------------------ */

export const CUSTOM_FORMATS = ["openai", "google", "anthropic"] as const;
export type CustomProviderFormat = (typeof CUSTOM_FORMATS)[number];
export type CustomModelKind = "image" | "video" | "text" | "off";

export interface CustomModelEntry {
  model: string;
  label?: string;
  kind: CustomModelKind;
  enabled: boolean;
}

export interface CustomProviderEntry {
  /** URL-safe slug, unique, never a built-in provider id. */
  id: string;
  label: string;
  format: CustomProviderFormat;
  baseUrl: string;
  apiKey: string | null;
  enabled: boolean;
  models: CustomModelEntry[];
  lastDiscoveredAt?: string;
}

/** Op-based patch for the custom provider list (validated in the settings
 * service; the repository applies the ops verbatim). */
export interface CustomProvidersPatch {
  upsert?: CustomProviderEntry;
  remove?: string;
  setModel?: {
    providerId: string;
    model: string;
    kind?: CustomModelKind;
    enabled?: boolean;
  };
}

const CUSTOM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function isValidCustomSlug(id: string): boolean {
  return CUSTOM_SLUG_PATTERN.test(id);
}

function sanitizeCustomModel(raw: unknown): CustomModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.model !== "string" || !m.model.trim()) return null;
  const kind: CustomModelKind =
    m.kind === "image" || m.kind === "video" || m.kind === "text" || m.kind === "off"
      ? m.kind
      : "off";
  return {
    model: m.model.trim(),
    ...(typeof m.label === "string" && m.label.trim() ? { label: m.label.trim() } : {}),
    kind,
    enabled: m.enabled === true,
  };
}

function sanitizeCustomProvider(raw: unknown): CustomProviderEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !isValidCustomSlug(e.id)) return null;
  if (typeof e.format !== "string" || !CUSTOM_FORMATS.includes(e.format as CustomProviderFormat)) {
    return null;
  }
  if (typeof e.baseUrl !== "string" || !e.baseUrl.trim()) return null;
  const models = Array.isArray(e.models)
    ? e.models.map(sanitizeCustomModel).filter((m): m is CustomModelEntry => m !== null)
    : [];
  return {
    id: e.id,
    label: typeof e.label === "string" && e.label.trim() ? e.label.trim() : e.id,
    format: e.format as CustomProviderFormat,
    baseUrl: e.baseUrl.trim(),
    apiKey: typeof e.apiKey === "string" && e.apiKey.trim() ? e.apiKey.trim() : null,
    enabled: e.enabled !== false,
    models,
    ...(typeof e.lastDiscoveredAt === "string" && e.lastDiscoveredAt
      ? { lastDiscoveredAt: e.lastDiscoveredAt }
      : {}),
  };
}

function sanitizeCustomProviders(raw: unknown): CustomProviderEntry[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, CustomProviderEntry>();
  for (const item of raw) {
    const entry = sanitizeCustomProvider(item);
    if (entry) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function cloneCustomProviders(entries: CustomProviderEntry[]): CustomProviderEntry[] {
  return entries.map((entry) => ({
    ...entry,
    models: entry.models.map((model) => ({ ...model })),
  }));
}

/** Overall render deadlines in seconds, configurable from Settings. */
export interface RenderTimeoutsConfig {
  image: number;
  video: number;
  /**
   * Durable-job staleness (Phase B): fail a render when the provider has
   * not reported progress for this long. Measures OUR wait, not provider
   * load — a backed-up render keeps polling, a hung one dies here.
   */
  staleness: number;
}

export interface ProviderConfig {
  version: 1;
  providers: Record<KnownProviderId, ProviderEntryConfig>;
  tasks: TaskModelConfig;
  renderTimeouts: RenderTimeoutsConfig;
  /** Generation-prompt budget in characters (Settings → General). */
  promptMaxChars: number;
  customProviders: CustomProviderEntry[];
}

export interface ProviderConfigPatch {
  providers?: Partial<
    Record<
      KnownProviderId,
      Partial<Omit<ProviderEntryConfig, "disabledModels">> & {
        disabledModels?: string[];
      }
    >
  >;
  tasks?: Partial<TaskModelConfig>;
  renderTimeouts?: Partial<RenderTimeoutsConfig>;
  promptMaxChars?: number;
  customProviders?: CustomProvidersPatch;
}

/** Defaults: images 5 minutes, videos 10 minutes, staleness 5 minutes. */
export const RENDER_TIMEOUT_DEFAULTS: RenderTimeoutsConfig = {
  image: 300,
  video: 600,
  staleness: 300,
};

/** Sanity clamp applied to configured values, in seconds. */
export const RENDER_TIMEOUT_RANGE = { min: 30, max: 3600 } as const;
/** Staleness has a tighter sane band — probing for hours would hide hangs. */
export const RENDER_STALENESS_RANGE = { min: 60, max: 1800 } as const;

const KNOWN_PROVIDERS: readonly KnownProviderId[] = [
  "apikey-fan",
  "sogni",
  "pollinations",
] as const;

let overridePath: string | null = null;
let cachedConfig: ProviderConfig | null = null;

/**
 * Monotonic counter bumped whenever the config may have changed. The provider
 * registry compares it to rebuild custom-provider adapters after a Settings
 * save without a process restart.
 */
let configRevision = 0;

export function getConfigRevision(): number {
  return configRevision;
}

function bumpConfigRevision(): void {
  configRevision += 1;
}

function resolveConfigPath(): string {
  if (overridePath) return overridePath;
  return path.join(process.cwd(), ".studio", "settings.json");
}

export function getDefaultProviderConfig(): ProviderConfig {
  return {
    version: 1,
    providers: {
      "apikey-fan": { enabled: true, apiKey: null, disabledModels: [] },
      sogni: { enabled: true, apiKey: null, disabledModels: [] },
      pollinations: { enabled: true, apiKey: null, disabledModels: [] },
    },
    tasks: {
      enhance: null,
      writer: null,
    },
    renderTimeouts: { ...RENDER_TIMEOUT_DEFAULTS },
    promptMaxChars: PROMPT_MAX,
    customProviders: [],
  };
}

function cloneDefault(): ProviderConfig {
  return JSON.parse(JSON.stringify(getDefaultProviderConfig()));
}

/** Coerces a configured timeout to a clamped integer within the safe range. */
function clampRenderTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    RENDER_TIMEOUT_RANGE.max,
    Math.max(RENDER_TIMEOUT_RANGE.min, Math.round(value)),
  );
}

/** Staleness clamps to its own band; missing value keeps the fallback. */
function clampStaleness(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    RENDER_STALENESS_RANGE.max,
    Math.max(RENDER_STALENESS_RANGE.min, Math.round(value)),
  );
}

/** Prompt budget clamps to its sane band; missing value keeps the fallback. */
function clampPromptMaxChars(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    PROMPT_MAX_RANGE.max,
    Math.max(PROMPT_MAX_RANGE.min, Math.round(value)),
  );
}

function sanitizeLoadedConfig(raw: unknown): ProviderConfig {
  const defaults = cloneDefault();
  if (!raw || typeof raw !== "object") return defaults;

  const obj = raw as Record<string, unknown>;
  const providersObj =
    obj.providers && typeof obj.providers === "object"
      ? (obj.providers as Record<string, unknown>)
      : {};

  for (const id of KNOWN_PROVIDERS) {
    const entry = providersObj[id];
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.enabled === "boolean") {
        defaults.providers[id].enabled = e.enabled;
      }
      if (typeof e.apiKey === "string" && e.apiKey.trim().length > 0) {
        defaults.providers[id].apiKey = e.apiKey.trim();
      } else {
        defaults.providers[id].apiKey = null;
      }
      if (Array.isArray(e.disabledModels)) {
        defaults.providers[id].disabledModels = e.disabledModels.filter(
          (m): m is string => typeof m === "string" && m.length > 0
        );
      }
    }
  }

  const tasksObj =
    obj.tasks && typeof obj.tasks === "object"
      ? (obj.tasks as Record<string, unknown>)
      : {};

  if (typeof tasksObj.enhance === "string" && tasksObj.enhance.trim().length > 0) {
    defaults.tasks.enhance = tasksObj.enhance.trim();
  } else {
    defaults.tasks.enhance = null;
  }

  if (typeof tasksObj.writer === "string" && tasksObj.writer.trim().length > 0) {
    defaults.tasks.writer = tasksObj.writer.trim();
  } else {
    defaults.tasks.writer = null;
  }

  const timeoutsObj =
    obj.renderTimeouts && typeof obj.renderTimeouts === "object"
      ? (obj.renderTimeouts as Record<string, unknown>)
      : {};
  defaults.renderTimeouts.image = clampRenderTimeout(
    timeoutsObj.image,
    defaults.renderTimeouts.image,
  );
  defaults.renderTimeouts.video = clampRenderTimeout(
    timeoutsObj.video,
    defaults.renderTimeouts.video,
  );
  defaults.renderTimeouts.staleness = clampStaleness(
    timeoutsObj.staleness,
    defaults.renderTimeouts.staleness,
  );
  defaults.promptMaxChars = clampPromptMaxChars(
    obj.promptMaxChars,
    defaults.promptMaxChars,
  );
  defaults.customProviders = sanitizeCustomProviders(obj.customProviders);

  return defaults;
}

export function getProviderConfig(): ProviderConfig {
  if (cachedConfig) return cachedConfig;

  const target = resolveConfigPath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cachedConfig = cloneDefault();
      return cachedConfig;
    }
    const rawText = fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8");
    const parsed = JSON.parse(rawText);
    cachedConfig = sanitizeLoadedConfig(parsed);
  } catch {
    cachedConfig = cloneDefault();
  }
  return cachedConfig;
}

/** Merges a validated patch onto the current config without persisting.
 * Callers that also validate against live state (settings service) use this
 * to preview the outcome before committing with `updateProviderConfig`. */
export function mergeProviderConfigPatch(patch: ProviderConfigPatch): ProviderConfig {
  const current = getProviderConfig();
  const next: ProviderConfig = {
    version: 1,
    providers: {
      "apikey-fan": { ...current.providers["apikey-fan"] },
      sogni: { ...current.providers.sogni },
      pollinations: { ...current.providers.pollinations },
    },
    tasks: { ...current.tasks },
    renderTimeouts: { ...current.renderTimeouts },
    promptMaxChars: current.promptMaxChars,
    customProviders: cloneCustomProviders(current.customProviders),
  };

  if (patch.providers) {
    for (const id of KNOWN_PROVIDERS) {
      const p = patch.providers[id];
      if (!p) continue;
      if (typeof p.enabled === "boolean") {
        next.providers[id].enabled = p.enabled;
      }
      if (p.apiKey !== undefined) {
        next.providers[id].apiKey =
          typeof p.apiKey === "string" && p.apiKey.trim().length > 0
            ? p.apiKey.trim()
            : null;
      }
      if (Array.isArray(p.disabledModels)) {
        next.providers[id].disabledModels = p.disabledModels.filter(
          (m): m is string => typeof m === "string" && m.length > 0
        );
      }
    }
  }

  if (patch.tasks) {
    if (patch.tasks.enhance !== undefined) {
      next.tasks.enhance =
        typeof patch.tasks.enhance === "string" &&
        patch.tasks.enhance.trim().length > 0
          ? patch.tasks.enhance.trim()
          : null;
    }
    if (patch.tasks.writer !== undefined) {
      next.tasks.writer =
        typeof patch.tasks.writer === "string" &&
        patch.tasks.writer.trim().length > 0
          ? patch.tasks.writer.trim()
          : null;
    }
  }

  if (patch.promptMaxChars !== undefined) {
    next.promptMaxChars = clampPromptMaxChars(
      patch.promptMaxChars,
      next.promptMaxChars,
    );
  }

  if (patch.customProviders) {
    const list = next.customProviders;
    const ops = patch.customProviders;
    if (ops.upsert) {
      const index = list.findIndex((entry) => entry.id === ops.upsert!.id);
      if (index >= 0) list[index] = cloneCustomProviders([ops.upsert])[0];
      else list.push(cloneCustomProviders([ops.upsert])[0]);
    }
    if (ops.remove) {
      const index = list.findIndex((entry) => entry.id === ops.remove);
      if (index >= 0) list.splice(index, 1);
    }
    if (ops.setModel) {
      const entry = list.find((e) => e.id === ops.setModel!.providerId);
      const model = entry?.models.find((m) => m.model === ops.setModel!.model);
      if (entry && model) {
        if (ops.setModel.kind !== undefined) model.kind = ops.setModel.kind;
        if (ops.setModel.enabled !== undefined) model.enabled = ops.setModel.enabled;
      }
    }
  }

  if (patch.renderTimeouts) {
    if (patch.renderTimeouts.image !== undefined) {
      next.renderTimeouts.image = clampRenderTimeout(
        patch.renderTimeouts.image,
        next.renderTimeouts.image,
      );
    }
    if (patch.renderTimeouts.video !== undefined) {
      next.renderTimeouts.video = clampRenderTimeout(
        patch.renderTimeouts.video,
        next.renderTimeouts.video,
      );
    }
    if (patch.renderTimeouts.staleness !== undefined) {
      next.renderTimeouts.staleness = clampStaleness(
        patch.renderTimeouts.staleness,
        next.renderTimeouts.staleness,
      );
    }
  }

  return next;
}

export function updateProviderConfig(patch: ProviderConfigPatch): ProviderConfig {
  const next = mergeProviderConfigPatch(patch);

  const target = resolveConfigPath();
  const dir = path.dirname(target);
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(target, JSON.stringify(next, null, 2), "utf-8");
  cachedConfig = next;
  bumpConfigRevision();
  return next;
}

export function invalidateProviderConfigCache(): void {
  cachedConfig = null;
  bumpConfigRevision();
}

/** Test hook: alias for cache invalidation. */
export const resetProviderConfigForTests = invalidateProviderConfigCache;

export function setProviderConfigPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cachedConfig = null;
}
