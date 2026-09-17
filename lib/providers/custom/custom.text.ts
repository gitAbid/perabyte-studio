import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { ProviderError } from "@/lib/providers/types";
import { formatFor } from "./formats";

/**
 * Text completion entry point for user-registered providers. The
 * enhancement engine chain (and any future text consumer) calls this with
 * the owning provider's slug; the wire format supplies the transport.
 */

const CUSTOM_TEXT_SYSTEM =
  "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.";

export async function customTextComplete(
  providerId: string,
  instruction: string,
  options?: { signal?: AbortSignal; modelId?: string; systemPrompt?: string },
): Promise<string> {
  const entry = getProviderConfig().customProviders.find((e) => e.id === providerId);
  if (!entry) {
    throw new ProviderError(`The ${providerId} provider no longer exists.`, {
      retryable: false,
    });
  }
  const format = formatFor(entry.format);
  if (!format.generateText) {
    throw new ProviderError(`The ${entry.label} provider cannot complete text.`, {
      retryable: false,
    });
  }
  const result = await format.generateText(entry, {
    systemPrompt: options?.systemPrompt ?? CUSTOM_TEXT_SYSTEM,
    userPrompt: instruction,
    modelId: options?.modelId,
    signal: options?.signal,
  });
  return result.text;
}
