import { describe, expect, it } from "vitest";
import type { Asset, StoryScene } from "@/lib/types";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { LocationRow } from "@/lib/repositories/location-row";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";
import { validateStoryCanon } from "@/lib/story/canon";

function scene(id: string, over: Partial<StoryScene> = {}): StoryScene {
  return { id, prompt: "scene", url: null, status: "queued", kind: "image", ...over };
}

function story(scenes: StoryScene[], over: Partial<Asset> = {}): Asset {
  return {
    id: "story-1", kind: "story", title: "Story", prompt: "premise", url: "", variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS }, createdAt: 0, favorite: false, mode: "Story Mode", scenes, ...over,
  };
}

const character: CharacterRow = {
  id: "character-1", name: "Mara", spec: DEFAULT_CHARACTER_SPEC,
  createdAt: 0, updatedAt: 0,
};
const location: LocationRow = { id: "location-1", name: "Rooftop", createdAt: 0, updatedAt: 0 };

describe("validateStoryCanon", () => {
  it("reports missing declared cast and scene cast outside the declared story cast", () => {
    const violations = validateStoryCanon(
      story([scene("one", { state: { characters: [{ id: "character-2" }] } })], {
        meta: { characterIds: ["deleted-character", "character-1"] },
      }),
      [character],
      [],
    );
    expect(violations).toEqual([
      expect.objectContaining({ field: "meta.characterIds", id: "deleted-character" }),
      expect.objectContaining({ field: "scenes.one.state.characters", id: "character-2" }),
    ]);
  });

  it("reports unknown world and scene location ids but permits free text and absent ids", () => {
    const violations = validateStoryCanon(
      story([
        scene("one", { state: { locationId: "deleted-scene-location", locationText: "forest" } }),
        scene("two", { state: { locationText: "old mill" } }),
      ], { world: { locationIds: ["deleted-world-location"] } }),
      [],
      [location],
    );
    expect(violations).toEqual([
      expect.objectContaining({ field: "world.locationIds", id: "deleted-world-location" }),
      expect.objectContaining({ field: "scenes.one.state.locationId", id: "deleted-scene-location" }),
    ]);
  });

  it("allows scene cast from the explicitly declared story cast", () => {
    expect(validateStoryCanon(
      story([scene("one", { state: { characters: [{ id: "character-1" }] } })], {
        meta: { characterIds: ["character-1"] },
      }),
      [character],
      [location],
    )).toEqual([]);
  });

  it("rejects effective scene casts larger than the renderer supports", () => {
    const cast = Array.from({ length: 4 }, (_, index) => ({
      ...character,
      id: `character-${index + 1}`,
    }));
    const violations = validateStoryCanon(
      story([scene("crowd", { state: { characters: cast.map(({ id }) => ({ id })) } })], {
        meta: { characterIds: cast.map(({ id }) => id) },
      }),
      cast,
      [],
    );
    expect(violations).toContainEqual(expect.objectContaining({
      field: "scenes.crowd.state.characters",
      sceneId: "crowd",
      message: expect.stringMatching(/4 characters.*split/i),
    }));
  });
});
