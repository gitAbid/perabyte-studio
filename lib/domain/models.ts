import type { AspectKey, DurationKey, ResolutionKey } from "@/lib/constants";

/**
 * Provider-agnostic model + request contracts shared by the service layer
 * and every provider adapter. Providers translate these into their native
 * payloads; nothing else in the app knows how a provider is called.
 */
export type ModelKind = "image" | "video";

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
}

export function durationToSeconds(duration: DurationKey): number {
  const seconds = Number.parseInt(duration, 10);
  return Number.isFinite(seconds) ? seconds : 5;
}
