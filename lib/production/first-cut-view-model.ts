/**
 * First Cut screen view model (spec 13 Alpha slice, `/first-cut`).
 *
 * Pure derivations only — no hooks, no window, no fetch, no Node builtins, so the client
 * FirstCutView and the server page can both import it. The working cut is ALWAYS the frozen
 * `RenderManifest` shape (plus the reversible `disabled` metadata from the C10 manifest ops,
 * lib/production/manifest-ops.ts); there is no feature-local timeline model. Timeline
 * arithmetic mirrors `compileManifestTimeline` (lib/production/manifest.ts): one trimmed shot
 * length each minus exactly `crossfadeFrames` per internal crossfade boundary. The frame
 * quantum arrives as an input so this file never imports the node-crypto-backed manifest module.
 *
 * "Reassemble only affected output" (spec 13 §2/§8) is answered by `changedSinceBuild` /
 * `delta`: entries are compared field-by-field against the last persisted (built) manifest,
 * so a single-shot change names only that shot.
 */
import type { EditableRenderManifest } from "./manifest-ops";

/** A manifest (stored or working copy) plus the optional reversible `disabled` metadata. */
export type FirstCutManifest = EditableRenderManifest;

export type FirstCutShotStatus = "selected" | "skipped" | "missing" | "failed";

/** One ordered entry of the take-strip. */
export interface FirstCutShotView {
  /** 1-based position in manifest order (skipped entries keep their position). */
  position: number;
  shotRevisionId: string;
  /** The id with any `-copy-N` suffix removed (duplicates share their source's media). */
  baseShotRevisionId: string;
  isCopy: boolean;
  takeId: string;
  assetId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  durationMs: number;
  /** Timeline offset in ms among ENABLED shots; null for skipped entries. */
  startMs: number | null;
  transition: "cut" | "crossfade";
  disabled: boolean;
  /** True when this is the last enabled shot (skipping it would empty the cut). */
  lastEnabled: boolean;
  status: FirstCutShotStatus;
  statusLabel: string;
  statusDetail: string;
  /** Differs from the same entry in the last built manifest (take/asset/trim/skip). */
  changedSinceBuild: boolean;
}

export interface FirstCutBuildDelta {
  changedShotIds: string[];
  changedCount: number;
  /** Human line for the "reassemble only affected output" indicator. */
  summary: string;
}

export interface FirstCutViewModel {
  aspect: "16:9" | "9:16";
  aspectCss: string;
  profileWidth: number;
  profileHeight: number;
  fps: number;
  shots: FirstCutShotView[];
  enabledCount: number;
  skippedCount: number;
  missingMediaCount: number;
  failedCount: number;
  /** Planned shots absent from this manifest (the plan moved on since the build). */
  outsideCut: Array<{ shotRevisionId: string; label: string | null }>;
  /** Enabled-shot timeline of the WORKING cut, recomputed from trims (never the stale totals). */
  workingTotalFrames: number;
  workingRuntimeMs: number;
  runtimeLabel: string;
  captions: Array<{ text: string; startFrame: number; endFrame: number }>;
  delta: FirstCutBuildDelta;
  /** Working manifest has the same inputsHash as the last built one. */
  matchesBuilt: boolean;
}

export interface FirstCutViewModelInput {
  workingManifest: FirstCutManifest;
  /** The last persisted manifest the playable build came from; null when nothing was built. */
  builtManifest: FirstCutManifest | null;
  /** Frozen crossfade overlap in frames (MANIFEST_CROSSFADE_FRAMES = 8). */
  crossfadeFrames: number;
  /** Asset ids missing from local records (a rebuild would fail on them). */
  missingAssetIds: ReadonlyArray<string>;
  /** Shot revision ids named by the last build failure artifact. */
  failedShotRevisionIds: ReadonlyArray<string>;
  /** Ordered shot revision ids of the project's active shot plan. */
  plannedShotRevisionIds: ReadonlyArray<string>;
  /** Optional human labels by base shot revision id (visual intent). */
  shotLabels?: Readonly<Record<string, string>>;
}

export interface FirstCutTakeOption {
  id: string;
  label: string;
}

/* ------------------------------------------------------------------ */
/* Small formatting + arithmetic helpers (pure)                        */
/* ------------------------------------------------------------------ */

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Smallest millisecond duration that maps to whole frames at `fps` (125ms at 24 fps). */
export const frameGridStepMs = (fps: number): number => 1000 / gcd(Math.round(fps), 1000);

/** Snaps a duration to the frame grid so `retimeShot` accepts it (nearest step, minimum one step). */
export const snapToFrameGrid = (ms: number, fps: number): number => {
  const step = frameGridStepMs(fps);
  if (!Number.isFinite(ms)) return step;
  return Math.max(step, Math.round(ms / step) * step);
};

export const framesToMs = (frames: number, fps: number): number => Math.round((frames * 1000) / fps);

/** "2s", "1.5s", "0.125s", "1m 23s" — plain durations for the strip and the runtime line. */
export function formatDurationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60_000) {
    const seconds = ms / 1000;
    if (Number.isInteger(seconds)) return `${seconds}s`;
    const oneDecimal = Math.round(seconds * 10) / 10;
    return oneDecimal === seconds ? `${oneDecimal}s` : `${seconds}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Strips repeated `-copy-N` suffixes left by the C10 duplicateShot op. */
export function baseShotRevisionId(shotRevisionId: string): string {
  let current = shotRevisionId;
  for (let depth = 0; depth < 8; depth += 1) {
    const match = /^(.*?)-copy-\d+$/.exec(current);
    if (!match) break;
    current = match[1]!;
  }
  return current;
}

export const isCopyShotId = (shotRevisionId: string): boolean => baseShotRevisionId(shotRevisionId) !== shotRevisionId;

/** Enabled-shot timeline totals, mirroring the frozen compile arithmetic (trim sums minus crossfade overlaps). */
export function workingTimeline(manifest: FirstCutManifest, crossfadeFrames: number): { totalFrames: number; runtimeMs: number; fps: number } {
  const fps = manifest?.profile?.fps ?? 24;
  const shots = Array.isArray(manifest?.shots) ? manifest.shots : [];
  let totalFrames = 0;
  let boundaries = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]!;
    if (shot.disabled === true) continue;
    totalFrames += shot.endFrame - shot.startFrame;
    let hasNextEnabled = false;
    for (let next = index + 1; next < shots.length; next += 1) {
      if (shots[next]!.disabled !== true) { hasNextEnabled = true; break; }
    }
    if (shot.transition === "crossfade" && hasNextEnabled) boundaries += 1;
  }
  const frames = Math.max(0, totalFrames - boundaries * crossfadeFrames);
  return { totalFrames: frames, runtimeMs: framesToMs(frames, fps), fps };
}

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

export function buildFirstCutViewModel(input: FirstCutViewModelInput): FirstCutViewModel {
  const { workingManifest, builtManifest, crossfadeFrames, missingAssetIds, failedShotRevisionIds, plannedShotRevisionIds, shotLabels } = input;
  const profile = workingManifest?.profile;
  const fps = profile?.fps ?? 24;
  const missingAssets = new Set(missingAssetIds);
  const failedIds = new Set(failedShotRevisionIds);
  const builtById = new Map<string, FirstCutManifest["shots"][number]>();
  if (builtManifest && Array.isArray(builtManifest.shots)) {
    for (const shot of builtManifest.shots) builtById.set(shot.shotRevisionId, shot);
  }

  const rows = Array.isArray(workingManifest?.shots) ? workingManifest.shots : [];
  const enabledIndexes = rows.map((shot, index) => (shot.disabled === true ? -1 : index)).filter((index) => index >= 0);
  const lastEnabledIndex = enabledIndexes.length > 0 ? enabledIndexes[enabledIndexes.length - 1]! : -1;
  // The frozen op only forbids disabling when ONE enabled shot would remain — not merely the last in order.
  const soleEnabled = enabledIndexes.length === 1;

  const shots: FirstCutShotView[] = [];
  let offsetFrames = 0;
  let enabledCount = 0;
  let skippedCount = 0;
  let missingMediaCount = 0;
  let failedCount = 0;
  let changedCount = 0;
  const changedShotIds: string[] = [];

  for (const [index, entry] of rows.entries()) {
    const durationFrames = Math.max(0, entry.endFrame - entry.startFrame);
    const durationMs = framesToMs(durationFrames, fps);
    const disabled = entry.disabled === true;
    const base = baseShotRevisionId(entry.shotRevisionId);
    const built = builtById.get(entry.shotRevisionId);
    const changedSinceBuild =
      !built ||
      built.takeId !== entry.takeId ||
      built.assetId !== entry.assetId ||
      built.startFrame !== entry.startFrame ||
      built.endFrame !== entry.endFrame ||
      (built.disabled === true) !== disabled;

    let status: FirstCutShotStatus;
    let statusLabel: string;
    let statusDetail: string;
    if (disabled) {
      status = "skipped";
      statusLabel = "Skipped in this cut";
      statusDetail = "You skipped this shot — it stays saved on the cut but plays nothing and adds no time.";
      skippedCount += 1;
    } else if (missingAssets.has(entry.assetId)) {
      status = "missing";
      statusLabel = "Missing media";
      statusDetail = "The video file behind this shot is missing locally, so a rebuild would fail here.";
      missingMediaCount += 1;
    } else if (failedIds.has(entry.shotRevisionId) || failedIds.has(base)) {
      status = "failed";
      statusLabel = "Skipped in this cut";
      statusDetail = "The last build could not render this shot, so it is not in the playable cut. Retry the build once the shot is fixed.";
      failedCount += 1;
    } else {
      status = "selected";
      statusLabel = "Selected";
      statusDetail = "Plays in the cut.";
    }

    let startMs: number | null = null;
    if (!disabled) {
      if (enabledCount > 0) {
        const previous = rows[enabledIndexes[enabledCount - 1]!];
        if (previous?.transition === "crossfade") offsetFrames -= crossfadeFrames;
      }
      startMs = framesToMs(offsetFrames, fps);
      offsetFrames += durationFrames;
      enabledCount += 1;
    }

    if (changedSinceBuild) {
      changedCount += 1;
      changedShotIds.push(entry.shotRevisionId);
    }

    shots.push({
      position: index + 1,
      shotRevisionId: entry.shotRevisionId,
      baseShotRevisionId: base,
      isCopy: isCopyShotId(entry.shotRevisionId),
      takeId: entry.takeId,
      assetId: entry.assetId,
      startFrame: entry.startFrame,
      endFrame: entry.endFrame,
      durationFrames,
      durationMs,
      startMs,
      transition: entry.transition,
      disabled,
      lastEnabled: soleEnabled && index === lastEnabledIndex,
      status,
      statusLabel,
      statusDetail,
      changedSinceBuild,
    });
  }

  // Planned shots the manifest does not cover (the active plan moved on since the build).
  const coveredBases = new Set(shots.map((shot) => shot.baseShotRevisionId));
  const outsideCut = plannedShotRevisionIds
    .filter((id) => !coveredBases.has(id))
    .map((id) => ({ shotRevisionId: id, label: shotLabels?.[id] ?? null }));

  const timeline = workingTimeline(workingManifest, crossfadeFrames);
  const deltaSummary =
    changedCount === 0
      ? "Unchanged from the last build."
      : changedCount === 1
        ? "1 shot changed — only it re-renders on the next build; every other scene is reused."
        : `${changedCount} shots changed — only those re-render on the next build; every other scene is reused.`;

  return {
    aspect: profile?.aspect ?? "16:9",
    aspectCss: `${profile?.width ?? 16} / ${profile?.height ?? 9}`,
    profileWidth: profile?.width ?? 1920,
    profileHeight: profile?.height ?? 1080,
    fps,
    shots,
    enabledCount,
    skippedCount,
    missingMediaCount,
    failedCount,
    outsideCut,
    workingTotalFrames: timeline.totalFrames,
    workingRuntimeMs: timeline.runtimeMs,
    runtimeLabel: formatDurationLabel(timeline.runtimeMs),
    captions: (workingManifest?.captionCues ?? []).map((cue) => ({ text: cue.text, startFrame: cue.startFrame, endFrame: cue.endFrame })),
    delta: { changedShotIds, changedCount, summary: deltaSummary },
    matchesBuilt: !!builtManifest && workingManifest.inputsHash === builtManifest.inputsHash,
  };
}

/* ------------------------------------------------------------------ */
/* Wire types for the "apply one confirmed change" server action       */
/* ------------------------------------------------------------------ */

export type FirstCutOpInput =
  | { kind: "retime"; shotId: string; durationMs: number }
  | { kind: "disable"; shotId: string }
  | { kind: "duplicate"; shotId: string }
  | { kind: "replaceTake"; shotId: string; takeId: string }
  | { kind: "setCaptions"; cues: Array<{ text: string; startFrame: number; endFrame: number }> };

export interface FirstCutApplyChangeCommand {
  projectId: string;
  /** The caller's current working manifest; the op is applied on top of it. */
  manifest: FirstCutManifest;
  op: FirstCutOpInput;
}

export type FirstCutApplyResult =
  | { ok: true; manifest: FirstCutManifest; inputsHash: string }
  | { ok: false; code: string; error: string };

export const firstCutApplyFailure = (code: string, error: string): FirstCutApplyResult => ({ ok: false, code, error });

/* ------------------------------------------------------------------ */
/* Honest plan text + free-text mapping (no pretend understanding)     */
/* ------------------------------------------------------------------ */

const SHOT_REF = /\b(?:shot|scene|clip)\s*#?(\d{1,4})\b/i;
const DURATION = /(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i;
const CAPTION_TEXT = /captions?\s*[:\-—]\s*(.+)/i;
const CAPTION_REMOVE = /(?:^|\s)(?:remove|clear|drop|delete|no)\s+(?:the\s+)?captions?/i;
const TRIM_VERB = /\b(?:trim|shorten|cut|reduce|shave)\b/i;
const EXTEND_VERB = /\b(?:extend|lengthen|stretch|longer)\b/i;
const SKIP_VERB = /\b(?:remove|skip|cut|disable|hide|drop|leave out|take out)\b/i;
const DUPLICATE_VERB = /\b(?:repeat|duplicate|copy|again)\b/i;
const TAKE_REF = /\btake\s*#?(\d{1,3})\b/i;
const TAKE_VERB = /\b(?:use|swap|switch|replace|go to|pick)\b/i;

const parseAmountMs = (raw: string, unit: string): number => {
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (/^m/i.test(unit)) return Math.round(value);
  return Math.round(value * 1000);
};

const shotAtPosition = (view: FirstCutViewModel, position: number): FirstCutShotView | null =>
  Number.isInteger(position) && position >= 1 && position <= view.shots.length ? view.shots[position - 1]! : null;

const shotWordFor = (position: number): string => (position > 0 ? `Shot ${position}` : "the shot");

/**
 * Human-readable plan line for one confirmed op. Pure; used by the structured forms and the
 * free-text mapping so the preview and the applied change can never drift apart.
 */
export function describeFirstCutOp(
  op: FirstCutOpInput,
  view: FirstCutViewModel,
  takesByBaseShot: Readonly<Record<string, ReadonlyArray<FirstCutTakeOption>>>,
): string {
  const findShot = (shotId: string): FirstCutShotView | undefined => view.shots.find((shot) => shot.shotRevisionId === shotId);
  switch (op.kind) {
    case "retime": {
      const shot = findShot(op.shotId);
      const from = shot ? formatDurationLabel(shot.durationMs) : "?";
      return `Trim ${shotWordFor(shot?.position ?? 0)} from ${from} to ${formatDurationLabel(op.durationMs)}.`;
    }
    case "disable": {
      const shot = findShot(op.shotId);
      return `Skip ${shotWordFor(shot?.position ?? 0)} — it will not appear in the cut.`;
    }
    case "duplicate": {
      const shot = findShot(op.shotId);
      return `Play ${shotWordFor(shot?.position ?? 0)} twice in a row.`;
    }
    case "replaceTake": {
      const shot = findShot(op.shotId);
      const options = takesByBaseShot[shot?.baseShotRevisionId ?? ""] ?? [];
      const next = options.find((take) => take.id === op.takeId);
      return `Shot ${shot?.position ?? 0}: use ${next?.label ?? "the other take"} instead of the current take.`;
    }
    case "setCaptions": {
      if (op.cues.length === 0) return "Remove all captions from the cut.";
      const first = op.cues[0]!;
      return `Replace the captions with ${op.cues.length === 1 ? "one line" : `${op.cues.length} lines`}, starting with “${first.text.slice(0, 80)}”.`;
    }
  }
}

export type FirstCutPlanDraft =
  | { ok: true; op: FirstCutOpInput; planText: string }
  | { ok: false; reason: string };

/**
 * Maps one free-text instruction onto the five frozen C10 ops — honestly. Anything that does
 * not clearly match one of the five returns ok:false with the button alternatives; the UI
 * never pretends to understand a broader instruction (spec 13 §8).
 */
export function parseFirstCutInstruction(
  instruction: string,
  view: FirstCutViewModel,
  takesByBaseShot: Readonly<Record<string, ReadonlyArray<FirstCutTakeOption>>>,
): FirstCutPlanDraft {
  const text = instruction.trim();
  if (!text) return { ok: false, reason: "Type a change first — for example “trim shot 2 to 1 second”." };

  const fallback = (): FirstCutPlanDraft => ({
    ok: false,
    reason:
      `I couldn't map “${text.slice(0, 120)}” to an edit I can make. ` +
      "I can do exactly five things — use the buttons below: trim a shot, skip a shot, repeat a shot, swap a take, or replace the captions.",
  });

  const shotRef = SHOT_REF.exec(text);
  const duration = DURATION.exec(text);
  const takeRef = TAKE_REF.exec(text);

  // Captions (no shot targeting): "remove captions" clears, "captions: …" replaces.
  if (CAPTION_REMOVE.test(text)) {
    const op: FirstCutOpInput = { kind: "setCaptions", cues: [] };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }
  const captionText = CAPTION_TEXT.exec(text);
  if (captionText?.[1]) {
    const line = captionText[1]!.trim().slice(0, 200);
    if (!line) return fallback();
    if (view.workingTotalFrames <= 0) return { ok: false, reason: "The cut has no playable length to caption yet — build it first." };
    const op: FirstCutOpInput = { kind: "setCaptions", cues: [{ text: line, startFrame: 0, endFrame: view.workingTotalFrames }] };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }

  if (!shotRef) return fallback();
  const position = Number(shotRef[1]);
  const target = shotAtPosition(view, position);
  if (!target) {
    return { ok: false, reason: `This cut has ${view.shots.length} shot${view.shots.length === 1 ? "" : "s"}; there is no shot ${position}.` };
  }

  // Swap take: a take number AND a shot number ("use take 2 for shot 3", or "shot 3 take 2").
  if (takeRef && (TAKE_VERB.test(text) || (!TRIM_VERB.test(text) && !SKIP_VERB.test(text) && !DUPLICATE_VERB.test(text)))) {
    const options = takesByBaseShot[target.baseShotRevisionId] ?? [];
    const ordinal = Number(takeRef[1]);
    const replacement = options[ordinal - 1];
    if (!replacement) {
      return { ok: false, reason: `Shot ${position} has ${options.length} take${options.length === 1 ? "" : "s"}; there is no take ${ordinal}.` };
    }
    if (replacement.id === target.takeId) {
      return { ok: false, reason: `Shot ${position} already uses ${replacement.label}. Pick a different take.` };
    }
    const op: FirstCutOpInput = { kind: "replaceTake", shotId: target.shotRevisionId, takeId: replacement.id };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }

  // Trim / extend with an explicit duration: "trim shot 2 to 1 second" (set),
  // "shorten shot 3 by 0.5s" (reduce), "extend shot 1 by 2 seconds" (grow).
  if (duration && (TRIM_VERB.test(text) || EXTEND_VERB.test(text))) {
    const amountMs = parseAmountMs(duration[1]!, duration[2]!);
    if (amountMs <= 0) return fallback();
    const extending = EXTEND_VERB.test(text) && !TRIM_VERB.test(text);
    const setMode = /\b(?:to|at|exactly)\b\s*$/i.test(text.slice(0, duration.index ?? 0).trimEnd());
    if (!extending && !setMode && amountMs >= target.durationMs) {
      const stepMs = frameGridStepMs(view.fps);
      return {
        ok: false,
        reason: `Shot ${position} is only ${formatDurationLabel(target.durationMs)} long — it cannot get ${formatDurationLabel(amountMs)} shorter (the shortest length on the ${view.fps} fps grid is ${formatDurationLabel(stepMs)}).`,
      };
    }
    const snapped = snapToFrameGrid(setMode ? amountMs : extending ? target.durationMs + amountMs : target.durationMs - amountMs, view.fps);
    const op: FirstCutOpInput = { kind: "retime", shotId: target.shotRevisionId, durationMs: snapped };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }

  // Skip a shot ("cut shot 2" with no duration means remove it).
  if (SKIP_VERB.test(text)) {
    if (target.lastEnabled) {
      return { ok: false, reason: `Shot ${position} is the only shot left in the cut — skipping it would leave nothing to play.` };
    }
    const op: FirstCutOpInput = { kind: "disable", shotId: target.shotRevisionId };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }

  // Repeat a shot.
  if (DUPLICATE_VERB.test(text)) {
    const op: FirstCutOpInput = { kind: "duplicate", shotId: target.shotRevisionId };
    return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
  }

  // "make shot 2 1 second" — a set-to duration without trim/extend wording.
  if (duration) {
    const amountMs = parseAmountMs(duration[1]!, duration[2]!);
    if (amountMs > 0) {
      const op: FirstCutOpInput = { kind: "retime", shotId: target.shotRevisionId, durationMs: snapToFrameGrid(amountMs, view.fps) };
      return { ok: true, op, planText: describeFirstCutOp(op, view, takesByBaseShot) };
    }
  }

  return fallback();
}

/* ------------------------------------------------------------------ */
/* Server page payload (serializable snapshot handed to the client)    */
/* ------------------------------------------------------------------ */

export interface FirstCutExportSnapshot {
  id: string;
  status: "queued" | "rendering" | "qc_pending" | "qc_failed" | "ready_for_review" | "approved" | "failed" | "canceled";
  assetId: string | null;
  manifestId: string;
  createdAt: number;
}

export interface FirstCutViewData {
  projectId: string;
  projectName: string;
  /** The last persisted manifest behind the playable build; null when nothing was ever built. */
  builtManifest: FirstCutManifest | null;
  crossfadeFrames: number;
  exportRecord: FirstCutExportSnapshot | null;
  missingAssetIds: string[];
  failedShotRevisionIds: string[];
  /** Stage named by the last build failure artifact, when one exists (e.g. "encode"). */
  failureStage: string | null;
  plannedShotRevisionIds: string[];
  shotLabels: Record<string, string>;
  /** Replacement candidates per base shot revision id (C10 replaceTake). */
  takesByBaseShot: Record<string, FirstCutTakeOption[]>;
  /** Pinned source length per manifest shot id — bounds the trim form. */
  sourceFramesByShot: Record<string, number>;
  /** False when the compile pins needed by the C10 ops are incomplete; edits stay read-only. */
  editsAvailable: boolean;
  editsUnavailableReason: string | null;
}
