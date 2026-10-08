import type { ApprovalState } from "@/lib/production/contracts";
import { Badge } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* ApprovalBadge — CONTRACTS-FROZEN C8 / UX spec §7                    */
/* ------------------------------------------------------------------ */
/* Calm, color-coded approval state. PeraByte (the AI) may recommend,  */
/* but only the creator approves — the screen-reader note says so so   */
/* the approval rule is never color-only.                              */

const TONES: Record<ApprovalState, "neutral" | "primary" | "success"> = {
  draft: "neutral",
  recommended: "primary",
  approved: "success",
};

const LABELS: Record<ApprovalState, string> = {
  draft: "Draft",
  recommended: "Recommended",
  approved: "Approved",
};

const NOTES: Record<ApprovalState, string> = {
  draft: "Not reviewed yet. PeraByte may recommend, but only you approve.",
  recommended: "PeraByte recommends this take. AI may recommend, but only you approve.",
  approved: "You approved this. PeraByte may recommend, but only you approve.",
};

export interface ApprovalBadgeProps {
  /** Frozen approval vocabulary (CONTRACTS-FROZEN C8). */
  state: ApprovalState;
  /** Stable test id for this stateful surface (feature.entity.action). */
  testId?: string;
  className?: string;
}

export function ApprovalBadge({
  state,
  testId = "approval.state",
  className = "",
}: ApprovalBadgeProps) {
  return (
    <span data-testid={testId} className={`inline-flex items-center ${className}`}>
      <Badge tone={TONES[state]}>
        {LABELS[state]}
        <span className="sr-only">. {NOTES[state]}</span>
      </Badge>
    </span>
  );
}
