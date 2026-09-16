import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearAssetsRepository,
  deleteAssetsRepository,
  listAssetsRepository,
  patchAssetRepository,
  putAssetRepository,
  setAssetsPathForTests,
} from "@/lib/repositories/assets.repository";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function makeAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: "image",
    title: `Asset ${id}`,
    prompt: "p",
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS },
    createdAt: 0,
    favorite: false,
    mode: "Solo Mode (Image)",
    ...over,
  };
}

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assets-repo-"));
  file = path.join(tmp, "assets.json");
  setAssetsPathForTests(file);
});

describe("assets repository", () => {
  it("persists an upsert and reads it back from disk", () => {
    putAssetRepository(makeAsset("a"));
    // Force a reload from disk by pointing at the same file fresh.
    setAssetsPathForTests(null);
    setAssetsPathForTests(file);
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["a"]);
  });

  it("starts an empty fresh store (seeding lives in the service layer)", () => {
    expect(listAssetsRepository()).toEqual([]);
  });

  it("does not seed demo rows into an existing store", () => {
    putAssetRepository(makeAsset("only"));
    setAssetsPathForTests(null);
    setAssetsPathForTests(file);
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["only"]);
  });

  it("patches in place and returns the patched row", () => {
    putAssetRepository(makeAsset("a"));
    expect(patchAssetRepository("a", { favorite: true })?.favorite).toBe(true);
    expect(patchAssetRepository("missing", { favorite: true })).toBeNull();
  });

  it("deletes by ids and reports the count removed", () => {
    putAssetRepository(makeAsset("a"));
    putAssetRepository(makeAsset("b"));
    expect(deleteAssetsRepository(["a", "missing"])).toBe(1);
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["b"]);
  });

  it("drops malformed rows on load instead of throwing", () => {
    putAssetRepository(makeAsset("ok"));
    // Corrupt the file with junk rows mixed in.
    const rows = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(
      file,
      JSON.stringify([...rows, { id: 42 }, null, "x", { id: "kindless", kind: "nope" }]),
    );
    setAssetsPathForTests(null);
    setAssetsPathForTests(file);
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["ok"]);
  });

  it("clears everything", () => {
    putAssetRepository(makeAsset("a"));
    clearAssetsRepository();
    expect(listAssetsRepository()).toEqual([]);
  });

  it("keeps the newest first ordering the API contract promises", () => {
    putAssetRepository(makeAsset("old", { createdAt: 1 }));
    putAssetRepository(makeAsset("new", { createdAt: 2 }));
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["new", "old"]);
  });
});
