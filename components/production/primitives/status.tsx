"use client";

/**
 * Long-action status primitives for the generation flow (spec 03 §3; contracts C12).
 *
 * Every long-running action must visibly transition Ready → Queued → Running →
 * Completed / Failed, with a human-readable stage, cancel only while it is
 * safe, retry on failure, and a cost line when known. These components render
 * exactly that, feature-agnostically: the lane owns the job state machine and
 * passes values in; cancel/retry are optional callbacks and nothing here
 * fetches or mutates by itself.
 *
 * Marked "use client" for the optional cancel/retry buttons; JobProgress and
 * callback-less GenerationStatus are plain render output, so lanes can also
 * use them from server components as long as no function props are passed.
 */

import { Icon, type IconName } from "@/components/Icon";
import { Badge, Button } from "@/components/ui";

/** The universal long-action phases (spec 03 §3). */
export type GenerationPhase = "ready" | "queued" | "running" | "completed" | "failed";

export type GenerationStatusProps = {
  phase: GenerationPhase;
  /** Human-readable stage line, e.g. "Composing frame 2 of 4". Never jargon. */
  stage?: string;
  /** Current item where possible, e.g. "Scene 04 — Moonlit bridge". */
  currentItem?: string;
  /** Specific, human failure reason (spec 03 §6); provider detail stays in diagnostics. */
  failureMessage?: string;
  /** Preformatted human cost line, e.g. "Estimated cost: $0.42". */
  cost?: string;
  /** Cancel affordance while queued/running; omit when cancellation is unsafe. */
  onCancel?: () => void;
  /** Retry affordance on failure. */
  onRetry?: () => void;
  cancelInFlight?: boolean;
  retryInFlight?: boolean;
  cancelDisabled?: boolean;
  retryDisabled?: boolean;
  className?: string;
  /** Root test id, e.g. "character.generation" → "character.generation.retry". */
  testId: string;
};

const PHASE_META: Record<GenerationPhase, { label: string; tone: "neutral" | "primary" | "success" | "danger"; icon: IconName; stage: string }> = {
  ready: { label: "Ready", tone: "neutral", icon: "clock", stage: "Ready when you are." },
  queued: { label: "Queued", tone: "primary", icon: "clock", stage: "Waiting for a free slot…" },
  running: { label: "Running", tone: "primary", icon: "sparkle", stage: "Generating…" },
  completed: { label: "Completed", tone: "success", icon: "check", stage: "Done." },
  failed: { label: "Failed", tone: "danger", icon: "alert", stage: "This generation didn't finish." },
};

/**
 * Compact status card for one generation. Announces stage changes politely,
 * failures assertively (role="alert"), and never shows a spinner without a
 * named state.
 */
export function GenerationStatus({
  phase,
  stage,
  currentItem,
  failureMessage,
  cost,
  onCancel,
  onRetry,
  cancelInFlight = false,
  retryInFlight = false,
  cancelDisabled = false,
  retryDisabled = false,
  className = "",
  testId,
}: GenerationStatusProps) {
  const meta = PHASE_META[phase];
  const cancellable = (phase === "queued" || phase === "running") && onCancel;
  const retryable = phase === "failed" && onRetry;

  return (
    <div
      data-testid={testId}
      className={`rounded-[12px] border p-4 ${
        phase === "failed"
          ? "border-danger/40 bg-danger-soft/40"
          : "border-border bg-raised"
      } ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* Badge owns a fixed prop shape (no passthrough), so the test id
                lives on this wrapper. The phase icon lives in the stage line. */}
            <span data-testid={`${testId}.phase`}>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </span>
            {cost && (
              <span data-testid={`${testId}.cost`} className="text-[12px] text-muted">
                {cost}
              </span>
            )}
          </div>
          <p
            role="status"
            data-testid={`${testId}.stage`}
            className="flex items-center gap-1.5 text-[13px] font-medium text-ink-soft"
          >
            <Icon
              name={meta.icon}
              size={14}
              aria-hidden="true"
              className={phase === "running" ? "animate-pulse" : undefined}
            />
            {stage ?? meta.stage}
          </p>
          {currentItem && (
            <p className="text-[12px] text-muted">{currentItem}</p>
          )}
        </div>
        {(cancellable || retryable) && (
          <div className="flex shrink-0 gap-2">
            {cancellable && (
              <Button
                variant="ghost"
                size="sm"
                icon="close"
                loading={cancelInFlight}
                disabled={cancelDisabled}
                onClick={onCancel}
                data-testid={`${testId}.cancel`}
              >
                Cancel
              </Button>
            )}
            {retryable && (
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                loading={retryInFlight}
                disabled={retryDisabled}
                onClick={onRetry}
                data-testid={`${testId}.retry`}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>

      {phase === "failed" && (
        <div
          role="alert"
          data-testid={`${testId}.failure`}
          className="mt-3 rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3"
        >
          <p className="text-[13px] font-bold text-ink">
            This generation didn't finish.
          </p>
          <p className="mt-1 text-[13px] leading-snug text-ink">
            {failureMessage ??
              "Nothing was lost — you can retry the same generation or start a new one."}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* JobProgress                                                         */
/* ------------------------------------------------------------------ */

export type JobProgressProps = {
  /** Human stage label, e.g. "Rendering scene 4". */
  label: string;
  /** 0–100 for a determinate bar; omit for an indeterminate pulse. */
  percent?: number;
  /** Current item where possible, e.g. "Frame 12 of 48". */
  currentItem?: string;
  className?: string;
  testId?: string;
};

/**
 * Determinate or indeterminate progress with a named stage label — the
 * full-width sibling of components/RenderProgress.tsx. Indeterminate mode
 * keeps the named state (spec 03 §3: never an unnamed spinner).
 */
export function JobProgress({
  label,
  percent,
  currentItem,
  className = "",
  testId,
}: JobProgressProps) {
  const determinate = percent !== undefined;
  const clamped = determinate ? Math.min(100, Math.max(0, Math.round(percent))) : null;

  return (
    <div role="status" data-testid={testId} className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-soft">{label}</p>
        {clamped !== null && (
          <span className="text-[12px] tabular-nums text-muted">{clamped}%</span>
        )}
      </div>
      {currentItem && <p className="text-[12px] text-muted">{currentItem}</p>}
      <div
        role={determinate ? "progressbar" : undefined}
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? clamped ?? 0 : undefined}
        className="h-1 overflow-hidden rounded-full bg-ink/10"
      >
        {determinate ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${clamped ?? 0}%` }}
          />
        ) : (
          <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
        )}
      </div>
    </div>
  );
}
