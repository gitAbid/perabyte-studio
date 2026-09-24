import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { LocationRow } from "@/lib/repositories/location-row";
import type { ModelDescriptor } from "@/lib/domain/models";
import type { StoryScene } from "@/lib/types";
import {
  buildGateExpectations,
  keyframePrompt,
  keyframeRefs,
  resolveKeyframeStrategy,
} from "@/lib/story/keyframe";

function character(id: string, front?: string): CharacterRow {
  return {
    id,
    name: `Char ${id}`,
    spec: { ...DEFAULT_CHARACTER_SPEC, prompt: `identity of ${id}` },
    ...(front ? { identity: { front } } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

const LOCATION: LocationRow = {
  id: "loc_1",
  name: "Rooftop bar",
  description: "neon-lit downtown rooftop",
  ref: "locplate.png",
  createdAt: 1,
  updatedAt: 1,
};

function scene(over: Partial<StoryScene> = {}): StoryScene {
  return { id: "sc1", prompt: "she waits", url: null, status: "queued", kind: "video", ...over };
}

function descriptor(id: string, over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    provider: "sogni",
    model: id,
    label: id,
    kind: "image",
    ...over,
  } as ModelDescriptor;
}

describe("keyframeRefs", () => {
  it("interleaves by priority — first front, location, prev end, then remaining fronts", () => {
    const refs = keyframeRefs([character("a", "front_a.png"), character("b", "front_b.png")], LOCATION, "prev.jpg");
    expect(refs).toEqual(["front_a.png", "locplate.png", "prev.jpg", "front_b.png"]);
  });

  it("skips characters without an identity front and dedupes repeats", () => {
    const refs = keyframeRefs([character("a")], LOCATION, "locplate.png");
    expect(refs).toEqual(["locplate.png"]);
  });
});

describe("resolveKeyframeStrategy", () => {
  const cast = [character("a", "front_a.png")];

  it("rung none: a manual start frame outranks everything", () => {
    const strategy = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene({ startImageRef: "manual.png" }),
      cast,
      location: LOCATION,
      imageModels: [descriptor("edit", { contextImages: { min: 0, max: 16 } })],
    });
    expect(strategy).toEqual({ rung: "none", reason: "manual start frame" });
  });

  it("rung none: nothing to anchor with", () => {
    const strategy = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene(),
      cast: [character("a")],
      imageModels: [descriptor("edit", { contextImages: { min: 0, max: 16 } })],
    });
    expect(strategy).toEqual({ rung: "none", reason: "no identity or location references" });
  });

  it("rung multi: largest context capacity wins, refs trim to its max by priority", () => {
    const strategy = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene(),
      cast: [character("a", "front_a.png"), character("b", "front_b.png")],
      location: LOCATION,
      predecessorEndRef: "prev.jpg",
      imageModels: [
        descriptor("qwen", { contextImages: { min: 1, max: 3 } }),
        descriptor("gpt", { contextImages: { min: 0, max: 16 } }),
      ],
    });
    expect(strategy).toEqual({
      rung: "multi",
      modelId: "gpt",
      refs: ["front_a.png", "locplate.png", "prev.jpg", "front_b.png"],
    });

    const trimmed = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene(),
      cast: [character("a", "front_a.png"), character("b", "front_b.png")],
      location: LOCATION,
      predecessorEndRef: "prev.jpg",
      imageModels: [descriptor("qwen", { contextImages: { min: 1, max: 3 } })],
    });
    expect(trimmed).toEqual({
      rung: "multi",
      modelId: "qwen",
      refs: ["front_a.png", "locplate.png", "prev.jpg"],
    });
  });

  it("rung single: img2img fallback takes the first ref (the first cast front)", () => {
    const strategy = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene(),
      cast: [character("a", "front_a.png")],
      location: LOCATION,
      imageModels: [descriptor("i2v-solo", { frameInput: { start: true, end: false } })],
    });
    expect(strategy).toEqual({ rung: "single", modelId: "i2v-solo", startRef: "front_a.png" });
  });

  it("rung none: no capable image model at all", () => {
    const strategy = resolveKeyframeStrategy({
      story: {} as never,
      scene: scene(),
      cast,
      location: LOCATION,
      imageModels: [descriptor("plain")],
    });
    expect(strategy).toEqual({ rung: "none", reason: "no context-capable or img2img image model" });
  });
});

describe("buildGateExpectations", () => {
  it("composes identity anchors and applies scene outfit overrides", () => {
    const expectations = buildGateExpectations(
      scene({ state: { characters: [{ id: "a", outfit: "Modern streetwear" }] } }),
      [character("a")],
      LOCATION,
    );
    expect(expectations?.identity).toContain("25-year-old");
    expect(expectations?.outfit).toBe("Modern streetwear");
    expect(expectations?.location).toContain("Rooftop bar — neon-lit downtown rooftop");
  });

  it("null when there is nothing to judge", () => {
    expect(buildGateExpectations(scene(), [], undefined)).toBeNull();
  });
});

describe("keyframePrompt", () => {
  it("appends the framing clause to the composed shot prompt", () => {
    const prompt = keyframePrompt("portrait of an adult woman, 18+, at the bar");
    expect(prompt).toContain("portrait of an adult woman");
    expect(prompt).toContain("same faces, same outfits, same environment");
  });
});
