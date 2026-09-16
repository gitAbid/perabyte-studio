"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CharacterSpec } from "@/lib/character";
import type { CharacterRow } from "@/lib/repositories/character-row";
import { characterTransport } from "@/lib/character-transport";

/**
 * The client saved-character store. Public API is the same external-store
 * contract the app has always used; the backing moved server-side (studio
 * libraries spec): every mutation applies optimistically to the in-memory
 * cache and mirrors to /api/characters, so a browser loses nothing by
 * clearing storage and any browser sees the same library. Legacy localStorage
 * rows import once, then retire to a read-only backup key.
 */

/** Kept name for consumers; the row shape lives with the server parser. */
export type SavedCharacter = CharacterRow;

const LEGACY_STORAGE_KEY = "perabyte.characters.v1";
const MIGRATED_KEY = "perabyte.characters.migrated.v2";

export interface AddCharacterOptions {
  parentId?: string;
  tags?: string[];
  favorite?: boolean;
}

const EMPTY: CharacterRow[] = [];
let cache: CharacterRow[] | null = null;
let hydration: Promise<CharacterRow[]> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function newId(): string {
  return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Optimistic local write + fire-and-forget server mirror. A server failure
 * never breaks the session — memory stays authoritative for the tab. */
function persist(
  next: CharacterRow[],
  sync?: (t: NonNullable<ReturnType<typeof characterTransport>>) => Promise<void>,
) {
  cache = next;
  const transport = characterTransport();
  if (transport && sync) {
    void sync(transport).catch(() => {
      /* server unreachable — the session still works in memory */
    });
  }
  emit();
}

function read(): CharacterRow[] {
  return cache ?? EMPTY;
}

/** Rows this browser saved before the server-store upgrade. */
function readLegacyRows(): CharacterRow[] {
  try {
    if (window.localStorage.getItem(MIGRATED_KEY)) return [];
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CharacterRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * One-time boot hydration: adopt the server list, importing legacy
 * localStorage rows (ids not already on the server) along the way. Idempotent
 * per page load; a failure resolves with whatever the tab already has.
 */
export function ensureCharactersHydrated(): Promise<CharacterRow[]> {
  if (hydration) return hydration;
  const transport = characterTransport();
  if (!transport) {
    hydration = Promise.resolve(read());
    return hydration;
  }
  hydration = (async () => {
    let rows: CharacterRow[] = [];
    try {
      rows = await transport.list();
    } catch {
      cache = cache ?? [];
      emit();
      return cache;
    }
    const legacy = readLegacyRows().filter((row) => !rows.some((r) => r.id === row.id));
    if (legacy.length) {
      try {
        for (const row of legacy) await transport.create(row);
        try {
          window.localStorage.setItem(MIGRATED_KEY, "1");
        } catch {
          /* storage blocked — the id-skip above still makes a re-run a no-op */
        }
        rows = await transport.list();
      } catch {
        /* server hiccup mid-import — retry next boot (flag stays unset) */
      }
    }
    cache = rows;
    emit();
    return cache;
  })();
  return hydration;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): CharacterRow[] {
  return read();
}

function getServerSnapshot(): CharacterRow[] {
  return EMPTY;
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export function getCharacters(): CharacterRow[] {
  return read();
}

export function getCharacter(id: string): CharacterRow | undefined {
  return read().find((c) => c.id === id);
}

export function addCharacter(
  name: string,
  spec: CharacterSpec,
  thumbnail?: string,
  options?: AddCharacterOptions,
): SavedCharacter {
  const character: SavedCharacter = {
    id: newId(),
    name: name.trim() || "Untitled character",
    spec,
    ...(thumbnail ? { thumbnail } : {}),
    ...(options?.parentId ? { parentId: options.parentId } : {}),
    ...(options?.tags?.length ? { tags: options.tags } : {}),
    ...(options?.favorite ? { favorite: true } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  persist([character, ...read()], (t) => t.create(character));
  return character;
}

export function updateCharacter(
  id: string,
  patch: Partial<Omit<SavedCharacter, "id">>,
): void {
  persist(
    read().map((c) =>
      c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
    ),
    (t) => t.patch(id, patch),
  );
}

export function toggleCharacterFavorite(id: string): void {
  const target = getCharacter(id);
  updateCharacter(id, { favorite: !target?.favorite });
}

export function removeCharacter(id: string): void {
  removeCharacters([id]);
}

/** Delete several characters in one persist/notify pass (bulk manage). */
export function removeCharacters(ids: string[]): void {
  const doomed = new Set(ids);
  persist(
    read().filter((c) => !doomed.has(c.id)),
    (t) => t.remove(ids),
  );
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useCharacters(): { characters: SavedCharacter[]; ready: boolean } {
  const characters = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ready = useHydrated();
  useEffect(() => {
    void ensureCharactersHydrated();
  }, []);
  return { characters, ready };
}

/** True once the client has mounted. */
function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

/** Test hook: drop the cache and hydration state (node tests only). */
export function resetCharactersForTests(): void {
  cache = null;
  hydration = null;
}
