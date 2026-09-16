import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";

/**
 * The hand-curated Sogni catalog: stable labels/order plus every picker claim
 * (tier, use case, cost). Nothing about WHERE a model sits in the picker is
 * guessed from ids — curated rows declare it here, and un-curated live models
 * resolve to `null` so they render unclaimed in the tail.
 */

export const PROVIDER_ID = "sogni";

interface CuratedModel {
  kind: ModelKind;
  model: string;
  label: string;
  hint?: string;
  tier?: "recommended";
  useCase?: string;
  costTier?: "free" | "credits" | "key-credits";
  /** Provider-workflow models that take only the raw prompt. */
  stylesSupported?: boolean;
  /** Family base id — live variants starting with it inherit this entry. */
  familyBase?: string;
  /** Cold-start chain pairing: the t2v entry's registered i2v sibling (must
   * exist in COLD_START_HIDDEN) so frame chaining works before the live
   * catalog warms. */
  i2vModel?: string;
}

const CURATED: CuratedModel[] = [
  {
    kind: "image",
    model: "krea2_turbo_fp8_scaled",
    label: "Krea 2 Turbo",
    hint: "premium credits",
    tier: "recommended",
    useCase: "Flagship all-rounder — crisp subjects, fast",
    costTier: "credits",
    familyBase: "krea2_turbo",
  },
  {
    kind: "image",
    model: "flux1-schnell-fp8",
    label: "Flux Schnell",
    hint: "4-step",
    tier: "recommended",
    useCase: "Fast everyday workhorse",
    costTier: "credits",
    familyBase: "flux1-schnell",
  },
  {
    kind: "image",
    model: "z_image_turbo_bf16",
    label: "Z-Image Turbo",
    hint: "sharp",
    tier: "recommended",
    useCase: "Sharp detail, strong text rendering",
    costTier: "credits",
    familyBase: "z_image_turbo",
  },
  {
    kind: "image",
    model: "chroma1-hd_fp8_scaled",
    label: "Chroma 1 HD",
    hint: "high detail",
    tier: "recommended",
    useCase: "Maximum detail on complex scenes",
    costTier: "credits",
    familyBase: "chroma1-hd",
  },
  {
    kind: "video",
    model: "wan_v2.2-14b-fp8_t2v_lightx2v",
    label: "WAN 2.2 LightX2V",
    hint: "budget",
    tier: "recommended",
    useCase: "Quick budget clips, 1–10s",
    costTier: "credits",
    familyBase: "wan_v2.2-14b-fp8_t2v",
    i2vModel: "wan_v2.2-14b-fp8_i2v_lightx2v",
  },
  {
    kind: "video",
    model: "ltx25-22b-int8_t2v_distilled",
    label: "LTX 2.5",
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship motion quality, 2–20s",
    costTier: "credits",
    familyBase: "ltx25-22b-int8_t2v",
    i2vModel: "ltx25-22b-int8_i2v_distilled",
  },
  {
    kind: "video",
    model: "seedance-2-0-mini",
    label: "Seedance 2.0 Mini",
    hint: "fast",
    tier: "recommended",
    useCase: "Fastest clips — prompt only, no style presets",
    costTier: "credits",
    stylesSupported: false,
  },
  {
    kind: "video",
    model: "seedance-2-0",
    label: "Seedance 2.0",
    hint: "cinematic",
    tier: "recommended",
    useCase: "Cinematic quality — start-frame capable, no style presets",
    costTier: "credits",
    stylesSupported: false,
    familyBase: "seedance-2-0",
  },
];

function toDescriptor(entry: CuratedModel): ModelDescriptor {
  return {
    id: buildModelId(PROVIDER_ID, entry.model),
    providerId: PROVIDER_ID,
    kind: entry.kind,
    model: entry.model,
    label: entry.label,
    ...(entry.hint ? { hint: entry.hint } : {}),
    ...(entry.tier ? { tier: entry.tier } : {}),
    ...(entry.useCase ? { useCase: entry.useCase } : {}),
    ...(entry.costTier ? { costTier: entry.costTier } : {}),
    ...(entry.stylesSupported === false ? { stylesSupported: false } : {}),
    ...(entry.i2vModel ? { i2vModelId: buildModelId(PROVIDER_ID, entry.i2vModel) } : {}),
  };
}

/** Cold-start picker catalog; `catalog.ts` also uses these as the curated
 * overlay on the live fetch. */
export const SOGNI_IMAGE_MODELS: ModelDescriptor[] = CURATED.filter(
  (entry) => entry.kind === "image",
).map(toDescriptor);

export const SOGNI_VIDEO_MODELS: ModelDescriptor[] = CURATED.filter(
  (entry) => entry.kind === "video",
).map(toDescriptor);

const EXACT_META = new Map(CURATED.map((entry) => [entry.model, entry]));
const FAMILY_META = CURATED.filter((entry) => entry.familyBase).sort(
  (a, b) => (b.familyBase?.length ?? 0) - (a.familyBase?.length ?? 0),
);

/** Curated claims for a live model id: exact match first, then the longest
 * matching family prefix. `null` = not curated — the UI makes no claims. */
export function sogniModelMeta(modelId: string): CuratedModel | null {
  const exact = EXACT_META.get(modelId);
  if (exact) return exact;
  return FAMILY_META.find((entry) => modelId.startsWith(entry.familyBase!)) ?? null;
}

/** The curated display label, only for ids curated verbatim. Family variants
 * keep their live/API name so same-family picker rows stay distinguishable. */
export function sogniCuratedLabel(modelId: string): string | null {
  return EXACT_META.get(modelId)?.label ?? null;
}
