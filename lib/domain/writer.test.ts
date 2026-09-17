import { describe, expect, it } from "vitest";
import { PROMPT_MAX } from "@/lib/constants";
import {
  WRITER_DRAFT_MAX,
  WRITER_IDEA_MAX,
  breakIntoScenePromptChunks,
  segmentDraftIntoScenes,
  clampScenePrompt,
  enhanceDraftInstruction,
  extractStoryScenes,
  parseEnhanceBody,
  parseSplitBody,
  parseWriteBody,
  splitScenesInstruction,
  suggestSceneCount,
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
    expect(text).toContain("Do not sanitize or moralize");
  });

  it("omits the uncensored clause when the flag is off", () => {
    const text = writeStoryInstruction({
      idea: "a neon chase",
      sceneCount: 5,
      tone: null,
      characterNames: [],
      uncensored: false,
    });
    expect(text).not.toContain("Do not sanitize or moralize");
  });

  it("enhance instruction carries draft, instruction, and the uncensored clause", () => {
    const text = enhanceDraftInstruction("old draft", "make it darker", true);
    expect(text).toContain("old draft");
    expect(text).toContain("make it darker");
    expect(text).toContain("Do not sanitize or moralize");
    expect(enhanceDraftInstruction("old draft", "make it darker", false)).not.toContain(
      "Do not sanitize or moralize",
    );
  });

  it("parses uncensored on enhance and split bodies", () => {
    expect(
      parseEnhanceBody({
        action: "enhance",
        draft: "adult scene",
        instruction: "more explicit",
        uncensored: true,
      }),
    ).toMatchObject({ uncensored: true });
    expect(
      parseEnhanceBody({ action: "enhance", draft: "adult scene", instruction: "more explicit" }),
    ).toMatchObject({ uncensored: false });
    expect(parseSplitBody({ action: "split", draft: "prose", uncensored: true })).toMatchObject({
      uncensored: true,
    });
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

  it("split instruction keeps adult visual detail when uncensored", () => {
    const text = splitScenesInstruction("adult prose", 3, [], "image", true);
    expect(text).toContain("Do not sanitize or moralize");
    expect(splitScenesInstruction("adult prose", 3, [], "image", false)).not.toContain(
      "Do not sanitize or moralize",
    );
  });
});

describe("extractStoryScenes", () => {
  it("parses a clean JSON object", () => {
    const parsed = extractStoryScenes(
      JSON.stringify({ title: "The Chase", scenes: ["scene one", "scene two"] }),
    );
    expect(parsed).toEqual({ title: "The Chase", scenes: ["scene one", "scene two"] });
  });

  it("survives code fences and surrounding chatter", () => {
    const raw = 'Here you go!\n```json\n{"title":"T","scenes":["a","b"]}\n```\nHope that helps.';
    expect(extractStoryScenes(raw)).toEqual({ title: "T", scenes: ["a", "b"] });
  });

  it("filters empty scenes and keeps over-count replies (scene count is a guide, not a cap)", () => {
    const raw = JSON.stringify({ title: "T", scenes: ["a", "", "  ", "b", "c", "d"] });
    expect(extractStoryScenes(raw)).toEqual({ title: "T", scenes: ["a", "b", "c", "d"] });
  });

  it("returns null on unusable replies", () => {
    expect(extractStoryScenes("no json at all")).toBeNull();
    expect(extractStoryScenes('{"scenes": "not an array"}')).toBeNull();
    expect(extractStoryScenes('{"title":"T","scenes":[]}')).toBeNull();
  });

  it("subdivides over-length scenes into ≤budget prompts without losing content", () => {
    const long = `${"A".repeat(900)}. ${"B".repeat(900)}.`;
    const parsed = extractStoryScenes(JSON.stringify({ scenes: [long] }), 1000);
    expect(parsed!.scenes.length).toBe(2);
    expect(parsed!.scenes.every((s) => s.length <= 1000)).toBe(true);
    expect(parsed!.scenes[0].endsWith(".")).toBe(true);
    // no text dropped — both halves survive across the chunks
    expect(parsed!.scenes.join(" ")).toContain("A".repeat(50));
    expect(parsed!.scenes.join(" ")).toContain("B".repeat(50));
  });
});

describe("clampScenePrompt", () => {
  it("keeps short prompts untouched", () => {
    expect(clampScenePrompt("short")).toBe("short");
  });
  it("falls back to a hard cut without sentence punctuation", () => {
    expect(clampScenePrompt("x".repeat(1400), 1000).length).toBe(1000);
  });
  it("defaults to the studio prompt budget", () => {
    expect(clampScenePrompt("x".repeat(PROMPT_MAX + 1)).length).toBe(PROMPT_MAX);
  });
});

describe("breakIntoScenePromptChunks", () => {
  it("returns short text as a single chunk", () => {
    expect(breakIntoScenePromptChunks("short")).toEqual(["short"]);
  });

  it("packs sentences into chunks of at most the given budget", () => {
    const text = Array.from({ length: 30 }, (_, i) => `${"word".repeat(8)} number ${i}.`).join(" ");
    const chunks = breakIntoScenePromptChunks(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-cuts a single sentence longer than the limit instead of dropping it", () => {
    const chunks = breakIntoScenePromptChunks("y".repeat(2500), 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.join("").length).toBe(2500);
  });

  it("defaults the budget to the studio prompt limit", () => {
    const chunks = breakIntoScenePromptChunks(". ".repeat(PROMPT_MAX));
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= PROMPT_MAX)).toBe(true);
  });
});

describe("segmentDraftIntoScenes", () => {
  it("splits on --- divider lines instead of packing by characters", () => {
    const draft = "First scene, short and whole.\n---\nSecond scene, also short.\n---\nThird scene.";
    expect(segmentDraftIntoScenes(draft)).toEqual([
      "First scene, short and whole.",
      "Second scene, also short.",
      "Third scene.",
    ]);
  });

  it("drops empty sections around repeated dividers", () => {
    const draft = "---\nOnly one real scene.\n---\n---\n---\nAnother real one.\n---";
    expect(segmentDraftIntoScenes(draft)).toEqual(["Only one real scene.", "Another real one."]);
  });

  it("keeps an over-length divider section whole — dividers are authoritative", () => {
    // Real-world shape: an authored ~1050-char scene slightly over the
    // 1000-char prompt budget must not be silently re-split into two scenes.
    const section = `${"A".repeat(900)}. ${"B".repeat(900)}.`;
    const draft = `Intro beat.\n---\n${section}`;
    const scenes = segmentDraftIntoScenes(draft);
    expect(scenes).toEqual(["Intro beat.", section]);
    expect(scenes[1].length).toBeGreaterThan(1000);
  });

  it("ignores --- that is not a standalone divider line", () => {
    const draft = "Three dashes inside a sentence --- stay part of the scene.";
    expect(segmentDraftIntoScenes(draft)).toEqual([draft]);
  });

  it("falls back to character-wise packing when no divider exists", () => {
    const text = Array.from({ length: 30 }, (_, i) => `${"word".repeat(8)} number ${i}.`).join(" ");
    expect(segmentDraftIntoScenes(text)).toEqual(breakIntoScenePromptChunks(text));
  });

  it("returns empty for an empty or divider-only draft", () => {
    expect(segmentDraftIntoScenes("")).toEqual([]);
    expect(segmentDraftIntoScenes("---\n---")).toEqual([]);
  });
});

describe("suggestSceneCount", () => {
  it("suggests one scene per budget characters when the count is too low", () => {
    expect(suggestSceneCount("x".repeat(4800), 3, 1000)).toBe(5);
  });

  it("returns null when the chosen count already covers the draft", () => {
    expect(suggestSceneCount("x".repeat(2500), 5, 1000)).toBeNull();
    expect(suggestSceneCount("", 5)).toBeNull();
  });

  it("never suggests more than the picker maximum", () => {
    expect(suggestSceneCount("x".repeat(20000), 5, 1000)).toBe(12);
  });

  it("defaults the per-scene budget to the studio prompt limit", () => {
    expect(suggestSceneCount("x".repeat(PROMPT_MAX * 6), 5)).toBe(6);
    expect(suggestSceneCount("x".repeat(PROMPT_MAX * 3), 5)).toBeNull();
  });
});
