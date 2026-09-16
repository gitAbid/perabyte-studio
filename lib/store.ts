"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { titleFromPrompt } from "./constants";
import type { Asset, GenerationResponse, GenerationSettings, StoryScene } from "./types";
import { parseAssetRows } from "./repositories/asset-row";
import { storeTransport } from "./store-transport";

/**
 * The client asset store (History + story projects). The public API is the
 * same external-store contract the app has always used; the backing moved
 * server-side (durable-jobs spec Phase A): every mutation applies
 * optimistically to the in-memory cache and mirrors to /api/assets, so a
 * browser loses nothing by clearing storage and any browser sees the same
 * library. Legacy localStorage rows are imported once, then retired to a
 * read-only fallback.
 */

const LEGACY_STORAGE_KEY = "perabyte.assets.v2";
const MIGRATED_KEY = "perabyte.assets.migrated.v3";

/* Demo content lives in ./demo-content so the server repository can seed
 * the example strip; only the export is re-exposed here for the generator's
 * example strip. */
export { DEMO_SPECS } from "./demo-content";
export type { DemoSpec } from "./demo-content";

/**
 * Legacy hook: demo rows are now seeded server-side on first `/api/assets`
 * read. Kept as a no-op so existing imports keep working.
 */
export function seedDemoContent() {}

const EMPTY: Asset[] = [];
let cache: Asset[] | null = null;
let hydration: Promise<Asset[]> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Optimistic local write + fire-and-forget server mirror. A server
 * failure never breaks the session — memory stays authoritative for the
 * tab and the next successful write re-syncs that row. */
function persist(next: Asset[], sync?: (t: NonNullable<ReturnType<typeof storeTransport>>) => Promise<void>) {
  cache = next;
  const transport = storeTransport();
  if (transport && sync) {
    void sync(transport).catch(() => {
      /* server unreachable — the session still works in memory */
    });
  }
  emit();
}

function read(): Asset[] {
  return cache ?? EMPTY;
}

/** Rows this browser generated before the server-store upgrade. Demo rows
 * are skipped — the server seeds those itself. */
function readLegacyRows(): Asset[] {
  try {
    if (window.localStorage.getItem(MIGRATED_KEY)) return [];
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    return parseAssetRows(JSON.parse(raw)).filter((a) => a.meta?.example !== true);
  } catch {
    return [];
  }
}

/**
 * One-time boot hydration: import legacy localStorage rows into the server
 * store, then adopt the server list as the cache. Resolves with the adopted
 * list (callers rehydrate story queues from it). Idempotent per page load;
 * a failure resolves with whatever the tab already has.
 */
export function ensureStoreHydrated(): Promise<Asset[]> {
  if (hydration) return hydration;
  const transport = storeTransport();
  if (!transport) {
    hydration = Promise.resolve(read());
    return hydration;
  }
  hydration = (async () => {
    const legacy = readLegacyRows();
    if (legacy.length) {
      try {
        await transport.importLegacy(legacy);
        try {
          window.localStorage.setItem(MIGRATED_KEY, "1");
        } catch {
          /* storage blocked — the import skip-list on the server still makes
             a re-run a no-op */
        }
      } catch {
        /* server unreachable — retry next boot; the import is idempotent */
      }
    }
    try {
      cache = await transport.list();
      emit();
    } catch {
      cache = cache ?? []; // offline: memory (or an empty library) still works
      emit();
    }
    return cache;
  })();
  return hydration;
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
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export function getAsset(id: string): Asset | undefined {
  return read().find((a) => a.id === id);
}

export function addAsset(asset: Asset): Asset {
  persist([asset, ...read().filter((a) => a.id !== asset.id)], (t) => t.create(asset));
  return asset;
}

export function updateAsset(id: string, patch: Partial<Asset>): void {
  persist(read().map((a) => (a.id === id ? { ...a, ...patch } : a)), (t) => t.patch(id, patch));
}

/** Functional scene update for a story asset (the queue's write path). */
export function updateStoryScenes(
  storyId: string,
  updater: (scenes: StoryScene[]) => StoryScene[],
): void {
  const next = read().map((asset) =>
    asset.id === storyId && asset.scenes
      ? { ...asset, scenes: updater(asset.scenes) }
      : asset,
  );
  const story = next.find((a) => a.id === storyId);
  persist(next, (t) =>
    story ? t.patch(storyId, { scenes: story.scenes }) : Promise.resolve(),
  );
}

export function toggleFavorite(id: string): void {
  const target = read().find((a) => a.id === id);
  persist(
    read().map((a) => (a.id === id ? { ...a, favorite: !a.favorite } : a)),
    (t) => t.patch(id, { favorite: !target?.favorite }),
  );
}

export function removeAsset(id: string): void {
  removeAssets([id]);
}

/** Delete several assets in one persist/notify pass (bulk manage actions). */
export function removeAssets(ids: string[]): void {
  const doomed = new Set(ids);
  persist(read().filter((a) => !doomed.has(a.id)), (t) => t.remove(ids));
}

/** "Clean library": clears History assets on the server; story projects are
 * kept (they are work, not history). */
export function clearAssets(): void {
  persist([], (t) => t.clear());
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
  useEffect(() => {
    void ensureStoreHydrated();
  }, []);
  return { assets, ready };
}

/** True once the client has mounted. */
export function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

/** Test hook: drop the cache and hydration state (node tests only). */
export function resetStoreForTests(): void {
  cache = null;
  hydration = null;
}
