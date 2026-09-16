import { describe, expect, it } from "vitest";
import { DEMO_SPECS, demoAsset, withDemoRows } from "@/lib/demo-content";
import type { Asset } from "@/lib/types";

describe("demo content", () => {
  it("defines the fixed example strip", () => {
    expect(DEMO_SPECS.length).toBeGreaterThanOrEqual(5);
    expect(DEMO_SPECS.every((s) => s.file.startsWith("/demo/"))).toBe(true);
  });

  it("builds example assets from a spec", () => {
    const spec = DEMO_SPECS[0];
    const asset = demoAsset(spec);
    expect(asset.id).toBe(`demo_${spec.seed}`);
    expect(asset.kind).toBe(spec.kind);
    expect(asset.meta?.example).toBe(true);
    expect(asset.url).toBe(spec.file);
    expect(asset.mode).toContain("Solo Mode");
  });

  it("withDemoRows adds unknown ids once and stays idempotent", () => {
    const first = withDemoRows([]);
    expect(first.length).toBe(DEMO_SPECS.length);
    const again = withDemoRows(first);
    expect(again.length).toBe(DEMO_SPECS.length);
  });

  it("withDemoRows sorts newest first around existing rows", () => {
    const custom: Asset = {
      ...demoAsset(DEMO_SPECS[0]),
      id: "custom",
      createdAt: Date.now() + 1_000_000,
    };
    const rows = withDemoRows([custom]);
    expect(rows[0]?.id).toBe("custom");
  });
});
