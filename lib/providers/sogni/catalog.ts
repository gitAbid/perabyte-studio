import type { ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import type { SogniAvailableModel, SogniClient } from "@/lib/providers/sogni/client";
import {
  PROVIDER_ID,
  SOGNI_IMAGE_MODELS,
  SOGNI_VIDEO_MODELS,
} from "@/lib/providers/sogni/request-maps";

/**
 * Live Sogni model catalog. Sogni's lineup is large and changes often, so the
 * provider lists whatever `projects.getAvailableModels` reports instead of a
 * hardcoded set. The fetch is stale-while-revalidate: `listImageModels` stays
 * synchronous and returns the last good list (the curated static catalog on
 * cold start), while `warmSogniCatalog` refreshes in the background.
 */

/** Model ids that need reference media or aren't prompt-to-media — skipped
 * until the studio can drive them (edit models, segmentation, 3D, upscalers,
 * image/video-to-video variants). Matched case-insensitively. */
const EXCLUDED_ID_PATTERNS = [
  "edit",
  "kontext",
  "segment",
  "sam3",
  "pixal3d",
  "upscale",
  "vsr",
  "i2v",
  "s2v",
  "v2v",
  "animate",
  "inpaint",
  "outpaint",
  "identity",
];

/** Curated entries keep their hand-written labels, hints and order. */
const CURATED = new Map(
  [...SOGNI_IMAGE_MODELS, ...SOGNI_VIDEO_MODELS].map((model) => [model.model, model]),
);

export interface SogniCatalog {
  images: ModelDescriptor[];
  videos: ModelDescriptor[];
}

const CATALOG_TTL_MS = 10 * 60_000;

let cache: { catalog: SogniCatalog; fetchedAt: number } | null = null;
let inFlight: Promise<void> | null = null;

/** Swap the catalog source in tests; `null` restores the real client. */
export function setCatalogFetcherForTests(
  fetcher: (() => Promise<SogniAvailableModel[]>) | null,
): void {
  catalogFetcher = fetcher;
  cache = null;
  inFlight = null;
}
let catalogFetcher: (() => Promise<SogniAvailableModel[]>) | null = null;

async function defaultFetcher(): Promise<SogniAvailableModel[]> {
  const client: SogniClient = await (await import("@/lib/providers/sogni/client")).getSogniClient();
  return client.projects.getAvailableModels("fast");
}

/** The catalog the provider lists right now — never blocks on the network. */
export function getSogniCatalog(): SogniCatalog {
  if (cache) return cache.catalog;
  return { images: SOGNI_IMAGE_MODELS, videos: SOGNI_VIDEO_MODELS };
}

/**
 * Refresh the catalog in the background (single-flight, TTL-gated). With
 * `boundedMs` the promise settles after that many milliseconds even if the
 * fetch is still running — callers stay fast while the refresh continues.
 */
export function warmSogniCatalog(boundedMs?: number): Promise<void> {
  const stale = !cache || Date.now() - cache.fetchedAt > CATALOG_TTL_MS;
  if (!inFlight && stale && getStudioEnv().sogniApiKey) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  if (!inFlight || !boundedMs) return inFlight ?? Promise.resolve();
  return Promise.race([
    inFlight,
    new Promise<void>((resolve) => setTimeout(resolve, boundedMs)),
  ]);
}

async function refresh(): Promise<void> {
  try {
    const fetcher = catalogFetcher ?? defaultFetcher;
    const models = await fetcher();
    if (!models.length) return; // Don't blank the picker on an empty answer.
    cache = {
      catalog: {
        images: toDescriptors(models, "image"),
        videos: toDescriptors(models, "video"),
      },
      fetchedAt: Date.now(),
    };
  } catch {
    // Network/auth trouble: keep serving the last good list (or curated).
  }
}

export function toDescriptors(
  models: SogniAvailableModel[],
  kind: "image" | "video",
): ModelDescriptor[] {
  const dynamic = models
    .filter(
      (model) =>
        model.media === kind &&
        model.workerCount > 0 &&
        !isExcluded(model.id),
    )
    .map((model) => {
      const curated = CURATED.get(model.id);
      return {
        id: buildModelId(PROVIDER_ID, model.id),
        providerId: PROVIDER_ID,
        kind,
        model: model.id,
        label: curated?.label ?? (model.name?.trim() || prettifyModelId(model.id)),
        hint: curated?.hint ?? speedHint(model.id),
      } satisfies ModelDescriptor;
    });

  // Hand-curated models first (stable order), the rest alphabetically.
  const curatedOrder = new Map(
    (kind === "image" ? SOGNI_IMAGE_MODELS : SOGNI_VIDEO_MODELS).map((m, i) => [m.model, i]),
  );
  return dynamic.sort((a, b) => {
    const rankA = curatedOrder.get(a.model);
    const rankB = curatedOrder.get(b.model);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
}

function isExcluded(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return EXCLUDED_ID_PATTERNS.some((pattern) => id.includes(pattern));
}

function speedHint(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/(turbo|schnell|lightx2v|distilled|flash|mini|fast|light)/.test(id)) return "Sogni · fast";
  if (/(hd|pro|ultra|quality|high|max)/.test(id)) return "Sogni · quality";
  return "Sogni · standard";
}

/** Fallback label when the API gives no usable name: `wan_v2.2-14b-fp8_t2v_lightx2v` → `Wan v2.2 14b t2v lightx2v`. */
function prettifyModelId(modelId: string): string {
  const cleaned = modelId
    .replace(/_(fp8|fp16|bf16|int8)(_scaled)?$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
