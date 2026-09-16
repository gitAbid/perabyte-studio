import { describe, expect, it } from "vitest";
import {
  assetTags,
  castUsage,
  characterFamilies,
  cloneForDuplicate,
  collectAssetTags,
  collectCharacterTags,
  duplicateStoryAsset,
  selectCharacters,
  selectMedia,
  selectStories,
  storyCover,
  storyProgress,
  variationFromParent,
  type CharacterLibraryState,
  type MediaLibraryState,
} from "@/lib/library-selectors";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { Asset, StoryScene } from "@/lib/types";

function character(overrides: Partial<CharacterRow> = {}): CharacterRow {
  return {
    id: "ch_1",
    name: "Ava",
    spec: { ...DEFAULT_CHARACTER_SPEC, prompt: "golden hour portrait" },
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function scene(overrides: Partial<StoryScene> = {}): StoryScene {
  return {
    id: "sc_1",
    prompt: "scene prompt",
    url: null,
    status: "queued",
    kind: "image",
    ...overrides,
  };
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a_1",
    kind: "image",
    title: "Mountain lake",
    prompt: "a serene lake",
    url: "/api/media?f=a",
    variants: [],
    settings: { kind: "image" } as Asset["settings"],
    createdAt: 10,
    favorite: false,
    mode: "Solo Mode",
    ...overrides,
  };
}

const charState = (over: Partial<CharacterLibraryState> = {}): CharacterLibraryState => ({
  query: "",
  favouritesOnly: false,
  sort: "newest",
  activeTags: [],
  familyId: null,
  ...over,
});

const mediaState = (over: Partial<MediaLibraryState> = {}): MediaLibraryState => ({
  query: "",
  favouritesOnly: false,
  sort: "newest",
  activeTags: [],
  ...over,
});

describe("character selectors", () => {
  const rows = [
    character({ id: "ch_ava", name: "Ava", tags: ["main cast"], updatedAt: 30 }),
    character({ id: "ch_ava_casual", name: "Ava Casual", parentId: "ch_ava", updatedAt: 20 }),
    character({ id: "ch_kai", name: "Kai", favorite: true, updatedAt: 10 }),
  ];

  it("searches name, prompt, and tags", () => {
    expect(selectCharacters(rows, charState({ query: "kai" })).map((c) => c.id)).toEqual(["ch_kai"]);
    expect(selectCharacters(rows, charState({ query: "golden" })).map((c) => c.id)).toContain("ch_ava");
    expect(selectCharacters(rows, charState({ query: "main" })).map((c) => c.id)).toEqual(["ch_ava"]);
  });

  it("favourites filter, tag union filter, and sorting", () => {
    expect(selectCharacters(rows, charState({ favouritesOnly: true })).map((c) => c.id)).toEqual(["ch_kai"]);
    expect(selectCharacters(rows, charState({ activeTags: ["main cast"] })).map((c) => c.id)).toEqual(["ch_ava"]);
    expect(selectCharacters(rows, charState({ sort: "name" })).map((c) => c.name)).toEqual([
      "Ava",
      "Ava Casual",
      "Kai",
    ]);
    expect(selectCharacters(rows, charState()).map((c) => c.id)).toEqual([
      "ch_ava",
      "ch_ava_casual",
      "ch_kai",
    ]); // updatedAt desc
  });

  it("family filter shows the parent and its direct children only", () => {
    const ids = selectCharacters(rows, charState({ familyId: "ch_ava" })).map((c) => c.id);
    expect(ids).toEqual(["ch_ava", "ch_ava_casual"]);
  });

  it("characterFamilies reports parents with child counts", () => {
    expect(characterFamilies(rows)).toEqual([{ parent: rows[0], count: 1 }]);
    expect(collectCharacterTags(rows)).toEqual(["main cast"]);
  });

  it("castUsage and clone helpers", () => {
    expect(castUsage("ch_kai", ["ch_kai"], [])).toEqual({ solo: true, story: false });
    const dup = cloneForDuplicate(rows[0]);
    expect(dup.name).toBe("Ava (copy)");
    expect(dup.parentId).toBeUndefined();
    expect(dup.favorite).toBe(false);
    expect(dup.id).toBe("");

    const variation = variationFromParent(rows[0], "ignored");
    expect(variation.parentId).toBe("ch_ava");
    expect(variation.spec).toEqual(rows[0].spec);
    expect(variation.spec).not.toBe(rows[0].spec); // deep copy
  });
});

describe("media selectors", () => {
  const list = [
    asset({ id: "a_img", kind: "image", title: "Lake" }),
    asset({ id: "a_vid", kind: "video", title: "Wave", prompt: "ocean waves crash", createdAt: 40 }),
    asset({ id: "a_story", kind: "story", title: "Epic", createdAt: 50 }),
    asset({ id: "a_fav", kind: "image", title: "Fav lake", favorite: true, meta: { tags: ["best"] } }),
  ] as Asset[];

  it("excludes stories; kind chips slice image/video", () => {
    expect(selectMedia(list, { ...mediaState(), kind: "all" }).map((a) => a.id)).not.toContain("a_story");
    expect(selectMedia(list, { ...mediaState(), kind: "video" }).map((a) => a.id)).toEqual(["a_vid"]);
  });

  it("search matches title and prompt; tags filter via meta", () => {
    expect(selectMedia(list, { ...mediaState(), kind: "all", query: "lake" })).toHaveLength(2);
    expect(selectMedia(list, { ...mediaState(), kind: "all", activeTags: ["best"] }).map((a) => a.id)).toEqual(["a_fav"]);
    expect(assetTags(list[3])).toEqual(["best"]);
    expect(collectAssetTags(list)).toEqual(["best"]);
  });

  it("favourites filter", () => {
    expect(selectMedia(list, { ...mediaState(), kind: "all", favouritesOnly: true })).toHaveLength(1);
  });
});

describe("story selectors", () => {
  const story = asset({
    id: "s_1",
    kind: "story",
    title: "Epic tale",
    prompt: "a saga",
    url: "",
    scenes: [
      scene({ id: "sc1", prompt: "opening shot", url: "/api/media?f=1", status: "completed" }),
      scene({ id: "sc2", prompt: "chase", url: null, status: "generating" }),
      scene({ id: "sc3", prompt: "finale", url: null, status: "queued" }),
    ],
  });

  it("filters stories, searches scene prompts, and reports progress", () => {
    expect(selectStories([story, asset()], mediaState()).map((a) => a.id)).toEqual(["s_1"]);
    expect(selectStories([story], mediaState({ query: "chase" }))).toHaveLength(1);
    expect(selectStories([story], mediaState({ query: "zzz" }))).toHaveLength(0);

    expect(storyCover(story)).toBe("/api/media?f=1");
    expect(storyProgress(story)).toEqual({ done: 1, total: 3, live: true });
  });

  it("duplicateStoryAsset resets non-completed scenes and copies identity", () => {
    const copy = duplicateStoryAsset(story, 1234);
    expect(copy.id).not.toBe(story.id);
    expect(copy.id).toMatch(/^s_/);
    expect(copy.title).toBe("Epic tale (copy)");
    expect(copy.favorite).toBe(false);
    expect(copy.createdAt).toBe(1234);
    expect(copy.scenes?.[0].status).toBe("completed");
    expect(copy.scenes?.[0].url).toBe("/api/media?f=1");
    expect(copy.scenes?.[1]).toMatchObject({ status: "queued", url: null, progress: undefined });
    expect(copy.scenes?.[2].status).toBe("queued");
  });
});
