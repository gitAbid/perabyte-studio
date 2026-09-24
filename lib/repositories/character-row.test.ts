import { describe, expect, it } from "vitest";
import {
  parseCharacterRow,
  type CharacterIdentity,
} from "@/lib/repositories/character-row";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";

const base = {
  id: "ch_1",
  name: "Ava",
  spec: { ...DEFAULT_CHARACTER_SPEC },
  createdAt: 1,
  updatedAt: 1,
};

describe("parseCharacterRow", () => {
  it("accepts a valid row and passes extras through", () => {
    const row = parseCharacterRow({
      ...base,
      thumbnail: "/api/media?f=x",
      parentId: "ch_0",
      favorite: true,
      tags: ["main cast"],
      futureField: 1,
    });
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Ava");
    expect(row!.favorite).toBe(true);
    expect(row!.parentId).toBe("ch_0");
    expect(row!.tags).toEqual(["main cast"]);
    expect((row as unknown as Record<string, unknown>).futureField).toBe(1);
  });

  it("rejects rows missing identity or spec", () => {
    expect(parseCharacterRow(null)).toBeNull();
    expect(parseCharacterRow(undefined)).toBeNull();
    expect(parseCharacterRow("nope")).toBeNull();
    expect(parseCharacterRow({ ...base, id: "" })).toBeNull();
    expect(parseCharacterRow({ ...base, spec: null })).toBeNull();
    expect(parseCharacterRow({ ...base, name: 5 })).toBeNull();
    expect(parseCharacterRow({ ...base, createdAt: "x" })).toBeNull();
    expect(parseCharacterRow({ ...base, updatedAt: undefined })).toBeNull();
  });

  it("clamps the age and fills missing spec fields from defaults", () => {
    const row = parseCharacterRow({
      ...base,
      spec: { prompt: "  a warrior  ", age: 12 },
    });
    expect(row).not.toBeNull();
    expect(row!.spec.age).toBe(18);
    expect(typeof row!.spec.style).toBe("string");
    expect(row!.spec.prompt).toBe("  a warrior  "); // prompt preserved verbatim
  });

  it("coerces optional fields defensively", () => {
    const bad = parseCharacterRow({ ...base, favorite: "yes", tags: "solo", thumbnail: 9 });
    expect(bad!.favorite).toBeUndefined();
    expect(bad!.tags).toBeUndefined();
    expect(bad!.thumbnail).toBeUndefined();

    const good = parseCharacterRow({
      ...base,
      favorite: false,
      tags: ["a", "b"],
      thumbnail: "/api/media?f=y",
      parentId: "",
    });
    expect(good!.favorite).toBe(false);
    expect(good!.tags).toEqual(["a", "b"]);
    expect(good!.thumbnail).toBe("/api/media?f=y");
    expect(good!.parentId).toBeUndefined(); // empty string drops
  });

  it("persists identity through the parser (round-trip)", () => {
    const identity: CharacterIdentity = {
      front: "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8.png",
      angles: ["c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2.png"],
      seed: 42,
      modelId: "flux-dev",
    };
    const row = parseCharacterRow({ ...base, identity });
    expect(row).not.toBeNull();
    expect(row!.identity).toEqual(identity);
  });

  it("leaves a partial identity untouched (presence-only, extras passthrough)", () => {
    const row = parseCharacterRow({ ...base, identity: { front: "abc.png" } });
    expect(row!.identity).toEqual({ front: "abc.png" });
    expect(parseCharacterRow(base)!.identity).toBeUndefined();
  });

  it("drops a wrong-typed identity instead of crashing consumers", () => {
    expect(parseCharacterRow({ ...base, identity: "abc.png" })!.identity).toBeUndefined();
    expect(parseCharacterRow({ ...base, identity: null })!.identity).toBeUndefined();
    expect(parseCharacterRow({ ...base, identity: 7 })!.identity).toBeUndefined();
  });
});
