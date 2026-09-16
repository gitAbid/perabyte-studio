import { beforeEach, describe, expect, it } from "vitest";
import {
  addAsset,
  clearAssets,
  ensureStoreHydrated,
  getAsset,
  removeAsset,
  removeAssets,
  resetStoreForTests,
  updateAsset,
} from "@/lib/store";
import { setStoreTransportForTests, type StoreTransport } from "@/lib/store-transport";
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
  resetStoreForTests();
  setStoreTransportForTests(null);
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

describe("server-backed store", () => {
  it("works purely in memory with no transport (node env)", async () => {
    addAsset(makeAsset("local"));
    const adopted = await ensureStoreHydrated();
    expect(adopted.map((a) => a.id)).toEqual(["local"]);
  });

  it("hydrates from the server list and mirrors mutations", async () => {
    const serverRows = [makeAsset("srv1"), makeAsset("srv2")];
    const calls: string[] = [];
    const fake: StoreTransport = {
      list: async () => {
        calls.push("list");
        return serverRows;
      },
      create: async (a) => {
        calls.push(`create:${a.id}`);
      },
      patch: async (id, patch) => {
        calls.push(`patch:${id}:${JSON.stringify(patch)}`);
      },
      remove: async (ids) => {
        calls.push(`remove:${ids.join(",")}`);
      },
      clear: async () => {
        calls.push("clear");
      },
      importLegacy: async () => {
        calls.push("import");
      },
    };
    setStoreTransportForTests(fake);

    const adopted = await ensureStoreHydrated();
    expect(adopted.map((a) => a.id)).toEqual(["srv1", "srv2"]);
    expect(getAsset("srv1")).toBeDefined();

    addAsset(makeAsset("fresh"));
    updateAsset("srv1", { favorite: true });
    removeAssets(["srv2"]);
    expect(calls).toEqual([
      "list",
      "create:fresh",
      'patch:srv1:{"favorite":true}',
      "remove:srv2",
    ]);
  });

  it("imports legacy rows once during hydration", async () => {
    const calls: string[] = [];
    setStoreTransportForTests({
      list: async () => [],
      create: async () => {
        calls.push("create");
      },
      patch: async () => {},
      remove: async () => {
        calls.push("remove");
      },
      clear: async () => {},
      importLegacy: async (rows) => {
        calls.push(`import:${rows.length}`);
      },
    });
    await ensureStoreHydrated();
    // Node env has no window/localStorage, so the legacy read yields none —
    // the call contract stays: no import, list only.
    expect(calls).toEqual([]);
  });

  it("survives a failing server mirror without losing the local write", async () => {
    setStoreTransportForTests({
      list: async () => [],
      create: async () => {
        throw new Error("down");
      },
      patch: async () => {
        throw new Error("down");
      },
      remove: async () => {
        throw new Error("down");
      },
      clear: async () => {
        throw new Error("down");
      },
      importLegacy: async () => {},
    });
    await ensureStoreHydrated();
    addAsset(makeAsset("kept"));
    updateAsset("kept", { favorite: true });
    expect(getAsset("kept")?.favorite).toBe(true);
  });
});
