import * as fs from "node:fs";
import * as path from "node:path";
import type { Asset } from "@/lib/types";
import { parseAssetRows } from "@/lib/repositories/asset-row";

/**
 * Server-side History records (`.studio/assets.json`) — thin fs-backed JSON
 * repository in the provider-config style: in-memory cache, sanitize on
 * load, sync writes. Deliberately pure storage: demo seeding lives one
 * level up (records service), so tests and callers get plain CRUD.
 */
export interface AssetsRepository {
  list(): Asset[];
  get(id: string): Asset | undefined;
  put(asset: Asset): Asset;
  patch(id: string, patch: Partial<Asset>): Asset | null;
  remove(ids: string[]): number;
  clear(): void;
}

let overridePath: string | null = null;
let cache: Asset[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "assets.json");
}

function load(): Asset[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = []; // fresh store — callers (records service) may seed content
    } else {
      cache = parseAssetRows(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
    }
  } catch {
    cache = []; // unreadable/corrupt file beats a crashed server
  }
  return cache;
}

function persist(rows: Asset[]): void {
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
    console.error("[assets-repository] persist failed", error);
  }
}

export function listAssetsRepository(): Asset[] {
  return load();
}

export function getAssetsRepository(id: string): Asset | undefined {
  return load().find((a) => a.id === id);
}

/** Upsert (create or replace), newest first. */
export function putAssetRepository(asset: Asset): Asset {
  persist([asset, ...load().filter((a) => a.id !== asset.id)]);
  return asset;
}

/** Merge a patch onto one row; returns the patched row or null when absent. */
export function patchAssetRepository(id: string, patch: Partial<Asset>): Asset | null {
  let patched: Asset | null = null;
  persist(
    load().map((a) => {
      if (a.id !== id) return a;
      patched = { ...a, ...patch };
      return patched;
    }),
  );
  return patched;
}

/** Delete by ids; returns how many rows were actually removed. */
export function deleteAssetsRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  const kept = rows.filter((a) => !doomed.has(a.id));
  persist(kept);
  return rows.length - kept.length;
}

export function clearAssetsRepository(): void {
  persist([]);
}

export function setAssetsPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
