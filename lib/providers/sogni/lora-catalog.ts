import { logger } from "@/lib/logging/logger";

/**
 * Sogni LoRA catalog — `GET /v1/loras/comfy`, public (no API key), trimmed to
 * the fields the picker needs. Mirrors the SDK's `projects.availableLoras`
 * contract (5-minute cache; the catalog's `modelIds` join is authoritative)
 * without needing an SDK client connection.
 */

const LORA_CATALOG_URL = "https://api.sogni.ai/v1/loras/comfy";
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounded window for the model route: a page load must never hang on this. */
export const LORA_CATALOG_BUDGET_MS = 2_500;

/** Client-facing catalog entry (subset of the provider's `ui` block). */
export interface LoraOption {
  loraId: string;
  name: string;
  description: string;
  /** Grouping for the picker, e.g. `character`, `lighting`. */
  category: string;
  /** Every model id (raw, e.g. `krea2_turbo_fp8_scaled`) that accepts it. */
  modelIds: string[];
  /** Requires the artist's Sensitive Content Filter off (our Uncensored Mode). */
  nsfw: boolean;
  /** Specifically sexual — narrower than nsfw. */
  sexual: boolean;
  min: number;
  max: number;
  default: number;
  step: number;
  recommendedMin: number;
  recommendedMax: number;
  /** Semantic captions on bipolar LoRAs, e.g. "Cooler & Darker". */
  rangeLabels?: { min: string; max: string };
}

interface LoraCatalogResult {
  loras: LoraOption[];
  /** Raw model ids with at least one LoRA. */
  models: string[];
  maxPerRequest: number;
}

interface CacheEntry {
  at: number;
  data: LoraCatalogResult;
}

let cache: CacheEntry | null = null;

interface RawCatalogResponse {
  status?: string;
  data?: {
    loras?: Array<Record<string, unknown>>;
    models?: string[];
    constraints?: { maxPerRequest?: number };
  };
}

function toOption(entry: Record<string, unknown>): LoraOption | null {
  const loraId = typeof entry.loraId === "string" ? entry.loraId : "";
  const ui = (entry.ui ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) =>
    typeof ui[key] === "number" && Number.isFinite(ui[key]) ? (ui[key] as number) : fallback;
  if (!loraId || !Array.isArray(entry.modelIds) || entry.modelIds.length === 0) return null;
  const rangeLabels = ui.rangeLabels as { min?: unknown; max?: unknown } | undefined;
  return {
    loraId,
    name: typeof entry.name === "string" ? entry.name : loraId,
    description: typeof entry.description === "string" ? entry.description : "",
    category: typeof ui.category === "string" ? ui.category : "other",
    modelIds: entry.modelIds.filter((m): m is string => typeof m === "string"),
    nsfw: ui.nsfw === true,
    sexual: ui.sexual === true,
    min: num("min", 0),
    max: num("max", 1),
    default: num("default", 1),
    step: num("step", 0.1),
    recommendedMin: num("recommendedMin", num("min", 0)),
    recommendedMax: num("recommendedMax", num("max", 1)),
    rangeLabels:
      rangeLabels && typeof rangeLabels.min === "string" && typeof rangeLabels.max === "string"
        ? { min: rangeLabels.min, max: rangeLabels.max }
        : undefined,
  };
}

/**
 * Cached catalog fetch. `force` bypasses the TTL (unused today, kept for the
 * poll pattern the model refresh may adopt). Any failure resolves `null` —
 * callers degrade to "no LoRA picker", never block a render.
 */
export async function fetchLoraCatalog(
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<LoraCatalogResult | null> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  const timeoutMs = options.timeoutMs ?? LORA_CATALOG_BUDGET_MS;
  try {
    const response = await fetch(LORA_CATALOG_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as RawCatalogResponse;
    const loras = (body.data?.loras ?? [])
      .map(toOption)
      .filter((entry): entry is LoraOption => entry !== null);
    const result: LoraCatalogResult = {
      loras,
      models: body.data?.models ?? [...new Set(loras.flatMap((l) => l.modelIds))],
      maxPerRequest: body.data?.constraints?.maxPerRequest ?? 8,
    };
    cache = { at: Date.now(), data: result };
    return result;
  } catch (error) {
    // Serve the last good copy past its TTL rather than blanking the picker.
    if (cache) {
      logger.child({ module: "sogni/lora-catalog" }).warn("catalog refresh failed — serving stale", {
        error: (error as Error).message,
      });
      return cache.data;
    }
    logger.child({ module: "sogni/lora-catalog" }).warn("lora catalog unavailable", {
      error: (error as Error).message,
    });
    return null;
  }
}

/** Test seam: drop the module cache. */
export function resetLoraCatalogCache(): void {
  cache = null;
}
