import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHARACTER_SPEC, type CharacterSpec } from "@/lib/character";
import {
  addCharacter,
  ensureCharactersHydrated,
  getCharacter,
  getCharacters,
  removeCharacters,
  resetCharactersForTests,
  toggleCharacterFavorite,
  updateCharacter,
} from "@/lib/character-store";
import {
  setCharacterTransportForTests,
  type CharacterTransport,
} from "@/lib/character-transport";
import type { CharacterRow } from "@/lib/repositories/character-row";

function row(overrides: Partial<CharacterRow> = {}): CharacterRow {
  return {
    id: "ch_server",
    name: "Server row",
    spec: { ...DEFAULT_CHARACTER_SPEC },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

class StorageStub {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}

/** Scriptable fake: records calls, serves a fixed list. */
function fakeTransport(serverRows: CharacterRow[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const transport: CharacterTransport = {
    async list() {
      calls.push({ method: "list", args: [] });
      return serverRows;
    },
    async create(r) {
      calls.push({ method: "create", args: [r] });
      serverRows.unshift(r);
    },
    async patch(id, patch) {
      calls.push({ method: "patch", args: [id, patch] });
    },
    async remove(ids) {
      calls.push({ method: "remove", args: [ids] });
    },
  };
  return { transport, calls };
}

let storage: StorageStub;

beforeEach(() => {
  storage = new StorageStub();
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("fetch", vi.fn());
  resetCharactersForTests();
  setCharacterTransportForTests(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCharacterTransportForTests(null);
  resetCharactersForTests();
});

describe("character-store (server mirror)", () => {
  it("mutations stay in memory when no transport exists (server absent)", async () => {
    const character = addCharacter("Offline", { ...DEFAULT_CHARACTER_SPEC });
    expect(getCharacter(character.id)?.name).toBe("Offline");
    await expect(ensureCharactersHydrated()).resolves.toHaveLength(1);
  });

  it("adds with lineage/tags options and mirrors create to the transport", async () => {
    const { transport, calls } = fakeTransport();
    setCharacterTransportForTests(transport);

    const character = addCharacter(
      "  Ava  ",
      { ...DEFAULT_CHARACTER_SPEC },
      "/api/media?f=x",
      { parentId: "ch_parent", tags: ["main cast"] },
    );
    expect(character.name).toBe("Ava");
    expect(character.parentId).toBe("ch_parent");
    expect(character.tags).toEqual(["main cast"]);
    expect(getCharacters()[0].id).toBe(character.id);
    await Promise.resolve(); // flush fire-and-forget sync
    expect(calls.some((c) => c.method === "create" && c.args[0] === character)).toBe(true);
  });

  it("update bumps updatedAt and mirrors the patch", async () => {
    const { transport, calls } = fakeTransport();
    setCharacterTransportForTests(transport);
    const character = addCharacter("Before", DEFAULT_CHARACTER_SPEC);
    updateCharacter(character.id, { name: "After" });
    expect(getCharacter(character.id)?.name).toBe("After");
    expect(getCharacter(character.id)?.createdAt).toBe(character.createdAt);
    await Promise.resolve();
    expect(calls.some((c) => c.method === "patch" && c.args[0] === character.id)).toBe(true);
  });

  it("toggleFavorite flips and mirrors", async () => {
    const { transport, calls } = fakeTransport();
    setCharacterTransportForTests(transport);
    const character = addCharacter("Fav", DEFAULT_CHARACTER_SPEC);
    toggleCharacterFavorite(character.id);
    expect(getCharacter(character.id)?.favorite).toBe(true);
    await Promise.resolve();
    const patch = calls.find((c) => c.method === "patch");
    expect(patch?.args[1]).toMatchObject({ favorite: true });
  });

  it("removeCharacters deletes several and mirrors one call", async () => {
    const { transport, calls } = fakeTransport();
    setCharacterTransportForTests(transport);
    const a = addCharacter("A", DEFAULT_CHARACTER_SPEC);
    const b = addCharacter("B", DEFAULT_CHARACTER_SPEC);
    addCharacter("C", DEFAULT_CHARACTER_SPEC);
    removeCharacters([a.id, b.id]);
    expect(getCharacters()).toHaveLength(1);
    await Promise.resolve();
    expect(calls.some((c) => c.method === "remove")).toBe(true);
  });

  it("hydrate adopts the server list; failed imports retry later (flag unset)", async () => {
    const failing = fakeTransport();
    failing.transport.create = async () => {
      throw new Error("server down");
    };
    setCharacterTransportForTests(failing.transport);
    storage.setItem(
      "perabyte.characters.v1",
      JSON.stringify([row({ id: "ch_legacy", name: "Legacy" })]),
    );
    await ensureCharactersHydrated();
    expect(storage.getItem("perabyte.characters.migrated.v2")).toBeNull();

    // next boot with a healthy transport imports the row
    resetCharactersForTests();
    const healthy = fakeTransport();
    setCharacterTransportForTests(healthy.transport);
    const adopted = await ensureCharactersHydrated();
    expect(adopted.map((r) => r.name)).toContain("Legacy");
    expect(storage.getItem("perabyte.characters.migrated.v2")).toBe("1");
  });

  it("migration skips ids already on the server and runs only once", async () => {
    storage.setItem(
      "perabyte.characters.v1",
      JSON.stringify([row({ id: "ch_server", name: "Already there" }), row({ id: "ch_new", name: "New" })]),
    );
    const { transport, calls } = fakeTransport([row({ id: "ch_server", name: "Already there" })]);
    setCharacterTransportForTests(transport);

    const first = await ensureCharactersHydrated();
    expect(first.map((r) => r.id)).toContain("ch_new");
    expect(calls.filter((c) => c.method === "create").map((c) => (c.args[0] as CharacterRow).id)).toEqual([
      "ch_new",
    ]);
    expect(storage.getItem("perabyte.characters.migrated.v2")).toBe("1");

    // second boot: flag set → no re-import
    resetCharactersForTests();
    const second = fakeTransport();
    setCharacterTransportForTests(second.transport);
    await ensureCharactersHydrated();
    expect(second.calls.every((c) => c.method !== "create")).toBe(true);
  });

  it("hydrate survives a list failure and keeps memory authoritative", async () => {
    const { transport } = fakeTransport();
    transport.list = async () => {
      throw new Error("down");
    };
    setCharacterTransportForTests(transport);
    const character = addCharacter("Local", DEFAULT_CHARACTER_SPEC);
    await ensureCharactersHydrated();
    expect(getCharacter(character.id)?.name).toBe("Local");
  });

  it("keeps a saved spec round-trip intact", () => {
    const spec: CharacterSpec = {
      ...DEFAULT_CHARACTER_SPEC,
      gender: "Male",
      nsfwLevel: 2,
    };
    const character = addCharacter("Round trip", spec);
    expect(getCharacter(character.id)?.spec).toEqual(spec);
  });
});
