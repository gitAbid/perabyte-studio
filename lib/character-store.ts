"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CharacterSpec } from "@/lib/character";

/**
 * Saved-character repository (localStorage), following the same
 * external-store pattern as the settings repository. A saved character is a
 * named CharacterSpec plus an optional thumbnail from the render that
 * defined it, so Solo and Story can reuse one identity across scenes.
 */
export interface SavedCharacter {
  id: string;
  name: string;
  spec: CharacterSpec;
  /** Primary render URL from the generation that defined the character. */
  thumbnail?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "perabyte.characters.v1";

const listeners = new Set<() => void>();
let cache: SavedCharacter[] | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

function persist(next: SavedCharacter[]) {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked — the session still works in memory */
  }
  emit();
}

function read(): SavedCharacter[] {
  if (cache) return cache;
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedCharacter[]) : [];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function getCharacters(): SavedCharacter[] {
  return read();
}

export function getCharacter(id: string): SavedCharacter | undefined {
  return read().find((character) => character.id === id);
}

export function addCharacter(
  name: string,
  spec: CharacterSpec,
  thumbnail?: string,
): SavedCharacter {
  const character: SavedCharacter = {
    id: `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Untitled character",
    spec,
    ...(thumbnail ? { thumbnail } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  persist([character, ...read()]);
  return character;
}

export function updateCharacter(id: string, patch: Partial<Omit<SavedCharacter, "id">>): void {
  persist(
    read().map((character) =>
      character.id === id
        ? { ...character, ...patch, updatedAt: Date.now() }
        : character,
    ),
  );
}

export function removeCharacter(id: string): void {
  persist(read().filter((character) => character.id !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: SavedCharacter[] = [];

/** Cached empty snapshot — a fresh array here would loop useSyncExternalStore. */
function getServerSnapshot(): SavedCharacter[] {
  return EMPTY;
}

function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

export function useCharacters(): { characters: SavedCharacter[]; ready: boolean } {
  const characters = useSyncExternalStore(subscribe, read, getServerSnapshot);
  const ready = useHydrated();
  return { characters, ready };
}

/** Test hook: reset the in-memory cache. */
export function resetCharactersForTests(): void {
  cache = null;
}