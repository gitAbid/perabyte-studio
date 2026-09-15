import { describe, expect, it } from "vitest";
import {
  GenerationServiceError,
  validateGenerationRequest,
} from "@/lib/services/generation.service";

function baseBody(): Record<string, unknown> {
  return {
    kind: "image",
    prompt: "a serene mountain lake",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    duration: "5s",
    count: 2,
  };
}

describe("validateGenerationRequest", () => {
  it("accepts a well-formed request and applies defaults", () => {
    const request = validateGenerationRequest(baseBody());
    expect(request.kind).toBe("image");
    expect(request.safe).toBe(true);
    expect(request.enhance).toBe(true);
    expect(request.modelId).toBeNull();
    expect(request.seed).toBeNull();
  });

  it("rejects an empty prompt with a field marker", () => {
    expect(() => validateGenerationRequest({ ...baseBody(), prompt: "  " })).toThrowError(
      GenerationServiceError,
    );
    try {
      validateGenerationRequest({ ...baseBody(), prompt: "" });
    } catch (error) {
      expect((error as GenerationServiceError).field).toBe("prompt");
    }
  });

  it("rejects unknown aspect ratios, resolutions and durations", () => {
    expect(() => validateGenerationRequest({ ...baseBody(), aspect: "21:9" })).toThrowError(
      GenerationServiceError,
    );
    expect(() =>
      validateGenerationRequest({ ...baseBody(), resolution: "8K" }),
    ).toThrowError(GenerationServiceError);
    expect(() => validateGenerationRequest({ ...baseBody(), duration: "30s" })).toThrowError(
      GenerationServiceError,
    );
  });

  it("clamps an unknown or stale style to the kind's default instead of failing", () => {
    // Garbage style falls back to the image default.
    expect(validateGenerationRequest({ ...baseBody(), style: "Nope" }).style).toBe("Realistic");
    // A stale image style must not fail a video render.
    expect(
      validateGenerationRequest({ ...baseBody(), kind: "video", style: "Realistic" }).style,
    ).toBe("Cinematic");
    // A video request without a style defaults to "Cinematic".
    expect(
      validateGenerationRequest({ ...baseBody(), kind: "video", style: undefined }).style,
    ).toBe("Cinematic");
  });

  it("clamps the variant count and parses string seeds", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      count: 99,
      seed: "4821",
    });
    expect(request.count).toBe(4);
    expect(request.seed).toBe(4821);
  });

  it("carries an explicit uncensored request as safe:false", () => {
    const request = validateGenerationRequest({ ...baseBody(), safe: false });
    expect(request.safe).toBe(false);
  });

  it("keeps a chosen model id", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      modelId: "apikey-fan:grok-imagine-image-2.0",
    });
    expect(request.modelId).toBe("apikey-fan:grok-imagine-image-2.0");
  });
});
