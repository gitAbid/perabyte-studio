import type { FrameImage, ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import type { NormalizedGenerationRequest } from "@/lib/domain/models";
import type { ResolutionKey } from "@/lib/constants";

/**
 * Adapter: neutral generation settings → apikey.fan (xAI-compatible) payloads.
 * Everything provider-specific about how our configs are transferred lives in
 * this one module, so a payload-format change is a single-file edit.
 */
export const PROVIDER_ID = "apikey-fan";

/* ------------------------------------------------------------------ */
/* Model catalog — IDs verified against the sub2api source and docs.x.ai */
/* ------------------------------------------------------------------ */

export const APIKEY_FAN_IMAGE_MODELS: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "grok-imagine-image-2.0"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "grok-imagine-image-2.0",
    label: "Grok Imagine 2.0",
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship realism — uncensored-ready",
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  },
  {
    id: buildModelId(PROVIDER_ID, "grok-imagine-image-quality"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "grok-imagine-image-quality",
    label: "Grok Imagine Quality",
    hint: "max detail",
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  },
  {
    id: buildModelId(PROVIDER_ID, "grok-imagine-image"),
    providerId: PROVIDER_ID,
    kind: "image",
    model: "grok-imagine-image",
    label: "Grok Imagine",
    hint: "fast · budget",
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  },
];

export const APIKEY_FAN_VIDEO_MODELS: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "grok-imagine-video-1.5"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "grok-imagine-video-1.5",
    label: "Grok Video 1.5",
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship realism — start-frame capable",
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  },
  {
    id: buildModelId(PROVIDER_ID, "grok-imagine-video"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "grok-imagine-video",
    label: "Grok Video",
    hint: "budget",
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  },
];

/* ------------------------------------------------------------------ */
/* Payload mapping                                                     */
/* ------------------------------------------------------------------ */

/** xAI exposes a resolution tier rather than pixel heights. */
const RESOLUTION_TIERS: Record<ResolutionKey, string> = {
  "720p": "1k",
  "1080p": "1k",
  "1440p": "2k",
  "4K": "2k",
};

/**
 * The images API has no negative-prompt parameter, so exclusions are folded
 * into the prompt as an explicit avoidance clause.
 */
export function foldNegativePrompt(prompt: string, negativePrompt: string): string {
  const negative = negativePrompt.trim();
  if (!negative) return prompt;
  return `${prompt}. Avoid: ${negative}.`;
}

export interface ImagePayloadRequest {
  prompt: string;
  count: number;
  aspect: NormalizedGenerationRequest["aspect"];
  resolution: ResolutionKey;
}

/**
 * Primary image payload; `prompt` should already have the negative folded in
 * (see `foldNegativePrompt`). `image_config` carries the aspect ratio and
 * resolution tier; `fallbackImagePayload` drops it for providers that reject
 * the field (see image.provider's adaptive retry).
 */
export function toImagePayload(model: string, request: ImagePayloadRequest) {
  const payload: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: Math.min(10, Math.max(1, request.count)),
    response_format: "b64_json",
    image_config: {
      aspect_ratio: request.aspect,
      resolution: RESOLUTION_TIERS[request.resolution] ?? "1k",
    },
  };
  const fallbackPayload: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: payload.n as number,
    response_format: "b64_json",
  };
  return { payload, fallbackPayload };
}

export interface VideoPayloadRequest {
  prompt: string;
  durationSeconds: number;
  /** Start frame (image-to-video); sent as `image: { url }`. */
  image?: FrameImage;
}

/** Video generation is capped at 15 seconds by the provider. */
export const MAX_VIDEO_SECONDS = 15;

/** Grok's first-frame input is a URL — a data URI carries our cached bytes. */
export function frameToDataUri(image: FrameImage): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}

export function toVideoPayload(model: string, request: VideoPayloadRequest) {
  return {
    model,
    prompt: request.prompt,
    duration: Math.min(MAX_VIDEO_SECONDS, Math.max(1, Math.round(request.durationSeconds))),
    ...(request.image ? { image: { url: frameToDataUri(request.image) } } : {}),
  };
}

/**
 * Grok img2img — `/v1/images/edits` accepts a public URL or data URI in
 * `image.url` (verified: docs.x.ai, see docs/sogni-api-guide.md §7).
 */
export function toImageEditsPayload(
  model: string,
  request: { prompt: string; image: FrameImage; count: number },
) {
  return {
    model,
    prompt: request.prompt,
    n: Math.min(10, Math.max(1, request.count)),
    response_format: "b64_json",
    image: { url: frameToDataUri(request.image), type: "image_url" },
  };
}
