import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";
import {
  applySceneOverrides,
  diffSettingsBaseline,
  mergedSceneSettings,
} from "./scene-settings";

describe("mergedSceneSettings", () => {
  it("returns the story settings untouched without overrides", () => {
    const story = { ...DEFAULT_IMAGE_SETTINGS, aspect: "16:9" as const };
    expect(mergedSceneSettings(story, {})).toEqual(story);
  });

  it("layers the scene's sparse overrides over the story settings", () => {
    const story = { ...DEFAULT_IMAGE_SETTINGS, aspect: "16:9" as const, style: "Cinematic" };
    const merged = mergedSceneSettings(story, {
      settings: { aspect: "9:16", duration: "10s" },
    });
    expect(merged.aspect).toBe("9:16");
    expect(merged.duration).toBe("10s");
    expect(merged.style).toBe("Cinematic");
  });
});

describe("diffSettingsBaseline", () => {
  it("records only the touched keys", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = { ...baseline, aspect: "1:1" as const };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({ aspect: "1:1" });
  });

  it("ignores keys outside the per-scene override set", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = { ...baseline, count: 3, seed: "42", enhance: true };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({});
  });

  it("compares lora selections by content", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = {
      ...baseline,
      loras: [{ loraId: "l1", strength: 0.8 }],
    };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({
      loras: [{ loraId: "l1", strength: 0.8 }],
    });
  });
});

describe("applySceneOverrides", () => {
  it("merges touched keys over existing overrides", () => {
    expect(applySceneOverrides({ aspect: "9:16" }, { style: "Anime" })).toEqual({
      aspect: "9:16",
      style: "Anime",
    });
  });

  it("accepts no existing overrides", () => {
    expect(applySceneOverrides(undefined, { modelId: "prov:model-b" })).toEqual({
      modelId: "prov:model-b",
    });
  });
});
