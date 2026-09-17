import { sogniChat } from "@/lib/providers/sogni/sogni.chat";
import type { TextModelDescriptor } from "@/lib/providers/types";

export const DEFAULT_SOGNI_TEXT_MODEL = "qwen3.5-35b-a3b-abliterated-gguf-q4km";

export const SOGNI_TEXT_MODELS: TextModelDescriptor[] = [
  {
    id: "sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km",
    label: "Qwen 3.5 35B (Abliterated)",
    provider: "sogni",
    description: "Uncensored instruction model with reasoning. Fast and expressive.",
    reasoning: true,
    uncensored: true,
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

const DEFAULT_TEXT_SYSTEM =
  "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.";

export interface TextCompletionOptions {
  signal?: AbortSignal;
  modelId?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export async function sogniTextComplete(
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  let model = options.modelId ?? DEFAULT_SOGNI_TEXT_MODEL;
  if (model.startsWith("sogni:")) {
    model = model.slice("sogni:".length);
  }
  return sogniChat(model, instruction, {
    signal: options.signal,
    systemPrompt: options.systemPrompt ?? DEFAULT_TEXT_SYSTEM,
    timeoutMs: TIMEOUT_MS,
    label: "Sogni enhancer",
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  });
}
