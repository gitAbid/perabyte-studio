import * as fs from "node:fs";
import * as path from "node:path";
import type { Asset } from "@/lib/types";
import { parseAssetRow } from "@/lib/repositories/asset-row";
import {
  clearAssetsRepository,
  deleteAssetsRepository,
  getAssetsRepository,
  listAssetsRepository,
  patchAssetRepository,
  putAssetRepository,
  setAssetsPathForTests,
} from "@/lib/repositories/assets.repository";
import {
  deleteStoriesRepository,
  getStoriesRepository,
  listStoriesRepository,
  patchStoryRepository,
  putStoryRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import { withDemoRows } from "@/lib/demo-content";

/**
 * Single read/write model over the two server record stores. History wants
 * one merged list; writes route to assets.json or stories.json by row kind
 * so story scene state stays isolated from the bulkier History file.
 */

export function listRecords(): Asset[] {
  return [...listStoriesRepository(), ...listAssetsRepository()].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

export function getRecord(id: string): Asset | undefined {
  return getStoriesRepository(id) ?? getAssetsRepository(id);
}

export function putRecord(asset: Asset): Asset {
  return asset.kind === "story" ? putStoryRepository(asset) : putAssetRepository(asset);
}

/** Merge a patch onto one row in whichever store owns it. */
export function patchRecord(id: string, patch: Partial<Asset>): Asset | null {
  return patchStoryRepository(id, patch) ?? patchAssetRepository(id, patch);
}

/** Delete by ids across both stores; returns the number actually removed. */
export function removeRecords(ids: string[]): number {
  return deleteStoriesRepository(ids) + deleteAssetsRepository(ids);
}

/** "Clean library": wipe History assets, keep stories (they are projects). */
export function clearHistoryRecords(): void {
  const storyIds = new Set(listStoriesRepository().map((a) => a.id));
  deleteAssetsRepository(listAssetsRepository().map((a) => a.id).filter((id) => !storyIds.has(id)));
}

let seededChecked = false;

/**
 * First-boot seeding of the example strip: only when the assets store does
 * not exist on disk yet, so a real History (even an emptied one) is never
 * re-seeded. Idempotent in-process and on disk.
 */
export function ensureRecordsSeeded(): void {
  if (seededChecked) return;
  seededChecked = true;
  if (listAssetsRepository().length > 0) return;
  const seeded = withDemoRows([]);
  for (const asset of seeded) putAssetRepository(asset);
}

/**
 * One-time legacy import from a browser's localStorage `assets.v2`. Known
 * ids (including demo rows) and malformed rows are skipped; anything new is
 * routed into its proper store.
 */
export function importLegacyRecords(rows: unknown[]): { imported: number; skipped: number } {
  const known = new Set(listRecords().map((a) => a.id));
  let imported = 0;
  let skipped = 0;
  for (const raw of rows) {
    const asset = parseAssetRow(raw);
    if (!asset || known.has(asset.id) || asset.meta?.example === true) {
      skipped += 1;
      continue;
    }
    putRecord(asset);
    known.add(asset.id);
    imported += 1;
  }
  return { imported, skipped };
}

/** Test hook: point both stores at scratch files and clear the seed guard. */
export function setRecordsPathsForTests(paths: { assets: string; stories: string } | null): void {
  setAssetsPathForTests(paths ? paths.assets : null);
  setStoriesPathForTests(paths ? paths.stories : null);
  seededChecked = false;
}
