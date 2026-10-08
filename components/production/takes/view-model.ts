/**
 * Takes view model (spec 10, shot inspector panel). Pure derivations only — no hooks, no
 * window, no fetch. Consumes the frozen take command domain (lib/production/takes.ts) and the
 * accepted legacy read helpers (components/production/storyboard.tsx) without modifying
 * either. Derivations that can fail (the domain functions throw ProductionApplicationError)
 * are wrapped into explicit ok/reason results so the panel fails closed with a readable
 * message instead of crashing the inspector.
 */

import {
  type AnchorCandidate, type Approval, type ApprovalState, type CreateQuoteCommand,
  type ProductionJob, type ShotRevision, type Take,
} from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { deriveApprovalState } from "@/lib/production/approval-state";
import {
  buildTakeGenerationCommand, buildTakeRetryCommand, composeTakeMotionPrompt, recommendTake,
  summarizeTakeHistory, TAKE_MOTION_DEFAULTS,
  type MotionSettings, type TakeCommandDraft, type TakeJobStatus, type TakeRetryDraft,
  type TakeRetryMode,
} from "@/lib/production/takes";
import { latestDecisionFor, type DecisionIssue } from "@/components/production/storyboard";
import type { MediaPreviewState, VersionThumb } from "@/components/production/primitives/media";

/* ================================================================== */
/* Job status → universal long-action phase (spec 03 §3)                */
/* ================================================================== */

export type TakePhase = "queued" | "running" | "completed" | "failed";

const FAILED_JOB_STATUSES = new Set<TakeJobStatus>(["failed", "canceled"]);
const RUNNING_JOB_STATUSES = new Set<TakeJobStatus>(["running", "persisting"]);

/** Phase label shown on thumbs and summaries; never provider or params jargon. */
export const TAKE_PHASE_LABELS: Record<TakePhase, string> = {
  queued: "Queued",
  running: "Generating…",
  completed: "Completed",
  failed: "Failed",
};

/** The take's generation job for a job id, if the provided slice carries it. */
export function jobById(jobs: readonly ProductionJob[], jobId: string): ProductionJob | undefined {
  return jobs.find((job) => job.id === jobId);
}

export function jobStatusMap(jobs: readonly ProductionJob[]): Map<string, TakeJobStatus> {
  return new Map(jobs.map((job) => [job.id, job.status]));
}

/**
 * Maps a take's generation job onto the universal phase. A job missing from the provided jobs
 * shows as queued — the read model normally carries it, and "still working" is the safe
 * direction (it never enables selection or hides a failure that is actually recorded).
 */
export function takeJobPhase(job: ProductionJob | undefined): TakePhase {
  if (!job) return "queued";
  if (job.status === "completed") return "completed";
  if (FAILED_JOB_STATUSES.has(job.status)) return "failed";
  if (RUNNING_JOB_STATUSES.has(job.status)) return "running";
  return "queued";
}

/* ================================================================== */
/* History rows (chronological take strip)                              */
/* ================================================================== */

export type TakeRowView = {
  take: Take;
  id: string;
  /** Chronological creator label, e.g. "Take 1" — never a job or asset id. */
  label: string;
  caption: string;
  phase: TakePhase;
  approvalState: ApprovalState;
  approved: boolean;
  selected: boolean;
  recommended: boolean;
  directionNote: string | null;
  /** Only an approved, completed take can become the selection (client mirror of the service rules). */
  selectable: boolean;
  /** Plain-language reason the take cannot be selected right now; null when selectable. */
  selectableReason: string | null;
  thumb: MediaPreviewState;
};

/** Previews stay honest: the read model exposes no media bytes, only asset ids. */
function takeThumb(phase: TakePhase, assetId: string): MediaPreviewState {
  if (phase === "queued" || phase === "running") {
    return { phase: "empty", title: TAKE_PHASE_LABELS[phase], body: "This take is still working — the strip keeps its place." };
  }
  if (phase === "failed") {
    return { phase: "empty", title: "Failed", body: "This take didn't finish. Your selected take stays untouched." };
  }
  return { phase: "empty", title: `Video asset ${assetId}`, body: "Media bytes aren't shown on this panel yet." };
}

/**
 * One row per take, in chronological order (Take 1 first) with the selection pin, each take's
 * latest decision and the advisory recommendation flag applied. A failed take never removes
 * the selected take — rows only ever report state.
 */
export function deriveTakeRows(input: {
  takes: readonly Take[];
  jobs: readonly ProductionJob[];
  approvals: readonly Approval[];
  selectedTakeId: string | null;
  recommendedId: string | null;
}): TakeRowView[] {
  const jobs = input.jobs;
  const chronological = [...input.takes].sort(
    (left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return chronological.map((take, index) => {
    const phase = takeJobPhase(jobById(jobs, take.jobId));
    const latestDecision = latestDecisionFor(input.approvals, "take", take.id);
    const approved = latestDecision?.decision === "approved";
    const selected = input.selectedTakeId === take.id;
    const recommended = input.recommendedId !== null && input.recommendedId === take.id;
    const captionParts = [
      phase === "completed" ? (approved ? "You approved this" : "Not reviewed yet") : TAKE_PHASE_LABELS[phase],
      recommended ? "Recommended" : null,
    ].filter((part): part is string => part !== null);
    const selectable = phase === "completed" && approved;
    const selectableReason = selectable
      ? null
      : phase === "queued" || phase === "running"
        ? "Still generating — you can use this take once it finishes."
        : phase === "failed"
          ? "This take didn't finish, so it can't be selected."
          : "Approve this take first — PeraByte may recommend, but only you approve.";
    return {
      take,
      id: take.id,
      label: `Take ${index + 1}`,
      caption: captionParts.join(" · "),
      phase,
      approvalState: deriveApprovalState({ approval: latestDecision, recommendedAt: take.recommendedAt ?? null }),
      approved,
      selected,
      recommended,
      directionNote: take.directionNote ?? null,
      selectable,
      selectableReason,
      thumb: takeThumb(phase, take.assetId),
    };
  });
}

/** VersionStrip thumbs: one immutable history entry per take, selection pin driven by the caller. */
export function takeVersionThumbs(rows: readonly TakeRowView[]): VersionThumb[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    caption: row.caption,
    state: row.thumb,
  }));
}

/* ================================================================== */
/* Recommendation + summary (guarded wrappers over the frozen domain)    */
/* ================================================================== */

/**
 * Advisory recommendation id from eligible takes (approved + completed when the caller supplies
 * those sets — the panel always does). A derivation failure yields null; nothing is recommended
 * rather than recommending from a broken list.
 */
export function recommendedTakeId(
  takes: readonly Take[],
  context: { completedJobIds: ReadonlySet<string>; approvedTakeIds: ReadonlySet<string> },
): string | null {
  try {
    return recommendTake([...takes], context)?.id ?? null;
  } catch {
    return null;
  }
}

/** Eligibility sets for recommendTake, derived from the read-model slices the panel already holds. */
export function takeEligibilitySets(input: {
  takes: readonly Take[];
  jobs: readonly ProductionJob[];
  approvals: readonly Approval[];
}): { completedJobIds: Set<string>; approvedTakeIds: Set<string> } {
  const completedJobIds = new Set<string>();
  for (const job of input.jobs) {
    if (job.operation === "take" && job.status === "completed") completedJobIds.add(job.id);
  }
  const approvedTakeIds = new Set<string>();
  for (const take of input.takes) {
    if (latestDecisionFor(input.approvals, "take", take.id)?.decision === "approved") approvedTakeIds.add(take.id);
  }
  return { completedJobIds, approvedTakeIds };
}

export type TakeHistorySummaryView = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  /** Takes whose job status is not in the provided jobs — counted in total only, never guessed. */
  unknown: number;
  selectedId: string | null;
};

export function summarize(input: {
  takes: readonly Take[];
  jobs: readonly ProductionJob[];
  selectedTakeId: string | null;
}): TakeHistorySummaryView {
  const summary = summarizeTakeHistory([...input.takes], {
    selectedTakeId: input.selectedTakeId,
    jobStatusById: jobStatusMap(input.jobs),
  });
  const unknown = Math.max(0, summary.total - summary.completed - summary.failed - summary.running);
  return { ...summary, unknown };
}

/** One plain line for the panel header, e.g. "3 takes · 1 completed · 1 generating · 1 failed". */
export function takeSummaryLine(summary: TakeHistorySummaryView): string {
  const parts = [`${summary.total} take${summary.total === 1 ? "" : "s"}`];
  if (summary.completed > 0) parts.push(`${summary.completed} completed`);
  if (summary.running > 0) parts.push(`${summary.running} generating`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.join(" · ");
}

/* ================================================================== */
/* Client-side generation gates (the server remains the truth)          */
/* ================================================================== */

/**
 * The anchor-side gates the panel can check without the full read model: a take rides the
 * approved anchor, and the take quote binds the anchor's exact current human approval id.
 * Story/plan/animatic gates arrive from the integrator via `gateReasons`.
 */
export function takeGenerationGateReasons(input: {
  approvedAnchor: { anchor: AnchorCandidate; approvalId: string | null } | null;
}): DecisionIssue[] {
  if (!input.approvedAnchor) {
    return [{ code: "APPROVAL_REQUIRED", message: "This shot needs an approved anchor before a take can be generated." }];
  }
  if (input.approvedAnchor.approvalId === null) {
    return [{ code: "APPROVAL_REQUIRED", message: "The anchor's approval record could not be found; re-approve the anchor to generate takes." }];
  }
  return [];
}

/** Retry-side gate: the retried request must still match the shot's current length. */
export function takeRetryGateReason(input: {
  job: ProductionJob | null;
  draftMotion: MotionSettings | null;
  currentTargetFrames: number;
}): DecisionIssue | null {
  if (!input.job) {
    return { code: "UNKNOWN_REFERENCE", message: "The generation job behind this take isn't in the loaded data, so it can't be retried here." };
  }
  if (input.draftMotion && input.draftMotion.targetFrames !== input.currentTargetFrames) {
    return { code: "STALE_REVISION", message: "This shot's length changed since that take was made — generate a new take instead." };
  }
  return null;
}

/* ================================================================== */
/* Command builders (fail-closed wrappers over the frozen domain)        */
/* ================================================================== */

/** Motion settings from the panel's controls; the direction note rides in the hashed prompt. */
export function panelTakeMotion(input: {
  motionIntent: string;
  targetFrames: number;
  aspect: "9:16" | "16:9";
  modelId: string;
  seed: number | null;
  directionNote: string | null;
}): MotionSettings {
  return {
    providerId: TAKE_MOTION_DEFAULTS.providerId,
    modelId: input.modelId,
    prompt: composeTakeMotionPrompt(input.motionIntent, input.directionNote),
    targetFrames: input.targetFrames,
    aspect: input.aspect,
    seed: input.seed,
  };
}

export type TakeCommandResult = { ok: true; draft: TakeCommandDraft } | { ok: false; reason: string };

/** One shot's take generation draft, or the honest reason it cannot compose. */
export function takeCommandForShot(input: {
  shot: ShotRevision;
  anchor: AnchorCandidate;
  motion?: MotionSettings;
  directionNote?: string | null;
}): TakeCommandResult {
  try {
    return { ok: true, draft: buildTakeGenerationCommand(input) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ProductionApplicationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error ? error.message : "This take could not be composed from the approved anchor.",
    };
  }
}

export type TakeRetryResult = { ok: true; draft: TakeRetryDraft } | { ok: false; reason: string };

/** One take retry draft, or the honest reason the retry cannot be derived. */
export function takeRetryCommandForTake(input: {
  job: ProductionJob;
  mode: TakeRetryMode;
  seed?: string;
  directionNote?: string | null;
}): TakeRetryResult {
  try {
    return { ok: true, draft: buildTakeRetryCommand(input) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ProductionApplicationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error ? error.message : "This retry could not be derived from the original request.",
    };
  }
}

/* ================================================================== */
/* Batch animation (spec 10 Agent D: selection, estimate, confirm)      */
/* ================================================================== */

/** One shot eligible for the batch "Animate all anchored shots" action. */
export type TakeBatchTarget = {
  label: string;
  /** Route-level shot id the take routes verify. */
  shotId: string;
  shot: ShotRevision;
  anchor: AnchorCandidate;
  /** The anchor's current human approval id — the take quote binds it. */
  approvalId: string;
};

/**
 * The representative estimate request for the batch cost gate: one real take quote for the
 * first target, scaled by the gate to the batch size. Each target still receives its own
 * recipe-bound quote at confirm time, so the final cost is exact per shot.
 */
export function batchEstimateRequest(input: {
  targets: readonly TakeBatchTarget[];
  aspect: "9:16" | "16:9";
  modelId: string;
}): Omit<CreateQuoteCommand, "projectId"> | null {
  const first = input.targets[0];
  if (!first) return null;
  return {
    providerId: TAKE_MOTION_DEFAULTS.providerId,
    modelId: input.modelId,
    operation: "take",
    inputSnapshot: {
      revisionIds: [first.shot.id],
      assetIds: [first.anchor.assetId],
      parameters: { frameCount: first.shot.targetFrames, aspect: input.aspect, seed: null },
    },
  };
}
