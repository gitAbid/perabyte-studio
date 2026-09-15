import { beforeEach, describe, expect, it } from "vitest";
import {
  addAsset,
  clearAssets,
  getAsset,
  removeAsset,
  removeAssets,
} from "@/lib/store";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function makeAsset(id: string): Asset {
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
  };
}

beforeEach(() => {
  clearAssets();
});

describe("asset store deletion", () => {
  it("removes a single asset by id", () => {
    addAsset(makeAsset("a"));
    addAsset(makeAsset("b"));

    removeAsset("a");

    expect(getAsset("a")).toBeUndefined();
    expect(getAsset("b")).toBeDefined();
  });

  it("removes a batch of assets in one pass", () => {
    addAsset(makeAsset("a"));
    addAsset(makeAsset("b"));
    addAsset(makeAsset("c"));

    removeAssets(["a", "c"]);

    expect(getAsset("a")).toBeUndefined();
    expect(getAsset("c")).toBeUndefined();
    expect(getAsset("b")).toBeDefined();
  });

  it("ignores unknown ids and duplicate ids", () => {
    addAsset(makeAsset("a"));

    removeAssets(["nope", "nope", "a", "a"]);

    expect(getAsset("a")).toBeUndefined();
  });
});
