import type { ModelDescriptor, ModelFrameInput } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import type { SogniAvailableModel, SogniClient } from "@/lib/providers/sogni/client";
import { fetchLoraCatalog } from "@/lib/providers/sogni/lora-catalog";
import { sogniCuratedLabel, sogniModelMeta } from "@/lib/providers/sogni/model-meta";
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

/** Model ids that need media the studio can't provide or aren't
 * prompt-to-media — skipped (segmentation, 3D, upscalers,
 * image/video-to-video variants, audio/reference workflows). Edit/identity
 * families are NOT excluded: they are multi-reference edit models the studio
 * drives via `contextImages` (spec 2026-09-19). `r2v` reference-video
 * workflows stay out (premium, separate render path). Matched
 * case-insensitively. `flf2v` models REQUIRE both frame anchors and reject
 * prompt-only renders — they are registered as hidden capability models (see
 * buildHiddenModels), never offered in the picker. */
const EXCLUDED_ID_PATTERNS = [
  "kontext",
  "segment",
  "sam3",
  "pixal3d",
  "upscale",
  "vsr",
  "i2v",
  "s2v",
  "v2v",
  "a2v", // audio-to-video (incl. ia2v, flfa2v) — no audio input in the studio
  "r2v", // reference-image workflows (incl. ref2va)
  "removal", // BiRefNet-style utilities
  "animate",
  "inpaint",
  "outpaint",
  "flf2v",
];

/**
 * Provider-workflow video families that accept only the raw prompt — the SDK
 * documents that they reject even negativePrompt, so style presets are
 * meaningless there and the UI disables the style picker for them.
 */
const STYLELESS_ID_PATTERNS = [/^seedance/i, /^happyhorse/i, /^minimax/i];

function supportsStyles(modelId: string): boolean {
  return !STYLELESS_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Closed commercial models whose safety checker is always on — no account
 * flag changes that, so they sit in the picker's "Sensored" group.
 */
const SENSORLESS_ID_PATTERNS = [/^gpt-image/i];

function supportsUncensored(modelId: string): boolean {
  return !SENSORLESS_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

/** Frame conditioning by model family (verified against the live catalog —
 * see docs/sogni-api-guide.md §5). Undefined = prompt-only. */
export function frameCapability(modelId: string): ModelFrameInput | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("_flf2v")) return { start: true, end: true };
  if (id.includes("_i2v")) {
    return { start: true, end: id.startsWith("ltx23-") || id.startsWith("minimax-h3") };
  }
  if (id.startsWith("seedance-2-5")) return { start: true, end: true };
  if (id.startsWith("seedance-2-0")) return { start: true, end: false };
  return undefined;
}

/** The i2v sibling of a t2v workflow model, or null. Covers both the
 * underscore families (WAN/LTX/MiniMax) and the dashed vendor families
 * (HappyHorse). */
export function i2vSiblingId(modelId: string): string | null {
  if (modelId.includes("_t2v")) return modelId.replace("_t2v", "_i2v");
  if (modelId.includes("-t2v")) return modelId.replace("-t2v", "-i2v");
  return null;
}

export interface SogniCatalog {
  images: ModelDescriptor[];
  videos: ModelDescriptor[];
  /** Registered but unpickable: i2v siblings + flf2v keyframe models. */
  hidden: ModelDescriptor[];
}

const CATALOG_TTL_MS = 10 * 60_000;

let cache: { catalog: SogniCatalog; fetchedAt: number } | null = null;
let inFlight: Promise<void> | null = null;

/** Cold-start hidden set (ids verified against the live catalog 2026-09-15 —
 * docs/sogni-api-guide.md §5) so frame swaps work before the first refresh. */
const COLD_START_HIDDEN: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "wan_v2.2-14b-fp8_i2v_lightx2v"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "wan_v2.2-14b-fp8_i2v_lightx2v",
    label: "WAN 2.2 i2v",
    hint: "start frame",
    frameInput: { start: true, end: false },
  },
  {
    id: buildModelId(PROVIDER_ID, "ltx25-22b-int8_i2v_distilled"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "ltx25-22b-int8_i2v_distilled",
    label: "LTX 2.5 i2v",
    hint: "start frame",
    frameInput: { start: true, end: false },
  },
];

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
  return { images: SOGNI_IMAGE_MODELS, videos: SOGNI_VIDEO_MODELS, hidden: COLD_START_HIDDEN };
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
    // LoRA catalog rides the same refresh (its own 5-min cache); a failure
    // just leaves models unflagged — the picker hides, renders unaffected.
    const [models, loraCatalog] = await Promise.all([
      fetcher(),
      fetchLoraCatalog().catch(() => null),
    ]);
    if (!models.length) return; // Don't blank the picker on an empty answer.
    const loraModels = new Set(loraCatalog?.models ?? []);
    cache = {
      catalog: {
        images: toDescriptors(models, "image", loraModels),
        videos: toDescriptors(models, "video", loraModels),
        hidden: buildHiddenModels(models, loraModels),
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
  loraModels: Set<string> = new Set(),
): ModelDescriptor[] {
  const dynamic = models
    .filter(
      (model) =>
        model.media === kind &&
        model.workerCount > 0 &&
        !isExcluded(model.id),
    )
    .map((model) => {
      const meta = sogniModelMeta(model.id);
      // Frame capability: video families declare their own rules; every Sogni
      // image model takes a startingImage (img2img).
      const capability =
        kind === "video" ? frameCapability(model.id) : { start: true, end: false };
      const sibling = kind === "video" ? i2vSiblingId(model.id) : null;
      const siblingExists = sibling !== null && models.some((m) => m.id === sibling);
      return {
        id: buildModelId(PROVIDER_ID, model.id),
        providerId: PROVIDER_ID,
        kind,
        model: model.id,
        label: sogniCuratedLabel(model.id) ??
          (model.name?.trim() || prettifyModelId(model.id)),
        ...(meta?.hint ? { hint: meta.hint } : {}),
        ...(meta?.tier ? { tier: meta.tier } : {}),
        ...(meta?.useCase ? { useCase: meta.useCase } : {}),
        ...(meta?.costTier ? { costTier: meta.costTier } : {}),
        ...(meta?.contextImages ? { contextImages: meta.contextImages } : {}),
        stylesSupported: meta ? meta.stylesSupported : supportsStyles(model.id),
        uncensored: supportsUncensored(model.id),
        ...(capability ? { frameInput: capability } : {}),
        ...(sibling && siblingExists ? { i2vModelId: buildModelId(PROVIDER_ID, sibling) } : {}),
        ...(loraModels.has(model.id) ? { loraCapable: true } : {}),
      } satisfies ModelDescriptor;
    });

  // Recommended first (stable curated order inside the tier), the rest
  // alphabetically.
  const curatedOrder = new Map(
    (kind === "image" ? SOGNI_IMAGE_MODELS : SOGNI_VIDEO_MODELS).map((m, i) => [m.model, i]),
  );
  return dynamic.sort((a, b) => {
    const recA = a.tier === "recommended";
    const recB = b.tier === "recommended";
    if (recA !== recB) return recA ? -1 : 1;
    const rankA = curatedOrder.get(a.model);
    const rankB = curatedOrder.get(b.model);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** Registered-but-unpickable frame models: i2v siblings and flf2v keyframe
 * variants pulled from the live fetch so the service can swap to them. */
function buildHiddenModels(
  models: SogniAvailableModel[],
  loraModels: Set<string> = new Set(),
): ModelDescriptor[] {
  const built: ModelDescriptor[] = [];
  for (const model of models) {
    if (model.media !== "video" || model.workerCount <= 0) continue;
    const id = model.id.toLowerCase();
    const isI2v = id.includes("_i2v");
    const isFlf2v = id.includes("_flf2v");
    if (!isI2v && !isFlf2v) continue; // picker models are built by toDescriptors
    const capability = frameCapability(model.id);
    if (!capability) continue;
    built.push({
      id: buildModelId(PROVIDER_ID, model.id),
      providerId: PROVIDER_ID,
      kind: "video",
      model: model.id,
      label: model.name?.trim() || prettifyModelId(model.id),
      hint: isFlf2v ? "start + end frame" : "start frame",
      stylesSupported: supportsStyles(model.id),
      uncensored: supportsUncensored(model.id),
      frameInput: capability,
      ...(loraModels.has(model.id) ? { loraCapable: true } : {}),
    });
  }
  return built;
}

function isExcluded(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return EXCLUDED_ID_PATTERNS.some((pattern) => id.includes(pattern));
}

/** Fallback label when the API gives no usable name: `wan_v2.2-14b-fp8_t2v_lightx2v` → `Wan v2.2 14b t2v lightx2v`. */
function prettifyModelId(modelId: string): string {
  const cleaned = modelId
    .replace(/_(fp8|fp16|bf16|int8)(_scaled)?$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
