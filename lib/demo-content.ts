import { DEFAULT_IMAGE_SETTINGS, DEFAULT_VIDEO_SETTINGS } from "./constants";
import type { Asset, GenerationSettings } from "./types";

const HOUR = 3_600_000;

export interface DemoSpec {
  title: string;
  prompt: string;
  kind: "image" | "video";
  aspect: "16:9" | "9:16" | "4:5" | "1:1" | "3:2";
  style: string;
  ageHours: number;
  seed: number;
  /** Pre-rendered example stored in /public/demo (see scripts/prerender_examples.py). */
  file: string;
}

/** Pre-rendered examples (see scripts/prerender_examples.py), also used by the
 * generator's "try an example" strip. */
export const DEMO_SPECS: DemoSpec[] = [
  {
    title: "Mountain Lake",
    prompt: "A serene mountain landscape with a lake, sunrise, and pine trees",
    kind: "image",
    aspect: "16:9",
    style: "Realistic",
    ageHours: 12,
    seed: 4821,
    file: "/demo/mountain-lake.jpg",
  },
  {
    title: "City at Night",
    prompt: "A neon city street at night in the rain, reflections on the road",
    kind: "video",
    aspect: "9:16",
    style: "Cinematic",
    ageHours: 30,
    seed: 7712,
    file: "/demo/city-night.jpg",
  },
  {
    title: "Fantasy Forest",
    prompt: "A glowing fantasy forest with floating lights and ancient mossy trees",
    kind: "image",
    aspect: "16:9",
    style: "Digital Art",
    ageHours: 52,
    seed: 3390,
    file: "/demo/fantasy-forest.jpg",
  },
  {
    title: "Ocean Sunset",
    prompt: "A calm ocean sunset with soft clouds and a distant sailboat",
    kind: "image",
    aspect: "4:5",
    style: "Realistic",
    ageHours: 78,
    seed: 9014,
    file: "/demo/ocean-sunset.jpg",
  },
  {
    title: "Robot in City",
    prompt: "A friendly robot walking through a futuristic city plaza at dusk",
    kind: "video",
    aspect: "9:16",
    style: "Animated",
    ageHours: 120,
    seed: 2265,
    file: "/demo/robot-city.jpg",
  },
  {
    title: "Winter Village",
    prompt: "A cosy winter village covered in snow beneath a purple evening sky",
    kind: "image",
    aspect: "16:9",
    style: "Watercolor",
    ageHours: 160,
    seed: 6120,
    file: "/demo/winter-village.jpg",
  },
];

export function demoAsset(spec: DemoSpec): Asset {
  const base =
    spec.kind === "video" ? DEFAULT_VIDEO_SETTINGS : DEFAULT_IMAGE_SETTINGS;
  const settings: GenerationSettings = {
    ...base,
    kind: spec.kind,
    aspect: spec.aspect,
    style: spec.style,
  };
  return {
    id: `demo_${spec.seed}`,
    kind: spec.kind,
    title: spec.title,
    prompt: spec.prompt,
    url: spec.file,
    variants: [spec.file],
    posterUrl: spec.file,
    settings,
    createdAt: Date.now() - spec.ageHours * HOUR,
    favorite: false,
    mode: spec.kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
    meta: { example: true, seed: spec.seed },
  };
}

/** Merge the demo rows into an existing list, skipping known ids, newest
 * first — the server repository calls this once on first boot. */
export function withDemoRows(existing: Asset[]): Asset[] {
  const known = new Set(existing.map((a) => a.id));
  const additions = DEMO_SPECS.map(demoAsset).filter((a) => !known.has(a.id));
  if (!additions.length) return existing;
  return [...existing, ...additions].sort((a, b) => b.createdAt - a.createdAt);
}
