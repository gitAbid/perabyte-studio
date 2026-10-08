import { describe, expect, it } from "vitest";
import { DERIVATIVE_ASPECTS, derivativeCacheKey, derivativeFilter, deriveDerivativeDimensions } from "./derivatives";
import { hashCanonicalJson } from "../../production/hash";

describe("derivative dimensions (M6-2)", () => {
  it("crops a 16:9 master into 9:16 and 1:1 without upscaling", () => {
    const vertical = deriveDerivativeDimensions(1920, 1080, "9:16");
    expect(vertical).toEqual({ width: 608, height: 1080 }); // 1080 * 9/16 = 607.5 → even-floor 608? verify evenness
    const square = deriveDerivativeDimensions(1920, 1080, "1:1");
    expect(square).toEqual({ width: 1080, height: 1080 });
    const same = deriveDerivativeDimensions(1920, 1080, "16:9");
    expect(same).toEqual({ width: 1920, height: 1080 });
    for (const size of [vertical, square, same]) {
      expect(size!.width % 2).toBe(0);
      expect(size!.height % 2).toBe(0);
      expect(size!.width).toBeLessThanOrEqual(1920);
      expect(size!.height).toBeLessThanOrEqual(1080);
    }
  });

  it("pads the limiting dimension the other way for narrow sources", () => {
    const wide = deriveDerivativeDimensions(1080, 1920, "16:9");
    expect(wide).toEqual({ width: 1080, height: 608 });
    expect(deriveDerivativeDimensions(0, 0, "1:1")).toBeNull();
  });

  it("builds a filter string and a stable cache key", () => {
    expect(derivativeFilter("1:1", 1920, 1080)).toContain("scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080");
    const key = derivativeCacheKey("a".repeat(64), { aspect: "9:16", quality: "high" });
    expect(key).toEqual(derivativeCacheKey("a".repeat(64), { aspect: "9:16", quality: "high" }));
    expect(key).not.toEqual(derivativeCacheKey("a".repeat(64), { aspect: "9:16", quality: "medium" }));
    expect(key).toHaveLength(32);
    expect(DERIVATIVE_ASPECTS.length).toBe(3);
    void hashCanonicalJson;
  });
});
