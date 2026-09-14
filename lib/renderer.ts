import {
  ASPECTS,
  IMAGE_STYLES,
  RESOLUTIONS,
  VIDEO_STYLES,
  type AspectKey,
  type GenerationKind,
  type ResolutionKey,
} from "./constants";

export const PROVIDER_HOST = "image.pollinations.ai";

export interface RenderRequest {
  kind: GenerationKind;
  prompt: string;
  aspect: AspectKey;
  resolution: ResolutionKey;
  style: string;
  seed?: number | string | null;
  negativePrompt?: string;
  enhance?: boolean;
}

/** Fold the chosen style preset into the prompt sent to the render provider. */
export function styleWithPrompt(prompt: string, style: string): string {
  const preset =
    (IMAGE_STYLES as Record<string, string>)[style] ??
    (VIDEO_STYLES as Record<string, string>)[style] ??
    "";
  return preset ? `${prompt.trim()}, ${preset}` : prompt.trim();
}

function round8(n: number) {
  return Math.max(256, Math.round(n / 8) * 8);
}

/** Resolve final pixel dimensions from aspect + resolution preset. */
export function resolveDimensions(
  aspect: AspectKey,
  resolution: ResolutionKey,
): { width: number; height: number } {
  const base = ASPECTS[aspect] ?? ASPECTS["16:9"];
  const scale = RESOLUTIONS[resolution]?.scale ?? 1;
  return {
    width: round8(base.width * scale),
    height: round8(base.height * scale),
  };
}

/**
 * Build a provider URL for a single frame. Deterministic: same prompt +
 * settings + seed returns the same render, which is what makes retries and
 * history thumbnails safe to re-fetch without re-billing generation.
 */
export function buildMediaUrl(req: RenderRequest, seed: number): string {
  const { width, height } = resolveDimensions(req.aspect, req.resolution);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: "flux",
    nologo: "true",
  });
  if (req.enhance) params.set("enhance", "true");
  if (req.negativePrompt?.trim()) params.set("negative", req.negativePrompt.trim());

  const prompt = styleWithPrompt(req.prompt, req.style);
  return `https://${PROVIDER_HOST}/prompt/${encodeURIComponent(prompt)}?${params}`;
}

/** Server-side guard: only our render provider may be proxied to the client. */
export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === PROVIDER_HOST;
  } catch {
    return false;
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}