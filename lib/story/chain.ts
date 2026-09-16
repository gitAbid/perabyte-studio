/**
 * Chain-model resolution for story scenes (pure — the page calls this before
 * spending a run). A chained scene carries the previous scene's final frame,
 * and most video picks are t2v workflow models that cannot condition on a
 * frame — the generation service then swaps the render to the family's hidden
 * i2v sibling. i2v models REQUIRE a reference image (Sogni submit error), so
 * the sibling can never render scene 1: the swap is inherently per-scene, and
 * this module exists to make it explicit up front instead of a surprise.
 */
import type { ModelOption } from "@/lib/model-catalog";
import type { StoryScene } from "@/lib/types";

export type ChainModelPlan =
  | {
      /** Chained scenes render with this (hidden) sibling model. */
      action: "swap";
      modelId: string;
      label: string;
    }
    /** No frame-capable sibling exists — chained scenes degrade to
     * prompt-only renders and the visual chain breaks. */
  | { action: "prompt-only" };

export function resolveChainModelPlan(input: {
  picked: Pick<ModelOption, "id" | "label" | "frameInput" | "i2vModelId">;
  /** Start-capable catalog entries (picker models + hidden i2v siblings). */
  startCapable: Pick<ModelOption, "id" | "label">[];
}): ChainModelPlan | null {
  // The pick takes a start frame — every scene renders on it, nothing to say.
  if (input.picked.frameInput?.start) return null;
  const sibling = input.picked.i2vModelId
    ? input.startCapable.find((model) => model.id === input.picked.i2vModelId)
    : undefined;
  if (sibling) {
    return { action: "swap", modelId: sibling.id, label: sibling.label };
  }
  return { action: "prompt-only" };
}

/**
 * Index of the nearest non-canceled scene before `index`, or -1. A canceled
 * scene is transparent to the chain — this is the single rule the runner and
 * the UI must agree on.
 */
export function chainPredecessorIndex(
  scenes: { status: string }[],
  index: number,
): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    // Optional chain: the page scans placeholder slots past the last scene.
    if (scenes[i]?.status !== "canceled") return i;
  }
  return -1;
}

/** The nearest non-canceled scene before `index` — undefined means "run
 * without a chain ref" (like scene 1). */
export function chainPredecessor<T extends { status: string }>(
  scenes: T[],
  index: number,
): T | undefined {
  const i = chainPredecessorIndex(scenes, index);
  return i === -1 ? undefined : scenes[i];
}

/** What the scene at `index` starts from, as the UI should show it. Pure —
 * same predecessor rule as the runner, so the preview can't disagree with
 * what actually renders. */
export type EffectiveChainRef =
  | { state: "manual"; ref: string }
  | { state: "chained"; ref: string; predecessorIndex: number }
  | { state: "pending"; predecessorIndex: number }
  | { state: "none" };

export function effectiveChainRef(
  scenes: StoryScene[],
  index: number,
  continuityOn: boolean,
): EffectiveChainRef {
  const scene = scenes[index];
  if (!scene) return { state: "none" };
  if (scene.startImageRef) return { state: "manual", ref: scene.startImageRef };
  if (!continuityOn || index === 0) return { state: "none" };
  const predecessorIndex = chainPredecessorIndex(scenes, index);
  if (predecessorIndex === -1) return { state: "none" };
  const predecessor = scenes[predecessorIndex];
  if (predecessor.endFrameRef) {
    return { state: "chained", ref: predecessor.endFrameRef, predecessorIndex };
  }
  // Predecessor not completed yet, or completed without a derived frame
  // (backfill is attempted at the next schedule) — the chain intent is real,
  // the frame just doesn't exist yet.
  return { state: "pending", predecessorIndex };
}
