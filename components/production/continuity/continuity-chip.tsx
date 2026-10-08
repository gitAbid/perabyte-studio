import { Icon, type IconName } from "@/components/Icon";
import type { ContinuityResult, ContinuityStatus } from "@/lib/production/continuity";
import {
  CONTINUITY_STATUS_PHRASE,
  firstFailingFinding,
  labelForAspect,
} from "./continuity-model";

/* ------------------------------------------------------------------ */
/* ContinuityChip — spec 11 §4 (chips embedded in the storyboard)      */
/* ------------------------------------------------------------------ */
/*
 * Compact, advisory continuity signal for reuse by any lane (the storyboard
 * lane imports it from `@/components/production/continuity`). Pass W2-A's
 * `checkContinuity(shot)` return straight in as `result`. Shows the status
 * color plus the first failing aspect, with the finding note as the tooltip.
 *
 * Calm by design (spec 11 §2): pass is soft green, warnings are amber, and a
 * fail is a filled amber — never a red alarm. Failures are advisory; nothing
 * here approves or rejects anything (spec 11 §8).
 */

const CHIP_STYLES: Record<ContinuityStatus, string> = {
  pass: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  fail: "bg-warning text-canvas",
  not_checked: "bg-surface-2 text-muted",
};

const CHIP_ICONS: Record<ContinuityStatus, IconName | null> = {
  pass: "check",
  warn: "alert",
  fail: "alert",
  not_checked: null,
};

export interface ContinuityChipProps {
  /** Frozen engine result — the `checkContinuity` return, passed straight through. */
  result: ContinuityResult;
  /** Stable test id for this stateful surface (feature.entity.action). */
  testId?: string;
  className?: string;
}

export function ContinuityChip({
  result,
  testId = "continuity.chip",
  className = "",
}: ContinuityChipProps) {
  const status = result.status;
  const failing = firstFailingFinding(result);

  const label =
    status === "pass"
      ? "Continuity"
      : status === "not_checked"
        ? "Not checked"
        : labelForAspect(failing?.aspect ?? "identity");

  const tooltip =
    status === "pass"
      ? "Continuity looks consistent for this shot."
      : status === "not_checked"
        ? "Continuity wasn't checked for this shot — this stays clearly marked, never green."
        : `${labelForAspect(failing?.aspect ?? "identity")}: ${failing?.note ?? "Worth a look before you continue."}`;

  const icon = CHIP_ICONS[status];
  const screenReader =
    status === "not_checked"
      ? "Continuity not checked. Nothing is wrong; the check hasn't run."
      : `Continuity ${CONTINUITY_STATUS_PHRASE[status]}${failing ? ` — ${labelForAspect(failing.aspect)}: ${failing.note}` : ""}. Advisory only; nothing is approved or rejected automatically.`;

  return (
    <span
      data-testid={testId}
      title={tooltip}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${CHIP_STYLES[status]} ${className}`}
    >
      {icon && <Icon name={icon} size={12} aria-hidden="true" className="shrink-0" />}
      <span className="truncate">{label}</span>
      <span className="sr-only">{screenReader}</span>
    </span>
  );
}
