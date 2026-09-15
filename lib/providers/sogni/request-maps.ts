import { ASPECTS, type AspectKey, type ResolutionKey } from "@/lib/constants";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import { isMinimaxH3, minimaxH3Dimensions, sogniVideoLimits } from "@/lib/providers/sogni/video-limits";

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
  /** LoRA adapter ids in application order (max 8, server-enforced). */
  loras?: string[];
  /** Strength per `loras` entry, positionally matched — bipolar, not 0–1. */
  loraStrengths?: number[];
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
  /** MiniMax H3 only: canvas on its 32px grid within its pixel caps. */
  width?: number;
  height?: number;
  /** Start frame — the SDK presigns and uploads Buffers automatically. */
  referenceImage?: Buffer;
  /** End frame — only sent to models with `frameInput.end` (gated upstream). */
  referenceImageEnd?: Buffer;
  /** Seedance 2.5: export the exact final frame (job.lastFrameUrl). */
  returnLastFrame?: boolean;
  /** LoRA adapter ids in application order (MiniMax H3 families only). */
  loras?: string[];
  /** Strength per `loras` entry, positionally matched — bipolar, not 0–1. */
  loraStrengths?: number[];
}

/** Sogni's render pipeline rejects requests over this cap at submit. */
const MAX_LORAS = 8;

/**
 * Split the normalized selections into the SDK's positionally-matched pair.
 * Strengths are always sent explicitly: omitting the array means 1.0 for
 * every LoRA, which is NOT the same as each LoRA's own `ui.default`.
 */
function loraFields(
  request: NormalizedGenerationRequest,
): Pick<SogniImageParams, "loras" | "loraStrengths"> {
  const selections = (request.loras ?? []).slice(0, MAX_LORAS);
  if (!selections.length) return {};
  return {
    loras: selections.map((l) => l.loraId),
    loraStrengths: selections.map((l) => l.strength),
  };
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
    ...loraFields(request),
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
/** MiniMax H3 has no negative-prompt input — fold exclusions into the positive. */
function foldsNegative(model: string): boolean {
  return model === "seedance-2-0-mini" || isMinimaxH3(model);
}

/**
 * Duration ranges per model family, from the SDK's `VideoProjectParams` docs.
 * The server rejects durations outside the family range (MiniMax H3 frames
 * must land on its `124 + n*17` grid, so its floor is 124/24 ≈ 5.167s) —
 * clamping here keeps a mismatched request renderable instead of dead.
 */
export function clampVideoDuration(model: string, seconds: number): number {
  const { min, max } = sogniVideoLimits(model).duration;
  return Math.min(max, Math.max(min, Math.round(seconds)));
}

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
  const limits = sogniVideoLimits(model);
  const negative = request.negativePrompt.trim();
  const fold = foldsNegative(model);
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
    duration: clampVideoDuration(model, request.durationSeconds),
    outputFormat: "mp4",
    // Only MiniMax H3 accepts explicit dimensions (32px grid, ≤1344px/axis,
    // ≤1,032,192 px) — other families render at their server-side default.
    ...(isMinimaxH3(model)
      ? minimaxH3Dimensions(request.aspect, request.resolution)
      : {}),
    ...(request.startImage ? { referenceImage: request.startImage.bytes } : {}),
    ...(request.endImage ? { referenceImageEnd: request.endImage.bytes } : {}),
    ...(model.startsWith("seedance-2-5") ? { returnLastFrame: true } : {}),
    ...loraFields(request),
  };
}
