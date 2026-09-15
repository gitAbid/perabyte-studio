import { describe, expect, it } from "vitest";
import { buildClipScenes, resolveEndCapableModel } from "@/lib/story/convert";

describe("buildClipScenes", () => {
  const sources = [
    { sceneId: "s1", prompt: "a fox at dawn", ref: "a.png" },
    { sceneId: "s2", prompt: "the fox runs", ref: "b.png" },
    { sceneId: "s3", prompt: "sunset", ref: "c.png" },
  ];

  it("produces N-1 clips with paired start/end refs", () => {
    const clips = buildClipScenes(sources);
    expect(clips).toHaveLength(2);
    expect(clips[0].startImageRef).toBe("a.png");
    expect(clips[0].endImageRef).toBe("b.png");
    expect(clips[1].startImageRef).toBe("b.png");
    expect(clips[1].endImageRef).toBe("c.png");
    expect(clips.every((c) => c.status === "queued")).toBe(true);
    expect(clips.every((c) => c.kind === "video")).toBe(true);
  });

  it("gives fewer than two sources zero clips", () => {
    expect(buildClipScenes(sources.slice(0, 1))).toEqual([]);
  });

  it("keeps prompts short and motion-focused", () => {
    const clips = buildClipScenes(sources);
    expect(clips[0].prompt.length).toBeLessThanOrEqual(240);
    expect(clips[0].prompt).toContain("the fox runs");
  });

  it("truncates a very long source prompt", () => {
    const long = { sceneId: "x", prompt: "word ".repeat(200), ref: "x.png" };
    const clips = buildClipScenes([sources[0], long]);
    expect(clips[0].prompt.length).toBeLessThanOrEqual(240);
  });
});

describe("resolveEndCapableModel", () => {
  const available = ["sogni:minimax-h3-fl2va-fp8_i2v_turbo", "sogni:ltx23-22b-fp8_i2v_distilled"];
  const capable = new Set(["sogni:ltx23-22b-fp8_i2v_distilled"]);

  it("keeps the user's model when it can condition on an end frame", () => {
    expect(resolveEndCapableModel("sogni:ltx23-22b-fp8_i2v_distilled", capable, available)).toBe(
      "sogni:ltx23-22b-fp8_i2v_distilled",
    );
  });

  it("falls back through the preference list", () => {
    expect(resolveEndCapableModel(undefined, capable, available)).toBe(
      "sogni:ltx23-22b-fp8_i2v_distilled",
    );
  });

  it("returns null when nothing end-capable is available", () => {
    expect(resolveEndCapableModel("pollinations:flux-keyframe", capable, [])).toBeNull();
  });
});
