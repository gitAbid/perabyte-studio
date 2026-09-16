import * as fs from "node:fs";
import * as path from "node:path";
import type { Asset } from "@/lib/types";
import { parseAssetRows } from "@/lib/repositories/asset-row";

/**
 * Server-side story records (`.studio/stories.json`) — the same thin
 * fs-backed pattern as the assets repository, but story-kind rows only so
 * scene/run state stays isolated from the bulkier History file.
 */
let overridePath: string | null = null;
let cache: Asset[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "stories.json");
}

function load(): Asset[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = [];
    } else {
      cache = parseAssetRows(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
    }
  } catch {
    cache = [];
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
    console.error("[stories-repository] persist failed", error);
  }
}

export function listStoriesRepository(): Asset[] {
  return load();
}

export function getStoriesRepository(id: string): Asset | undefined {
  return load().find((a) => a.id === id);
}

export function putStoryRepository(story: Asset): Asset {
  if (story.kind !== "story") {
    throw new Error("stories repository accepts story-kind rows only");
  }
  persist([story, ...load().filter((a) => a.id !== story.id)]);
  return story;
}

/** Merge a patch onto one story; returns the patched row or null. */
export function patchStoryRepository(id: string, patch: Partial<Asset>): Asset | null {
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

export function deleteStoriesRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  const kept = rows.filter((a) => !doomed.has(a.id));
  persist(kept);
  return rows.length - kept.length;
}

export function setStoriesPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
