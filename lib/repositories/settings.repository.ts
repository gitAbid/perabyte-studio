"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { GenerationKind } from "@/lib/constants";

/**
 * Client-side user settings repository (localStorage), following the same
 * external-store pattern as the assets store. The Uncensored Mode toggle
 * lives here — disabled by default — and is the single gate for all
 * uncensored features across the app.
 */
export interface UserSettings {
  uncensoredEnabled: boolean;
  /** Blur 18+/uncensored media in the UI until the user reveals it. On by default. */
  maskUncensored: boolean;
  imageModel: string | null;
  videoModel: string | null;
  /** Saved characters attached in Solo Mode — anchor order follows the array. */
  soloCharacterIds: string[];
  /** Saved characters attached in Story Mode — anchor order follows the array. */
  storyCharacterIds: string[];
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  uncensoredEnabled: false,
  maskUncensored: true,
  imageModel: null,
  videoModel: null,
  soloCharacterIds: [],
  storyCharacterIds: [],
};

const STORAGE_KEY = "perabyte.settings.v1";

const listeners = new Set<() => void>();
let cache: UserSettings | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function persist(next: UserSettings) {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked — the session still works in memory */
  }
  emit();
}

/** Single-character fields from before the cast feature — promoted to the
 * array fields so an existing attach survives the upgrade. */
function migrateLegacyCharacters(
  parsed: Record<string, unknown>,
): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  const pairs = [
    ["soloCharacterId", "soloCharacterIds"],
    ["storyCharacterId", "storyCharacterIds"],
  ] as const;
  for (const [legacyKey, idsKey] of pairs) {
    if (!Array.isArray(parsed[idsKey]) && typeof parsed[legacyKey] === "string") {
      patch[idsKey] = [parsed[legacyKey] as string].filter(Boolean);
    }
  }
  return patch;
}

function read(): UserSettings {
  if (cache) return cache;
  if (typeof window === "undefined") return DEFAULT_USER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    cache = {
      ...DEFAULT_USER_SETTINGS,
      ...parsed,
      ...migrateLegacyCharacters(parsed),
    } as UserSettings;
  } catch {
    cache = { ...DEFAULT_USER_SETTINGS };
  }
  return cache;
}

function update(patch: Partial<UserSettings>) {
  persist({ ...read(), ...patch });
}

export function getSettings(): UserSettings {
  return read();
}

export function setUncensoredEnabled(value: boolean) {
  update({ uncensoredEnabled: value });
}

/** Attach or detach the saved-character cast used by Solo Mode. */
export function setSoloCharacters(characterIds: string[]) {
  update({ soloCharacterIds: characterIds });
}

/** Attach or detach the saved-character cast used by Story Mode. */
export function setStoryCharacters(characterIds: string[]) {
  update({ storyCharacterIds: characterIds });
}

export function setMaskUncensored(value: boolean) {
  update({ maskUncensored: value });
}

export function setSelectedModel(kind: GenerationKind, modelId: string | null) {
  update(kind === "video" ? { videoModel: modelId } : { imageModel: modelId });
}

/** Selected model for a kind, falling back to `null` (→ catalog default). */
export function getSelectedModel(kind: GenerationKind): string | null {
  return kind === "video" ? read().videoModel : read().imageModel;
}

// Bumped after a provider-settings save so open model catalogs re-fetch.
let catalogVersion = 0;

export function bumpCatalogVersion(): void {
  catalogVersion += 1;
  emit();
}

export function getCatalogVersion(): number {
  return catalogVersion;
}

/** Reactive view for hooks that must re-run when provider settings change. */
export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => catalogVersion, () => 0);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): { settings: UserSettings; ready: boolean } {
  const settings = useSyncExternalStore(subscribe, read, () => DEFAULT_USER_SETTINGS);
  const ready = useHydrated();
  return { settings, ready };
}

function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

/** Test hook: reset the in-memory cache. */
export function resetSettingsForTests(): void {
  cache = null;
}
