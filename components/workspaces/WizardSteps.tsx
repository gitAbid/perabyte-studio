"use client";

/**
 * Shared wizard chrome for creation flows — the same visual step treatment as
 * the Character Studio wizard (components/character/CharacterSteps.tsx:
 * numbered circles that tick off, bold step headings, Back/Next footer bar,
 * compact review cards) so every multi-step form in the app reads as one
 * wizard. Purely presentational: all state and behavior stay with the caller.
 */

import type { ReactNode } from "react";
import { useId } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Button } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* Step indicator                                                      */
/* ------------------------------------------------------------------ */

export function WizardSteps({
  steps,
  current,
  maxVisited,
  onStepClick,
  ariaLabel,
}: {
  steps: readonly string[];
  /** 1-based current step. */
  current: number;
  /** Highest step reached this session; only visited steps are clickable. */
  maxVisited: number;
  onStepClick: (step: number) => void;
  ariaLabel: string;
}) {
  return (
    <ol aria-label={ariaLabel} className="flex w-full items-center gap-2 sm:gap-3">
      {steps.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        const reachable = step <= maxVisited && !active;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 last:flex-none">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onStepClick(step)}
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 text-left ${
                reachable ? "cursor-pointer" : "cursor-default"
              }`}
            >
              <span
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition-colors ${
                  done
                    ? "bg-primary-strong text-white"
                    : active
                      ? "bg-primary-strong text-white ring-4 ring-primary-soft"
                      : "bg-surface-2 text-muted"
                }`}
              >
                {done ? <Icon name="check" size={13} /> : step}
              </span>
              <span
                className={`hidden truncate text-[13px] font-semibold sm:block ${
                  active ? "text-ink" : done ? "text-ink-soft" : "text-muted"
                }`}
              >
                {label}
              </span>
            </button>
            {step < steps.length && (
              <span
                aria-hidden
                className={`h-px flex-1 ${done ? "bg-primary/40" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Step heading                                                        */
/* ------------------------------------------------------------------ */

export function WizardStepHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <h2 className="text-[19px] font-extrabold tracking-[-0.02em] text-ink">
        {title}
      </h2>
      <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Back / Next footer bar                                              */
/* ------------------------------------------------------------------ */

export function WizardStepNav({
  left,
  onNext,
  nextLabel,
  nextIcon,
  nextType = "button",
  nextDisabled = false,
  nextLoading = false,
  reason,
  nextTestId,
}: {
  /** Left slot — the Back button, or anything else (e.g. a Cancel link). */
  left?: ReactNode;
  /** Click handler for "button"-type nexts; omit for type="submit" so the
   * surrounding form's onSubmit stays the single submit path. */
  onNext?: () => void;
  nextLabel: string;
  nextIcon?: IconName;
  nextType?: "button" | "submit";
  nextDisabled?: boolean;
  nextLoading?: boolean;
  /** Shown instead of a click when the step is invalid and Next is disabled. */
  reason?: string;
  nextTestId: string;
}) {
  // The reason is announced with the disabled button via describedby, since a
  // disabled control is not focusable and its neighbor text is otherwise easy
  // to miss for assistive tech.
  const reasonId = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      {left ?? <span aria-hidden />}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {nextDisabled && reason ? (
          <p id={reasonId} className="text-[12px] text-muted">{reason}</p>
        ) : null}
        <Button
          type={nextType}
          iconRight={nextIcon}
          onClick={onNext}
          disabled={nextDisabled}
          loading={nextLoading}
          aria-describedby={nextDisabled && reason ? reasonId : undefined}
          data-testid={nextTestId}
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review summary pieces                                               */
/* ------------------------------------------------------------------ */

export function WizardReviewCard({
  title,
  onEdit,
  editLabel,
  children,
}: {
  title: string;
  /** When given, an Edit link that jumps back to the owning wizard step. */
  onEdit?: () => void;
  editLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[16px] border border-border bg-raised p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13.5px] font-bold text-ink">{title}</h3>
        {onEdit ? (
          <Button
            variant="text"
            size="sm"
            icon="pen"
            onClick={onEdit}
            aria-label={editLabel ?? `Edit ${title.toLowerCase()}`}
          >
            Edit
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 divide-y divide-border/70">{children}</div>
    </section>
  );
}

export function WizardReviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[12.5px] text-muted">{label}</span>
      <span className="min-w-0 text-right text-[12.5px] font-semibold text-ink">
        {children}
      </span>
    </div>
  );
}
