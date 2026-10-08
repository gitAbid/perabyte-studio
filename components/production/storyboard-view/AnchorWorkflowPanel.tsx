"use client";

/**
 * AnchorWorkflowPanel — the explicit anchor generation flow (spec 09 §5, §8; UX spec 03 §3).
 *
 * Two phases, both explicit: first a free cost check (a quote creates no job and spends
 * nothing), then a CostEstimateCard confirm that actually enqueues. The summary lines come
 * from the frozen buildAnchorGenerationCommand derivation, so the creator always reads what
 * will be generated before spending money (UX spec 03 §7). Batch failures never touch
 * existing approved anchors (spec 09 §8) — each shot enqueues independently and reports its
 * own outcome.
 */

import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { CostEstimateCard } from "@/components/production/primitives/cost";
import { BlockedAlert, ErrorAlert, GateReasons, StatusNote } from "./feedback";
import { enqueueAnchor, requestAnchorQuote } from "./client";
import { summarizeQuotes, type AnchorTargetView } from "./view-model";
import type { ProductionQuote } from "@/lib/production/contracts";
import type { DecisionIssue } from "@/components/production/storyboard";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";

export interface AnchorWorkflowPanelProps {
  projectId: string;
  /** Human scope line, e.g. "Scene 2 — Strange Footprints" or "Shot shot_3". */
  scopeLabel: string;
  /** Prepared targets: a resolved generation command per shot, or the reason it cannot resolve. */
  targets: readonly AnchorTargetView[];
  /** Shared client-side gate reasons (approval chain, pending job); the server remains the truth. */
  gateReasons: readonly DecisionIssue[];
  /** Called after the enqueue round finishes so the parent can reload the read model. */
  onDone: () => void;
  /** Test id base, e.g. "storyboard.scene.generate" → ".check", ".cost.confirm", ".results". */
  testIdBase: string;
  checkLabel?: string;
}

type QuotedTarget = { target: AnchorTargetView; quote: ProductionQuote };

type PanelPhase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "ready"; quoted: QuotedTarget[] }
  | { kind: "enqueuing"; quoted: QuotedTarget[] }
  | { kind: "done"; results: EnqueueOutcome[] }
  | { kind: "blocked"; view: ErrorEnvelopeView }
  | { kind: "failed"; view: ErrorEnvelopeView };

type EnqueueOutcome =
  | { label: string; ok: true; jobId: string; jobStatus: string }
  | { label: string; ok: false; message: string };

export function AnchorWorkflowPanel({
  projectId,
  scopeLabel,
  targets,
  gateReasons,
  onDone,
  testIdBase,
  checkLabel,
}: AnchorWorkflowPanelProps) {
  const [phase, setPhase] = useState<PanelPhase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);

  const runnable = targets.filter((target) => target.command.ok);
  const blocked = targets.filter((target) => !target.command.ok);
  const busy = phase.kind === "quoting" || phase.kind === "enqueuing";
  const gateOpen = gateReasons.length === 0 && runnable.length > 0;

  async function checkCost() {
    if (!gateOpen || busy) return;
    setNotice(null);
    setPhase({ kind: "quoting" });
    const quoted: QuotedTarget[] = [];
    let firstFailure: { view: ErrorEnvelopeView; blocked: boolean } | null = null;
    for (const target of runnable) {
      const command = target.command.ok ? target.command.draft : null;
      if (!command) continue;
      const result = await requestAnchorQuote({ projectId, shotRevisionId: command.shotRevisionId, renderSettings: command.renderSettings });
      if (result.ok) quoted.push({ target, quote: result.quote });
      else if (firstFailure === null) firstFailure = { view: result.view, blocked: result.blocked };
    }
    if (quoted.length === 0) {
      setPhase(firstFailure?.blocked
        ? { kind: "blocked", view: firstFailure.view }
        : { kind: "failed", view: firstFailure?.view ?? {
            code: "UNKNOWN_RESPONSE",
            message: "No cost quote could be requested for any shot in this batch.",
            requestId: "unavailable",
            action: "Retry the cost check; if it repeats, inspect the local server logs.",
            retryable: true,
            status: null,
            shape: "unparseable",
          } });
      return;
    }
    if (firstFailure) {
      setNotice(`Cost check missed ${runnable.length - quoted.length} of ${runnable.length} shot${runnable.length === 1 ? "" : "s"} — those are left out of this batch.`);
    }
    setPhase({ kind: "ready", quoted });
  }

  async function startGenerating() {
    if (phase.kind !== "ready" || busy) return;
    const { quoted } = phase;
    setPhase({ kind: "enqueuing", quoted });
    const results: EnqueueOutcome[] = [];
    for (const { target, quote } of quoted) {
      const command = target.command.ok ? target.command.draft : null;
      if (!command) continue;
      const outcome = await enqueueAnchor({
        projectId,
        shotId: target.shotId,
        shotRevisionId: command.shotRevisionId,
        quoteId: quote.id,
        renderSettings: command.renderSettings,
      });
      results.push(outcome.ok
        ? { label: target.label, ok: true, jobId: outcome.jobId, jobStatus: outcome.jobStatus }
        : { label: target.label, ok: false, message: `${outcome.view.code} — ${outcome.view.message}` });
    }
    setPhase({ kind: "done", results });
    onDone();
  }

  function decline() {
    setPhase({ kind: "idle" });
    setNotice("Nothing was started — the cost check expires on its own.");
  }

  const quotedNow = phase.kind === "ready" || phase.kind === "enqueuing" ? phase.quoted : [];
  const totals = summarizeQuotes(quotedNow.map(({ target, quote }) => ({ label: target.label, quote })));

  return (
    <div data-testid={testIdBase} className="rounded-[10px] border border-border bg-surface p-3.5">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Generate anchors — {scopeLabel}</p>

      <div className="mt-2 space-y-1.5" data-testid={`${testIdBase}.plan`}>
        {runnable.map((target) => (
          <p key={target.shotRevisionId} className="text-[13px] leading-snug text-ink">
            <span className="font-semibold">{target.label}</span>
            <span className="ml-1.5">{target.command.ok ? target.command.draft.summary : ""}</span>
          </p>
        ))}
        {blocked.map((target) => (
          <p key={target.shotRevisionId} role="note" className="text-[12.5px] leading-snug text-warning">
            <span className="font-semibold">{target.label}</span>
            <span className="ml-1.5">can’t generate yet — {target.command.ok ? "" : target.command.reason}</span>
          </p>
        ))}
        {runnable.length === 0 && blocked.length === 0 ? (
          <p className="text-[13px] text-muted">No shots need anchors right now.</p>
        ) : null}
      </div>

      <GateReasons reasons={gateReasons} testId={`${testIdBase}.gates`} />

      {phase.kind === "idle" || phase.kind === "quoting" ? (
        runnable.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon="sparkle"
              disabled={!gateOpen || busy}
              loading={phase.kind === "quoting"}
              onClick={() => void checkCost()}
              data-testid={`${testIdBase}.check`}
            >
              {checkLabel ?? (runnable.length === 1 ? "Check the cost of one anchor" : `Check the cost of ${runnable.length} anchors`)}
            </Button>
            {!gateOpen && gateReasons.length === 0 ? (
              <span className="text-[12px] text-muted">Every shot here already has an approved anchor.</span>
            ) : null}
            <span className="text-[12px] text-muted">Checking the cost is free — nothing is generated until you confirm.</span>
          </div>
        ) : null
      ) : null}

      {phase.kind === "ready" ? (
        totals.available ? (
          <div className="mt-3">
            <CostEstimateCard
              itemCount={quotedNow.length}
              itemNoun="anchor"
              estimateMin={totals.min}
              estimateMax={totals.max}
              currency={totals.currency}
              qualityStrategy="balanced"
              breakdown={totals.lines}
              testIdBase={`${testIdBase}.cost`}
              confirmLabel="Start generating"
              declineLabel="Not now"
              onConfirm={() => void startGenerating()}
              onDecline={decline}
            />
          </div>
        ) : (
          <div className="mt-3 rounded-[12px] border border-border bg-raised p-4" data-testid={`${testIdBase}.cost`}>
            <p className="text-[15px] leading-[1.6] text-ink">
              This will generate {quotedNow.length} anchor{quotedNow.length === 1 ? "" : "s"}. The provider returned no cost estimate.
            </p>
            <p className="mt-1 text-[12px] text-muted">You’ll see the actual cost when it finishes.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void startGenerating()} data-testid={`${testIdBase}.cost.confirm`}>Start generating</Button>
              <Button size="sm" variant="secondary" onClick={decline} data-testid={`${testIdBase}.cost.decline`}>Not now</Button>
            </div>
          </div>
        )
      ) : null}

      {phase.kind === "enqueuing" ? (
        <p role="status" className="mt-3 text-[13px] text-ink-soft" data-testid={`${testIdBase}.progress`}>
          Starting {quotedNow.length} anchor generation{quotedNow.length === 1 ? "" : "s"}…
        </p>
      ) : null}

      {phase.kind === "done" ? (
        <div className="mt-3 space-y-2" data-testid={`${testIdBase}.results`}>
          <StatusNote
            tone="success"
            lines={phase.results
              .filter((result): result is Extract<EnqueueOutcome, { ok: true }> => result.ok)
              .map((result) => `${result.label} — queued (job ${result.jobId}, status ${result.jobStatus}).`)}
            testId={`${testIdBase}.results.queued`}
          />
          {phase.results.some((result) => !result.ok) ? (
            <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
              <ul className="space-y-1">
                {phase.results
                  .filter((result): result is Extract<EnqueueOutcome, { ok: false }> => !result.ok)
                  .map((result) => (
                    <li key={result.label} className="text-[13px] leading-snug text-ink">
                      <span className="font-semibold">{result.label}</span>
                      <span className="ml-1.5">{result.message}</span>
                    </li>
                  ))}
              </ul>
              <p className="mt-1 text-[12px] text-muted">Failed shots keep their previously approved anchor — nothing was replaced.</p>
            </div>
          ) : null}
          <p className="text-[12px] text-muted">Results appear here after the worker finishes. Reload to see the new jobs.</p>
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => setPhase({ kind: "idle" })} data-testid={`${testIdBase}.reset`}>
            Check cost again
          </Button>
        </div>
      ) : null}

      {notice ? <StatusNote lines={[notice]} testId={`${testIdBase}.notice`} /> : null}
      {phase.kind === "blocked" ? <BlockedAlert view={phase.view} lead="Generation is blocked — the server refused the cost check." testId={`${testIdBase}.blocked`} /> : null}
      {phase.kind === "failed" ? <ErrorAlert view={phase.view} lead="The cost check could not be completed." testId={`${testIdBase}.error`} /> : null}

      {phase.kind !== "idle" && phase.kind !== "quoting" ? (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-muted">
          <Badge tone="neutral">{phase.kind}</Badge>
          Nothing is generated without the confirm step above.
        </p>
      ) : null}
    </div>
  );
}
