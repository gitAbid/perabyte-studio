import { logger } from "@/lib/logging/logger";
import type { SceneScore, SceneState } from "@/lib/types";

/**
 * External seam for story-consistency integrations ("Jev" and friends):
 * fire points the runner can subscribe to without importing any concrete
 * implementation. Nothing in the story pipeline depends on a consumer —
 * with no hooks set these are documented no-ops, and a misbehaving hook
 * (throw or rejected promise) is logged and swallowed so an add-on can
 * never break scene planning or keyframe gating.
 */

const log = logger.child({ surface: "consistency-hooks" });

export interface ScenePlanContext {
  storyId: string;
  sceneId: string;
  /** The machine-readable world state the Writer's `plan` pass emitted. */
  state: SceneState;
}

export interface KeyframeGateContext {
  storyId: string;
  sceneId: string;
  /** Media-cache ref of the scored keyframe. */
  ref: string;
  /** Per-dimension 0..1 scores from the vision gate. */
  score: SceneScore;
  /** True when every dimension cleared GATE_PASS_THRESHOLD. */
  passed: boolean;
}

export interface ConsistencyHooks {
  /** Fired after a scene's world state is planned. */
  onScenePlan?(ctx: ScenePlanContext): void | Promise<void>;
  /** Fired after a keyframe is scored by the quality gate. */
  onKeyframeGate?(ctx: KeyframeGateContext): void | Promise<void>;
}

let hooks: ConsistencyHooks = {};

/** Install (or replace) the consistency hook set. Safe to call mid-run:
 * each fire reads whatever is installed at that moment. */
export function setConsistencyHooks(next: ConsistencyHooks): void {
  hooks = next;
}

/** Test hook: uninstall every consistency hook. */
export function resetConsistencyHooksForTests(): void {
  hooks = {};
}

export async function onScenePlan(ctx: ScenePlanContext): Promise<void> {
  const hook = hooks.onScenePlan;
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (error) {
    log.warn("onScenePlan hook failed — ignored", {
      storyId: ctx.storyId,
      sceneId: ctx.sceneId,
      message: (error as Error)?.message,
    });
  }
}

export async function onKeyframeGate(ctx: KeyframeGateContext): Promise<void> {
  const hook = hooks.onKeyframeGate;
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (error) {
    log.warn("onKeyframeGate hook failed — ignored", {
      storyId: ctx.storyId,
      sceneId: ctx.sceneId,
      message: (error as Error)?.message,
    });
  }
}
