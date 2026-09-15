import { ProviderError } from "@/lib/providers/types";

/**
 * Keyless text-completion adapter for the Pollinations legacy GET endpoint —
 * the same free tier the render fallback already rides. No system/user split:
 * the whole instruction travels in the URL path, so the instruction builder
 * keeps the prompt and its rules in one block.
 *
 * The endpoint fronts a shared anonymous key pool. When the pool is out of
 * budget it still answers 200 with an apology instead of an error status, so
 * the reply text itself must be screened — a budget notice must surface as a
 * ProviderError, never as an "enhanced" prompt.
 */
const HOST = "text.pollinations.ai";
const TIMEOUT_MS = 12_000;

const FAILURE_MARKERS =
  /reached its budget|raise the key budget|model not found|rate limit|api key|error occurred/i;

export interface TextCompletionOptions {
  signal?: AbortSignal;
  /** Randomising the seed avoids a cached budget-notice reply. */
  seed?: number;
}

export async function pollinationsTextComplete(
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  const params = new URLSearchParams();
  params.set("seed", String(options.seed ?? Math.floor(Math.random() * 1_000_000)));
  const query = params.size ? `?${params}` : "";
  const url = `https://${HOST}/${encodeURIComponent(instruction)}${query}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "text/plain" },
      cache: "no-store",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new ProviderError("The prompt enhancer timed out.", { retryable: true });
    }
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ProviderError("The prompt enhancer is unreachable.", { retryable: true });
  }

  if (!response.ok) {
    throw new ProviderError(`The prompt enhancer replied ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const text = (await response.text()).trim();
  if (!text || FAILURE_MARKERS.test(text)) {
    throw new ProviderError("The prompt enhancer has no free capacity right now.", {
      retryable: true,
    });
  }
  return text;
}
