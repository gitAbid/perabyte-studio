import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHARACTER_SPEC, type CharacterSpec } from "@/lib/character";
import {
  addCharacter,
  getCharacter,
  getCharacters,
  removeCharacter,
  resetCharactersForTests,
  updateCharacter,
} from "@/lib/repositories/characters.repository";

class LocalStorageStub {
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

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: new LocalStorageStub() });
  resetCharactersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCharactersForTests();
});

describe("characters repository", () => {
  it("starts empty", () => {
    expect(getCharacters()).toEqual([]);
  });

  it("adds a named character with a trimmed name and reads it back", () => {
    const character = addCharacter("  Maya  ", { ...DEFAULT_CHARACTER_SPEC }, "/api/media?f=x");
    expect(character.name).toBe("Maya");
    expect(character.thumbnail).toBe("/api/media?f=x");
    expect(getCharacters()).toHaveLength(1);
    expect(getCharacter(character.id)?.name).toBe("Maya");
  });

  it("falls back to a default name and omits an absent thumbnail", () => {
    const character = addCharacter("   ", DEFAULT_CHARACTER_SPEC);
    expect(character.name).toBe("Untitled character");
    expect(character.thumbnail).toBeUndefined();
  });

  it("persists to localStorage and newest first", () => {
    const first = addCharacter("First", DEFAULT_CHARACTER_SPEC);
    const second = addCharacter("Second", DEFAULT_CHARACTER_SPEC);
    const raw = JSON.parse(window.localStorage.getItem("perabyte.characters.v1") as string);
    expect(raw[0].name).toBe("Second");
    expect(getCharacter(first.id)?.name).toBe("First");
    expect(second.createdAt).toBeGreaterThanOrEqual(first.createdAt);
  });

  it("renames via update without moving createdAt", () => {
    const character = addCharacter("Before", DEFAULT_CHARACTER_SPEC);
    updateCharacter(character.id, { name: "After" });
    const updated = getCharacter(character.id);
    expect(updated?.name).toBe("After");
    expect(updated?.createdAt).toBe(character.createdAt);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(character.createdAt);
  });

  it("removes by id", () => {
    const character = addCharacter("Temp", DEFAULT_CHARACTER_SPEC);
    removeCharacter(character.id);
    expect(getCharacters()).toEqual([]);
  });

  it("keeps a saved spec round-trip intact", () => {
    const spec: CharacterSpec = {
      ...DEFAULT_CHARACTER_SPEC,
      gender: "Male",
      nsfwLevel: 2,
      outfit: "Lingerie",
    };
    const character = addCharacter("Round trip", spec);
    expect(getCharacter(character.id)?.spec).toEqual(spec);
  });
});