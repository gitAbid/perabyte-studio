import { getStudioEnv } from "@/lib/config/env";
import { ProviderError } from "@/lib/providers/types";

export const CHAT_TIMEOUT_MS = 25_000;
export const CHAT_MAX_TOKENS = 700;

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Plain string for text models; multimodal parts for vision models. */
export type ChatContent = string | ChatContentPart[];

export interface SogniChatOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Human name for error messages, e.g. "Sogni enhancer" / "Sogni vision". */
  label?: string;
}

/**
 * One OpenAI-style chat completion against the Sogni LLM surface
 * (POST /v1/chat/completions, Bearer auth, rides the subscription —
 * verified live, see docs/sogni-api-guide.md §LLM surface).
 */
export async function sogniChat(
  model: string,
  content: ChatContent,
  options: SogniChatOptions = {},
): Promise<string> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError("Sogni is not configured.", { retryable: false });
  }
  const label = options.label ?? "Sogni";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CHAT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.sogniRestUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.sogniApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: options.systemPrompt ?? "You are a helpful assistant." },
          { role: "user", content },
        ],
        max_tokens: options.maxTokens ?? CHAT_MAX_TOKENS,
        stream: false,
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new ProviderError(`The ${label} timed out.`, { retryable: true });
    }
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ProviderError(`The ${label} is unreachable.`, { retryable: true });
  }

  if (!response.ok) {
    throw new ProviderError(`The ${label} replied ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const reply = body?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!reply) {
    throw new ProviderError(`The ${label} returned an empty reply.`, {
      retryable: true,
    });
  }
  return reply;
}
