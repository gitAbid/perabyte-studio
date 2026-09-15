import { ProviderError, type TextModelDescriptor } from "@/lib/providers/types";

export const POLLINATIONS_TEXT_MODEL: TextModelDescriptor = {
  id: "pollinations:default",
  label: "Pollinations (Keyless)",
  provider: "pollinations",
  description: "Anonymous shared key pool. Free fallback with no API key required.",
};

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
