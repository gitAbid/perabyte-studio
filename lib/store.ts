"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { titleFromPrompt } from "./constants";
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
/* Demo content lives in ./demo-content so the server repository can    */
/* seed the example strip; only the export is re-exposed here for the   */
/* generator's example strip.                                          */
/* ------------------------------------------------------------------ */

export { DEMO_SPECS } from "./demo-content";
export type { DemoSpec } from "./demo-content";

/**
 * Legacy hook: demo rows are now seeded server-side on first `/api/assets`
 * read. Kept as a no-op so existing imports keep working until Task 8
 * replaces the bootstrap.
 */
export function seedDemoContent() {}

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
  removeAssets([id]);
}

/** Delete several assets in one persist/notify pass (bulk manage actions). */
export function removeAssets(ids: string[]): void {
  const doomed = new Set(ids);
  persist(read().filter((a) => !doomed.has(a.id)));
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