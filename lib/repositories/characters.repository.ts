import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseCharacterRow,
  parseCharacterRows,
  type CharacterRow,
} from "@/lib/repositories/character-row";

/**
 * Server-side saved characters (`.studio/characters.json`) — thin fs-backed
 * JSON repository in the assets-repository style: in-memory cache, sanitize
 * on load, sync writes. Deliberately pure storage; the characters service
 * owns row validation on writes.
 */

let overridePath: string | null = null;
let cache: CharacterRow[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "characters.json");
}

function load(): CharacterRow[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = [];
    } else {
      cache = parseCharacterRows(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
    }
  } catch {
    cache = []; // unreadable/corrupt file beats a crashed server
  }
  return cache;
}

function persist(rows: CharacterRow[]): void {
  cache = rows;
  const target = resolvePath();
  const dir = path.dirname(target);
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(/*turbopackIgnore: true*/ target, JSON.stringify(rows, null, 2), "utf-8");
  } catch (error) {
    // A full disk must not crash the API route — memory stays authoritative
    // for this process and the next successful write re-syncs the file.
    console.error("[characters-repository] persist failed", error);
  }
}

export function listCharactersRepository(): CharacterRow[] {
  return load();
}

export function getCharactersRepository(id: string): CharacterRow | undefined {
  return load().find((c) => c.id === id);
}

/** Upsert (create or replace), newest first. */
export function putCharacterRepository(row: CharacterRow): CharacterRow {
  persist([row, ...load().filter((c) => c.id !== row.id)]);
  return row;
}

/** Merge a patch onto one row; returns the patched row or null when absent. */
export function patchCharacterRepository(
  id: string,
  patch: Partial<CharacterRow>,
): CharacterRow | null {
  let patched: CharacterRow | null = null;
  persist(
    load().map((c) => {
      if (c.id !== id) return c;
      patched = { ...c, ...patch };
      return patched;
    }),
  );
  return patched;
}

/** Delete by ids; returns how many rows were actually removed. */
export function deleteCharactersRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  const kept = rows.filter((c) => !doomed.has(c.id));
  persist(kept);
  return rows.length - kept.length;
}

export function setCharactersPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
