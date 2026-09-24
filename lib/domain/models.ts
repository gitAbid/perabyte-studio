import type { AspectKey, DurationKey, ResolutionKey } from "@/lib/constants";
import type { LoraSelection } from "@/lib/types";

/**
 * Provider-agnostic model + request contracts shared by the service layer
 * and every provider adapter. Providers translate these into their native
 * payloads; nothing else in the app knows how a provider is called.
 */
export type ModelKind = "image" | "video";

/** Frame conditioning a model accepts. Absent = prompt-only. */
export interface ModelFrameInput {
  start: boolean;
  end: boolean;
}

/** Render limits a video model enforces — the UI constrains its option
 * pickers to these (see `VideoLimits` for the field semantics). */
export interface ModelVideoLimits {
  duration: { min: number; max: number };
  /** Aspect presets accepted; empty = the model takes no ratio input. */
  ratios: readonly AspectKey[];
  /** Resolution presets honored; empty = fixed server-side default. */
  resolutions: readonly ResolutionKey[];
}

/** A continuity frame loaded from the media cache. */
export interface FrameImage {
  bytes: Buffer;
  contentType: string;
}

export interface ModelDescriptor {
  /** Stable app-wide id: `<providerId>:<providerModelId>`. */
  id: string;
  providerId: string;
  kind: ModelKind;
  /** Raw model id sent to the provider (e.g. `grok-imagine-image-2.0`). */
  model: string;
  label: string;
  /** Short qualifier shown in the model picker (speed / price / tier). */
  hint?: string;
  /** `false` when the model can't honour style presets — the UI disables the
   * style picker and the service skips folding the preset into the prompt.
   * Absent means supported. */
  stylesSupported?: boolean;
  /** `false` when the model always runs behind a safety checker — such models
   * are grouped under "Sensored" in the picker and ignore Uncensored Mode.
   * Absent means the model can render with the safety checker off. */
  uncensored?: boolean;
  /** Curated placement. Set only on hand-picked models; absent = picker tail. */
  tier?: "recommended";
  /** One-line "what it's good for" — the picker entry's second row. */
  useCase?: string;
  /** Rough cost signal for a compact badge. */
  costTier?: "free" | "credits" | "key-credits";
  /** Frame conditioning this model accepts. Absent = prompt-only. */
  frameInput?: ModelFrameInput;
  /** Model id (`<provider>:<model>`) to swap to when a start frame is present.
   * Absent when the model itself already takes frames. */
  i2vModelId?: string;
  /** Video render limits (duration range, accepted aspects, resolutions).
   * Absent on video models = no known constraint; UI shows everything. */
  videoLimits?: ModelVideoLimits;
  /** `true` when the provider exposes LoRA adapters for this model — the UI
   * shows the LoRA picker and the service keeps `loras` on the request.
   * Absent means prompt-only. */
  loraCapable?: boolean;
  /** Multi-reference edit capability (spec 2026-09-19): how many context
   * images the model accepts; min ≥ 1 means it requires at least one. */
  contextImages?: { min: number; max: number };
}

export function buildModelId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

export function parseModelId(id: string): { providerId: string; model: string } | null {
  const index = id.indexOf(":");
  if (index <= 0 || index === id.length - 1) return null;
  return { providerId: id.slice(0, index), model: id.slice(index + 1) };
}

/**
 * A fully-validated generation request in neutral form. The service layer
 * produces it; adapters map it onto their provider's API.
 */
export interface NormalizedGenerationRequest {
  kind: ModelKind;
  /** User prompt with the style preset already folded in. */
  prompt: string;
  negativePrompt: string;
  aspect: AspectKey;
  resolution: ResolutionKey;
  /** Video only; 0 for images. */
  durationSeconds: number;
  count: number;
  seed: number | null;
  /** Provider safety checker off (Uncensored Mode). */
  safe: boolean;
  /** Ask the provider to expand the prompt (where supported). */
  enhance: boolean;
  /** LoRA adapters in application order. Present only when the resolved
   * model is `loraCapable`; providers without LoRA support never see it. */
  loras?: LoraSelection[];
  /** Continuity frames resolved by the service layer (media-cache bytes). */
  startImage?: FrameImage;
  endImage?: FrameImage;
  /** Extra identity/location references (media-cache bytes). Consumed by
   * context-capable edit models; ignored elsewhere. */
  referenceImages?: FrameImage[];
}

export function durationToSeconds(duration: DurationKey): number {
  const seconds = Number.parseInt(duration, 10);
  return Number.isFinite(seconds) ? seconds : 5;
}

/**
 * True when a stored asset was rendered with the provider safety checker off
 * (Uncensored Mode), i.e. it may be adult (18+) content and should be masked
 * in the UI when the mask setting is on. Only an explicit `safe: false`
 * counts — legacy assets without the flag stay unmasked.
 */
export function isSensitiveAsset(asset: {
  settings?: { safe?: boolean };
}): boolean {
  return asset.settings?.safe === false;
}
