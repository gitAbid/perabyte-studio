import type { CustomProviderFormat } from "@/lib/repositories/provider-config.repository";
import type { ProviderFormat } from "./types";
import { createOpenAiFormat } from "./openai";
import { createGoogleFormat } from "./google";
import { createAnthropicFormat } from "./anthropic";

/**
 * Wire-format registry. Adding a new gateway family means adding a file that
 * exports a `createXFormat()` and one entry here — nothing else changes.
 */
export const FORMATS: Record<CustomProviderFormat, ProviderFormat> = {
  openai: createOpenAiFormat(),
  google: createGoogleFormat(),
  anthropic: createAnthropicFormat(),
};

export function formatFor(id: CustomProviderFormat): ProviderFormat {
  return FORMATS[id];
}
