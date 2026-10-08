import {
  isEnvironmentKind,
  type Approval,
  type ApprovalState,
  type CanonRevision,
  type CharacterState,
  type EnvironmentState,
  type Scene,
  type StoryBeat,
  type StoryRevision,
  type UpsertSceneCommand,
} from "./contracts";
import { deriveApprovalState } from "./approval-state";

/**
 * Story Studio view model (spec 08). Pure derivations only — no hooks, no
 * window, no fetch. The story proposal pipeline (lib/production/proposals.ts)
 * stays the single source of generation truth; this module only shapes what the
 * UI renders: revision diffs, scene drafts with stable IDs, structured state
 * summaries and approval state per CONTRACTS-FROZEN C6-C8.
 */

/* ------------------------------------------------------------------ */
/* Conversational revise encoding                                      */
/* ------------------------------------------------------------------ */

/**
 * The frozen story proposal command has exactly one free-text field
 * (`scriptText`) and one base-revision marker (`expectedStoryRevisionId`).
 * Until a dedicated revise endpoint exists, a follow-up instruction is carried
 * in `scriptText` after the current script, behind this visible marker, so the
 * request stays self-contained and auditable.
 */
export const REVISION_INSTRUCTION_MARKER = "[revision request]";
/** scriptText bound from CreateStoryProposalCommandSchema (mirror of the contract). */
export const REVISION_SCRIPT_TEXT_MAX_CHARS = 500_000;

export type ComposedRevisionText = { ok: true; text: string } | { ok: false; reason: string };

/** Base script + creator instruction, composed for the proposal command's scriptText field. */
export function composeRevisionScriptText(input: { baseScript: string; instruction: string }): ComposedRevisionText {
  const base = input.baseScript.trim();
  const instruction = input.instruction.trim();
  if (instruction.length === 0) return { ok: false, reason: "Describe the change you want before sending it." };
  const text = base.length > 0 ? `${base}\n\n${REVISION_INSTRUCTION_MARKER}\n${instruction}` : instruction;
  if (text.length > REVISION_SCRIPT_TEXT_MAX_CHARS) {
    return { ok: false, reason: `The story plus your change is ${text.length.toLocaleString("en-US")} characters, above the ${REVISION_SCRIPT_TEXT_MAX_CHARS.toLocaleString("en-US")}-character bound. Shorten the change or the story first.` };
  }
  return { ok: true, text };
}

/** Splits a composed proposal scriptText back into base script and instruction (null when absent). */
export function splitRevisionInstruction(scriptText: string): { baseScript: string; instruction: string | null } {
  const markerAt = scriptText.lastIndexOf(`\n${REVISION_INSTRUCTION_MARKER}\n`);
  if (markerAt === -1) return { baseScript: scriptText, instruction: null };
  return {
    baseScript: scriptText.slice(0, markerAt),
    instruction: scriptText.slice(markerAt + REVISION_INSTRUCTION_MARKER.length + 2).trim() || null,
  };
}

/* ------------------------------------------------------------------ */
/* Human-readable story diff                                           */
/* ------------------------------------------------------------------ */

export type StoryBeatField = "action" | "narration" | "dialogue";
export type StoryBeatSummary = { action: string; narration: string; dialogue: string[] };

export type StoryDiffEntry =
  | { kind: "added"; beatId: string; label: string; after: StoryBeatSummary }
  | { kind: "removed"; beatId: string; label: string; before: StoryBeatSummary }
  | { kind: "changed"; beatId: string; label: string; before: StoryBeatSummary; after: StoryBeatSummary; changedFields: StoryBeatField[] };

export type StoryDiff = {
  entries: StoryDiffEntry[];
  unchangedCount: number;
  hasChanges: boolean;
};

/** Plain summary of one beat used for before/after rows. */
export function summarizeBeat(beat: StoryBeat): StoryBeatSummary {
  return {
    action: beat.action,
    narration: beat.narration,
    dialogue: beat.dialogue.map((line) => `${line.characterId}: ${line.text}`),
  };
}

/** Creator-facing label for a beat: its position and the first action line. */
export function beatLabel(beat: StoryBeat): string {
  const firstLine = beat.action.split("\n", 1)[0]?.trim() || beat.narration.split("\n", 1)[0]?.trim() || "";
  const title = firstLine.length > 0 ? firstLine.slice(0, 80) : `beat ${beat.id}`;
  return `Beat ${beat.order + 1} — “${title}”`;
}

const sameSummary = (left: StoryBeatSummary, right: StoryBeatSummary): boolean =>
  left.action === right.action && left.narration === right.narration &&
  left.dialogue.length === right.dialogue.length && left.dialogue.every((line, index) => line === right.dialogue[index]);

/**
 * Structured diff of two story revisions. Beats are matched by ID (stable
 * identity across revisions); matched beats report exactly which of
 * action / narration / dialogue changed, in plain language for the UI.
 */
export function deriveStoryDiff(base: StoryRevision, next: StoryRevision): StoryDiff {
  const baseById = new Map(base.beats.map((beat) => [beat.id, beat]));
  const nextById = new Map(next.beats.map((beat) => [beat.id, beat]));
  const entries: StoryDiffEntry[] = [];
  let unchangedCount = 0;
  for (const beat of next.beats) {
    const before = baseById.get(beat.id);
    const after = summarizeBeat(beat);
    if (!before) {
      entries.push({ kind: "added", beatId: beat.id, label: beatLabel(beat), after });
      continue;
    }
    const beforeSummary = summarizeBeat(before);
    if (sameSummary(beforeSummary, after)) {
      unchangedCount += 1;
      continue;
    }
    const changedFields: StoryBeatField[] = [];
    if (beforeSummary.action !== after.action) changedFields.push("action");
    if (beforeSummary.narration !== after.narration) changedFields.push("narration");
    if (beforeSummary.dialogue.join("\n") !== after.dialogue.join("\n")) changedFields.push("dialogue");
    entries.push({ kind: "changed", beatId: beat.id, label: beatLabel(beat), before: beforeSummary, after, changedFields });
  }
  for (const beat of base.beats) {
    if (!nextById.has(beat.id)) {
      entries.push({ kind: "removed", beatId: beat.id, label: beatLabel(beat), before: summarizeBeat(beat) });
    }
  }
  return { entries, unchangedCount, hasChanges: entries.length > 0 };
}

/* ------------------------------------------------------------------ */
/* Scene drafts with stable IDs                                        */
/* ------------------------------------------------------------------ */

/** Initial structured character state for one canon revision (arrays required by the contract). */
export function characterStateDraft(characterCanonRevisionId: string): CharacterState {
  return { characterCanonRevisionId, accessories: [], carriedObjects: [], condition: [] };
}

/** Initial structured environment state for one canon revision. */
export function environmentStateDraft(environmentCanonRevisionId: string): EnvironmentState {
  return { environmentCanonRevisionId, persistentProps: [] };
}

export type SceneDraftResult =
  | { ok: true; draft: UpsertSceneCommand; unmappedSpeakers: { characterId: string; text: string }[] }
  | { ok: false; reason: string };

const SCENE_ACTION_MAX_CHARS = 20_000;
const SCENE_TITLE_MAX_CHARS = 200;

/**
 * Turns a story beat into a scene upsert draft. Speaker lines map to the
 * character's ACTIVE canon revision; lines with no active character canon are
 * reported back (never invented). The scene ID is provided by the caller so
 * re-deriving a draft never silently re-keys an existing scene.
 */
export function deriveSceneDraftFromBeat(input: {
  sceneId: string;
  beat: StoryBeat;
  order: number;
  projectId: string;
  storyRevisionId: string | null;
  canonRevisions: readonly CanonRevision[];
}): SceneDraftResult {
  const characterRevisionByEntity = new Map(
    input.canonRevisions.filter((revision) => revision.entityKind === "character").map((revision) => [revision.entityId, revision.id]),
  );
  const dialogue: UpsertSceneCommand["dialogue"] = [];
  const unmappedSpeakers: { characterId: string; text: string }[] = [];
  for (const line of input.beat.dialogue) {
    const revisionId = characterRevisionByEntity.get(line.characterId);
    if (!revisionId) {
      unmappedSpeakers.push({ characterId: line.characterId, text: line.text });
      continue;
    }
    dialogue.push({ characterCanonRevisionId: revisionId, text: line.text });
  }
  const firstActionLine = input.beat.action.split("\n", 1)[0]?.trim() ?? "";
  const title = (firstActionLine.length > 0 ? firstActionLine : `Scene ${input.order + 1}`).slice(0, SCENE_TITLE_MAX_CHARS);
  const narrationBlock = input.beat.narration.trim().length > 0 ? `\n\n${input.beat.narration}` : "";
  const action = (input.beat.action + narrationBlock).slice(0, SCENE_ACTION_MAX_CHARS);
  const characterStates: CharacterState[] = [];
  for (const line of dialogue) {
    if (!characterStates.some((state) => state.characterCanonRevisionId === line.characterCanonRevisionId)) {
      characterStates.push(characterStateDraft(line.characterCanonRevisionId));
    }
  }
  return {
    ok: true,
    draft: {
      id: input.sceneId,
      projectId: input.projectId,
      storyRevisionId: input.storyRevisionId,
      order: input.order,
      title,
      action,
      dialogue,
      durationTargetMs: null,
      characterStates,
      environmentState: null,
    },
    unmappedSpeakers,
  };
}

/** Scene-shaped draft derived from an existing scene (edit path keeps every stored byte). */
export function deriveSceneDraftFromScene(scene: Scene): UpsertSceneCommand {
  return {
    id: scene.id,
    projectId: scene.projectId,
    storyRevisionId: scene.storyRevisionId,
    order: scene.order,
    title: scene.title,
    action: scene.action,
    dialogue: scene.dialogue.map((line) => ({ characterCanonRevisionId: line.characterCanonRevisionId, text: line.text })),
    durationTargetMs: scene.durationTargetMs,
    characterStates: scene.characterStates.map((state) => ({ ...state })),
    environmentState: scene.environmentState === null ? null : { ...scene.environmentState },
  };
}

/* ------------------------------------------------------------------ */
/* Plain-language state summaries                                      */
/* ------------------------------------------------------------------ */

const joinList = (values: readonly string[]): string => values.join(", ");

/** One readable line per character state, e.g. “Ayo — wearing a rain coat; carrying a lantern”. */
export function describeCharacterState(state: CharacterState, label: string): string {
  const parts: string[] = [];
  if (state.outfit !== undefined) parts.push(`wearing ${state.outfit}`);
  if (state.hairState !== undefined) parts.push(`hair: ${state.hairState}`);
  if (state.agePresentation !== undefined) parts.push(`looks ${state.agePresentation}`);
  if (state.accessories.length > 0) parts.push(`accessories: ${joinList(state.accessories)}`);
  if (state.carriedObjects.length > 0) parts.push(`carrying ${joinList(state.carriedObjects)}`);
  if (state.condition.length > 0) parts.push(`condition: ${joinList(state.condition)}`);
  if (state.notes !== undefined) parts.push(state.notes);
  return parts.length === 0 ? `${label} — canon look, nothing added for this scene` : `${label} — ${parts.join("; ")}`;
}

/** One readable line for the scene's environment, e.g. “Harbor — at dawn; foggy”. */
export function describeEnvironmentState(state: EnvironmentState, label: string): string {
  const parts: string[] = [];
  if (state.zone !== undefined) parts.push(`area: ${state.zone}`);
  if (state.timeOfDay !== undefined) parts.push(state.timeOfDay);
  if (state.lighting !== undefined) parts.push(`lighting: ${state.lighting}`);
  if (state.weather !== undefined) parts.push(`weather: ${state.weather}`);
  if (state.persistentProps.length > 0) parts.push(`always present: ${joinList(state.persistentProps)}`);
  return parts.length === 0 ? `${label} — canon look, nothing added for this scene` : `${label} — ${parts.join("; ")}`;
}

/* ------------------------------------------------------------------ */
/* Approval derivation (C8)                                            */
/* ------------------------------------------------------------------ */

export type StoryApprovalFacts = {
  state: ApprovalState;
  latest: Approval | null;
  /** True only when the newest decision is an approval bound to this revision's exact contentHash. */
  approvedCurrent: boolean;
};

/**
 * Approval facts for the current story revision per CONTRACTS-FROZEN C8:
 * explicit approval → approved; a rejected or superseded (hash-mismatched)
 * record falls back to draft (or recommended when the AI recommendation marker
 * is set); nothing here ever approves by itself.
 */
export function deriveStoryApprovalFacts(approvals: readonly Approval[], story: StoryRevision | null): StoryApprovalFacts {
  if (!story) return { state: "draft", latest: null, approvedCurrent: false };
  const matching = approvals
    .filter((approval) => approval.targetKind === "story" && approval.targetId === story.id)
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const latest = matching[0] ?? null;
  const superseded = !!latest && latest.decision === "approved" && latest.targetHash !== story.contentHash;
  const state = deriveApprovalState({
    approval: superseded ? null : latest,
    recommendedAt: story.recommendedAt ?? null,
  });
  return { state, latest, approvedCurrent: !!latest && latest.decision === "approved" && latest.targetHash === story.contentHash };
}

/* ------------------------------------------------------------------ */
/* Display helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Short creator-facing label for a canon revision: the leading phrase of its
 * description (a name-like hint), falling back to the entity ID. Never fabricates.
 */
export function displayLabelForCanonRevision(revision: CanonRevision): string {
  const lead = revision.description.split(/[,;—]/, 1)[0]?.trim() ?? "";
  if (lead.length > 0) return lead.length > 60 ? `${lead.slice(0, 57)}…` : lead;
  return revision.entityId;
}

/** Character canon revisions among the active pins, in pin order. */
export function characterCanonRevisions(canonRevisions: readonly CanonRevision[]): CanonRevision[] {
  return canonRevisions.filter((revision) => revision.entityKind === "character");
}

/** Environment canon revisions (environment kind plus tolerated legacy location rows) in pin order. */
export function environmentCanonRevisions(canonRevisions: readonly CanonRevision[]): CanonRevision[] {
  return canonRevisions.filter((revision) => isEnvironmentKind(revision.entityKind));
}

/** Scene label for lists, e.g. “Scene 3 — Sleeping Dragon”. */
export function sceneLabel(scene: Pick<Scene, "order" | "title">): string {
  return `Scene ${scene.order + 1} — ${scene.title}`;
}
