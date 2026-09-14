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

/**
 * One-click prompt enhancement: expand the user's text with concrete,
 * style-aware detail before generating. Deterministic and local — no API call.
 * Idempotent: enhancing twice does not pile up clauses.
 */
export function enhancePromptText(prompt: string, style: string): string {
  const base = prompt.trim().replace(/[.,\s]+$/, "");
  if (!base) return prompt;

  const STYLE_CLAUSES: Record<string, string> = {
    Realistic:
      "photorealistic detail, natural lighting, shallow depth of field, razor-sharp focus",
    Cinematic:
      "cinematic lighting, dramatic composition, anamorphic lens, subtle film grain",
    Anime:
      "clean anime line art, vibrant cel shading, expressive character acting",
    "Digital Art":
      "highly detailed digital painting, rich color grading, intricate textures",
    Watercolor:
      "soft watercolor washes, textured cold-press paper, delicate brush strokes",
    "3D Render":
      "physically-based 3d render, soft studio lighting, subsurface scattering",
    Animated:
      "stylized 3d animation still, warm palette, expressive poses",
    "Minimal Line Art":
      "minimal clean line art, generous negative space, balanced composition",
  };

  const extras = [
    STYLE_CLAUSES[style] ?? "highly detailed, balanced composition",
    "atmospheric depth, high resolution",
  ].filter((clause) => !base.toLowerCase().includes(clause.split(",")[0]));

  if (!extras.length) return prompt;
  return `${base}, ${extras.join(", ")}.`;
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

/**
 * Every render is displayed through our own origin.
 *
 * Two reasons this is not optional:
 * 1. Chrome's Opaque Response Blocking refuses the provider's rate-limit (429)
 *    responses for a cross-origin <img>, so failures surface as broken images
 *    with no way to retry.
 * 2. The `download` attribute is ignored cross-origin, so downloads must come
 *    from the same origin anyway.
 *
 * Local assets (pre-rendered examples, anything under /public) pass through.
 */
export function displaySrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (isAllowedMediaUrl(url)) {
    return `/api/media?u=${encodeURIComponent(url)}`;
  }
  return url;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}