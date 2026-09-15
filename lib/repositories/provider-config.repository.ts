import * as fs from "node:fs";
import * as path from "node:path";

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
}

/** Overall render deadlines in seconds, configurable from Settings. */
export interface RenderTimeoutsConfig {
  image: number;
  video: number;
}

export interface ProviderConfig {
  version: 1;
  providers: Record<KnownProviderId, ProviderEntryConfig>;
  tasks: TaskModelConfig;
  renderTimeouts: RenderTimeoutsConfig;
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
}

/** Defaults: images 5 minutes, videos 10 minutes. */
export const RENDER_TIMEOUT_DEFAULTS: RenderTimeoutsConfig = {
  image: 300,
  video: 600,
};

/** Sanity clamp applied to configured values, in seconds. */
export const RENDER_TIMEOUT_RANGE = { min: 30, max: 3600 } as const;

const KNOWN_PROVIDERS: readonly KnownProviderId[] = [
  "apikey-fan",
  "sogni",
  "pollinations",
] as const;

let overridePath: string | null = null;
let cachedConfig: ProviderConfig | null = null;

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
    },
    renderTimeouts: { ...RENDER_TIMEOUT_DEFAULTS },
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
  return next;
}

export function invalidateProviderConfigCache(): void {
  cachedConfig = null;
}

/** Test hook: alias for cache invalidation. */
export const resetProviderConfigForTests = invalidateProviderConfigCache;

export function setProviderConfigPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cachedConfig = null;
}
