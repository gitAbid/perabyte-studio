/**
 * Server-side environment configuration, parsed once and cached.
 *
 * The app must keep working when optional values are missing: an absent
 * API key simply disables the apikey-fan provider (the registry then falls
 * back to the keyless Pollinations provider), so no env var is ever a hard
 * startup requirement.
 */
export interface StudioEnv {
  /** OpenAI-compatible base URL of the apikey.fan relay. */
  apiKeyFanBaseUrl: string;
  /** Relay key (`sk-…`). `null` when unset — provider disabled. */
  apiKeyFanApiKey: string | null;
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

  const apiKey = process.env.APIKEY_FAN_API_KEY?.trim() ?? "";

  return {
    apiKeyFanBaseUrl,
    apiKeyFanApiKey: apiKey ? apiKey : null,
    logLevel: (process.env.LOG_LEVEL?.trim() || "info").toLowerCase(),
    mediaCacheDir: process.env.MEDIA_CACHE_DIR?.trim() || ".media-cache",
  };
}

export function getStudioEnv(): StudioEnv {
  cached ??= parseEnv();
  return cached;
}

/** Test hook: force a re-read of process.env. */
export function resetStudioEnvForTests(): void {
  cached = null;
}
