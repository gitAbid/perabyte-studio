import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { Asset, StoryScene } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";
import { composeShot, type ShotLocation } from "@/lib/story/compose-shot";

function character(id: string, spec = DEFAULT_CHARACTER_SPEC): CharacterRow {
  return { id, name: `Char ${id}`, spec, createdAt: 1, updatedAt: 1 };
}

function story(safe: boolean): Asset {
  return {
    id: "s1",
    kind: "story",
    title: "Story",
    prompt: "s",
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS, kind: "image", count: 1, safe },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    meta: { continuity: true, running: false },
  };
}

function scene(over: Partial<StoryScene> = {}): StoryScene {
  return { id: "sc1", prompt: "she walks home", url: null, status: "queued", kind: "image", ...over };
}

const LOCATIONS: ShotLocation[] = [
  { id: "loc_1", name: "Rooftop bar", description: "neon-lit downtown rooftop", lighting: "moody neon glow" },
];

describe("composeShot", () => {
  it("matches the plain prompt when there is no cast and no state", () => {
    expect(composeShot(story(true), scene(), { characters: [] })).toBe("she walks home");
  });

  it("appends location, time-of-day and props clauses from state", () => {
    const out = composeShot(
      story(true),
      scene({
        state: {
          locationId: "loc_1",
          timeOfDay: "night",
          props: ["red umbrella", "empty glass"],
        },
      }),
      { characters: [], locations: LOCATIONS },
    );
    expect(out).toContain("Setting: Rooftop bar — neon-lit downtown rooftop — moody neon glow");
    expect(out).toContain("Time of day: night");
    expect(out).toContain("Props in scene: red umbrella, empty glass");
    expect(out.endsWith("she walks home")).toBe(true);
  });

  it("uses locationText when no location asset matches", () => {
    const out = composeShot(
      story(true),
      scene({ state: { locationText: "a rainy bus stop" } }),
      { characters: [], locations: LOCATIONS },
    );
    expect(out).toContain("Setting: a rainy bus stop");
  });

  it("does not duplicate a location the prompt already names", () => {
    const out = composeShot(
      story(true),
      scene({ prompt: "at the rooftop bar, she walks home", state: { locationText: "rooftop bar" } }),
      { characters: [] },
    );
    expect(out).not.toContain("Setting:");
  });

  it("does not duplicate a time of day the prompt already sets", () => {
    const out = composeShot(
      story(true),
      scene({ prompt: "under the moonlight she walks home", state: { timeOfDay: "night" } }),
      { characters: [] },
    );
    expect(out).not.toContain("Time of day:");
  });

  it("overrides a character's outfit for the scene only", () => {
    const cast = [character("ch_1", { ...DEFAULT_CHARACTER_SPEC, outfit: "Formal" })];
    const base = composeShot(story(true), scene(), { characters: cast });
    expect(base).toContain("wearing formal");

    const overridden = composeShot(
      story(true),
      scene({ state: { characters: [{ id: "ch_1", outfit: "Modern streetwear" }] } }),
      { characters: cast },
    );
    expect(overridden).toContain("wearing modern streetwear");
    expect(overridden).not.toContain("formal");
    // The row itself is never mutated.
    expect(cast[0].spec.outfit).toBe("Formal");
  });

  it("orders the cast by scene presence when state lists characters", () => {
    const first = character("ch_1", { ...DEFAULT_CHARACTER_SPEC, hairColor: "Black" });
    const second = character("ch_2", { ...DEFAULT_CHARACTER_SPEC, hairColor: "Blonde" });
    const out = composeShot(
      story(true),
      scene({ state: { characters: [{ id: "ch_2" }, { id: "ch_1" }] } }),
      { characters: [first, second] },
    );
    expect(out.indexOf("Blonde")).toBeLessThan(out.indexOf("black hair"));
  });

  it("follows the story's uncensored gate (safe === false)", () => {
    const cast = [character("ch_1", { ...DEFAULT_CHARACTER_SPEC, outfit: "Nude" })];
    expect(composeShot(story(false), scene(), { characters: cast })).toContain("nude");
    expect(composeShot(story(true), scene(), { characters: cast })).toContain("wearing casual");
  });
});
