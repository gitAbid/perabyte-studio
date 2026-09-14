export const PROMPT_MAX = 1000;

export type GenerationKind = "image" | "video";

/** Aspect presets — the pixel box we ask the render provider for. */
export const ASPECTS = {
  "16:9": { width: 1280, height: 720, label: "16:9", hint: "Landscape" },
  "9:16": { width: 720, height: 1280, label: "9:16", hint: "Portrait" },
  "1:1": { width: 1024, height: 1024, label: "1:1", hint: "Square" },
  "4:5": { width: 896, height: 1120, label: "4:5", hint: "Social" },
  "3:2": { width: 1200, height: 800, label: "3:2", hint: "Photo" },
} as const;

export type AspectKey = keyof typeof ASPECTS;

export const RESOLUTIONS = {
  "720p": { scale: 0.75, label: "720p  ·  HD" },
  "1080p": { scale: 1, label: "1080p  ·  Full HD" },
  "1440p": { scale: 1.25, label: "1440p  ·  Quad HD" },
  "4K": { scale: 1.5, label: "4K  ·  Ultra HD" },
} as const;

export type ResolutionKey = keyof typeof RESOLUTIONS;

export const IMAGE_STYLES = {
  Realistic: "photorealistic, natural lighting, sharp focus, high detail",
  Cinematic: "cinematic lighting, film grain, dramatic composition, depth of field",
  Anime: "anime illustration, cel shading, expressive line work, vibrant palette",
  "Digital Art": "digital painting, painterly brushwork, rich colour grading",
  Watercolor: "watercolour on textured paper, soft bleeding edges, muted washes",
  "3D Render": "octane render, volumetric light, glossy materials, studio setup",
  "Minimal Line Art": "minimal line art, flat colour blocks, generous negative space",
  "Photo Studio": "studio softbox lighting, seamless backdrop, editorial photography",
} as const;

export const VIDEO_STYLES = {
  Cinematic: "cinematic colour grade, anamorphic flares, smooth camera move",
  Documentary: "handheld documentary look, natural light, candid framing",
  Animated: "stylised animation, bold shapes, snappy timing",
  "Slow Motion": "slow motion, shallow depth of field, suspended particles",
  Drone: "aerial drone shot, sweeping descent, golden hour haze",
} as const;

export type ImageStyleKey = keyof typeof IMAGE_STYLES;
export type VideoStyleKey = keyof typeof VIDEO_STYLES;

export const DURATIONS = ["3s", "5s", "8s", "10s"] as const;
export type DurationKey = (typeof DURATIONS)[number];

export const VARIANT_COUNTS = [1, 2, 3, 4] as const;

export const DEFAULT_IMAGE_SETTINGS = {
  kind: "image" as GenerationKind,
  aspect: "16:9" as AspectKey,
  resolution: "1080p" as ResolutionKey,
  style: "Realistic" as ImageStyleKey,
  duration: "5s" as DurationKey,
  count: 2 as number,
  seed: "" as string,
  negativePrompt: "" as string,
  enhance: true,
};

export const DEFAULT_VIDEO_SETTINGS = {
  ...DEFAULT_IMAGE_SETTINGS,
  kind: "video" as GenerationKind,
  aspect: "9:16" as AspectKey,
  style: "Cinematic" as VideoStyleKey,
  duration: "5s" as DurationKey,
};

export const PROMPT_PLACEHOLDERS = {
  image:
    "A serene mountain landscape with a lake, sunrise, and pine trees.",
  video: "A cinematic shot of a car driving through a mountain road at sunset.",
  story: "Describe the first scene of your story...",
};

/** Deterministic short title derived from the prompt, for History rows. */
export function titleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Untitled generation";
  const words = cleaned.split(" ").slice(0, 4).join(" ");
  const titled = words
    .split(" ")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return titled.length > 42 ? `${titled.slice(0, 42)}…` : titled;
}

export function modeLabel(kind: GenerationKind): string {
  return kind === "image" ? "Solo Mode (Image)" : "Solo Mode (Video)";
}