import { z } from "zod";
import {
  AnchorCandidateSchema, CanonRevisionSchema, CharacterStateSchema, EnvironmentStateSchema,
  ShotRevisionSchema, type AnchorCandidate, type CanonRevision, type CharacterState,
  type EnvironmentState, type Scene, type ShotRevision,
} from "./contracts";
import { ProductionApplicationError } from "./errors";

/**
 * Wave-2 structured continuity checks (spec 11). Pure, deterministic, advisory only — a
 * result never approves, rejects, deletes or re-rolls anything. Checks compare structured
 * state (CharacterState / EnvironmentState) against the shot's cast bindings and the
 * resolved canon revisions, exactly as recorded; nothing is inferred from prompt text
 * (spec 11 acceptance 1). Missing inputs yield `not_checked`, never a guess, so
 * unsupported dimensions never display as green.
 */

export type ContinuityStatus = "pass" | "warn" | "fail" | "not_checked";
export type ContinuityAspect = "identity" | "outfit" | "environment" | "lighting";
export type ContinuityFinding = { aspect: ContinuityAspect; status: ContinuityStatus; note: string };
export type ContinuityResult = { status: ContinuityStatus; findings: ContinuityFinding[] };

export type ContinuityInput = {
  shot: ShotRevision;
  sceneStates: { characters: CharacterState[]; environment: EnvironmentState | null };
  characterRevisions: readonly CanonRevision[];
  environmentRevision: CanonRevision | null;
  anchor?: AnchorCandidate | null;
};

const CheckContinuityInputSchema = z.strictObject({
  shot: ShotRevisionSchema,
  sceneStates: z.strictObject({
    characters: z.array(CharacterStateSchema).max(10),
    environment: EnvironmentStateSchema.nullable(),
  }),
  characterRevisions: z.array(CanonRevisionSchema).max(500),
  environmentRevision: CanonRevisionSchema.nullable(),
  anchor: AnchorCandidateSchema.nullable().optional(),
});

const SummarizeResultSchema = z.strictObject({
  status: z.enum(["pass", "warn", "fail", "not_checked"]),
  findings: z.array(z.strictObject({
    aspect: z.enum(["identity", "outfit", "environment", "lighting"]),
    status: z.enum(["pass", "warn", "fail", "not_checked"]),
    note: z.string(),
  })).max(100),
});

function failInvalidInput(context: string, error: z.ZodError): never {
  const issue = error.issues[0];
  throw new ProductionApplicationError(
    "INVALID_INPUT",
    `${context} does not match the frozen contracts at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`,
  );
}

/** Worst-of aggregation: fail > warn > not_checked > pass (a gap never masks a finding, and never looks green). */
const STATUS_SEVERITY: Record<ContinuityStatus, number> = { pass: 0, not_checked: 1, warn: 2, fail: 3 };

const worstStatus = (statuses: readonly ContinuityStatus[]): ContinuityStatus =>
  statuses.reduce<ContinuityStatus>(
    (worst, status) => (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst] ? status : worst),
    "pass",
  );

const finding = (aspect: ContinuityAspect, status: ContinuityStatus, note: string): ContinuityFinding =>
  ({ aspect, status, note });

/** Wardrobe/outfit comparison stays structural: trimmed, whitespace-collapsed, case-folded equality. */
const sameWording = (left: string, right: string): boolean =>
  left.trim().replace(/\s+/g, " ").toLowerCase() === right.trim().replace(/\s+/g, " ").toLowerCase();

type CheckContext = z.infer<typeof CheckContinuityInputSchema>;

function identityFinding(context: CheckContext): ContinuityFinding {
  const { shot, sceneStates, characterRevisions, anchor } = context;
  if (!anchor) {
    return finding("identity", "not_checked", "No anchor was provided, so identity continuity was not checked.");
  }
  if (sceneStates.characters.length === 0) {
    return finding("identity", "not_checked", "The scene pins no character states, so there was nothing to compare.");
  }
  const revisionById = new Map(characterRevisions.map((revision) => [revision.id, revision]));
  const statuses: ContinuityStatus[] = [];
  const notes: string[] = [];
  for (const state of sceneStates.characters) {
    const sceneRevision = revisionById.get(state.characterCanonRevisionId);
    if (!sceneRevision) {
      statuses.push("not_checked");
      notes.push(`Scene character revision ${state.characterCanonRevisionId} is not among the provided canon revisions, so its identity could not be verified.`);
      continue;
    }
    const boundToEntity = shot.castBindings.filter(
      (binding) => revisionById.get(binding.canonRevisionId)?.entityId === sceneRevision.entityId,
    );
    if (boundToEntity.length === 0) {
      statuses.push("fail");
      notes.push(`${sceneRevision.entityId} appears in the scene states but is not cast in this shot, so the anchor cannot contain this character.`);
      continue;
    }
    if (boundToEntity.some((binding) => binding.canonRevisionId === state.characterCanonRevisionId)) {
      statuses.push("pass");
      notes.push(`${sceneRevision.entityId} matches the anchor-bound revision ${state.characterCanonRevisionId}.`);
    } else {
      statuses.push("warn");
      notes.push(`${sceneRevision.entityId} now pins revision ${state.characterCanonRevisionId}, but the shot bound ${boundToEntity.map((binding) => binding.canonRevisionId).join(", ")}; the anchor may show the older look.`);
    }
  }
  return finding("identity", worstStatus(statuses), notes.join(" "));
}

function outfitFinding(context: CheckContext): ContinuityFinding {
  const { shot, sceneStates, characterRevisions } = context;
  if (sceneStates.characters.length === 0) {
    return finding("outfit", "not_checked", "The scene pins no character states, so there was nothing to compare.");
  }
  const revisionById = new Map(characterRevisions.map((revision) => [revision.id, revision]));
  const statuses: ContinuityStatus[] = [];
  const notes: string[] = [];
  for (const state of sceneStates.characters) {
    const sceneRevision = revisionById.get(state.characterCanonRevisionId);
    if (!sceneRevision) {
      statuses.push("not_checked");
      notes.push(`Scene character revision ${state.characterCanonRevisionId} is not among the provided canon revisions, so its outfit could not be compared.`);
      continue;
    }
    if (state.outfit === undefined) {
      statuses.push("not_checked");
      notes.push(`${sceneRevision.entityId} has no outfit pinned on the scene state, so the wardrobe was not compared.`);
      continue;
    }
    const binding = shot.castBindings.find(
      (candidate) => revisionById.get(candidate.canonRevisionId)?.entityId === sceneRevision.entityId,
    );
    if (!binding) {
      statuses.push("not_checked");
      notes.push(`${sceneRevision.entityId} is not cast in this shot, so there is no wardrobe guidance to compare against.`);
      continue;
    }
    if (sameWording(state.outfit, binding.wardrobe)) {
      statuses.push("pass");
      notes.push(`${sceneRevision.entityId} wears the scene outfit "${state.outfit}" as directed.`);
    } else {
      statuses.push("warn");
      notes.push(`${sceneRevision.entityId}'s scene outfit "${state.outfit}" differs from the shot wardrobe "${binding.wardrobe}".`);
    }
  }
  return finding("outfit", worstStatus(statuses), notes.join(" "));
}

function environmentFinding(context: CheckContext): ContinuityFinding {
  const { shot, sceneStates, environmentRevision } = context;
  const environment = sceneStates.environment;
  if (!environment) {
    return finding("environment", "not_checked", "The scene has no structured environment state, so environment continuity was not checked.");
  }
  if (!environmentRevision) {
    return finding("environment", "not_checked", "The scene's environment canon revision was not provided, so environment continuity was not checked.");
  }
  const statuses: ContinuityStatus[] = [];
  const notes: string[] = [];
  if (environment.environmentCanonRevisionId === environmentRevision.id) {
    statuses.push("pass");
    notes.push(`Scene environment state matches the active revision ${environmentRevision.id}.`);
  } else {
    statuses.push("warn");
    notes.push(`Scene environment state pins revision ${environment.environmentCanonRevisionId}, but the active revision is ${environmentRevision.id}.`);
  }
  if (shot.locationRevisionId !== environmentRevision.id) {
    statuses.push("warn");
    notes.push(`Shot pins environment revision ${shot.locationRevisionId}, which differs from the active revision ${environmentRevision.id}.`);
  }
  if (environment.zone === undefined) {
    statuses.push("warn");
    notes.push("No zone is set for this scene environment.");
  } else {
    statuses.push("pass");
    notes.push(`Environment zone "${environment.zone}" is set.`);
  }
  return finding("environment", worstStatus(statuses), notes.join(" "));
}

function lightingFinding(context: CheckContext): ContinuityFinding {
  const environment = context.sceneStates.environment;
  if (!environment) {
    return finding("lighting", "not_checked", "The scene has no structured environment state, so lighting was not checked.");
  }
  const setContext = [environment.timeOfDay, environment.lighting].filter((value) => value !== undefined);
  if (setContext.length === 0) {
    return finding("lighting", "warn", "Neither time of day nor lighting is set for this scene environment.");
  }
  return finding("lighting", "pass", `Lighting context is set (${setContext.map((value) => `"${value}"`).join(", ")}).`);
}

/**
 * Runs the four core continuity checks (identity, outfit, environment, lighting) for one
 * shot against its scene's structured states and the resolved canon revisions. The anchor
 * enables the identity check: the shot's cast bindings are what the anchor generation
 * pinned, so scene character states are compared against them. Advisory only — the result
 * never gates or mutates anything; input-shape violations still fail closed with
 * `INVALID_INPUT`.
 */
export function checkContinuity(input: ContinuityInput): ContinuityResult {
  const parsed = CheckContinuityInputSchema.safeParse(input);
  if (!parsed.success) failInvalidInput("Continuity check input", parsed.error);
  const findings = [
    identityFinding(parsed.data),
    outfitFinding(parsed.data),
    environmentFinding(parsed.data),
    lightingFinding(parsed.data),
  ];
  return { status: worstStatus(findings.map((item) => item.status)), findings };
}

/**
 * Counts results by status for the calm production-level signal (spec 11 §6). Malformed
 * results fail closed with `INVALID_INPUT` instead of being silently miscounted.
 */
export function summarizeContinuity(results: ContinuityResult[]): {
  pass: number;
  warn: number;
  fail: number;
  notChecked: number;
} {
  const parsed = z.array(SummarizeResultSchema).max(10_000).safeParse(results);
  if (!parsed.success) failInvalidInput("Continuity results", parsed.error);
  const counts = { pass: 0, warn: 0, fail: 0, notChecked: 0 };
  for (const result of parsed.data) {
    if (result.status === "not_checked") counts.notChecked += 1;
    else counts[result.status] += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Report projection (spec 11 §9 "produce report projection") + the    */
/* affected-checks-only re-evaluation primitive (spec 11 §8)           */
/* ------------------------------------------------------------------ */
/*
 * `continuityCheckEntries` turns the parsed project read model into the ordered
 * per-shot check inputs the report (page + guidance generator) consumes: one
 * entry per shot, joined to its scene's structured states, sorted scene-major
 * (storyboard convention: scenes by order, shots by order within the scene,
 * shots without a scene last). Pure and deterministic — the page recomputes
 * every shot with it on each server render, which is cheap at read-model scale
 * (pure checks, no I/O, ≤10k shots).
 *
 * `recomputeAffected` is the incremental primitive for the state-rule-change
 * path (spec 11 §8: "changing state rules re-evaluates only affected checks"):
 * a caller that holds cached results and learns a scene's CharacterState /
 * EnvironmentState changed passes the changed scene ids plus a FRESH projection,
 * and only shots pinned to those scenes re-run. Every other shot keeps its
 * cached result BY REFERENCE (object identity is preserved, tested), so
 * downstream memoization stays valid. Cached results are trusted as-is — they
 * are engine output by construction.
 */

/** Structural slice of the parsed read model the projection joins over; extra fields are fine. */
export interface ContinuityProjectionInput {
  readonly shots: ReadonlyArray<{
    readonly shotRevision: ShotRevision;
    readonly selectedAnchor: AnchorCandidate | null;
    readonly selectedTake: Readonly<{ id: string }> | null;
  }>;
  readonly scenes: ReadonlyArray<Scene>;
  readonly canonRevisions: ReadonlyArray<CanonRevision>;
}

/** One shot's report slot: identifiers for the exact offending artifact plus its check input. */
export interface ContinuityCheckEntry {
  readonly shotId: string;
  readonly shotRevisionId: string;
  readonly sceneId: string | null;
  /** 1-based scene position in the ordered scene list (storyboard convention); null without a scene. */
  readonly sceneNumber: number | null;
  readonly sceneTitle: string | null;
  readonly hasAnchor: boolean;
  readonly selectedTakeId: string | null;
  readonly input: ContinuityInput;
}

/**
 * Joins the parsed read model into ordered per-shot check entries (scene-major). Shots whose
 * sceneId is missing or unknown keep every check honestly answerable — they get empty scene
 * states, so the engine reports `not_checked` where it has nothing to compare.
 */
export function continuityCheckEntries(model: ContinuityProjectionInput): ContinuityCheckEntry[] {
  const scenesByOrder = [...model.scenes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const sceneById = new Map(scenesByOrder.map((scene) => [scene.id, scene]));
  const sceneNumberById = new Map(scenesByOrder.map((scene, index) => [scene.id, index + 1]));
  const byShotOrder = (left: ContinuityProjectionInput["shots"][number], right: ContinuityProjectionInput["shots"][number]): number =>
    left.shotRevision.order - right.shotRevision.order ||
    left.shotRevision.shotId.localeCompare(right.shotRevision.shotId);

  const entries: ContinuityCheckEntry[] = [];
  for (const scene of scenesByOrder) {
    for (const shot of model.shots.filter((entry) => entry.shotRevision.sceneId === scene.id).sort(byShotOrder)) {
      entries.push(entryFor(shot, scene, sceneNumberById.get(scene.id) ?? null, model));
    }
  }
  for (const shot of model.shots
    .filter((entry) => entry.shotRevision.sceneId == null || !sceneById.has(entry.shotRevision.sceneId))
    .sort(byShotOrder)) {
    entries.push(entryFor(shot, null, null, model));
  }
  return entries;
}

function entryFor(
  shot: ContinuityProjectionInput["shots"][number],
  scene: Scene | null,
  sceneNumber: number | null,
  model: ContinuityProjectionInput,
): ContinuityCheckEntry {
  return {
    shotId: shot.shotRevision.shotId,
    shotRevisionId: shot.shotRevision.id,
    sceneId: scene?.id ?? null,
    sceneNumber,
    sceneTitle: scene?.title ?? null,
    hasAnchor: shot.selectedAnchor != null,
    selectedTakeId: shot.selectedTake?.id ?? null,
    input: {
      shot: shot.shotRevision,
      sceneStates: scene
        ? { characters: scene.characterStates, environment: scene.environmentState }
        : { characters: [], environment: null },
      characterRevisions: model.canonRevisions,
      environmentRevision:
        model.canonRevisions.find((revision) => revision.id === shot.shotRevision.locationRevisionId) ?? null,
      anchor: shot.selectedAnchor,
    },
  };
}

/** The scene ids whose state rules changed (CharacterState / EnvironmentState edits). */
export interface ContinuitySceneChange {
  readonly sceneIds: ReadonlySet<string>;
}

/**
 * Incremental re-evaluation for the state-rule-change path — see the block comment above for
 * which path uses it. Shots pinned to a changed scene (and shots with no cached result yet)
 * re-run through the frozen engine; all other shots keep their cached result object, so
 * identity-sensitive consumers can rely on stable references. Shots without a scene are never
 * affected by scene-state changes. Shots present in `previous` but absent from `entries`
 * (deleted shots) are dropped, mirroring the projection.
 */
export function recomputeAffected(
  previous: ReadonlyMap<string, ContinuityResult>,
  changed: ContinuitySceneChange,
  entries: readonly ContinuityCheckEntry[],
): Map<string, ContinuityResult> {
  const next = new Map<string, ContinuityResult>();
  for (const entry of entries) {
    const cached = previous.get(entry.shotId);
    if (cached === undefined || (entry.sceneId !== null && changed.sceneIds.has(entry.sceneId))) {
      next.set(entry.shotId, checkContinuity(entry.input));
    } else {
      next.set(entry.shotId, cached);
    }
  }
  return next;
}
