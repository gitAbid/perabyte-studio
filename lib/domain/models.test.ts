import { describe, expect, it } from "vitest";
import {
  buildModelId,
  durationToSeconds,
  isSensitiveAsset,
  parseModelId,
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
