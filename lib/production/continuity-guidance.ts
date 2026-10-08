import type {
  CanonRevision, CharacterState, ShotCastBinding,
} from "./contracts";
import type {
  ContinuityAspect, ContinuityInput, ContinuityResult,
} from "./continuity";

/**
 * Targeted repair guidance (spec 11 §9 "generate targeted repair guidance"). Pure and
 * deterministic: from one shot's failing `ContinuityResult` plus the SAME resolved states the
 * engine compared, it produces one guidance line per failing dimension. Every line is derived
 * ONLY from structured state text (CharacterState / EnvironmentState / cast bindings / canon
 * revision descriptions — the same inputs `checkContinuity` read; no prompt substring parsing,
 * no AI, no network) and embeds the exact offending scene/shot/take identifiers so the report
 * footer (spec 11 §6) can link the repair to the artifact.
 *
 * Advisory only: guidance is text. Queueing the re-roll that carries it stays a separate,
 * creator-initiated step (POST /reroll) that never approves, rejects or spends anything.
 */

/** Display-line cap — footer lines stay scannable (spec 11 §6 wireframe). */
export const REPAIR_LINE_MAX_CHARS = 280;
/** Note cap for the guided re-roll endpoint (RerollGuidanceSchema note max). */
export const REPAIR_NOTE_MAX_CHARS = 2000;

/** What the footer/generator needs per shot: identifiers, the engine input, and the engine result. */
export interface RepairGuidanceSource {
  readonly shotId: string;
  /** 1-based scene position (storyboard convention); null when the shot has no scene. */
  readonly sceneNumber: number | null;
  readonly sceneTitle: string | null;
  readonly selectedTakeId: string | null;
  readonly input: ContinuityInput;
  readonly result: ContinuityResult;
}

/** One failing dimension's repair: the display line (identifiers embedded) and the re-roll note. */
export interface RepairGuidance {
  readonly aspect: ContinuityAspect;
  readonly status: "warn" | "fail";
  /** Creator-facing repair line, artifact identifiers embedded, ≤ REPAIR_LINE_MAX_CHARS. */
  readonly line: string;
  /** Regen-oriented note for POST /reroll (`guidance.note`), ≤ REPAIR_NOTE_MAX_CHARS. */
  readonly note: string;
}

const cap = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Wardrobe/outfit comparison — mirrors the engine's structural equality (no shared private helper). */
const sameWording = (left: string, right: string): boolean =>
  left.trim().replace(/\s+/g, " ").toLowerCase() === right.trim().replace(/\s+/g, " ").toLowerCase();

/** "Scene 02" storyboard numbering; falls back to the title, then to nothing. */
function sceneLabel(source: RepairGuidanceSource): string | null {
  if (source.sceneNumber !== null) return `Scene ${String(source.sceneNumber).padStart(2, "0")}`;
  if (source.sceneTitle !== null) return `Scene "${cap(source.sceneTitle, 40)}"`;
  return null;
}

/** Exact artifact prefix: `Scene 02 · Shot s-3 · Take t-1 — ` (take segment only when selected). */
function artifactPrefix(source: RepairGuidanceSource): string {
  const parts = [sceneLabel(source), `Shot ${source.shotId}`];
  if (source.selectedTakeId !== null) parts.push(`Take ${source.selectedTakeId}`);
  return `${parts.filter((part) => part !== null).join(" · ")} — `;
}

interface ResolvedContext {
  readonly revisionById: Map<string, CanonRevision>;
}

function resolvedContext(input: ContinuityInput): ResolvedContext {
  return { revisionById: new Map(input.characterRevisions.map((revision) => [revision.id, revision])) };
}

/** Scene character state + the shot's binding for the same entity, when both resolve. */
function stateWithBinding(
  context: ResolvedContext,
  state: CharacterState,
  bindings: readonly ShotCastBinding[],
): { entityId: string; binding: ShotCastBinding } | null {
  const sceneRevision = context.revisionById.get(state.characterCanonRevisionId);
  if (!sceneRevision) return null;
  const binding = bindings.find(
    (candidate) => context.revisionById.get(candidate.canonRevisionId)?.entityId === sceneRevision.entityId,
  );
  return binding ? { entityId: sceneRevision.entityId, binding } : null;
}

function identityRepair(source: RepairGuidanceSource, context: ResolvedContext): string | null {
  const { shot, sceneStates } = source.input;
  const parts: string[] = [];
  for (const state of sceneStates.characters) {
    const sceneRevision = context.revisionById.get(state.characterCanonRevisionId);
    if (!sceneRevision) continue;
    const bound = shot.castBindings.filter(
      (binding) => context.revisionById.get(binding.canonRevisionId)?.entityId === sceneRevision.entityId,
    );
    if (bound.length === 0) {
      parts.push(`${sceneRevision.entityId} is in the scene states but not cast in this shot — cast them on the shot, then re-roll; a re-roll alone cannot add a missing character.`);
    } else if (!bound.some((binding) => binding.canonRevisionId === state.characterCanonRevisionId)) {
      parts.push(`Regenerate ${sceneRevision.entityId} in the scene-pinned look: "${sceneRevision.description}".`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function outfitRepair(source: RepairGuidanceSource, context: ResolvedContext): string | null {
  const { shot, sceneStates } = source.input;
  const parts: string[] = [];
  for (const state of sceneStates.characters) {
    if (state.outfit === undefined) continue;
    const resolved = stateWithBinding(context, state, shot.castBindings);
    if (resolved === null || sameWording(state.outfit, resolved.binding.wardrobe)) continue;
    parts.push(
      `${resolved.entityId}'s outfit differs from canon: the scene pins "${state.outfit}", the shot wardrobe pins "${resolved.binding.wardrobe}". Regenerate wearing the scene outfit.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function environmentRepair(source: RepairGuidanceSource, _context: ResolvedContext): string | null {
  const { shot, sceneStates } = source.input;
  const environment = sceneStates.environment;
  const active = source.input.environmentRevision;
  if (environment === null || active === null) return null;
  const parts: string[] = [];
  if (environment.environmentCanonRevisionId !== active.id) {
    parts.push(`Re-pin the scene environment to the active revision ("${active.description}").`);
  }
  if (shot.locationRevisionId !== active.id) {
    parts.push(`Re-pin the shot's location to the active environment revision ("${active.description}").`);
  }
  if (environment.zone === undefined) {
    parts.push("Set a zone on the scene environment so the space stays the same across shots.");
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function lightingRepair(source: RepairGuidanceSource): string | null {
  const environment = source.input.sceneStates.environment;
  if (environment === null) return null;
  if (environment.timeOfDay === undefined || environment.lighting === undefined) {
    return "Set time of day and lighting on the scene environment so the lighting check has something to hold steady.";
  }
  return null;
}

const REPAIRS: Record<ContinuityAspect, ((source: RepairGuidanceSource, context: ResolvedContext) => string | null) | null> = {
  identity: identityRepair,
  outfit: outfitRepair,
  environment: environmentRepair,
  lighting: lightingRepair,
};

/**
 * One guidance per failing (warn | fail) finding, in the result's finding order. Repair text
 * re-derives the concrete mismatch from structured state; when a failing dimension has no
 * structured repair to name (all its inputs were `not_checked`), the engine's own finding note
 * — itself structured-state-derived — carries the line unchanged. Passing results produce no
 * guidance. Deterministic: the same input always renders the same lines.
 */
export function repairGuidance(source: RepairGuidanceSource): RepairGuidance[] {
  const context = resolvedContext(source.input);
  const prefix = artifactPrefix(source);
  const guidance: RepairGuidance[] = [];
  for (const finding of source.result.findings) {
    if (finding.status !== "warn" && finding.status !== "fail") continue;
    const repair = REPAIRS[finding.aspect]?.(source, context) ?? finding.note;
    guidance.push({
      aspect: finding.aspect,
      status: finding.status,
      line: cap(`${prefix}${repair}`, REPAIR_LINE_MAX_CHARS),
      note: cap(repair, REPAIR_NOTE_MAX_CHARS),
    });
  }
  return guidance;
}
