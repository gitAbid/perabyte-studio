import { ASPECTS, type AspectKey, type ResolutionKey } from "@/lib/constants";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";

/**
 * Adapter: neutral generation settings → Sogni Supernet project params.
 * Field names and semantics verified against `@sogni-ai/sogni-client` 5.x
 * types (`ImageProjectParams` / `VideoProjectParams`): a project is one
 * generation request, and `numberOfMedia` outputs come back as URLs from
 * `project.waitForCompletion()`.
 */
export const PROVIDER_ID = "sogni";

/* ------------------------------------------------------------------ */
/* Model catalog — ids verified against the SDK README model list       */
/* ------------------------------------------------------------------ */

export const SOGNI_IMAGE_MODELS: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "krea2_turbo_fp8_scaled"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "krea2_turbo_fp8_scaled",
    label: "Krea 2 Turbo",
    hint: "Sogni · spark credits",
  },
  {
    id: buildModelId(PROVIDER_ID, "flux1-schnell-fp8"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "flux1-schnell-fp8",
    label: "Flux Schnell",
    hint: "Sogni · 4-step",
  },
  {
    id: buildModelId(PROVIDER_ID, "z_image_turbo_bf16"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "z_image_turbo_bf16",
    label: "Z-Image Turbo",
    hint: "Sogni · sharp",
  },
  {
    id: buildModelId(PROVIDER_ID, "chroma1-hd_fp8_scaled"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "chroma1-hd_fp8_scaled",
    label: "Chroma 1 HD",
    hint: "Sogni · high detail",
  },
];

export const SOGNI_VIDEO_MODELS: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "wan_v2.2-14b-fp8_t2v_lightx2v"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "wan_v2.2-14b-fp8_t2v_lightx2v",
    label: "WAN 2.2 LightX2V",
    hint: "Sogni · budget",
  },
  {
    id: buildModelId(PROVIDER_ID, "ltx25-22b-int8_t2v_distilled"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "ltx25-22b-int8_t2v_distilled",
    label: "LTX 2.5",
    hint: "Sogni · flagship",
  },
  {
    id: buildModelId(PROVIDER_ID, "seedance-2-0-mini"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "seedance-2-0-mini",
    label: "Seedance 2.0 Mini",
    hint: "Sogni · fast",
    // Provider workflow: takes only the raw prompt (no negative prompt, no
    // style directives) — the service must not fold presets into it.
    stylesSupported: false,
  },
];

/* ------------------------------------------------------------------ */
/* Payload mapping                                                     */
/* ------------------------------------------------------------------ */

export interface SogniImageParams {
  type: "image";
  modelId: string;
  positivePrompt: string;
  negativePrompt?: string;
  numberOfMedia: number;
  seed?: number;
  disableNSFWFilter?: boolean;
  sizePreset: string;
  width?: number;
  height?: number;
  outputFormat: "png";
  /** Img2img source (Buffer → SDK presigns an upload automatically). */
  startingImage?: Buffer;
}

export interface SogniVideoParams {
  type: "video";
  modelId: string;
  positivePrompt: string;
  negativePrompt?: string;
  numberOfMedia: number;
  seed?: number;
  disableNSFWFilter?: boolean;
  ratio: string;
  duration: number;
  outputFormat: "mp4";
  /** Start frame — the SDK presigns and uploads Buffers automatically. */
  referenceImage?: Buffer;
  /** End frame — only sent to models with `frameInput.end` (gated upstream). */
  referenceImageEnd?: Buffer;
  /** Seedance 2.5: export the exact final frame (job.lastFrameUrl). */
  returnLastFrame?: boolean;
}

/** Snap to the 8px grid most diffusion UNets expect. */
function snap8(value: number): number {
  return Math.max(8, Math.round(value / 8) * 8);
}

export function toImageParams(
  model: string,
  request: NormalizedGenerationRequest,
): SogniImageParams {
  const base = ASPECTS[request.aspect];
  const scale = resolutionScale(request.resolution);
  return {
    type: "image",
    modelId: model,
    positivePrompt: request.prompt,
    negativePrompt: request.negativePrompt.trim() || undefined,
    numberOfMedia: Math.min(10, Math.max(1, request.count)),
    seed: toUint32Seed(request.seed),
    disableNSFWFilter: !request.safe,
    sizePreset: "custom",
    width: snap8(base.width * scale),
    height: snap8(base.height * scale),
    outputFormat: "png",
    ...(request.startImage ? { startingImage: request.startImage.bytes } : {}),
  };
}

function resolutionScale(resolution: ResolutionKey): number {
  const scales: Record<ResolutionKey, number> = {
    "720p": 0.75,
    "1080p": 1,
    "1440p": 1.25,
    "4K": 1.5,
  };
  return scales[resolution] ?? 1;
}

function toUint32Seed(seed: number | null): number {
  const value = seed ?? 0;
  return value >>> 0;
}

/**
 * Seedance workflows reject `negativePrompt`; exclusions are folded into the
 * prompt as an explicit avoidance clause instead (same trick as apikey.fan).
 */
const FOLD_NEGATIVE_MODELS = new Set(["seedance-2-0-mini"]);

/** Duration ranges per model family, from the SDK's `VideoProjectParams` docs. */
const VIDEO_DURATION_LIMITS: Record<string, { min: number; max: number }> = {
  "wan_v2.2-14b-fp8_t2v_lightx2v": { min: 1, max: 10 },
  "ltx25-22b-int8_t2v_distilled": { min: 2, max: 20 },
  "seedance-2-0-mini": { min: 4, max: 15 },
};

/** Sogni video ratios; our 4:5 / 3:2 snap to the nearest supported box. */
const VIDEO_RATIOS: Partial<Record<AspectKey, string>> = {
  "16:9": "16:9",
  "9:16": "9:16",
  "1:1": "1:1",
  "4:5": "3:4",
  "3:2": "4:3",
};

export function toVideoParams(
  model: string,
  request: NormalizedGenerationRequest,
): SogniVideoParams {
  const limits = VIDEO_DURATION_LIMITS[model] ?? { min: 1, max: 10 };
  const negative = request.negativePrompt.trim();
  const fold = FOLD_NEGATIVE_MODELS.has(model);
  const positive = fold && negative
    ? `${request.prompt}. Avoid: ${negative}.`
    : request.prompt;

  return {
    type: "video",
    modelId: model,
    positivePrompt: positive,
    negativePrompt: !fold && negative ? negative : undefined,
    numberOfMedia: Math.min(10, Math.max(1, request.count)),
    seed: toUint32Seed(request.seed),
    disableNSFWFilter: !request.safe,
    ratio: VIDEO_RATIOS[request.aspect] ?? "16:9",
    duration: Math.min(limits.max, Math.max(limits.min, Math.round(request.durationSeconds))),
    outputFormat: "mp4",
    ...(request.startImage ? { referenceImage: request.startImage.bytes } : {}),
    ...(request.endImage ? { referenceImageEnd: request.endImage.bytes } : {}),
    ...(model.startsWith("seedance-2-5") ? { returnLastFrame: true } : {}),
  };
}
