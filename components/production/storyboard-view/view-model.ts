/**
 * Storyboard screen view model (spec 09, /production/[projectId]/storyboard).
 *
 * Pure derivations only — no hooks, no window, no fetch. Consumes the frozen Wave-2 domain
 * signatures (lib/production/storyboard.ts + lib/production/anchors.ts) and the accepted
 * legacy view helpers (components/production/storyboard.tsx) without modifying either.
 * Every derivation that can fail (the domain functions throw ProductionApplicationError on
 * invalid input) is wrapped into an explicit ok/reason result so the UI fails closed with a
 * readable message instead of crashing the board.
 */

import {
  type AnchorCandidate, type CanonRevision, type ProductionJob,
  type ProductionQuote, type Scene, type ShotRevision, type StoryRevision,
} from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { buildAnchorGenerationCommand, recommendAnchorCandidate, type AnchorCommandDraft, type AnchorRenderSettings } from "@/lib/production/anchors";
import { deriveShotDraft, deriveStoryboard, type ShotPlanShotDraft, type StoryboardModel, type StoryboardSceneCoverage, type StoryboardSceneRow, type StoryboardStaleReason } from "@/lib/production/storyboard";
import { displayLabelForCanonRevision } from "@/lib/production/story-view-model";
import { PRODUCTION_MODEL_DEFAULTS } from "@/lib/providers/production/sogni-h3";
import {
  deriveAnchorRows, deriveGenerationReadiness, derivePendingMediaJobs, deriveShotCurrency,
  framesToDurationLabel, latestDecisionFor,
  type DecisionIssue, type ReadModelShot, type ShotCurrency,
} from "@/components/production/storyboard";
import type { MediaPreviewState } from "@/components/production/primitives/media";
import type { VariantCandidate } from "@/components/production/primitives/variants";
import { deriveApprovalState } from "@/lib/production/approval-state";
import type { ApprovalState } from "@/lib/production/contracts";

/* ================================================================== */
/* Board derivation (W2-A deriveStoryboard, fail-closed wrapper)       */
/* ================================================================== */

/** A read-model shot plus the selection markers coverage derivation reads (C7: derived, not stored). */
export type StoryboardShotInput = ShotRevision & { selectedAnchorId: string | null; selectedTakeId: string | null };

/** Read-model shots shaped for deriveStoryboard (plain ShotRevision[] stays a valid input there). */
export function storyboardShotInputs(readModelShots: readonly ReadModelShot[]): StoryboardShotInput[] {
  return readModelShots.map((entry) => ({
    ...entry.shotRevision,
    selectedAnchorId: entry.selectedAnchor?.id ?? null,
    selectedTakeId: entry.selectedTake?.id ?? null,
  }));
}

export type BoardResult = { ok: true; model: StoryboardModel } | { ok: false; message: string };

/**
 * Derives the board model from the approved story, the project's scenes and the read-model
 * shots. The domain derivation validates its input and throws, so the wrapper reports a
 * readable failure instead of rendering a half-derived board.
 */
export function deriveBoard(input: { story: StoryRevision; scenes: readonly Scene[]; shots: readonly StoryboardShotInput[] }): BoardResult {
  try {
    return {
      ok: true,
      model: deriveStoryboard({ story: input.story, scenes: [...input.scenes], shots: [...input.shots] }),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ProductionApplicationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error ? error.message : "The storyboard could not be derived from the project data.",
    };
  }
}

/** Stale shots keyed by shot revision id, so scene cards can look their shots up directly. */
export function staleShotsByShotId(model: StoryboardModel): Map<string, StoryboardModel["staleShots"][number]> {
  return new Map(model.staleShots.map((entry) => [entry.shot.id, entry]));
}

/* ================================================================== */
/* Frozen display metadata                                             */
/* ================================================================== */

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger";

/** Calm coverage vocabulary; the plain labels are UI choices over the frozen coverage values. */
export const COVERAGE_META: Record<StoryboardSceneCoverage, { label: string; tone: BadgeTone }> = {
  uncovered: { label: "No shots yet", tone: "neutral" },
  partial: { label: "Shots need anchors", tone: "warning" },
  anchored: { label: "Anchored", tone: "success" },
  animated: { label: "Animated", tone: "primary" },
};

/** Plain-language stale reasons; the codes stay the frozen dependency vocabulary. */
export const STALE_REASON_TEXT: Record<StoryboardStaleReason, string> = {
  DEPENDENCY_REPLACED: "The story no longer uses canon this shot pins.",
  STORY_CHANGED: "This shot was planned from a different story revision.",
  DEPENDENCY_MISSING: "This shot continues from a shot that is no longer on the board.",
};

export const STALE_BADGE_LABEL = "Stale — re-anchor";

/** Creator labels for the frozen anchor approval checklist ids (the submitted ids stay frozen). */
export const ANCHOR_CHECKLIST_LABELS: Record<string, string> = {
  identity: "Everyone looks like themselves",
  wardrobe: "Outfits match the scene",
  location: "The place matches the scene",
  props: "Props match the scene",
  framing: "The framing fits the shot",
};

/** New-shot draft profile: the accepted plan default, on the legal H3 frame grid. */
export const STORYBOARD_PROFILE = { targetFrames: 192 } as const;

/** Anchor generation defaults, mirroring the accepted legacy anchor form. */
export const DEFAULT_ANCHOR_SETTINGS: AnchorRenderSettings = {
  providerId: "sogni",
  modelId: PRODUCTION_MODEL_DEFAULTS.anchor,
  aspect: "9:16",
  resolution: "720p",
  seed: null,
  referenceAssetIds: [],
};

/* ================================================================== */
/* Small formatting helpers                                            */
/* ================================================================== */

/** "7s" scene target label; null when the scene sets no target (valid per spec 09 §8). */
export function sceneDurationLabel(durationTargetMs: number | null): string | null {
  if (durationTargetMs === null || !Number.isFinite(durationTargetMs) || durationTargetMs <= 0) return null;
  const wholeSeconds = Math.round(durationTargetMs / 1000);
  return `${wholeSeconds}s`;
}

/** Creator-facing framing label, e.g. "medium wide". */
export function framingLabel(framing: ShotRevision["framing"]): string {
  return framing.replace(/_/g, " ");
}

/** Shot duration line, e.g. "192 frames · 8.000s". */
export function shotDurationLine(shot: Pick<ShotRevision, "targetFrames">): string {
  return `${shot.targetFrames} frames · ${framesToDurationLabel(shot.targetFrames)}`;
}

/** Canon label that never fabricates: falls back to the revision id. */
export function canonLabel(revision: CanonRevision | undefined, fallback: string): string {
  return revision ? displayLabelForCanonRevision(revision) : fallback;
}

/* ================================================================== */
/* Shot draft (W2-A deriveShotDraft, fail-closed wrapper)              */
/* ================================================================== */

export type ShotDraftResult = { ok: true; draft: ShotPlanShotDraft } | { ok: false; reason: string };

/** One scene-derived shot draft at the given zero-based position; throws are reported, never propagated. */
export function draftShotForScene(scene: Scene, index: number): ShotDraftResult {
  try {
    return { ok: true, draft: deriveShotDraft({ scene, index, profile: { targetFrames: STORYBOARD_PROFILE.targetFrames } }) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ProductionApplicationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error ? error.message : "The shot draft could not be derived from this scene.",
    };
  }
}

/* ================================================================== */
/* Anchor commands (W2-A, fail-closed wrapper)                         */
/* ================================================================== */

export type AnchorCommandResult = { ok: true; draft: AnchorCommandDraft } | { ok: false; reason: string };

/** One shot prepared for anchor generation: a resolved command, or the honest reason it cannot resolve. */
export type AnchorTargetView = {
  label: string;
  shotId: string;
  shotRevisionId: string;
  command: AnchorCommandResult;
};

/**
 * Builds one anchor generation draft. Cast bindings that do not resolve to the provided canon
 * revisions fail closed (UNKNOWN_REFERENCE), so an anchor is never composed from unresolved
 * identity; the reason is shown on the shot instead.
 */
export function anchorCommandForShot(shot: ShotRevision, canonRevisions: readonly CanonRevision[], settings: AnchorRenderSettings): AnchorCommandResult {
  const revisionById = new Map(canonRevisions.map((revision) => [revision.id, revision]));
  const characterRevisions = shot.castBindings
    .map((binding) => revisionById.get(binding.canonRevisionId))
    .filter((revision): revision is CanonRevision => revision !== undefined);
  const environmentRevision = revisionById.get(shot.locationRevisionId) ?? null;
  try {
    return { ok: true, draft: buildAnchorGenerationCommand({ shot, characterRevisions, environmentRevision, settings }) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ProductionApplicationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error ? error.message : "This shot's cast or environment pins could not be resolved.",
    };
  }
}

/** Advisory recommendation (never an approval); a derivation failure yields null. */
export function recommendedAnchor(candidates: readonly AnchorCandidate[]): AnchorCandidate | null {
  try {
    return recommendAnchorCandidate([...candidates]);
  } catch {
    return null;
  }
}

/* ================================================================== */
/* Per-shot view data                                                  */
/* ================================================================== */

export type ShotRow = { anchor: AnchorCandidate; latestDecision: ReturnType<typeof latestDecisionFor> };

/** Everything one ShotCard renders, derived once in StoryboardView. */
export type ShotCardView = {
  entry: ReadModelShot;
  /** 1-based position within its scene (or the unassigned list). */
  number: number;
  stale: StoryboardModel["staleShots"][number] | null;
  gate: ShotCurrency;
  pendingJobs: readonly ProductionJob[];
  /** The shot's approved anchor with the exact current approval id, or null when none is approved. */
  approvedAnchor: { anchor: AnchorCandidate; approvalId: string } | null;
  /** The generation jobs behind this shot's take history (TakesPanel reads status from them). */
  takeJobs: readonly ProductionJob[];
  /** Project profile aspect; take motion must match it (server rule). */
  aspect: "9:16" | "16:9";
};

/**
 * The approved anchor a take can ride on: an anchor whose latest decision is an approval, preferring
 * the selected anchor, then the recommended one, then pin order. The approval id is the exact
 * latest approved decision so the take routes can re-validate its currency server-side.
 */
export function approvedAnchorWithApproval(entry: ReadModelShot): { anchor: AnchorCandidate; approvalId: string } | null {
  const model = deriveShotAnchorModel(entry);
  const approved = model.views.filter((view) =>
    view.approvalState === "approved" && view.row.latestDecision?.decision === "approved" && !!view.row.latestDecision.id);
  const pick = approved.find((view) => view.row.anchor.id === model.selected?.id) ??
    approved.find((view) => view.row.anchor.id === model.recommended?.id) ??
    approved[0];
  const decision = pick?.row.latestDecision;
  return pick && decision ? { anchor: pick.row.anchor, approvalId: decision.id } : null;
}

export function deriveShotCardView(input: {
  entry: ReadModelShot;
  number: number;
  stale: StoryboardModel["staleShots"][number] | null;
  readModel: Parameters<typeof deriveShotCurrency>[0];
}): ShotCardView {
  const gate = deriveShotCurrency(input.readModel, input.entry);
  const takeJobIds = new Set(input.entry.takeHistory.map((take) => take.jobId));
  return {
    entry: input.entry,
    number: input.number,
    stale: input.stale,
    gate,
    pendingJobs: derivePendingMediaJobs(input.readModel.activeJobs, input.entry.shotRevision.id),
    approvedAnchor: approvedAnchorWithApproval(input.entry),
    takeJobs: input.readModel.jobs.filter((job) => takeJobIds.has(job.id)),
    aspect: input.readModel.project.profile.format,
  };
}

export type AnchorCandidateView = {
  row: ShotRow;
  candidate: VariantCandidate;
  approvalState: ApprovalState;
  visionStatus: string | null;
};

export type ShotAnchorModel = {
  rows: ShotRow[];
  views: AnchorCandidateView[];
  recommended: AnchorCandidate | null;
  selected: AnchorCandidate | null;
  /** The candidate the card's approval controls target: recommended, then selected, then newest. */
  primary: AnchorCandidate | null;
};

/** Candidate previews stay honest: the read model exposes no media bytes, only asset ids. */
function candidatePreview(assetId: string): MediaPreviewState {
  return { phase: "empty", title: "Anchor frame", body: `Image asset ${assetId} — media not shown on this screen yet.` };
}

export function deriveShotAnchorModel(entry: ReadModelShot): ShotAnchorModel {
  const rows = deriveAnchorRows(entry);
  const recommended = recommendedAnchor(rows.map((row) => row.anchor));
  const selected = entry.selectedAnchor;
  const primary = recommended ?? selected ?? rows[0]?.anchor ?? null;
  const views: AnchorCandidateView[] = rows.map((row, index) => {
    const decision = row.latestDecision?.decision ?? null;
    const visionStatus = row.anchor.visionAssessment?.status ?? null;
    const isRecommended = recommended !== null && recommended.id === row.anchor.id;
    const captionParts = [
      visionStatus ? `Vision check: ${visionStatus}` : "No vision check recorded",
      decision ? (decision === "approved" ? "You approved this" : "Change requested") : "Not reviewed yet",
    ];
    return {
      row,
      approvalState: deriveApprovalState({
        approval: row.latestDecision ?? null,
        recommendedAt: row.anchor.recommendedAt ?? null,
      }),
      visionStatus,
      candidate: {
        id: row.anchor.id,
        label: `Candidate ${index + 1}`,
        preview: candidatePreview(row.anchor.assetId),
        badge: isRecommended ? "Recommended" : undefined,
        badgeTone: "primary",
        caption: captionParts.join(" · "),
        disabled: false,
      } satisfies VariantCandidate,
    };
  });
  return { rows, views, recommended, selected, primary };
}

/** True when the shot has a latest anchor decision of "approved" on any of its candidates. */
export function hasApprovedAnchor(entry: ReadModelShot): boolean {
  return entry.anchorHistory.some((anchor) => latestDecisionFor(entry.approvals, "anchor", anchor.id)?.decision === "approved");
}

/** Shared generation gate for one shot (the enqueue route's APPROVAL_REQUIRED rules, client mirror). */
export function anchorGenerationGate(readModel: Parameters<typeof deriveShotCurrency>[0], entry: ReadModelShot): { gate: ShotCurrency; reasons: readonly DecisionIssue[] } {
  const gate = deriveShotCurrency(readModel, entry);
  const readiness = deriveGenerationReadiness({
    operation: "anchor",
    providerId: DEFAULT_ANCHOR_SETTINGS.providerId,
    modelId: DEFAULT_ANCHOR_SETTINGS.modelId,
    storyApprovedCurrent: gate.storyApprovedCurrent,
    shotPlanApprovedCurrent: gate.shotPlanApprovedCurrent,
    animaticApprovedCurrent: gate.animaticApprovedCurrent,
    shotCurrent: gate.shotCurrent,
    pendingJob: gate.pendingMediaJob,
    anchorApprovedCurrent: true,
  });
  return { gate, reasons: readiness.reasons };
}

/* ================================================================== */
/* Quote math for the batch cost card                                  */
/* ================================================================== */

const minorToMajor = (minor: number): number => Math.round(minor) / 100;

export type QuoteSummary =
  | { available: true; min: number; max: number; currency: string; lines: { label: string; amount: string }[] }
  | { available: false };

/**
 * Sums per-shot quote estimates into one range. The accepted quote record carries minor-unit
 * estimates plus a nullable currency: quotes without a currency, mixing currencies, or missing
 * numbers are reported as "estimate unavailable" rather than guessed.
 */
export function summarizeQuotes(quotes: readonly { label: string; quote: ProductionQuote }[]): QuoteSummary {
  if (quotes.length === 0) return { available: false };
  const currency = quotes[0].quote.currency;
  if (currency === null) return { available: false };
  if (!quotes.every(({ quote }) => quote.currency === currency)) return { available: false };
  let min = 0;
  let max = 0;
  let numeric = true;
  const lines: { label: string; amount: string }[] = [];
  for (const { label, quote } of quotes) {
    if (quote.estimateMinMinor === null || quote.estimateMaxMinor === null) {
      numeric = false;
      continue;
    }
    const low = minorToMajor(quote.estimateMinMinor);
    const high = minorToMajor(quote.estimateMaxMinor);
    min += low;
    max += high;
    lines.push({ label, amount: `${low}–${high} ${currency}` });
  }
  if (!numeric) return { available: false };
  return { available: true, min, max, currency, lines };
}

/* ================================================================== */
/* Pending job → universal long-action phase (spec 03 §3)              */
/* ================================================================== */

const QUEUED_STATUSES = new Set(["queued", "validating", "submitting", "blocked", "submission_unknown", "cancel_requested"]);
const RUNNING_STATUSES = new Set(["running", "persisting"]);

export function jobGenerationPhase(job: ProductionJob): "queued" | "running" | "completed" | "failed" {
  if (job.status === "completed") return "completed";
  if (job.status === "failed" || job.status === "canceled") return "failed";
  if (RUNNING_STATUSES.has(job.status)) return "running";
  if (QUEUED_STATUSES.has(job.status)) return "queued";
  return "queued";
}
