import { describe, expect, it } from "vitest";
import { deriveSceneSeed, mintSeed } from "@/lib/story/seeds";

describe("story seeds", () => {
  it("derives a stable seed per scene", () => {
    expect(deriveSceneSeed(42, "sc_1_abc")).toBe(deriveSceneSeed(42, "sc_1_abc"));
    expect(deriveSceneSeed(42, "sc_1_abc")).toBe(deriveSceneSeed(42, "sc_1_abc"));
  });

  it("differs across scenes, base seeds and attempts", () => {
    const base = deriveSceneSeed(42, "sc_1_abc");
    expect(deriveSceneSeed(42, "sc_2_def")).not.toBe(base);
    expect(deriveSceneSeed(43, "sc_1_abc")).not.toBe(base);
    expect(deriveSceneSeed(42, "sc_1_abc", 1)).not.toBe(base);
  });

  it("stays inside the 0–1e6 render seed range", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const seed = deriveSceneSeed(999_999, "sc_x", attempt);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1_000_000);
    }
  });

  it("mints seeds in range", () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = mintSeed();
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1_000_000);
      expect(Number.isInteger(seed)).toBe(true);
    }
  });
});
