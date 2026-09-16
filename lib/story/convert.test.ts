import { describe, expect, it } from "vitest";
import { buildClipScenes, buildConvertSettings, resolveEndCapableModel } from "@/lib/story/convert";
import type { GenerationSettings } from "@/lib/types";

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

describe("buildConvertSettings", () => {
  const base = {
    kind: "image",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    duration: "5s",
    count: 1,
    seed: "",
    negativePrompt: "",
    enhance: true,
    safe: false,
    modelId: "sogni:krea2_turbo_fp8_scaled",
    chainModelId: "sogni:ltx23-22b-fp8_i2v_distilled",
    loras: [
      { loraId: "krea2-mystic-x", strength: 1 },
      { loraId: "h3-better-motion", strength: 2 },
    ],
  } as GenerationSettings;
  const chosen = "sogni:minimax-h3-fl2va-fp8_i2v";
  const models = [{ id: chosen, model: "minimax-h3-fl2va-fp8_i2v" }];
  const loras = [
    motionEntry(),
  ];

  function motionEntry() {
    return {
      loraId: "h3-better-motion",
      name: "Better Motion",
      description: "",
      category: "popular-community-fine-tunes",
      modelIds: ["minimax-h3-fl2va-fp8_i2v"],
      nsfw: false,
      sexual: false,
      min: -2,
      max: 2,
      default: 1,
      step: 0.1,
      recommendedMin: -1,
      recommendedMax: 1,
    };
  }

  it("switches to video on the chosen model with the default video style", () => {
    const settings = buildConvertSettings(base, chosen, { models, loras, loraMaxPerRequest: 8 });
    expect(settings.kind).toBe("video");
    expect(settings.modelId).toBe(chosen);
    expect(settings.style).toBe("Cinematic");
  });

  it("strips a composer chain-model override — the dialog's pick rules", () => {
    const settings = buildConvertSettings(base, chosen, { models, loras, loraMaxPerRequest: 8 });
    expect(settings.chainModelId).toBeUndefined();
  });

  it("keeps only LoRAs the chosen model accepts", () => {
    const settings = buildConvertSettings(base, chosen, { models, loras, loraMaxPerRequest: 8 });
    expect(settings.loras).toEqual([{ loraId: "h3-better-motion", strength: 2 }]);
  });

  it("wipes LoRA selections when the LoRA catalog is unavailable", () => {
    const settings = buildConvertSettings(base, chosen, { models, loras: [] });
    expect(settings.loras).toEqual([]);
  });
});
