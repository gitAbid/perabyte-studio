import { getStudioEnv } from "@/lib/config/env";
import { ProviderError } from "@/lib/providers/types";

/**
 * Text-completion adapter over Sogni's OpenAI-compatible chat endpoint.
 * Primary engine for prompt enhancement: the key is already required for
 * Sogni renders, completions ride the account subscription (no per-call
 * charge observed), and it answers with real reasoning models instead of
 * Pollinations' shared key pool.
 *
 * Reasoning quirk: with a tight `max_tokens` the model spends everything on
 * hidden reasoning and answers `content: ""` — an empty content is treated
 * as an engine failure so the service falls through to the next engine.
 */
const MODEL = "qwen3.5-35b-a3b-abliterated-gguf-q4km";
const TIMEOUT_MS = 25_000;

export interface TextCompletionOptions {
  signal?: AbortSignal;
}

export async function sogniTextComplete(
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError("Sogni is not configured.", { retryable: false });
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.sogniRestUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.sogniApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.",
          },
          { role: "user", content: instruction },
        ],
        max_tokens: 700,
        stream: false,
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new ProviderError("The Sogni enhancer timed out.", { retryable: true });
    }
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ProviderError("The Sogni enhancer is unreachable.", { retryable: true });
  }

  if (!response.ok) {
    throw new ProviderError(`The Sogni enhancer replied ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = body?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new ProviderError("The Sogni enhancer returned an empty reply.", {
      retryable: true,
    });
  }
  return content;
}
