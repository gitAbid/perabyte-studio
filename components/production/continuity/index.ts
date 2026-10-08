/**
 * Continuity UI (spec 11) — shared with any lane.
 *
 * `ContinuityChip` is the compact storyboard badge: pass W2-A's
 * `checkContinuity(shot)` return straight in as `result`.
 * `ContinuityReportView` is the production-level report, with `RerollButton`
 * as its client island for continuity-guided take re-rolls. The result types
 * are the frozen engine types from `@/lib/production/continuity`, re-exported
 * here (never redefined) for convenience.
 */
export {
  BASE_CONTINUITY_ASPECTS,
  CONTINUITY_STATUS_PHRASE,
  firstFailingFinding,
  labelForAspect,
  summarizeRowStatuses,
  weakestStatus,
  type ContinuityReportRow,
  type ContinuitySummary,
} from "./continuity-model";
export type {
  ContinuityAspect,
  ContinuityFinding,
  ContinuityResult,
  ContinuityStatus,
} from "@/lib/production/continuity";
export { ContinuityChip, type ContinuityChipProps } from "./continuity-chip";
export { ContinuityReportView, type ContinuityReportViewProps } from "./continuity-report-view";
export { RerollButton, type RerollButtonProps } from "./reroll-button";
