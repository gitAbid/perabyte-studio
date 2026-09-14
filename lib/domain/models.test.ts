import { describe, expect, it } from "vitest";
import {
  buildModelId,
  durationToSeconds,
  parseModelId,
} from "@/lib/domain/models";

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
