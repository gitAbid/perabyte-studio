import { getStudioEnv } from "@/lib/config/env";
import { ProviderError, type TextModelDescriptor } from "@/lib/providers/types";

export const DEFAULT_SOGNI_TEXT_MODEL = "qwen3.5-35b-a3b-abliterated-gguf-q4km";

export const SOGNI_TEXT_MODELS: TextModelDescriptor[] = [
  {
    id: "sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km",
    label: "Qwen 3.5 35B (Abliterated)",
    provider: "sogni",
    description: "Uncensored instruction model with reasoning. Fast and expressive.",
    reasoning: true,
  },
  {
    id: "sogni:qwen3.6-35b-a3b-gguf-iq4xs",
    label: "Qwen 3.6 35B",
    provider: "sogni",
    description: "Latest Qwen release with enhanced reasoning capabilities.",
    reasoning: true,
  },
  {
    id: "sogni:deepseek-v4-flash-vision-exp-dspark-1m",
    label: "DeepSeek v4 Flash Vision",
    provider: "sogni",
    description: "Vision-capable fast reasoning model with 1M context.",
    reasoning: true,
  },
];

const TIMEOUT_MS = 25_000;

export interface TextCompletionOptions {
  signal?: AbortSignal;
  modelId?: string;
  systemPrompt?: string;
}

export async function sogniTextComplete(
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError("Sogni is not configured.", { retryable: false });
  }

  // Strip "sogni:" prefix if present
  let model = options.modelId ?? DEFAULT_SOGNI_TEXT_MODEL;
  if (model.startsWith("sogni:")) {
    model = model.slice("sogni:".length);
  }

  const system =
    options.systemPrompt ??
    "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.";

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
        model,
        messages: [
          { role: "system", content: system },
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
