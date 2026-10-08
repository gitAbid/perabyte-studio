/**
 * Small shared feedback chrome for the storyboard screen (spec 03 §3, §6): named loading,
 * human error/blocked alerts (provider detail stays in the envelope line), polite status
 * notes and the client-side gate reason list. Presentational only — no data access.
 */

import { Button } from "@/components/ui";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";
import type { DecisionIssue } from "@/components/production/storyboard";
import { formatEnvelope } from "@/components/production/project-canon";

export function LoadingPanel({ label, testId }: { label: string; testId: string }) {
  return (
    <div role="status" data-testid={testId} className="rounded-[12px] border border-border bg-raised px-6 py-14 text-center text-sm text-muted">
      {label}
    </div>
  );
}

export function ErrorAlert({ view, lead, testId }: { view: ErrorEnvelopeView; lead: string; testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Your work is unchanged — nothing was lost. You can retry.</p>
    </div>
  );
}

export function BlockedAlert({ view, lead, testId }: { view: ErrorEnvelopeView; lead: string; testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Nothing was started. The server owns the entitlement decision; adjust the request or configure the provider.</p>
    </div>
  );
}

export function StatusNote({ lines, testId, tone = "info" }: { lines: readonly string[]; testId?: string; tone?: "info" | "success" }) {
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid={testId} className={`rounded-[8px] border px-3.5 py-3 ${tone === "success" ? "border-success/30 bg-success-soft/60" : "border-primary/25 bg-primary-soft/60"}`}>
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line} className="text-[13px] leading-snug text-ink">{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function GateReasons({ reasons, testId }: { reasons: readonly DecisionIssue[]; testId: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul role="status" data-testid={testId} className="space-y-1 rounded-[8px] border border-border bg-surface px-3 py-2.5">
      {reasons.map((reason) => (
        <li key={`${reason.code}-${reason.message}`} className="text-[12.5px] leading-snug text-ink-soft">
          <span className="font-mono text-[11px] text-muted">{reason.code}</span>
          <span className="ml-1.5">{reason.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function RetryRow({ onRetry, label = "Try again", testId }: { onRetry: () => void; label?: string; testId?: string }) {
  return (
    <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} data-testid={testId}>
      {label}
    </Button>
  );
}
