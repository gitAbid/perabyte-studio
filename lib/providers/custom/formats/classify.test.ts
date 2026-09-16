import { describe, expect, it } from "vitest";
import { classifyModelId, guessEntry } from "./classify";

describe("classifyModelId", () => {
  it.each([
    ["gpt-image-1", "image"],
    ["imagen-4.0-generate", "image"],
    ["flux-pro-1.1", "image"],
    ["grok-imagine-image", "image"],
    ["grok-imagine-image-quality", "image"],
    ["stable-diffusion-3.5", "image"],
    ["black-forest-labs/flux-schnell", "image"],
    ["grok-imagine-video-1.5", "video"],
    ["veo-3.1-generate-preview", "video"],
    ["sora-2", "video"],
    ["kling-v2-master", "video"],
    ["grok-imagine-video", "video"],
    ["grok-4.5", "text"],
    ["gpt-4.1", "text"],
    ["claude-sonnet-4", "text"],
    ["qwen3.5-35b", "text"],
    ["deepseek-chat", "text"],
    ["gemini-2.5-flash", "text"],
    ["my-weird-model", "off"],
    ["totally-unknown-xyz", "off"],
  ])("%s → %s", (input, expected) => {
    expect(classifyModelId(input)).toBe(expected);
  });
});

describe("guessEntry", () => {
  it("enables guessed image/video models and holds text/off back", () => {
    const models = guessEntry([
      { model: "flux-pro", kind: "off" },
      { model: "veo-3", kind: "off" },
      { model: "grok-4.5", kind: "off" },
      { model: "mystery", kind: "off" },
    ]);
    expect(models).toEqual([
      { model: "flux-pro", kind: "image", enabled: true },
      { model: "veo-3", kind: "video", enabled: true },
      { model: "grok-4.5", kind: "text", enabled: false },
      { model: "mystery", kind: "off", enabled: false },
    ]);
  });

  it("trusts adapter-supplied kinds over name guessing", () => {
    const models = guessEntry([{ model: "chat-bison", label: "Bison", kind: "text" }]);
    expect(models).toEqual([
      { model: "chat-bison", label: "Bison", kind: "text", enabled: false },
    ]);
  });

  it("keeps the listing's display name as label", () => {
    const models = guessEntry([{ model: "sora-2", label: "Sora 2", kind: "off" }]);
    expect(models[0].label).toBe("Sora 2");
  });
});
