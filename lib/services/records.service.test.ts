import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearHistoryRecords,
  ensureRecordsSeeded,
  getRecord,
  importLegacyRecords,
  listRecords,
  patchRecord,
  putRecord,
  removeRecords,
  setRecordsPathsForTests,
} from "@/lib/services/records.service";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function row(id: string, kind: Asset["kind"], over: Partial<Asset> = {}): Asset {
  return {
    id,
    kind,
    title: id,
    prompt: "p",
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS, kind: kind === "video" ? "video" : "image", count: 1 },
    createdAt: 0,
    favorite: false,
    mode: kind === "story" ? "Story Mode" : kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
    ...(kind === "story" ? { scenes: [] } : {}),
    ...over,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
  setRecordsPathsForTests({
    assets: path.join(tmp, "assets.json"),
    stories: path.join(tmp, "stories.json"),
  });
});

describe("records service", () => {
  it("lists both stores merged, newest first", () => {
    putRecord(row("old", "image", { createdAt: 1 }));
    putRecord(row("new", "story", { createdAt: 2 }));
    expect(listRecords().map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("gets across both stores", () => {
    putRecord(row("img", "image"));
    putRecord(row("story", "story"));
    expect(getRecord("img")?.kind).toBe("image");
    expect(getRecord("story")?.kind).toBe("story");
    expect(getRecord("nope")).toBeUndefined();
  });

  it("patches across both stores", () => {
    putRecord(row("img", "image"));
    putRecord(row("story", "story"));
    expect(patchRecord("img", { favorite: true })?.favorite).toBe(true);
    expect(patchRecord("story", { title: "renamed" })?.title).toBe("renamed");
    expect(patchRecord("nope", { favorite: true })).toBeNull();
    // The patch landed in the right store on disk.
    expect(getRecord("story")?.title).toBe("renamed");
  });

  it("routes deletes across both stores", () => {
    putRecord(row("img", "image"));
    putRecord(row("story", "story"));
    expect(removeRecords(["img", "story"])).toBe(2);
    expect(listRecords()).toEqual([]);
  });

  it("clear clears History assets only — stories survive", () => {
    putRecord(row("img", "image"));
    putRecord(row("story", "story"));
    clearHistoryRecords();
    expect(listRecords().map((a) => a.id)).toEqual(["story"]);
  });

  it("seeds demo rows into assets on a fresh install, once", () => {
    ensureRecordsSeeded();
    const seeded = listRecords().filter((a) => a.meta?.example === true);
    expect(seeded.length).toBeGreaterThanOrEqual(5);

    // A later call with the same files present never duplicates.
    ensureRecordsSeeded();
    expect(listRecords().filter((a) => a.meta?.example === true).length).toBe(seeded.length);
  });

  it("does not seed when a store already exists", () => {
    putRecord(row("user", "image"));
    ensureRecordsSeeded();
    expect(listRecords().filter((a) => a.meta?.example === true)).toEqual([]);
  });

  it("imports legacy rows, skipping known ids and demo rows", () => {
    putRecord(row("have", "image"));
    const result = importLegacyRecords([
      row("fresh", "video"),
      row("have", "image"),
      row("demo_4821", "image", { meta: { example: true, seed: 4821 } }),
      { id: 42 },
    ]);
    expect(result).toEqual({ imported: 1, skipped: 3 });
    expect(getRecord("fresh")?.kind).toBe("video");
  });
});
