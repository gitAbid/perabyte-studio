import { describe, expect, it, vi } from "vitest";
import {
  onKeyframeGate,
  onScenePlan,
  resetConsistencyHooksForTests,
  setConsistencyHooks,
  type KeyframeGateContext,
  type ScenePlanContext,
} from "@/lib/story/consistency-hooks";

const PLAN_CTX: ScenePlanContext = {
  storyId: "story-1",
  sceneId: "scene-1",
  state: { locationText: "harbor", characters: [{ id: "mara" }] },
};

const GATE_CTX: KeyframeGateContext = {
  storyId: "story-1",
  sceneId: "scene-1",
  ref: "a".repeat(64) + ".png",
  score: { identity: 0.9, outfit: 0.9, location: 0.8 },
  passed: true,
};

describe("consistency hooks", () => {
  it("is a no-op when no hook is installed", async () => {
    await expect(onScenePlan(PLAN_CTX)).resolves.toBeUndefined();
    await expect(onKeyframeGate(GATE_CTX)).resolves.toBeUndefined();
  });

  it("fires onScenePlan with the context", async () => {
    const scenePlan = vi.fn();
    setConsistencyHooks({ onScenePlan: scenePlan });
    await onScenePlan(PLAN_CTX);
    expect(scenePlan).toHaveBeenCalledWith(PLAN_CTX);
    resetConsistencyHooksForTests();
  });

  it("fires onKeyframeGate with the context", async () => {
    const keyframeGate = vi.fn();
    setConsistencyHooks({ onKeyframeGate: keyframeGate });
    await onKeyframeGate(GATE_CTX);
    expect(keyframeGate).toHaveBeenCalledWith(GATE_CTX);
    resetConsistencyHooksForTests();
  });

  it("swallows a throwing hook so it never propagates", async () => {
    setConsistencyHooks({
      onScenePlan: () => {
        throw new Error("hook exploded");
      },
    });
    await expect(onScenePlan(PLAN_CTX)).resolves.toBeUndefined();
    resetConsistencyHooksForTests();
  });

  it("swallows a rejected async hook", async () => {
    setConsistencyHooks({
      onKeyframeGate: async () => {
        throw new Error("hook rejected");
      },
    });
    await expect(onKeyframeGate(GATE_CTX)).resolves.toBeUndefined();
    resetConsistencyHooksForTests();
  });

  it("uninstalls hooks on reset", async () => {
    const scenePlan = vi.fn();
    setConsistencyHooks({ onScenePlan: scenePlan });
    resetConsistencyHooksForTests();
    await onScenePlan(PLAN_CTX);
    expect(scenePlan).not.toHaveBeenCalled();
  });
});
