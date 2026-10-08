import type { ContinuityAspect, ContinuityFinding, ContinuityResult, ContinuityStatus } from "@/lib/production/continuity";
import type { RepairGuidance } from "@/lib/production/continuity-guidance";

/* ------------------------------------------------------------------ */
/* Continuity view model — spec 11 §7 / W2-A engine (`lib/production/  */
/* continuity.ts`)                                                     */
/* ------------------------------------------------------------------ */
/*
 * Status and result types are the FROZEN engine types, re-exported (never
 * redefined) from `@/lib/production/continuity` so lanes can import them from
 * either place. This file only adds what a creator-facing view needs: human
 * labels, finding aggregation, and report-row shapes.
 */

export type { ContinuityAspect, ContinuityFinding, ContinuityResult, ContinuityStatus };

/** The dimensions the engine checks first (spec 11 §2), in stable display order. */
export const BASE_CONTINUITY_ASPECTS: readonly ContinuityAspect[] = ["identity", "outfit", "environment", "lighting"];

const ASPECT_LABELS: Record<ContinuityAspect, string> = {
  identity: "Identity",
  outfit: "Outfit",
  environment: "Environment",
  lighting: "Lighting",
};

/**
 * Human label for an aspect. Unknown aspects degrade to a readable title, and
 * the legacy "location" word never reaches the UI (CONTRACTS-FROZEN C1).
 */
export function labelForAspect(aspect: string): string {
  if (aspect === "location") return "Environment";
  return ASPECT_LABELS[aspect as ContinuityAspect] ?? (aspect.charAt(0).toUpperCase() + aspect.slice(1).replace(/_/g, " "));
}

/** Screen-reader phrase per status; color is never the only signal. */
export const CONTINUITY_STATUS_PHRASE: Record<ContinuityStatus, string> = {
  pass: "looks consistent",
  warn: "worth a look",
  fail: "mismatch",
  not_checked: "not checked",
};

/**
 * Worst-of aggregation over findings, matching the engine's own severity
 * (fail > warn > not_checked > pass — a gap never masks a finding, and never
 * looks green).
 */
export function weakestStatus(findings: readonly ContinuityFinding[]): ContinuityStatus {
  const severity: Record<ContinuityStatus, number> = { pass: 0, not_checked: 1, warn: 2, fail: 3 };
  return findings.reduce<ContinuityStatus>(
    (worst, finding) => (severity[finding.status] > severity[worst] ? finding.status : worst),
    "pass",
  );
}

/** First finding that needs creator attention: the first fail, else the first warn. */
export function firstFailingFinding(result: ContinuityResult): ContinuityFinding | null {
  return (
    result.findings.find((finding) => finding.status === "fail") ??
    result.findings.find((finding) => finding.status === "warn") ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Row + summary shapes for the report view                            */
/* ------------------------------------------------------------------ */

export interface ContinuityReportRow {
  /** Stable shot id (also the DOM hook, `data-shot-id`). */
  shotId: string;
  /** Human row label, matching the storyboard, e.g. "Shot S01". */
  shotLabel: string;
  /** Where the creator fixes this shot (storyboard). Null = no link. */
  shotHref: string | null;
  /** A shot can only be re-rolled where an anchor exists (spec 11 §8). */
  hasAnchor: boolean;
  /** Frozen engine result for this shot (`checkContinuity` output). */
  result: ContinuityResult;
  /** 1-based scene position (storyboard numbering); null without a scene. */
  sceneNumber?: number | null;
  sceneTitle?: string | null;
  selectedTakeId?: string | null;
  /** Targeted repair lines (spec 11 §9) derived from the same engine input; empty when nothing fails. */
  repairs?: readonly RepairGuidance[];
}

/** Status counts, exactly the frozen `summarizeContinuity` return shape. */
export interface ContinuitySummary {
  pass: number;
  warn: number;
  fail: number;
  notChecked: number;
}

/** View-level fallback counts when a lane hasn't called the engine's `summarizeContinuity`. */
export function summarizeRowStatuses(rows: readonly ContinuityReportRow[]): ContinuitySummary {
  const summary: ContinuitySummary = { pass: 0, warn: 0, fail: 0, notChecked: 0 };
  for (const row of rows) {
    if (row.result.status === "pass") summary.pass += 1;
    else if (row.result.status === "warn") summary.warn += 1;
    else if (row.result.status === "fail") summary.fail += 1;
    else summary.notChecked += 1;
  }
  return summary;
}
