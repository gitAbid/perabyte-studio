import { z } from "zod";
import {
  IdSchema, PositiveFramesSchema, SceneSchema, ShotRevisionSchema, StoryRevisionSchema,
  type DependencyIssue, type Scene, type ShotRevision, type StoryRevision,
} from "./contracts";
import { ProductionApplicationError } from "./errors";
import { describeCharacterState, describeEnvironmentState } from "./story-view-model";

/**
 * Wave-2 storyboard derivation (spec 09). Pure read-model shaping only — no IO, no React,
 * no writes. The board model is derived from an approved story revision, the project's
 * scenes and the shot revisions; scene→shot membership follows the frozen C7 rule
 * (shots whose `sceneId` equals the scene id, ordered by `order`), never an authored list.
 *
 * Selection markers (`selectedAnchorId` / `selectedTakeId`) are NOT stored on shot
 * revisions (CONTRACTS-FROZEN C7); the read model projects them. They are accepted here as
 * optional additive fields so callers holding the read-model view get full coverage
 * derivation, while a plain `ShotRevision[]` remains a valid input.
 */

export type StoryboardSceneCoverage = "uncovered" | "partial" | "anchored" | "animated";
export type StoryboardStaleReason = DependencyIssue["code"];

/**
 * A shot revision plus the optional read-model selection markers used for coverage.
 * Plain shot revisions are accepted wherever this type is expected.
 */
export type StoryboardShot = ShotRevision & {
  selectedAnchorId?: string | null;
  selectedTakeId?: string | null;
};

export type StoryboardSceneRow = {
  scene: Scene;
  shots: ShotRevision[];
  coverage: StoryboardSceneCoverage;
};

export type StaleShot = { shot: ShotRevision; reason: StoryboardStaleReason };

export type StoryboardModel = {
  scenes: StoryboardSceneRow[];
  unassignedShots: ShotRevision[];
  staleShots: StaleShot[];
};

/** Frozen shot shape plus the two optional selection markers the read model projects (C7). */
const StoryboardShotSchema = ShotRevisionSchema.extend({
  selectedAnchorId: IdSchema.nullable().optional(),
  selectedTakeId: IdSchema.nullable().optional(),
});
const DeriveStoryboardInputSchema = z.strictObject({
  story: StoryRevisionSchema,
  scenes: z.array(SceneSchema).max(10_000),
  shots: z.array(StoryboardShotSchema).max(10_000),
});

function failInvalidInput(context: string, error: z.ZodError): never {
  const issue = error.issues[0];
  throw new ProductionApplicationError(
    "INVALID_INPUT",
    `${context} does not match the frozen contracts at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`,
  );
}

/** Scene coverage reflects its best shot state: any selected take → animated, else any selected anchor → anchored, else shots exist → partial, else uncovered. */
function sceneCoverage(shots: readonly StoryboardShot[]): StoryboardSceneCoverage {
  if (shots.length === 0) return "uncovered";
  if (shots.some((shot) => shot.selectedTakeId != null && shot.selectedTakeId !== "")) return "animated";
  if (shots.some((shot) => shot.selectedAnchorId != null && shot.selectedAnchorId !== "")) return "anchored";
  return "partial";
}

/**
 * Derives the storyboard board model: ordered scene rows with derived shot lists and
 * coverage, shots not attached to any known scene, and per-shot stale reasons.
 *
 * Stale reasons reuse the frozen dependency vocabulary (spec 02 §11) and are derived from
 * the provided inputs only, in fixed precedence DEPENDENCY_REPLACED → STORY_CHANGED →
 * DEPENDENCY_MISSING:
 * - `DEPENDENCY_REPLACED`: a pinned canon revision (location, style, props, cast) is not
 *   among the story's `canonRevisionIds`, i.e. the active story no longer references it.
 * - `STORY_CHANGED`: the shot was planned against a different story revision.
 * - `DEPENDENCY_MISSING`: the shot's continuation pins a previous shot revision that is
 *   not present in the provided shots.
 */
export function deriveStoryboard(input: {
  story: StoryRevision;
  scenes: Scene[];
  shots: ShotRevision[];
}): StoryboardModel {
  const parsed = DeriveStoryboardInputSchema.safeParse(input);
  if (!parsed.success) failInvalidInput("Storyboard derivation input", parsed.error);
  const { story, scenes, shots } = parsed.data;

  const activeCanonRevisions = new Set(story.canonRevisionIds);
  const shotRevisionIds = new Set(shots.map((shot) => shot.id));
  const knownSceneIds = new Set(scenes.map((scene) => scene.id));

  const staleReasonFor = (shot: StoryboardShot): StoryboardStaleReason | null => {
    const pinnedCanonIds = [
      shot.locationRevisionId,
      shot.styleRevisionId,
      ...shot.propRevisionIds,
      ...shot.castBindings.map((binding) => binding.canonRevisionId),
    ];
    if (pinnedCanonIds.some((id) => !activeCanonRevisions.has(id))) return "DEPENDENCY_REPLACED";
    if (shot.storyRevisionId !== story.id) return "STORY_CHANGED";
    if (shot.continuation !== null && !shotRevisionIds.has(shot.continuation.previousShotRevisionId)) return "DEPENDENCY_MISSING";
    return null;
  };

  const staleShots: StaleShot[] = [];
  for (const shot of shots) {
    const reason = staleReasonFor(shot);
    if (reason !== null) staleShots.push({ shot, reason });
  }

  const scenesByOrder = [...scenes].sort((left, right) => left.order - right.order);
  const sceneRows: StoryboardSceneRow[] = scenesByOrder.map((scene) => {
    const sceneShots = shots
      .filter((shot) => shot.sceneId === scene.id)
      .sort((left, right) => left.order - right.order);
    return { scene, shots: sceneShots, coverage: sceneCoverage(sceneShots) };
  });

  const unassignedShots = shots.filter(
    (shot) => shot.sceneId === null || shot.sceneId === undefined || !knownSceneIds.has(shot.sceneId),
  );

  return { scenes: sceneRows, unassignedShots, staleShots };
}

/* ------------------------------------------------------------------ */
/* Scene → shot draft                                                  */
/* ------------------------------------------------------------------ */

/** Neutral motion prefill for a shot drafted from a scene; the creator edits it before planning. */
export const SHOT_DRAFT_DEFAULT_MOTION_INTENT = "Hold the frame steady and let the scene action play out.";

/**
 * One scene-derived shot draft (spec 09 "Generate Shot Plan" prefill). Framing defaults to
 * `medium`, the target frame count comes from the production profile, and the visual intent
 * is composed from the scene's own action plus its structured character/environment states
 * using the shared Wave-0 describe helpers — nothing is invented beyond the neutral motion
 * prefill. `durationTargetMs` mirrors the scene's target when one is set.
 */
export type ShotPlanShotDraft = {
  sceneId: string;
  /** Position of this draft within the scene's shot list (zero-based). */
  index: number;
  framing: ShotRevision["framing"];
  visualIntent: string;
  motionIntent: string;
  targetFrames: number;
  durationTargetMs: number | null;
};

const DeriveShotDraftInputSchema = z.strictObject({
  scene: SceneSchema,
  index: z.number().int().safe().nonnegative(),
  profile: z.strictObject({ targetFrames: PositiveFramesSchema }),
});

export function deriveShotDraft(input: {
  scene: Scene;
  index: number;
  profile: { targetFrames: number };
}): ShotPlanShotDraft {
  const parsed = DeriveShotDraftInputSchema.safeParse(input);
  if (!parsed.success) failInvalidInput("Shot draft derivation input", parsed.error);
  const { scene, index, profile } = parsed.data;

  // The draft input carries no canon records, so labels fall back to the pinned revision
  // IDs; the readable canon labels are restored wherever the caller has them.
  const stateLines = [
    ...scene.characterStates.map((state) => describeCharacterState(state, state.characterCanonRevisionId)),
    ...(scene.environmentState === null ? [] : [describeEnvironmentState(scene.environmentState, scene.environmentState.environmentCanonRevisionId)]),
  ]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/[.]+\s*$/, ""));

  const visualIntent = `${[scene.action.trim().replace(/[.]+\s*$/, ""), ...stateLines].join("; ")}.`;
  return {
    sceneId: scene.id,
    index,
    framing: "medium",
    visualIntent,
    motionIntent: SHOT_DRAFT_DEFAULT_MOTION_INTENT,
    targetFrames: profile.targetFrames,
    durationTargetMs: scene.durationTargetMs,
  };
}
