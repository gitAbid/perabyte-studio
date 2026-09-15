"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  titleFromPrompt,
} from "./constants";
import type { Asset, GenerationResponse, GenerationSettings, StoryScene } from "./types";

const STORAGE_KEY = "perabyte.assets.v2";
const SEED_KEY = "perabyte.seeded.v2";

const EMPTY: Asset[] = [];
let cache: Asset[] | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function persist(assets: Asset[]) {
  cache = assets;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(assets));
  } catch {
    /* storage full or blocked — the session still works in memory */
  }
  emit();
}

function read(): Asset[] {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as Asset[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): Asset[] {
  return read();
}

export function getServerSnapshot(): Asset[] {
  return EMPTY;
}

/* ------------------------------------------------------------------ */
/* Seed content so a fresh browser shows a populated History, matching  */
/* the mockup. Real renders from the provider, flagged as examples.     */
/* ------------------------------------------------------------------ */

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

function demoAsset(spec: DemoSpec): Asset {
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

/**
 * Ensure the fixed example assets exist. Safe to call from anywhere: it only
 * runs once per browser and **merges** instead of replacing, so a render
 * generated before the first History visit is never clobbered.
 */
export function seedDemoContent() {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(SEED_KEY)) return;
    window.localStorage.setItem(SEED_KEY, "1");

    const existing = read();
    const known = new Set(existing.map((a) => a.id));
    const additions = DEMO_SPECS.map(demoAsset).filter((a) => !known.has(a.id));
    if (!additions.length) return;

    persist(
      [...existing, ...additions].sort((a, b) => b.createdAt - a.createdAt),
    );
  } catch {
    /* ignore blocked storage */
  }
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export function getAsset(id: string): Asset | undefined {
  return read().find((a) => a.id === id);
}

export function addAsset(asset: Asset): Asset {
  persist([asset, ...read().filter((a) => a.id !== asset.id)]);
  return asset;
}

export function updateAsset(id: string, patch: Partial<Asset>): void {
  persist(read().map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

/** Functional scene update for a story asset (the queue's write path). */
export function updateStoryScenes(
  storyId: string,
  updater: (scenes: StoryScene[]) => StoryScene[],
): void {
  persist(
    read().map((asset) =>
      asset.id === storyId && asset.scenes
        ? { ...asset, scenes: updater(asset.scenes) }
        : asset,
    ),
  );
}

export function toggleFavorite(id: string): void {
  persist(read().map((a) => (a.id === id ? { ...a, favorite: !a.favorite } : a)));
}

export function removeAsset(id: string): void {
  persist(read().filter((a) => a.id !== id));
}

export function clearAssets(): void {
  persist([]);
}

/** Build a storable asset from a completed API response. */
export function assetFromResponse(
  response: GenerationResponse,
  settings: GenerationSettings,
  prompt: string,
): Asset {
  const primary = response.media[0];
  return {
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    kind: response.kind,
    title: titleFromPrompt(prompt),
    prompt,
    url: primary?.url ?? "",
    variants: response.media.map((m) => m.url),
    posterUrl: primary?.url,
    settings,
    createdAt: Date.now(),
    favorite: false,
    mode: response.kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
    meta: {
      requestId: response.requestId,
      seeds: response.media.map((m) => m.seed).join(", "),
      example: false,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useAssets(): { assets: Asset[]; ready: boolean } {
  const assets = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ready = useHydrated();
  return { assets, ready };
}

/** True once the client has mounted. */
export function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}