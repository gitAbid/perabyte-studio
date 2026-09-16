import { ProviderError } from "@/lib/providers/types";

/**
 * Hardened JSON HTTP helper for user-registered providers. Mirrors the
 * apikey-fan client's retry semantics (rate-limits always retry, 5xx only
 * on idempotent GETs) with provider-neutral error copy so any gateway gets
 * the same one request path.
 */

export interface HttpTarget {
  baseUrl: string;
  apiKey: string | null;
  /** Display name used in error copy ("My Relay"). */
  label: string;
}

export interface HttpCall {
  method?: "GET" | "POST";
  /** Appended verbatim to the target's baseUrl. */
  path: string;
  body?: unknown;
  /** Extra headers (google's `x-goog-api-key`, anthropic's version header…). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return typeof obj.message === "string" ? obj.message : null;
}

function statusMessage(label: string, status: number, detail: string | null): string {
  switch (status) {
    case 401:
      return `The ${label} API key was rejected. Check it in Settings and try again.`;
    case 403:
      return `The ${label} API key is missing permission for this action.`;
    case 404:
      return `That endpoint was not found on ${label}. Check the base URL and the provider's API surface.`;
    case 429:
      return `${label} is rate limiting us. Please retry in a moment.`;
    default:
      return detail ?? `The ${label} provider returned an error (${status}).`;
  }
}

function toProviderError(label: string, status: number, detail: string | null): ProviderError {
  return new ProviderError(statusMessage(label, status, detail), {
    retryable: status === 429 || status === 408 || status >= 500,
    status,
  });
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

export async function httpJson<T>(
  target: HttpTarget,
  call: HttpCall,
  fetchImpl: FetchImpl = fetch,
): Promise<T> {
  const method = call.method ?? "GET";
  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = call.retries ?? MAX_ATTEMPTS;
  const url = `${target.baseUrl.replace(/\/+$/, "")}${call.path}`;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const headers: Record<string, string> = {
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
        ...call.headers,
        ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
      };
      const response = await fetchImpl(url, {
        method,
        headers,
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        cache: "no-store",
        signal: combinedSignal(timeoutMs, call.signal),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const detail = extractMessage(await response.json().catch(() => null));
      const rateLimited = response.status === 429 || response.status === 408;
      const serverError = response.status >= 500;
      const canRetry =
        attempt < maxAttempts && (rateLimited || (method === "GET" && serverError));
      if (canRetry) {
        await sleep(800 * attempt + Math.floor(Math.random() * 250), call.signal);
        continue;
      }
      throw toProviderError(target.label, response.status, detail);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const name = (error as Error)?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        if (call.signal?.aborted) throw error; // caller cancelled — propagate
        throw new ProviderError(`The ${target.label} provider took too long to respond.`, {
          retryable: true,
        });
      }
      if (attempt < maxAttempts) {
        await sleep(800 * attempt + Math.floor(Math.random() * 250), call.signal);
        continue;
      }
      throw new ProviderError(
        `We could not reach ${target.label}. Check the base URL and your connection.`,
        { retryable: true },
      );
    }
  }
}

/**
 * Downloads raw bytes with the provider's auth. Video content endpoints are
 * auth-gated, so a hosted URL is useless to the client — fetch server-side.
 */
export async function httpBytes(
  target: HttpTarget,
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number },
): Promise<Buffer | null> {
  try {
    const headers: Record<string, string> = {
      ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      ...init?.headers,
    };
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: combinedSignal(init?.timeoutMs ?? 60_000, init?.signal),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}
