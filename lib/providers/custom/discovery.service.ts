import { CUSTOM_FORMATS, getProviderConfig, type CustomModelEntry, type CustomProviderEntry, type CustomProviderFormat } from "@/lib/repositories/provider-config.repository";
import { ProviderError } from "@/lib/providers/types";
import { FORMATS } from "./formats";
import type { ProviderFormat } from "./formats/types";
import { guessEntry } from "./formats/classify";

/**
 * Model discovery orchestration: fetch a provider's model listing through
 * its wire format, guess kinds, and (for saved providers) merge the result
 * with the user's existing classifications — kept kinds/enabled flags win,
 * new models arrive guessed, vanished models are dropped.
 */

export interface DiscoverInput {
  /** Re-discover a saved provider (uses its stored key unless overridden). */
  id?: string;
  format?: string;
  baseUrl?: string;
  /** Explicit key — required for a first discovery of an unsaved provider. */
  apiKey?: string;
}

export interface DiscoverResult {
  models: CustomModelEntry[];
  lastDiscoveredAt: string;
}

function requireFormat(
  id: string,
  formats: Record<string, ProviderFormat>,
): ProviderFormat {
  if (
    typeof id !== "string" ||
    !CUSTOM_FORMATS.includes(id as CustomProviderFormat)
  ) {
    throw new ProviderError(
      `The format must be one of: ${CUSTOM_FORMATS.join(", ")}.`,
      { retryable: false, field: "format" },
    );
  }
  return formats[id as CustomProviderFormat] ?? FORMATS[id as CustomProviderFormat];
}

function requireBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ProviderError("Enter a valid http(s) base URL.", {
      retryable: false,
      field: "baseUrl",
    });
  }
  return trimmed;
}

/** Maps a wire failure onto the form field the user can fix. */
function fieldFor(error: unknown): string {
  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
    return "apiKey";
  }
  return "baseUrl";
}

export async function discoverProviderModels(
  input: DiscoverInput,
  formats: Record<string, ProviderFormat> = FORMATS,
): Promise<DiscoverResult> {
  const wantedId = input.id?.trim();
  if (!wantedId) {
    const format = requireFormat(input.format ?? "", formats);
    const baseUrl = requireBaseUrl(input.baseUrl ?? "");
    const cfg: CustomProviderEntry = {
      id: "discover",
      label: "Provider",
      format: format.id,
      baseUrl,
      apiKey: input.apiKey?.trim() || null,
      enabled: true,
      models: [],
    };
    try {
      const discovered = await format.listModels(cfg);
      return { models: guessEntry(discovered), lastDiscoveredAt: new Date().toISOString() };
    } catch (error) {
      throw new ProviderError((error as Error).message, {
        retryable: false,
        field: fieldFor(error),
      });
    }
  }

  const entry = getProviderConfig().customProviders.find((e) => e.id === wantedId);
  if (!entry) {
    throw new ProviderError(`Unknown provider "${wantedId}".`, {
      retryable: false,
      field: "id",
    });
  }
  const format = formats[entry.format] ?? FORMATS[entry.format];
  const cfg: CustomProviderEntry = {
    ...entry,
    apiKey: input.apiKey?.trim() || entry.apiKey,
  };
  let discovered: Awaited<ReturnType<ProviderFormat["listModels"]>>;
  try {
    discovered = await format.listModels(cfg);
  } catch (error) {
    throw new ProviderError((error as Error).message, {
      retryable: false,
      field: fieldFor(error),
    });
  }

  const guessed = new Map(guessEntry(discovered).map((model) => [model.model, model]));
  const merged: CustomModelEntry[] = [];
  for (const existing of entry.models) {
    const fresh = guessed.get(existing.model);
    if (!fresh) continue; // vanished from the listing — drop
    merged.push(existing);
    guessed.delete(existing.model);
  }
  for (const fresh of guessed.values()) {
    merged.push(fresh);
  }
  return { models: merged, lastDiscoveredAt: new Date().toISOString() };
}
