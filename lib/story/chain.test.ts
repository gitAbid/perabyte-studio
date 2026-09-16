import { describe, expect, it } from "vitest";
import { resolveChainModelPlan } from "@/lib/story/chain";

describe("resolveChainModelPlan", () => {
  const startCapable = [
    { id: "sogni:fake_t2v", label: "Fake 2.3 T2V Dev" },
    // The hidden i2v sibling the service swaps to — not in the picker.
    { id: "sogni:fake_i2v", label: "Fake 2.3 I2V Dev" },
  ];

  it("swaps a frame-incapable pick to its i2v sibling", () => {
    expect(
      resolveChainModelPlan({
        picked: {
          id: "sogni:fake_t2v",
          label: "Fake 2.3 T2V Dev",
          i2vModelId: "sogni:fake_i2v",
        },
        startCapable,
      }),
    ).toEqual({ action: "swap", modelId: "sogni:fake_i2v", label: "Fake 2.3 I2V Dev" });
  });

  it("reports prompt-only continuation when no sibling exists", () => {
    expect(
      resolveChainModelPlan({
        picked: { id: "sogni:lonely_t2v", label: "Lonely T2V" },
        startCapable,
      }),
    ).toEqual({ action: "prompt-only" });
  });

  it("reports prompt-only when the sibling id is unknown to the catalog", () => {
    expect(
      resolveChainModelPlan({
        picked: {
          id: "sogni:fake_t2v",
          label: "Fake 2.3 T2V Dev",
          i2vModelId: "sogni:ghost_i2v",
        },
        startCapable,
      }),
    ).toEqual({ action: "prompt-only" });
  });

  it("returns null when the pick already chains on itself", () => {
    expect(
      resolveChainModelPlan({
        picked: {
          id: "sogni:seedance-2-0",
          label: "Seedance 2.0",
          frameInput: { start: true, end: false },
        },
        startCapable,
      }),
    ).toBeNull();
  });

  it("returns null when the pick takes frames but lists no sibling", () => {
    expect(
      resolveChainModelPlan({
        picked: {
          id: "sogni:seedance-2-5",
          label: "Seedance 2.5",
          frameInput: { start: true, end: true },
          i2vModelId: "sogni:seedance-2-5_i2v",
        },
        startCapable,
      }),
    ).toBeNull();
  });
});
