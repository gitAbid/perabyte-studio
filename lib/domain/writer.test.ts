import { describe, expect, it } from "vitest";
import {
  WRITER_DRAFT_MAX,
  WRITER_IDEA_MAX,
  clampScenePrompt,
  enhanceDraftInstruction,
  extractStoryScenes,
  parseEnhanceBody,
  parseSplitBody,
  parseWriteBody,
  splitScenesInstruction,
  writeStoryInstruction,
} from "@/lib/domain/writer";

describe("writer request validation", () => {
  it("rejects an empty or oversized idea", () => {
    expect(() => parseWriteBody({ action: "write", brief: { idea: "   " } })).toThrow(
      /idea/i,
    );
    expect(() =>
      parseWriteBody({ action: "write", brief: { idea: "x".repeat(WRITER_IDEA_MAX + 1) } }),
    ).toThrow(/idea/i);
  });

  it("defaults scene count and clamps out-of-range values", () => {
    expect(parseWriteBody({ action: "write", brief: { idea: "a chase" } }).sceneCount).toBe(5);
    expect(parseWriteBody({ action: "write", brief: { idea: "a", sceneCount: 0 } }).sceneCount).toBe(1);
    expect(parseWriteBody({ action: "write", brief: { idea: "a", sceneCount: 99 } }).sceneCount).toBe(12);
  });

  it("ignores unknown tone names and normalizes character names", () => {
    const parsed = parseWriteBody({
      action: "write",
      brief: { idea: "a", tone: "nope", characterNames: [" Ada ", "", "Riven"] },
    });
    expect(parsed.tone).toBeNull();
    expect(parsed.characterNames).toEqual(["Ada", "Riven"]);
  });

  it("normalizes the 'none' tone to null", () => {
    expect(parseWriteBody({ action: "write", brief: { idea: "a", tone: "none" } }).tone).toBeNull();
    expect(parseWriteBody({ action: "write", brief: { idea: "a", tone: "dark" } }).tone).toBe("dark");
  });

  it("validates enhance and split bodies", () => {
    expect(() => parseEnhanceBody({ action: "enhance", draft: "", instruction: "x" })).toThrow();
    expect(() => parseEnhanceBody({ action: "enhance", draft: "ok", instruction: "" })).toThrow();
    expect(() =>
      parseSplitBody({ action: "split", draft: "y".repeat(WRITER_DRAFT_MAX + 1), sceneCount: 3 }),
    ).toThrow();
    expect(parseSplitBody({ action: "split", draft: "prose", sceneCount: 4 })).toMatchObject({
      sceneCount: 4,
    });
    expect(parseSplitBody({ action: "split", draft: "prose" }).sceneCount).toBe(5);
  });

  it("defaults the split kind to image and clamps unknown values", () => {
    expect(parseSplitBody({ action: "split", draft: "prose" }).kind).toBe("image");
    expect(parseSplitBody({ action: "split", draft: "prose", kind: "video" }).kind).toBe("video");
    expect(parseSplitBody({ action: "split", draft: "prose", kind: "image" }).kind).toBe("image");
    expect(parseSplitBody({ action: "split", draft: "prose", kind: "film" }).kind).toBe("image");
    expect(parseSplitBody({ action: "split", draft: "prose", kind: 7 }).kind).toBe("image");
  });
});

describe("instruction builders", () => {
  it("embeds the brief fields", () => {
    const text = writeStoryInstruction({
      idea: "a neon chase",
      sceneCount: 5,
      tone: "dark",
      characterNames: ["Ada"],
      uncensored: true,
    });
    expect(text).toContain("a neon chase");
    expect(text).toContain("5");
    expect(text).toContain("dark");
    expect(text).toContain("Ada");
  });

  it("enhance instruction carries draft and instruction", () => {
    const text = enhanceDraftInstruction("old draft", "make it darker");
    expect(text).toContain("old draft");
    expect(text).toContain("make it darker");
  });

  it("split instruction demands JSON output with the requested count", () => {
    const text = splitScenesInstruction("prose", 4, []);
    expect(text).toContain("4");
    expect(text).toContain('"scenes"');
    expect(text).toContain("JSON");
  });

  it("split instruction adds a video-clip rule only for video kind", () => {
    const video = splitScenesInstruction("prose", 4, [], "video");
    expect(video).toContain("motion");
    expect(video).toContain("camera movement");
    expect(video).toContain("5-second");
    const image = splitScenesInstruction("prose", 4, []);
    const explicitImage = splitScenesInstruction("prose", 4, [], "image");
    expect(explicitImage).toBe(image);
    expect(image).not.toContain("motion");
  });
});

describe("extractStoryScenes", () => {
  it("parses a clean JSON object", () => {
    const parsed = extractStoryScenes(
      JSON.stringify({ title: "The Chase", scenes: ["scene one", "scene two"] }),
      2,
    );
    expect(parsed).toEqual({ title: "The Chase", scenes: ["scene one", "scene two"] });
  });

  it("survives code fences and surrounding chatter", () => {
    const raw = 'Here you go!\n```json\n{"title":"T","scenes":["a","b"]}\n```\nHope that helps.';
    expect(extractStoryScenes(raw, 2)).toEqual({ title: "T", scenes: ["a", "b"] });
  });

  it("filters empty scenes and clamps to the requested count", () => {
    const raw = JSON.stringify({ title: "T", scenes: ["a", "", "  ", "b", "c", "d"] });
    expect(extractStoryScenes(raw, 3)).toEqual({ title: "T", scenes: ["a", "b", "c"] });
  });

  it("returns null on unusable replies", () => {
    expect(extractStoryScenes("no json at all", 3)).toBeNull();
    expect(extractStoryScenes('{"scenes": "not an array"}', 3)).toBeNull();
    expect(extractStoryScenes('{"title":"T","scenes":[]}', 3)).toBeNull();
  });

  it("trims over-length scenes at a sentence boundary", () => {
    const long = `${"A".repeat(900)}. ${"B".repeat(900)}.`;
    const parsed = extractStoryScenes(JSON.stringify({ scenes: [long] }), 1);
    expect(parsed!.scenes[0].length).toBeLessThanOrEqual(1000);
    expect(parsed!.scenes[0].endsWith(".")).toBe(true);
  });
});

describe("clampScenePrompt", () => {
  it("keeps short prompts untouched", () => {
    expect(clampScenePrompt("short")).toBe("short");
  });
  it("falls back to a hard cut without sentence punctuation", () => {
    expect(clampScenePrompt("x".repeat(1400)).length).toBe(1000);
  });
});
