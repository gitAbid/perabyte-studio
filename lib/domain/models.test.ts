import { describe, expect, it } from "vitest";
import {
  buildModelId,
  durationToSeconds,
  isSensitiveAsset,
  parseModelId,
  type FrameImage,
  type ModelDescriptor,
  type NormalizedGenerationRequest,
} from "@/lib/domain/models";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

describe("model id helpers", () => {
  it("round-trips a provider-qualified model id", () => {
    const id = buildModelId("apikey-fan", "grok-imagine-image-2.0");
    expect(id).toBe("apikey-fan:grok-imagine-image-2.0");
    expect(parseModelId(id)).toEqual({
      providerId: "apikey-fan",
      model: "grok-imagine-image-2.0",
    });
  });

  it("rejects ids without a provider segment", () => {
    expect(parseModelId("grok-imagine-image")).toBeNull();
    expect(parseModelId(":grok")).toBeNull();
    expect(parseModelId("grok:")).toBeNull();
  });
});

describe("durationToSeconds", () => {
  it("parses the duration presets", () => {
    expect(durationToSeconds("3s")).toBe(3);
    expect(durationToSeconds("5s")).toBe(5);
    expect(durationToSeconds("10s")).toBe(10);
  });

  it("falls back to 5 seconds for garbage", () => {
    expect(durationToSeconds("long" as never)).toBe(5);
  });
});

describe("multi-reference capability", () => {
  const frame: FrameImage = { bytes: Buffer.from("ref-bytes"), contentType: "image/png" };

  it("round-trips contextImages on a model descriptor", () => {
    const descriptor: ModelDescriptor = {
      id: "sogni:qwen_image_edit_2511_fp8",
      providerId: "sogni",
      kind: "image",
      model: "qwen_image_edit_2511_fp8",
      label: "Qwen Image Edit",
      contextImages: { min: 1, max: 3 },
    };
    const spread: ModelDescriptor = { ...descriptor };
    expect(spread.contextImages).toEqual({ min: 1, max: 3 });
  });

  it("carries referenceImages on a normalized request", () => {
    const request: NormalizedGenerationRequest = {
      kind: "image",
      prompt: "same character",
      negativePrompt: "",
      aspect: "16:9",
      resolution: "1080p",
      durationSeconds: 0,
      count: 1,
      seed: null,
      safe: true,
      enhance: true,
      referenceImages: [frame],
    };
    expect(request.referenceImages).toEqual([frame]);
  });
});

describe("isSensitiveAsset", () => {
  function assetWith(safe: boolean | undefined): Asset {
    return {
      id: "a_test",
      kind: "image",
      title: "Test",
      prompt: "p",
      url: "",
      variants: [],
      settings: { ...DEFAULT_IMAGE_SETTINGS, ...(safe === undefined ? {} : { safe }) },
      createdAt: 0,
      favorite: false,
      mode: "Solo Mode (Image)",
    };
  }

  it("flags renders made with the safety checker off", () => {
    expect(isSensitiveAsset(assetWith(false))).toBe(true);
  });

  it("treats safe renders and defaults as not sensitive", () => {
    expect(isSensitiveAsset(assetWith(true))).toBe(false);
    expect(isSensitiveAsset(assetWith(undefined))).toBe(false);
  });

  it("is safe when settings are missing entirely", () => {
    expect(isSensitiveAsset({} as Partial<Asset>)).toBe(false);
  });
});
