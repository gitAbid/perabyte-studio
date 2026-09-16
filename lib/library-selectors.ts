import type { Asset, StoryScene } from "@/lib/types";
import type { GenerationKind } from "@/lib/constants";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { CharacterSpec } from "@/lib/character";

/**
 * Pure library selectors and clone helpers for the three studio libraries
 * (characters / images / stories). Kept free of React so the node-env suite
 * can test the exact filtering the pages render.
 */

export type SortMode = "newest" | "oldest" | "name";
export type MediaFilter = "all" | "image" | "video";

export interface CharacterLibraryState {
  query: string;
  favouritesOnly: boolean;
  sort: SortMode;
  activeTags: string[];
  /** Family filter: the parent id — shows the parent + its direct children. */
  familyId: string | null;
}

export interface MediaLibraryState {
  query: string;
  favouritesOnly: boolean;
  sort: SortMode;
  activeTags: string[];
}

const LIVE_STATUSES = new Set(["queued", "generating"]);

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

export function assetTags(asset: Asset): string[] {
  const tags = asset.meta?.tags;
  return Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : [];
}

export function collectAssetTags(assets: Asset[]): string[] {
  return [...new Set(assets.flatMap(assetTags))].sort((a, b) => a.localeCompare(b));
}

export function collectCharacterTags(rows: CharacterRow[]): string[] {
  return [...new Set(rows.flatMap((r) => r.tags ?? []))].sort((a, b) => a.localeCompare(b));
}

function matchesTags(active: string[], tags: string[]): boolean {
  return active.every((tag) => tags.includes(tag));
}

function sortRows<T extends { createdAt: number }>(
  rows: T[],
  sort: SortMode,
  name: (row: T) => string,
  updated: (row: T) => number,
): T[] {
  const copy = rows.slice();
  if (sort === "name") copy.sort((a, b) => name(a).localeCompare(name(b)));
  else if (sort === "oldest") copy.sort((a, b) => a.createdAt - b.createdAt);
  else if (sort === "newest") copy.sort((a, b) => updated(b) - updated(a));
  return copy;
}

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

export function selectCharacters(
  rows: CharacterRow[],
  state: CharacterLibraryState,
): CharacterRow[] {
  const term = state.query.trim().toLowerCase();
  let list = rows.slice();

  if (state.favouritesOnly) list = list.filter((c) => c.favorite);
  if (state.familyId) {
    list = list.filter(
      (c) => c.id === state.familyId || c.parentId === state.familyId,
    );
  }
  if (state.activeTags.length) {
    list = list.filter((c) => matchesTags(state.activeTags, c.tags ?? []));
  }
  if (term) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.spec.prompt.toLowerCase().includes(term) ||
        (c.tags ?? []).some((tag) => tag.toLowerCase().includes(term)),
    );
  }
  return sortRows(
    list,
    state.sort,
    (c) => c.name,
    (c) => c.updatedAt,
  );
}

/** Rows that have at least one variation — enables the family chip. */
export function characterFamilies(rows: CharacterRow[]): { parent: CharacterRow; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.parentId) counts.set(row.parentId, (counts.get(row.parentId) ?? 0) + 1);
  }
  return rows
    .filter((r) => counts.has(r.id))
    .map((parent) => ({ parent, count: counts.get(parent.id) ?? 0 }));
}

/** Which Solo/Story casts reference this character (drives badges + safe delete). */
export function castUsage(
  characterId: string,
  soloIds: string[],
  storyIds: string[],
): { solo: boolean; story: boolean } {
  return { solo: soloIds.includes(characterId), story: storyIds.includes(characterId) };
}

/** Exact clone for "Duplicate": backup copy, no lineage, favourite reset. */
export function cloneForDuplicate(row: CharacterRow): CharacterRow & { name: string } {
  return {
    ...row,
    id: "",
    name: `${row.name} (copy)`,
    parentId: undefined,
    favorite: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Prefill for "Create variation": parent identity, fresh identity fields. */
export function variationFromParent(parent: CharacterRow, name: string): {
  spec: CharacterSpec;
  parentId: string;
} {
  return { spec: { ...parent.spec }, parentId: parent.id };
}

/* ------------------------------------------------------------------ */
/* Media (images + videos) and stories                                 */
/* ------------------------------------------------------------------ */

export function selectMedia(assets: Asset[], state: MediaLibraryState & { kind: MediaFilter }): Asset[] {
  const term = state.query.trim().toLowerCase();
  let list = assets.filter((a) => a.kind === "image" || a.kind === "video");

  if (state.kind !== "all") list = list.filter((a) => a.kind === (state.kind as GenerationKind));
  if (state.favouritesOnly) list = list.filter((a) => a.favorite);
  if (state.activeTags.length) {
    list = list.filter((a) => matchesTags(state.activeTags, assetTags(a)));
  }
  if (term) {
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(term) ||
        a.prompt.toLowerCase().includes(term) ||
        assetTags(a).some((tag) => tag.toLowerCase().includes(term)),
    );
  }
  return sortRows(
    list,
    state.sort,
    (a) => a.title,
    (a) => a.createdAt,
  );
}

export function selectStories(assets: Asset[], state: MediaLibraryState): Asset[] {
  const term = state.query.trim().toLowerCase();
  let list = assets.filter((a) => a.kind === "story");

  if (state.favouritesOnly) list = list.filter((a) => a.favorite);
  if (state.activeTags.length) {
    list = list.filter((a) => matchesTags(state.activeTags, assetTags(a)));
  }
  if (term) {
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(term) ||
        a.prompt.toLowerCase().includes(term) ||
        (a.scenes ?? []).some((s) => s.prompt.toLowerCase().includes(term)) ||
        assetTags(a).some((tag) => tag.toLowerCase().includes(term)),
    );
  }
  return sortRows(
    list,
    state.sort,
    (a) => a.title,
    (a) => a.createdAt,
  );
}

/** First scene render to use as the story cover (falls back to the poster). */
export function storyCover(story: Asset): string | null {
  const scene = (story.scenes ?? []).find((s) => typeof s.url === "string" && s.url);
  return scene?.url ?? story.url ?? null;
}

export function storyProgress(story: Asset): { done: number; total: number; live: boolean } {
  const scenes: StoryScene[] = story.scenes ?? [];
  return {
    done: scenes.filter((s) => s.status === "completed").length,
    total: scenes.length,
    live: scenes.some((s) => LIVE_STATUSES.has(s.status)),
  };
}

/**
 * Deep copy for "Duplicate": fresh id/timestamps, favourite reset, completed
 * scenes keep their renders; anything not completed resets to the neutral
 * queued/no-url state (a copy carries no jobs, so a "generating" ghost would
 * never resolve).
 */
export function duplicateStoryAsset(story: Asset, now = Date.now()): Asset {
  const id = `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    ...story,
    id,
    title: `${story.title} (copy)`,
    favorite: false,
    createdAt: now,
    scenes: (story.scenes ?? []).map((scene) =>
      scene.status === "completed"
        ? scene
        : {
            ...scene,
            status: "queued" as const,
            url: null,
            progress: undefined,
            error: undefined,
          },
    ),
  };
}
