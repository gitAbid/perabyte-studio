import { describe, expect, it } from "vitest";
import { ProductionApplicationError } from "./errors";
import { ProductionProfileSchema, resolveProductionProfile } from "./profiles";

describe("production profiles", () => {
  it("provides validated short and long immutable defaults", () => {
    expect(Object.isFrozen(ProductionProfileSchema)).toBe(true);
    for (const [id, format, targetFrames] of [["storybook-short-v1", "9:16", 1152], ["storybook-long-v1", "16:9", 5760]] as const) {
      expect(resolveProductionProfile(id)).toEqual({ id, format, targetFrames, language: "en", ageIntent: "5-8", projectCapMinor: null, dailyCapMinor: null });
    }
  });

  it("returns isolated snapshots and rejects unknown IDs with stable INVALID_INPUT", () => {
    const first = resolveProductionProfile("storybook-short-v1");
    (first as { language: string }).language = "fr";
    expect(resolveProductionProfile("storybook-short-v1").language).toBe("en");
    try { resolveProductionProfile("missing"); throw new Error("expected error"); }
    catch (error) { expect(error).toBeInstanceOf(ProductionApplicationError); expect((error as ProductionApplicationError).code).toBe("INVALID_INPUT"); }
  });

  it("resolves a validated profile from an injected catalog", () => {
    const custom = { id: "mythology-v2", format: "16:9" as const, targetFrames: 7200, language: "fr", ageIntent: "12+", projectCapMinor: null, dailyCapMinor: null };
    expect(resolveProductionProfile(custom.id, [custom])).toEqual(custom);
    expect(() => resolveProductionProfile(custom.id, [{ ...custom, targetFrames: 0 }])).toThrow();
  });
});
