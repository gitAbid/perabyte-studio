import * as fs from "node:fs";
import * as path from "node:path";

export type KnownProviderId = "apikey-fan" | "sogni" | "pollinations";

export interface ProviderEntryConfig {
  enabled: boolean;
  apiKey: string | null;
  disabledModels: string[];
}

export interface TaskModelConfig {
  enhance: string | null;
}

export interface ProviderConfig {
  version: 1;
  providers: Record<KnownProviderId, ProviderEntryConfig>;
  tasks: TaskModelConfig;
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
}

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
  };
}

function cloneDefault(): ProviderConfig {
  return JSON.parse(JSON.stringify(getDefaultProviderConfig()));
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

  return defaults;
}

export function getProviderConfig(): ProviderConfig {
  if (cachedConfig) return cachedConfig;

  const target = resolveConfigPath();
  try {
    if (!fs.existsSync(target)) {
      cachedConfig = cloneDefault();
      return cachedConfig;
    }
    const rawText = fs.readFileSync(target, "utf-8");
    const parsed = JSON.parse(rawText);
    cachedConfig = sanitizeLoadedConfig(parsed);
  } catch {
    cachedConfig = cloneDefault();
  }
  return cachedConfig;
}

export function updateProviderConfig(patch: ProviderConfigPatch): ProviderConfig {
  const current = getProviderConfig();
  const next: ProviderConfig = {
    version: 1,
    providers: {
      "apikey-fan": { ...current.providers["apikey-fan"] },
      sogni: { ...current.providers.sogni },
      pollinations: { ...current.providers.pollinations },
    },
    tasks: { ...current.tasks },
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

  const target = resolveConfigPath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
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
