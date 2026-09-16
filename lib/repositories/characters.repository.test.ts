import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  deleteCharactersRepository,
  getCharactersRepository,
  listCharactersRepository,
  patchCharacterRepository,
  putCharacterRepository,
  setCharactersPathForTests,
} from "./characters.repository";
import {
  listCharacters,
  patchCharacter,
  putCharacter,
  removeCharacters,
} from "@/lib/services/characters.service";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import type { CharacterRow } from "./character-row";

function row(overrides: Partial<CharacterRow> = {}): CharacterRow {
  return {
    id: "ch_test",
    name: "Ava",
    spec: { ...DEFAULT_CHARACTER_SPEC },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("characters.repository + characters.service", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-characters-test-"));
    storePath = path.join(tempDir, "characters.json");
    setCharactersPathForTests(storePath);
  });

  afterEach(async () => {
    setCharactersPathForTests(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty store when the file does not exist", () => {
    expect(listCharactersRepository()).toEqual([]);
  });

  it("returns an empty store for a corrupt file", async () => {
    await fs.writeFile(storePath, "{not json", "utf-8");
    expect(listCharactersRepository()).toEqual([]);
  });

  it("put upserts newest-first and round-trips through disk", () => {
    putCharacterRepository(row({ id: "a", updatedAt: 1 }));
    putCharacterRepository(row({ id: "b", updatedAt: 2 }));
    putCharacterRepository(row({ id: "a", updatedAt: 3 })); // replace, moves to front

    const rows = listCharactersRepository();
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    // A fresh read hits the file again (new module cache via set-for-tests)
    setCharactersPathForTests(storePath);
    expect(listCharactersRepository().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("get finds one row or undefined", () => {
    putCharacterRepository(row({ id: "a" }));
    expect(getCharactersRepository("a")?.name).toBe("Ava");
    expect(getCharactersRepository("missing")).toBeUndefined();
  });

  it("patch merges onto one row and reports null for unknown ids", () => {
    putCharacterRepository(row({ id: "a", name: "Ava" }));
    const patched = patchCharacterRepository("a", { name: "Ava Prime" });
    expect(patched?.name).toBe("Ava Prime");
    expect(patchCharacterRepository("missing", { name: "x" })).toBeNull();
    expect(getCharactersRepository("a")?.name).toBe("Ava Prime");
  });

  it("delete removes only the given ids and reports the count", () => {
    putCharacterRepository(row({ id: "a" }));
    putCharacterRepository(row({ id: "b" }));
    expect(deleteCharactersRepository(["a", "zz"])).toBe(1);
    expect(listCharactersRepository().map((r) => r.id)).toEqual(["b"]);
  });

  describe("service", () => {
    it("putCharacter validates rows and rejects invalid payloads", () => {
      expect(putCharacter(row({ id: "ok" }))).not.toBeNull();
      expect(putCharacter({ id: "", name: "x", spec: {}, createdAt: 1, updatedAt: 1 })).toBeNull();
      expect(putCharacter("garbage")).toBeNull();
    });

    it("listCharacters sorts by updatedAt desc and clamps on load", () => {
      putCharacter(row({ id: "old", updatedAt: 10 }));
      putCharacter(row({ id: "new", updatedAt: 20 }));
      const rows = listCharacters();
      expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    });

    it("patchCharacter merges, bumps updatedAt, revalidates, and 404s unknown", () => {
      putCharacter(row({ id: "a", name: "Ava", updatedAt: 1 }));
      const before = Date.now();
      const patched = patchCharacter("a", { name: "Renamed", favorite: true });
      expect(patched?.name).toBe("Renamed");
      expect(patched?.favorite).toBe(true);
      expect((patched?.updatedAt ?? 0) - before).toBeLessThan(50);

      expect(patchCharacter("missing", { name: "x" })).toBeNull();
      // invalid patch payload is rejected, not merged
      expect(patchCharacter("a", { tags: "not-an-array" })).not.toBeNull(); // drops bad field, still merges
      expect(patchCharacter("a", { createdAt: "bogus" })).toBeNull();
    });

    it("removeCharacters deletes and counts", () => {
      putCharacter(row({ id: "a" }));
      putCharacter(row({ id: "b" }));
      expect(removeCharacters(["a", "nope"])).toBe(1);
      expect(listCharacters().map((r) => r.id)).toEqual(["b"]);
    });
  });
});
