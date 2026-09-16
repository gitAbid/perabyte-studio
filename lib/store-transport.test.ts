import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserStoreTransport,
  setStoreTransportForTests,
  storeTransport,
  type StoreTransport,
} from "@/lib/store-transport";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

const asset: Asset = {
  id: "t1",
  kind: "image",
  title: "T",
  prompt: "p",
  url: "",
  variants: [],
  settings: { ...DEFAULT_IMAGE_SETTINGS },
  createdAt: 0,
  favorite: false,
  mode: "Solo Mode (Image)",
};

afterEach(() => setStoreTransportForTests(null));

describe("store transport", () => {
  it("is absent outside the browser by default (node tests stay sync)", () => {
    expect(storeTransport()).toBeNull();
    expect(typeof browserStoreTransport).toBe("function");
  });

  it("routes every mutation to the records API", async () => {
    const calls: string[] = [];
    const fake: StoreTransport = {
      list: async () => {
        calls.push("list");
        return [];
      },
      create: async () => {
        calls.push("create");
      },
      patch: async () => {
        calls.push("patch");
      },
      remove: async () => {
        calls.push("remove");
      },
      clear: async () => {
        calls.push("clear");
      },
      importLegacy: async () => {
        calls.push("import");
      },
    };
    setStoreTransportForTests(fake);
    const transport = storeTransport();
    if (!transport) throw new Error("override transport missing");
    await transport.create(asset);
    await transport.patch("t1", { favorite: true });
    await transport.remove(["t1"]);
    await transport.clear();
    await transport.importLegacy([asset]);
    await transport.list();
    expect(calls).toEqual(["create", "patch", "remove", "clear", "import", "list"]);
  });
});
