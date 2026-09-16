import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteStoriesRepository,
  getStoriesRepository,
  listStoriesRepository,
  patchStoryRepository,
  putStoryRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function makeStory(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: "story",
    title: `Story ${id}`,
    prompt: "s",
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS, kind: "image", count: 1 },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    scenes: [
      { id: `${id}-sc1`, prompt: "sc one", url: null, status: "queued", kind: "image" },
      { id: `${id}-sc2`, prompt: "sc two", url: null, status: "queued", kind: "image" },
    ],
    meta: { continuity: true, running: false },
    ...over,
  };
}

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stories-repo-"));
  file = path.join(tmp, "stories.json");
  setStoriesPathForTests(file);
});

describe("stories repository", () => {
  it("persists and reloads story rows with scenes", () => {
    putStoryRepository(makeStory("s1"));
    setStoriesPathForTests(null);
    setStoriesPathForTests(file);
    const story = getStoriesRepository("s1");
    expect(story?.scenes?.length).toBe(2);
    expect(story?.meta?.running).toBe(false);
  });

  it("starts empty — stories never carry demo rows", () => {
    expect(listStoriesRepository()).toEqual([]);
  });

  it("patches one story in place", () => {
    putStoryRepository(makeStory("s1"));
    const patched = patchStoryRepository("s1", {
      meta: { continuity: true, running: true },
    });
    expect(patched?.meta?.running).toBe(true);
    expect(patchStoryRepository("missing", { favorite: true })).toBeNull();
  });

  it("replaces a story wholesale on put (scenes rewritten together)", () => {
    putStoryRepository(makeStory("s1"));
    putStoryRepository(makeStory("s1", { scenes: [], title: "rewritten" }));
    expect(getStoriesRepository("s1")?.title).toBe("rewritten");
    expect(listStoriesRepository()).toHaveLength(1);
  });

  it("deletes by ids", () => {
    putStoryRepository(makeStory("s1"));
    putStoryRepository(makeStory("s2"));
    expect(deleteStoriesRepository(["s1"])).toBe(1);
    expect(getStoriesRepository("s1")).toBeUndefined();
    expect(getStoriesRepository("s2")).toBeDefined();
  });

  it("rejects a non-story row instead of storing it", () => {
    expect(() => putStoryRepository({ ...makeStory("x"), kind: "image" })).toThrow();
  });
});
