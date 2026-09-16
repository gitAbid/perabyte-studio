import { describe, expect, it } from "vitest";
import {
  chainPredecessor,
  chainPredecessorIndex,
  effectiveChainRef,
  resolveChainModelPlan,
} from "@/lib/story/chain";
import type { StoryScene } from "@/lib/types";

function refScene(partial: Partial<StoryScene> & { id: string }): StoryScene {
  return { prompt: "p", url: null, status: "queued", kind: "image", ...partial };
}

describe("chainPredecessor", () => {
  it("returns the nearest non-canceled scene before the index", () => {
    const scenes = [
      refScene({ id: "s1" }),
      refScene({ id: "s2", status: "canceled" }),
      refScene({ id: "s3" }),
    ];
    expect(chainPredecessor(scenes, 2)?.id).toBe("s1");
    expect(chainPredecessorIndex(scenes, 2)).toBe(0);
    expect(chainPredecessor(scenes, 1)?.id).toBe("s1");
    expect(chainPredecessor(scenes, 0)).toBeUndefined();
    expect(chainPredecessorIndex(scenes, 0)).toBe(-1);
  });
});

describe("effectiveChainRef", () => {
  it("prefers the scene's own manual start frame", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "pred.png" }),
      refScene({ id: "s2", startImageRef: "mine.png" }),
    ];
    expect(effectiveChainRef(scenes, 1, true)).toEqual({
      state: "manual",
      ref: "mine.png",
    });
  });

  it("chains from the predecessor's derived end frame", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(scenes, 1, true)).toEqual({
      state: "chained",
      ref: "f1.png",
      predecessorIndex: 0,
    });
  });

  it("is pending while the predecessor has no derived frame yet", () => {
    const queued = [refScene({ id: "s1" }), refScene({ id: "s2" })];
    expect(effectiveChainRef(queued, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
    const generating = [
      refScene({ id: "s1", status: "generating" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(generating, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
    // Completed but the end frame hasn't been backfilled yet.
    const awaitingBackfill = [
      refScene({ id: "s1", status: "completed", url: "a" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(awaitingBackfill, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
  });

  it("chains across a canceled predecessor", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      refScene({ id: "s2", status: "canceled" }),
      refScene({ id: "s3" }),
    ];
    expect(effectiveChainRef(scenes, 2, true)).toEqual({
      state: "chained",
      ref: "f1.png",
      predecessorIndex: 0,
    });
  });

  it("is none for the first scene, with continuity off, or with no live predecessor", () => {
    const first = [refScene({ id: "s1", endFrameRef: "f.png" })];
    expect(effectiveChainRef(first, 0, true)).toEqual({ state: "none" });
    const two = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f.png" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(two, 1, false)).toEqual({ state: "none" });
    const allCanceled = [
      refScene({ id: "s1", status: "canceled" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(allCanceled, 1, true)).toEqual({ state: "none" });
    expect(effectiveChainRef([], 0, true)).toEqual({ state: "none" });
  });
});

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
