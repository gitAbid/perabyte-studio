import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseLocationRow,
  parseLocationRows,
  type LocationRow,
} from "@/lib/repositories/location-row";

/**
 * Server-side saved locations (`.studio/locations.json`) — thin fs-backed
 * JSON repository in the assets-repository style: in-memory cache, sanitize
 * on load, sync writes. Deliberately pure storage; the locations service
 * owns row validation on writes.
 */

let overridePath: string | null = null;
let cache: LocationRow[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "locations.json");
}

function load(): LocationRow[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = [];
    } else {
      cache = parseLocationRows(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
    }
  } catch {
    cache = []; // unreadable/corrupt file beats a crashed server
  }
  return cache;
}

function persist(rows: LocationRow[]): void {
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
    console.error("[locations-repository] persist failed", error);
  }
}

export function listLocationsRepository(): LocationRow[] {
  return load();
}

export function getLocationsRepository(id: string): LocationRow | undefined {
  return load().find((l) => l.id === id);
}

/** Upsert (create or replace), newest first. */
export function putLocationRepository(row: LocationRow): LocationRow {
  persist([row, ...load().filter((l) => l.id !== row.id)]);
  return row;
}

/** Merge a patch onto one row; returns the patched row or null when absent. */
export function patchLocationRepository(
  id: string,
  patch: Partial<LocationRow>,
): LocationRow | null {
  let patched: LocationRow | null = null;
  persist(
    load().map((l) => {
      if (l.id !== id) return l;
      patched = { ...l, ...patch };
      return patched;
    }),
  );
  return patched;
}

/** Delete by ids; returns how many rows were actually removed. */
export function deleteLocationsRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  const kept = rows.filter((l) => !doomed.has(l.id));
  persist(kept);
  return rows.length - kept.length;
}

export function setLocationsPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
