import type { Logger } from "@/lib/logging/logger";
import { ProviderError } from "@/lib/providers/types";

/**
 * Minimal OpenAI-compatible HTTP client for the apikey.fan relay.
 * Handles auth, timeouts, bounded retries and error normalization so every
 * provider adapter shares one hardened request path.
 */
export interface ApiKeyFanClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface CallOptions {
  logger: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Auto-retry rate limits (429/408) even for POSTs — they are not billed. */
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

interface RelayErrorBody {
  error?: { message?: string } | string;
  message?: string;
}

function extractMessage(body: RelayErrorBody | null): string | null {
  if (!body) return null;
  if (typeof body.error === "string") return body.error;
  return body.error?.message ?? body.message ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeout]);
  }
  return signal ?? timeout;
}

function statusMessage(status: number, detail: string | null): string {
  switch (status) {
    case 401:
      return "The render provider rejected the API key. Check APIKEY_FAN_API_KEY and try again.";
    case 403:
      return detail?.toLowerCase().includes("permission")
        ? "The API key's group is missing image-generation permission. Enable it on apikey.fan and retry."
        : "The render provider refused this request.";
    case 404:
      return "That model is not available through the configured provider.";
    case 429:
      return "The render provider is rate limiting us. Please retry in a moment.";
    default:
      return detail ?? `The render provider returned an error (${status}).`;
  }
}

function toProviderError(status: number, detail: string | null): ProviderError {
  const retryable = status === 429 || status === 408 || status >= 500;
  return new ProviderError(statusMessage(status, detail), {
    retryable,
    status,
  });
}

export interface ApiKeyFanClient {
  postJson<T>(path: string, body: unknown, options: CallOptions): Promise<T>;
  getJson<T>(path: string, options: CallOptions): Promise<T>;
}

export function createApiKeyFanClient(config: ApiKeyFanClientConfig): ApiKeyFanClient {
  const url = (path: string) => `${config.baseUrl}${path}`;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: CallOptions,
  ): Promise<T> {
    const { logger, signal } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = options.retries ?? MAX_ATTEMPTS;
    const log = logger.child({ provider: "apikey-fan", method, path });

    let attempt = 0;
    // Bounded retry loop: GETs retry on 5xx too; POSTs only on rate limits,
    // since repeating a create call on an opaque failure risks double billing.
    while (true) {
      attempt += 1;
      try {
        const response = await fetch(url(path), {
          method,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          cache: "no-store",
          signal: combinedSignal(timeoutMs, signal),
        });

        if (response.ok) {
          log.debug("provider call ok", { status: response.status, attempt });
          return (await response.json()) as T;
        }

        const detail = extractMessage(await response.json().catch(() => null));
        const rateLimited = response.status === 429 || response.status === 408;
        const serverError = response.status >= 500;
        const canRetry =
          attempt < maxAttempts && (rateLimited || (method === "GET" && serverError));

        if (canRetry) {
          const backoff = 800 * attempt + Math.floor(Math.random() * 250);
          log.warn("provider call failed — retrying", { status: response.status, backoff });
          await sleep(backoff, signal);
          continue;
        }
        throw toProviderError(response.status, detail);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if ((error as Error)?.name === "AbortError" || (error as Error)?.name === "TimeoutError") {
          if (signal?.aborted) throw error; // caller cancelled — propagate
          throw new ProviderError(
            "The render provider took too long to respond. Please try again.",
            { retryable: true },
          );
        }
        if (attempt < maxAttempts) {
          const backoff = 800 * attempt + Math.floor(Math.random() * 250);
          log.warn("provider network error — retrying", { backoff });
          await sleep(backoff, signal);
          continue;
        }
        log.error("provider call failed", { error });
        throw new ProviderError(
          "We could not reach the render provider. Check your connection and retry.",
          { retryable: true },
        );
      }
    }
  }

  return {
    postJson: (path, body, options) => request("POST", path, body, options),
    getJson: (path, options) => request("GET", path, undefined, options),
  };
}
