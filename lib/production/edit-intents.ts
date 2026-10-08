/**
 * Deterministic NL intent router for the advanced edit timeline (spec 13 §5/§8/§10, FR-31.1).
 *
 * Pure keyword/ordinal parsing — no AI calls, no network, no store access. The caller supplies an
 * {@link EditIntentContext} built from the CURRENT working manifest; every supported intent
 * resolves against it (1-based ordinals over the manifest's shot order) and carries a
 * human-readable summary so the confirm preview and the applied op can never drift. Directions
 * that belong to other flows (retakes → storyboard, speech delivery → audio) and anything
 * untestable are named honestly instead of guessed; `unsupported` results may name the matching
 * panel so the fallback is never a dead end (spec 13 §8).
 *
 * Scene reorder ("swap scenes 3 and 4") parses to a `swap` intent, but the frozen C10 op set
 * (lib/production/manifest-ops.ts) has no reorder op — reorder belongs to the plan-revision flow
 * (FR-31.1), so the UI renders swap as a storyboard hand-off exactly like the direction intents.
 */
import {
  formatDurationLabel, frameGridStepMs, snapToFrameGrid,
  type FirstCutOpInput,
} from "./first-cut-view-model";

export interface EditIntentTakeOption { readonly id: string; readonly label: string }

/** One manifest shot, 1-based ordinal = position in the working manifest's shot order. */
export interface EditIntentShotContext {
  readonly ordinal: number;
  readonly shotRevisionId: string;
  readonly label: string | null;
  readonly durationMs: number;
  /** Pinned source length bound for retimes; null when unknown (retime growth is then unchecked here). */
  readonly sourceDurationMs: number | null;
  readonly disabled: boolean;
  readonly soleEnabled: boolean;
  readonly currentTakeId: string;
  readonly takes: ReadonlyArray<EditIntentTakeOption>;
}

export interface EditIntentContext {
  readonly fps: number;
  readonly shots: ReadonlyArray<EditIntentShotContext>;
  /** Known cast names (canon characters); empty disables known-name matching, capitalized-subject fallback still applies. */
  readonly characterNames: ReadonlyArray<string>;
}

export type EditIntent =
  | { readonly kind: "retime"; readonly shotOrdinal: number; readonly shotRevisionId: string; readonly durationMs: number; readonly summary: string }
  | { readonly kind: "disable"; readonly shotOrdinal: number; readonly shotRevisionId: string; readonly summary: string }
  | { readonly kind: "duplicate"; readonly shotOrdinal: number; readonly shotRevisionId: string; readonly summary: string }
  | { readonly kind: "replaceTake"; readonly shotOrdinal: number; readonly shotRevisionId: string; readonly takeId: string; readonly takeLabel: string; readonly summary: string }
  /** Parsed but not a frozen C10 op: reorder belongs to the storyboard plan-revision flow (FR-31.1). */
  | { readonly kind: "swap"; readonly firstOrdinal: number; readonly secondOrdinal: number; readonly summary: string }
  | { readonly kind: "retake_direction"; readonly sceneOrdinal: number | null; readonly note: string; readonly summary: string }
  | { readonly kind: "delivery_direction"; readonly characterName: string | null; readonly note: string; readonly summary: string }
  | { readonly kind: "unsupported"; readonly hint: string; /** Matching panel for the graceful fallback deep link, when one is known. */ readonly panel: "audio" | "storyboard" | null };

const buildContextGuard = (context: EditIntentContext): EditIntentContext => {
  if (!context || !Array.isArray(context.shots)) return { fps: 24, shots: [], characterNames: [] };
  return context;
};

const shotAtOrdinal = (context: EditIntentContext, ordinal: number): EditIntentShotContext | null =>
  Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= context.shots.length ? context.shots[ordinal - 1]! : null;

const sceneNoun = (ordinal: number): string => `Scene ${ordinal}`;

/* ------------------------------------------------------------------ */
/* Pattern tables (single deterministic pass, first match wins)         */
/* ------------------------------------------------------------------ */

const WORD_ORDINALS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12,
};
const NOUN = String.raw`(?:scenes?|shots?|clips?)`;
const ORDINALS = String.raw`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)`;
const SHOT_REF = new RegExp(String.raw`\b${NOUN}\s*#?(?:(\d{1,4})|${ORDINALS})\b`, "i");
const SHOT_REF_REV = new RegExp(String.raw`\b(${ORDINALS})\s+${NOUN}\b`, "i");
const DURATION = /(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;
const TAKE_REF = /\btake\s*#?(\d{1,3})\b/i;
const SET_TO = /\b(?:to|at|exactly)\b\s*$/i;
const TRIM_VERB = /\b(?:trim|shorten|cut|reduce|shave|tighten)\b/i;
const EXTEND_VERB = /\b(?:extend|lengthen|stretch|longer|hold)\b/i;
const SKIP_VERB = /\b(?:remove|skip|cut|disable|hide|drop|leave out|take out|delete)\b/i;
const DUPLICATE_VERB = /\b(?:repeat|duplicate|copy|again|twice|double)\b/i;
const SWAP_VERB = /\b(?:swap|switch|flip|reverse|exchange|transpose)\b/i;
const SWAP_PAIR = new RegExp(
  String.raw`\b${NOUN}\s*#?(?:(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b[^.\n]{0,16}?(?:and|with|,|&|<->|->|vs\.?)\s*(?:the\s+)?(?:${NOUN})?\s*#?(?:(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b`,
  "i",
);
const TAKE_VERB = /\b(?:use|swap|switch|replace|go to|pick|swap in)\b/i;
const DELIVERY_VERB = /\b(?:sounds?|feels?|voice|tone|delivery|line reading)\b/i;
const DELIVERY_PRESET = /\b(?:scared|angry|excited|calm|whisper|shout|sad|happy|nervous|tense|gentle|soft|loud|quiet|breathy)\b/i;
const DELIVERY_STOP_SUBJECTS = /\b(?:music|sfx|audio|narration|cue|mix|it|this|that|everything|she|he|they|the|a|we|i|you)\b/i;
const RETAKE_EXPLICIT = /\b(?:retake|re-?shoot|reshoot|regenerate|redo|another take)\b/i;
const RETAKE_COMPARE = /\bmake\b[^.\n]{0,30}?\b(?:more|less)\b/i;
const RETAKE_ADJECTIVE = /\b(?:more|less)\s+(?:dramatic|tense|calm|exciting|scary|joyful|sad|energetic|quiet|intense|mysterious|hopeful|playful|serious|daring|warm|cold)\b/i;
const AUDIO_TARGET = /\b(?:music|sfx|sound effects?|audio|narration|voice-?over|voiceover|cue|mix|ducking)\b/i;

const parseAmountMs = (raw: string, unit: string): number => {
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (/^ms/i.test(unit)) return Math.round(value);
  if (/^m/i.test(unit)) return Math.round(value * 60_000);
  return Math.round(value * 1000);
};

const refOrdinal = (digits: string | undefined, word: string | undefined): number | null => {
  if (digits) return Number(digits);
  if (word) return WORD_ORDINALS[word.toLowerCase()] ?? null;
  return null;
};

const parseShotRefs = (text: string): number[] => {
  const refs: number[] = [];
  const forward = new RegExp(SHOT_REF.source, "gi");
  for (const match of text.matchAll(forward)) {
    const ordinal = refOrdinal(match[1], match[2]);
    if (ordinal !== null) refs.push(ordinal);
  }
  const reversed = new RegExp(SHOT_REF_REV.source, "gi");
  for (const match of text.matchAll(reversed)) {
    const ordinal = refOrdinal(undefined, match[1]);
    if (ordinal !== null && !refs.includes(ordinal)) refs.push(ordinal);
  }
  return refs;
};

const unsupported = (hint: string, panel: "audio" | "storyboard" | null = null): EditIntent => ({ kind: "unsupported", hint, panel });

const noSuchScene = (context: EditIntentContext, ordinal: number): EditIntent =>
  unsupported(`This cut has ${context.shots.length} scene${context.shots.length === 1 ? "" : "s"}; there is no scene ${ordinal}.`);

/* ------------------------------------------------------------------ */
/* Intent -> frozen C10 op mapping (existing ops only)                  */
/* ------------------------------------------------------------------ */

/** The intent kinds that map onto a frozen C10 op (everything else is a direction hand-off or unsupported). */
export type ManifestOpIntent = Extract<EditIntent, { kind: "retime" | "disable" | "duplicate" | "replaceTake" }>;

export const isManifestOpIntent = (intent: EditIntent): intent is ManifestOpIntent =>
  intent.kind === "retime" || intent.kind === "disable" || intent.kind === "duplicate" || intent.kind === "replaceTake";

/** Maps a manifest-op intent onto the frozen C10 `FirstCutOpInput`; direction/swap/unsupported intents have no op. */
export function editIntentToOp(intent: EditIntent): FirstCutOpInput | null {
  switch (intent.kind) {
    case "retime": return { kind: "retime", shotId: intent.shotRevisionId, durationMs: intent.durationMs };
    case "disable": return { kind: "disable", shotId: intent.shotRevisionId };
    case "duplicate": return { kind: "duplicate", shotId: intent.shotRevisionId };
    case "replaceTake": return { kind: "replaceTake", shotId: intent.shotRevisionId, takeId: intent.takeId };
    default: return null;
  }
}

/** Builds the parser context from the working manifest's derived shot rows (pure; the page supplies the data). */
export function buildEditIntentContext(input: {
  fps: number;
  shotRows: ReadonlyArray<{
    shotRevisionId: string; label: string | null; durationMs: number; sourceDurationMs: number | null;
    disabled: boolean; soleEnabled: boolean; currentTakeId: string; takes: ReadonlyArray<EditIntentTakeOption>;
  }>;
  characterNames?: ReadonlyArray<string>;
}): EditIntentContext {
  return {
    fps: input.fps,
    shots: input.shotRows.map((row, index) => ({ ...row, ordinal: index + 1 })),
    characterNames: input.characterNames ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parses one free-text instruction against the current manifest context. Deterministic: the same
 * text and context always produce the same intent. Nothing is ever guessed — an instruction that
 * does not clearly name a supported edit returns `unsupported` with an actionable hint.
 */
export function parseEditIntent(text: string, contextInput: EditIntentContext): EditIntent {
  const context = buildContextGuard(contextInput);
  const instruction = (text ?? "").trim();
  if (!instruction) {
    return unsupported("Type a change first — for example “trim scene 2 to 1 second” or “swap scenes 3 and 4”.");
  }

  const shotRefs = parseShotRefs(instruction);
  const shotRef = SHOT_REF.exec(instruction);
  const duration = DURATION.exec(instruction);
  const takeRef = TAKE_REF.exec(instruction);
  const firstRef = shotRefs[0] ?? null;

  const target = firstRef !== null ? shotAtOrdinal(context, firstRef) : null;
  if (firstRef !== null && !target) return noSuchScene(context, firstRef);

  // --- replaceTake: a take number AND a scene number ("use take 2 for shot 3", "scene 3 take 2").
  if (takeRef && target && !duration) {
    const takeOrdinal = Number(takeRef[1]);
    const options = target.takes;
    const replacement = Number.isInteger(takeOrdinal) && takeOrdinal >= 1 && takeOrdinal <= options.length ? options[takeOrdinal - 1]! : null;
    if (!replacement) {
      return unsupported(`${sceneNoun(target.ordinal)} has ${options.length} take${options.length === 1 ? "" : "s"}; there is no take ${takeOrdinal}.`);
    }
    if (replacement.id === target.currentTakeId) {
      return unsupported(`${sceneNoun(target.ordinal)} already uses ${replacement.label}. Pick a different take.`);
    }
    return {
      kind: "replaceTake",
      shotOrdinal: target.ordinal,
      shotRevisionId: target.shotRevisionId,
      takeId: replacement.id,
      takeLabel: replacement.label,
      summary: `${sceneNoun(target.ordinal)}: use ${replacement.label} instead of the current take.`,
    };
  }

  // --- retime: an explicit duration plus a scene reference ("trim 2 seconds off scene 5",
  // "trim scene 2 to 1 second", "extend scene 1 by 2 seconds", "make scene 2 3 seconds").
  if (duration && target) {
    const amountMs = parseAmountMs(duration[1]!, duration[2]!);
    if (amountMs <= 0) return unsupported("I couldn't read that duration — try “1.5 seconds” or “250ms”.");
    const extending = EXTEND_VERB.test(instruction) && !TRIM_VERB.test(instruction);
    const setMode = SET_TO.test(instruction.slice(0, duration.index ?? 0).trimEnd()) || (!extending && !TRIM_VERB.test(instruction));
    const gridMs = frameGridStepMs(context.fps);
    let nextMs = setMode ? amountMs : extending ? target.durationMs + amountMs : target.durationMs - amountMs;
    if (!extending && !setMode && nextMs <= 0) {
      return unsupported(`${sceneNoun(target.ordinal)} is only ${formatDurationLabel(target.durationMs)} long — it cannot get ${formatDurationLabel(amountMs)} shorter (the shortest length on the ${context.fps} fps grid is ${formatDurationLabel(gridMs)}).`);
    }
    nextMs = snapToFrameGrid(nextMs, context.fps);
    if (target.sourceDurationMs !== null && nextMs > target.sourceDurationMs) {
      return unsupported(`${sceneNoun(target.ordinal)} has only ${formatDurationLabel(target.sourceDurationMs)} of source footage — it cannot be made ${formatDurationLabel(nextMs)} long.`);
    }
    if (nextMs === target.durationMs) {
      return unsupported(`${sceneNoun(target.ordinal)} is already ${formatDurationLabel(target.durationMs)} long — pick a different length.`);
    }
    return {
      kind: "retime",
      shotOrdinal: target.ordinal,
      shotRevisionId: target.shotRevisionId,
      durationMs: nextMs,
      summary: `Trim ${sceneNoun(target.ordinal)} from ${formatDurationLabel(target.durationMs)} to ${formatDurationLabel(nextMs)}${target.disabled ? " (it stays skipped until restored)" : ""}.`,
    };
  }
  if (duration && !target) {
    return unsupported("Name the scene to retime — for example “trim scene 2 to 1 second”.");
  }

  // --- speech delivery direction ("Luna sounds scared here"): routes to the audio workspace.
  if (DELIVERY_VERB.test(instruction) || (DELIVERY_PRESET.test(instruction) && /\b(?:make|sound|reads?|deliver|speaks?)\b/i.test(instruction))) {
    const subject = /\b([\p{L}][\p{L}'-]{1,23})\s+(?:sounds?|feels?|reads?)/u.exec(instruction)?.[1] ?? null;
    if (subject && DELIVERY_STOP_SUBJECTS.test(subject)) {
      return unsupported("Audio timing and cue levels live in the audio workspace — I can't change them from the timeline.", "audio");
    }
    let characterName: string | null = null;
    for (const name of [...context.characterNames].sort((left, right) => right.length - left.length)) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(instruction)) { characterName = name; break; }
    }
    if (!characterName && subject && !DELIVERY_STOP_SUBJECTS.test(subject)) characterName = subject;
    return {
      kind: "delivery_direction",
      characterName,
      note: instruction,
      summary: `Delivery direction${characterName ? ` for ${characterName}` : ""}: “${instruction}” — set it on the affected lines in the audio workspace.`,
    };
  }

  // --- retake direction ("make scene 2 more dramatic"): routes to the storyboard retake flow.
  if (RETAKE_EXPLICIT.test(instruction) || RETAKE_COMPARE.test(instruction) || RETAKE_ADJECTIVE.test(instruction)) {
    if (firstRef !== null && !target) return noSuchScene(context, firstRef);
    return {
      kind: "retake_direction",
      sceneOrdinal: firstRef,
      note: instruction,
      summary: `Retake direction${firstRef !== null ? ` for ${sceneNoun(firstRef)}` : ""}: “${instruction}” — retakes are generated from the storyboard.`,
    };
  }

  // --- swap ("swap scenes 3 and 4"): parsed, but reorder is a plan-revision (storyboard) edit.
  if (SWAP_VERB.test(instruction)) {
    const pair = SWAP_PAIR.exec(instruction);
    const a = pair ? refOrdinal(pair[1], pair[2]) : null;
    const b = pair ? refOrdinal(pair[3], pair[4]) : null;
    if (a === null || b === null) {
      return unsupported(`Tell me both scenes — for example “swap scenes 3 and 4”. This cut has ${context.shots.length} scene${context.shots.length === 1 ? "" : "s"}.`);
    }
    if (!shotAtOrdinal(context, a)) return noSuchScene(context, a);
    if (!shotAtOrdinal(context, b)) return noSuchScene(context, b);
    if (a === b) return unsupported(`Those are the same scene — swap needs two different scenes, for example “swap scenes 3 and 4”.`);
    return {
      kind: "swap",
      firstOrdinal: a,
      secondOrdinal: b,
      summary: `Swap the order of ${sceneNoun(a)} and ${sceneNoun(b)} — scene order is a storyboard plan revision, so this opens the storyboard.`,
    };
  }

  // --- disable ("skip scene 3", "cut shot 2").
  if (SKIP_VERB.test(instruction) && target) {
    if (target.disabled) return unsupported(`${sceneNoun(target.ordinal)} is already skipped.`);
    if (target.soleEnabled) return unsupported(`${sceneNoun(target.ordinal)} is the only scene left in the cut — skipping it would leave nothing to play.`);
    return {
      kind: "disable",
      shotOrdinal: target.ordinal,
      shotRevisionId: target.shotRevisionId,
      summary: `Skip ${sceneNoun(target.ordinal)} — it will not appear in the cut.`,
    };
  }

  // --- duplicate ("repeat scene 4", "play scene 2 again").
  if (DUPLICATE_VERB.test(instruction) && target) {
    return {
      kind: "duplicate",
      shotOrdinal: target.ordinal,
      shotRevisionId: target.shotRevisionId,
      summary: `Play ${sceneNoun(target.ordinal)} twice in a row.`,
    };
  }

  // --- audio cue bounds ("cut to the music from 0:45"): no frozen op touches cue timing.
  if (AUDIO_TARGET.test(instruction)) {
    return unsupported("Audio cue timing lives in the audio workspace — I can't move music, SFX or narration cues from the timeline.", "audio");
  }

  // --- scene reference alone ("scene 2", "shot 5") — name what I can do with it.
  if (target) {
    return unsupported(`I can trim, skip, repeat or swap the take of ${sceneNoun(target.ordinal)} — tell me which, for example “skip ${sceneNoun(target.ordinal).toLowerCase()}”.`);
  }

  return unsupported(
    `I couldn't map “${instruction.slice(0, 120)}” to a timeline edit. I can trim or extend a scene, skip a scene, repeat a scene, or swap a scene's take — by scene number. Scene order lives in the storyboard; delivery and retake directions belong to the audio and storyboard panels.`,
  );
}
