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
