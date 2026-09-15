import { getProviderConfig } from "@/lib/repositories/provider-config.repository";

/**
 * Server-side environment configuration, parsed once and cached.
 *
 * The app must keep working when optional values are missing: an absent
 * API key simply disables the apikey-fan provider (the registry then falls
 * back to the keyless Pollinations provider), so no env var is ever a hard
 * startup requirement.
 *
 * When an API key is configured via Settings (stored in `.studio/settings.json`),
 * it takes precedence over the environment variable. Clearing the key in
 * Settings falls back to the environment variable.
 */
export interface StudioEnv {
  /** OpenAI-compatible base URL of the apikey.fan relay. */
  apiKeyFanBaseUrl: string;
  /** Relay key (`sk-…`). `null` when unset — provider disabled. */
  apiKeyFanApiKey: string | null;
  /** Sogni AI API key. `null` when unset — provider disabled. */
  sogniApiKey: string | null;
  /** Stable per-installation connection id. `null` → generated and persisted. */
  sogniAppId: string | null;
  /** Sogni REST endpoint (generation rides the companion WebSocket). */
  sogniRestUrl: string;
  /** Sogni WebSocket endpoint. */
  sogniSocketUrl: string;
  /** Minimum log level: debug | info | warn | error. */
  logLevel: string;
  /** Directory used by the media cache repository. */
  mediaCacheDir: string;
}

let cached: StudioEnv | null = null;

function parseEnv(): StudioEnv {
  const baseUrlRaw =
    process.env.APIKEY_FAN_BASE_URL?.trim() || "https://apikey.fan/v1";
  let apiKeyFanBaseUrl = baseUrlRaw;
  try {
    // Normalize: accept a bare host as well as a full /v1 path.
    const url = new URL(baseUrlRaw);
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1";
    apiKeyFanBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    // An invalid URL is a configuration error; surface it lazily at use
    // time via the provider instead of crashing module load.
  }

  const envApiKeyFan = process.env.APIKEY_FAN_API_KEY?.trim() || null;
  const envSogni = process.env.SOGNI_API_KEY?.trim() || null;

  let settingsConfig: ReturnType<typeof getProviderConfig> | null = null;
  try {
    settingsConfig = getProviderConfig();
  } catch {
    // Fallback gracefully if filesystem fails at early boot.
  }

  const settingsApiKeyFan =
    settingsConfig?.providers["apikey-fan"]?.apiKey?.trim() || null;
  const settingsSogni =
    settingsConfig?.providers.sogni?.apiKey?.trim() || null;

  const apiKeyFanApiKey = settingsApiKeyFan ?? envApiKeyFan;
  const sogniApiKey = settingsSogni ?? envSogni;

  return {
    apiKeyFanBaseUrl,
    apiKeyFanApiKey,
    sogniApiKey,
    sogniAppId: process.env.SOGNI_APP_ID?.trim() || null,
    sogniRestUrl: process.env.SOGNI_REST_URL?.trim() || "https://api.sogni.ai",
    sogniSocketUrl: process.env.SOGNI_SOCKET_URL?.trim() || "wss://socket.sogni.ai",
    logLevel: (process.env.LOG_LEVEL?.trim() || "info").toLowerCase(),
    mediaCacheDir: process.env.MEDIA_CACHE_DIR?.trim() || ".media-cache",
  };
}

export function getStudioEnv(): StudioEnv {
  cached ??= parseEnv();
  return cached;
}

/** Invalidate cached env so changes from Settings take effect instantly. */
export function invalidateStudioEnv(): void {
  cached = null;
}

/** Test hook: force a re-read of process.env / settings. */
export function resetStudioEnvForTests(): void {
  cached = null;
}
