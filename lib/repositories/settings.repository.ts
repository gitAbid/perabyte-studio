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
  imageModel: string | null;
  videoModel: string | null;
  /** Saved character attached in Solo Mode, or null for prompt-only scenes. */
  soloCharacterId: string | null;
  /** Saved character attached in Story Mode, or null for prompt-only scenes. */
  storyCharacterId: string | null;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  uncensoredEnabled: false,
  imageModel: null,
  videoModel: null,
  soloCharacterId: null,
  storyCharacterId: null,
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

function read(): UserSettings {
  if (cache) return cache;
  if (typeof window === "undefined") return DEFAULT_USER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<UserSettings>) : {};
    cache = { ...DEFAULT_USER_SETTINGS, ...parsed };
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

/** Attach or detach the saved character used by Solo Mode. */
export function setSoloCharacter(characterId: string | null) {
  update({ soloCharacterId: characterId });
}

/** Attach or detach the saved character used by Story Mode. */
export function setStoryCharacter(characterId: string | null) {
  update({ storyCharacterId: characterId });
}

export function setSelectedModel(kind: GenerationKind, modelId: string) {
  update(kind === "video" ? { videoModel: modelId } : { imageModel: modelId });
}

/** Selected model for a kind, falling back to `null` (→ catalog default). */
export function getSelectedModel(kind: GenerationKind): string | null {
  return kind === "video" ? read().videoModel : read().imageModel;
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
