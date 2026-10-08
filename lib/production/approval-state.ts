import { ApprovalStateSchema, type ApprovalState } from "./contracts";
import { ProductionApplicationError } from "./errors";

export { ApprovalStateSchema, type ApprovalState };

/**
 * Approval-state derivation (CONTRACTS-FROZEN C8, spec 02 §7). Approval state is derived from
 * evidence, never stored: an explicit human approval record (created only by
 * `CreateApprovalCommand`) raises a target to `approved`; a rejection or supersede knocks it
 * back to `draft`; an AI-written `recommendedAt` alone shows `recommended`. Viewing or
 * consuming an artifact never approves anything.
 *
 * Precedence: rejection/supersede (fail-safe to `draft`) -> explicit `approved` ->
 * `recommendedAt` set -> `draft`.
 */

/** Structural input: `approval` accepts any record carrying an approval `decision` (e.g. a full `Approval`). */
export interface ApprovalStateInput {
  approval?: Readonly<{ decision: "approved" | "rejected" }> | null;
  recommendedAt?: number | null;
  rejected?: boolean;
}

/**
 * Derives the approval state for one artifact from its latest evidence.
 * - `approval.decision === "rejected"`, or the `rejected` supersede flag, returns `draft`
 *   (a rejected or superseded artifact is back to draft even if it was recommended before).
 * - Otherwise `approval.decision === "approved"` returns `approved`.
 * - Otherwise a set (non-null, non-undefined) `recommendedAt` returns `recommended`.
 * - Otherwise `draft`.
 * Throws INVALID_INPUT for a decision outside the frozen vocabulary or a non-UTC-millis
 * `recommendedAt`; garbage evidence must fail closed, never silently downgrade.
 */
export function deriveApprovalState(input: ApprovalStateInput): ApprovalState {
  const approval = input?.approval ?? null;
  if (approval !== null && (typeof approval !== "object" || (approval.decision !== "approved" && approval.decision !== "rejected"))) {
    throw new ProductionApplicationError("INVALID_INPUT", `Approval decision must be "approved" or "rejected", received ${String((approval as { decision?: unknown } | null)?.decision)}.`);
  }
  const recommendedAt = input?.recommendedAt ?? null;
  if (recommendedAt !== null && (!Number.isSafeInteger(recommendedAt) || recommendedAt < 0)) {
    throw new ProductionApplicationError("INVALID_INPUT", `recommendedAt must be a nonnegative safe integer UTC millis value, received ${String(input?.recommendedAt)}.`);
  }
  if (approval?.decision === "rejected" || input?.rejected === true) return "draft";
  if (approval?.decision === "approved") return "approved";
  if (recommendedAt !== null) return "recommended";
  return "draft";
}
