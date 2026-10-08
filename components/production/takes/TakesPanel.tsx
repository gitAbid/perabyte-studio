"use client";

/**
 * TakesPanel — the explicit take flow for one shot (spec 10 §5–§8, UX spec 03 §3/§4/§7).
 *
 * Mirrors the accepted AnchorWorkflowPanel discipline: every spend is two explicit phases —
 * a free cost check (a quote creates no job and spends nothing) then a confirm that actually
 * enqueues — and every selection is an explicit creator action against the existing selection
 * route. The three retry semantics delegate to the frozen Wave-0 derivations
 * (lib/production/job-retry.ts via lib/production/takes.ts): Try Again replays the identical
 * request under a retry idempotency key, Different Take draws an explicit new seed, Change
 * Something carries the creator's direction note. Creator language stays plain — no params
 * hashes or provider ids in the primary UI. A failed take never removes the selected take;
 * failed batch shots keep their selected takes and approved anchors.
 */

import { useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { ApprovalBadge } from "@/components/production/primitives/approval";
import { CostEstimateCard } from "@/components/production/primitives/cost";
import { MediaPreview, VersionStrip } from "@/components/production/primitives/media";
import { NaturalLanguageChangeBox } from "@/components/production/primitives/change";
import { BatchCostGate } from "@/components/production/cost-preflight/batch-cost-gate";
import type {
  AnchorCandidate, Approval, ProductionJob, ProductionQuote, ShotRevision, Take,
} from "@/lib/production/contracts";
import { PRODUCTION_MODEL_BASELINE } from "@/lib/providers/production/sogni-h3";
import { baselineProductionModelOptions, parseProductionModelsPayload, type DecisionIssue } from "@/components/production/storyboard";
import type { MotionSettings } from "@/lib/production/takes";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";
import { formatEnvelope } from "@/components/production/project-canon";
import { enqueueTake, freshTakeIdempotencyKey, requestTakeQuote, selectTake } from "./client";
import {
  batchEstimateRequest, deriveTakeRows, jobById, panelTakeMotion, recommendedTakeId, summarize,
  takeCommandForShot, takeEligibilitySets, takeGenerationGateReasons, takeRetryCommandForTake,
  takeRetryGateReason, takeSummaryLine, takeVersionThumbs,
  type TakeBatchTarget, type TakeRowView,
} from "./view-model";
import type { TakeRetryDraft } from "@/lib/production/takes";

export interface TakesPanelProps {
  projectId: string;
  /** Route-level shot id the take routes verify (the URL-level identity). */
  shotId: string;
  /** The current shot revision (its motion intent and frame target bind every take). */
  shot: ShotRevision;
  /** The approved anchor takes ride on, with its current human approval id (null when missing). */
  approvedAnchor: { anchor: AnchorCandidate; approvalId: string | null } | null;
  /** Read-model slices for this shot: take history, jobs, and approval records. */
  takeHistory: readonly Take[];
  jobs: readonly ProductionJob[];
  approvals: readonly Approval[];
  /** Current take selection pin from the read model. */
  selectedTakeId: string | null;
  /** The selection CAS version carried exactly as read, never guessed. */
  selectionVersion: number;
  /** Project profile aspect; take motion must match it (server rule). */
  aspect: "9:16" | "16:9";
  /** Shared client-side gate reasons (story/plan/animatic approval chain, pending jobs). */
  gateReasons?: readonly DecisionIssue[];
  /** Shots with an approved anchor for the batch action; omit to hide "Animate all anchored shots". */
  batchTargets?: readonly TakeBatchTarget[];
  /** Called after any successful mutation so the parent can reload the read model. */
  onChanged?: () => void;
  /** Human scope line, e.g. "Shot 03B — Luna close-up". */
  scopeLabel?: string;
  /** Root test id base; defaults to "takes". */
  testIdBase?: string;
}

type FlowKind = "generate" | "tryAgain" | "differentTake" | "changeSomething";

type PendingFlow =
  | { target: "generate"; label: string; shotRevisionId: string; anchorId: string; approvalId: string; motion: MotionSettings }
  | { target: "retry"; label: string; draft: TakeRetryDraft };

type FlowPhase =
  | { kind: "quoting" }
  | { kind: "ready"; quote: ProductionQuote }
  | { kind: "enqueuing"; quote: ProductionQuote }
  | { kind: "done"; ok: boolean; lines: string[] }
  | { kind: "blocked"; view: ErrorEnvelopeView }
  | { kind: "failed"; view: ErrorEnvelopeView };

type ActiveFlow = { kind: FlowKind; phase: FlowPhase; pending: PendingFlow } | null;

type BatchOutcome = { label: string; ok: boolean; message: string };

const FLOW_LABELS: Record<FlowKind, string> = {
  generate: "New take",
  tryAgain: "Try again",
  differentTake: "Different take",
  changeSomething: "Your direction",
};

const RETRY_HELP: Record<"tryAgain" | "differentTake", string> = {
  tryAgain: "Same setup, a new result may still vary.",
  differentTake: "A deliberately new variation of the same setup.",
};

/* ------------------------------------------------------------------ */
/* Local feedback chrome (self-contained; mirrors storyboard feedback)  */
/* ------------------------------------------------------------------ */

function FailureAlert({ view, lead, testId }: { view: ErrorEnvelopeView; lead: string; testId: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Your work is unchanged — the selected take and every earlier take stay put. You can retry.</p>
    </div>
  );
}

function BlockedAlertView({ view, lead, testId }: { view: ErrorEnvelopeView; lead: string; testId: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Nothing was started. The server owns the entitlement decision.</p>
    </div>
  );
}

function NoteList({ lines, tone = "info", testId }: { lines: readonly string[]; tone?: "info" | "success" | "warning"; testId: string }) {
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid={testId} className={`rounded-[8px] border px-3.5 py-3 ${
      tone === "success" ? "border-success/30 bg-success-soft/60" : tone === "warning" ? "border-warning/40 bg-warning-soft/50" : "border-primary/25 bg-primary-soft/60"
    }`}>
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line} className="text-[13px] leading-snug text-ink">{line}</li>
        ))}
      </ul>
    </div>
  );
}

function GateList({ reasons, testId }: { reasons: readonly DecisionIssue[]; testId: string }) {
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

/* ------------------------------------------------------------------ */
/* Model catalog (one fetch per page load, baseline fallback)           */
/* ------------------------------------------------------------------ */

function useTakeModelOptions(): { loading: boolean; options: { id: string; label: string }[] } {
  const [state, setState] = useState<{ loading: boolean; options: { id: string; label: string }[] }>({
    loading: true,
    options: baselineProductionModelOptions("take"),
  });
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch("/api/production/models?kind=take", { cache: "no-store" });
        const payload: unknown = await response.json().catch(() => null);
        const options = response.ok ? parseProductionModelsPayload(payload) : null;
        if (!stopped) setState({ loading: false, options: options ?? baselineProductionModelOptions("take") });
      } catch {
        if (!stopped) setState({ loading: false, options: baselineProductionModelOptions("take") });
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);
  return state;
}

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */

export function TakesPanel({
  projectId,
  shotId,
  shot,
  approvedAnchor,
  takeHistory,
  jobs,
  approvals,
  selectedTakeId,
  selectionVersion,
  aspect,
  gateReasons,
  batchTargets,
  onChanged,
  scopeLabel,
  testIdBase = "takes",
}: TakesPanelProps) {
  const base = testIdBase;

  const [flow, setFlow] = useState<ActiveFlow>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<{ takeId: string | null; version: number } | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionLines, setSelectionLines] = useState<readonly string[]>([]);
  const [selectionError, setSelectionError] = useState<ErrorEnvelopeView | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [modelId, setModelId] = useState<string>(PRODUCTION_MODEL_BASELINE.take[0]);
  const [seedText, setSeedText] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchResults, setBatchResults] = useState<readonly BatchOutcome[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const modelCatalog = useTakeModelOptions();

  const effectiveSelection = localSelection ?? { takeId: selectedTakeId, version: selectionVersion };

  const seed = useMemo(() => {
    const trimmed = seedText.trim();
    if (trimmed.length === 0) return { seed: null as number | null, valid: true };
    if (!/^\d+$/.test(trimmed)) return { seed: null as number | null, valid: false };
    const value = Number(trimmed);
    return { seed: Number.isSafeInteger(value) ? value : null, valid: Number.isSafeInteger(value) };
  }, [seedText]);

  const eligibility = useMemo(
    () => takeEligibilitySets({ takes: takeHistory, jobs, approvals }),
    [takeHistory, jobs, approvals],
  );
  const recommendedId = useMemo(
    () => recommendedTakeId(takeHistory, eligibility),
    [takeHistory, eligibility],
  );

  const rows = useMemo(
    () => deriveTakeRows({ takes: takeHistory, jobs, approvals, selectedTakeId: effectiveSelection.takeId, recommendedId }),
    [takeHistory, jobs, approvals, effectiveSelection.takeId, recommendedId],
  );
  const historySummary = useMemo(
    () => summarize({ takes: takeHistory, jobs, selectedTakeId: effectiveSelection.takeId }),
    [takeHistory, jobs, effectiveSelection.takeId],
  );

  const inspectedRow: TakeRowView | null =
    rows.find((row) => row.id === inspectedId) ??
    rows.find((row) => row.id === effectiveSelection.takeId) ??
    rows.find((row) => row.recommended) ??
    rows[0] ??
    null;
  const inspectedJob: ProductionJob | null = inspectedRow ? jobById(jobs, inspectedRow.take.jobId) ?? null : null;

  const anchorGates = useMemo(() => takeGenerationGateReasons({ approvedAnchor }), [approvedAnchor]);
  const generationGates: readonly DecisionIssue[] = [...(gateReasons ?? []), ...anchorGates];
  const generationOpen = generationGates.length === 0 && seed.valid;

  /** A live flow (quote in flight, confirm open, enqueue running) holds every other action until confirmed, declined or reset. */
  const busy =
    selectionBusy ||
    (flow !== null && (flow.phase.kind === "quoting" || flow.phase.kind === "ready" || flow.phase.kind === "enqueuing"));
  const batchTargetsSafe = batchTargets ?? [];
  const estimateRequest = useMemo(
    () => (batchOpen ? batchEstimateRequest({ targets: batchTargetsSafe, aspect, modelId }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchOpen, batchTargets, aspect, modelId],
  );

  const quoteRange = (quote: ProductionQuote): { min: number; max: number; currency: string } | null =>
    quote.estimateMinMinor !== null && quote.estimateMaxMinor !== null && quote.currency !== null
      ? { min: quote.estimateMinMinor / 100, max: quote.estimateMaxMinor / 100, currency: quote.currency }
      : null;

  function resetFlow() {
    setFlow(null);
    setNotice(null);
  }

  /* ---------------- New take ---------------- */

  async function startGenerate() {
    if (busy || !generationOpen || !approvedAnchor?.approvalId) return;
    setNotice(null);
    setSelectionLines([]);
    const motion = panelTakeMotion({
      motionIntent: shot.motionIntent,
      targetFrames: shot.targetFrames,
      aspect,
      modelId,
      seed: seed.seed,
      directionNote: null,
    });
    const command = takeCommandForShot({ shot, anchor: approvedAnchor.anchor, motion });
    if (!command.ok) {
      setNotice(command.reason);
      return;
    }
    const pending: PendingFlow = {
      target: "generate",
      label: FLOW_LABELS.generate,
      shotRevisionId: command.draft.shotRevisionId,
      anchorId: command.draft.anchorId,
      approvalId: approvedAnchor.approvalId,
      motion: command.draft.motion,
    };
    setFlow({ kind: "generate", phase: { kind: "quoting" }, pending });
    const result = await requestTakeQuote({
      projectId,
      shotRevisionId: pending.shotRevisionId,
      anchorId: pending.anchorId,
      approvalId: pending.approvalId,
      motionSettings: pending.motion,
    });
    setFlow(result.ok
      ? { kind: "generate", phase: { kind: "ready", quote: result.quote }, pending }
      : { kind: "generate", phase: { kind: result.blocked ? "blocked" : "failed", view: result.view }, pending });
  }

  /* ---------------- Retries (Try Again / Different Take / Change Something) ---------------- */

  async function startRetry(mode: "tryAgain" | "differentTake") {
    if (busy || !inspectedRow) return;
    setNotice(null);
    setSelectionLines([]);
    if (!inspectedJob) {
      setNotice("The generation job behind this take isn't in the loaded data, so it can't be retried here.");
      return;
    }
    const draft = takeRetryCommandForTake({ job: inspectedJob, mode });
    if (!draft.ok) {
      setNotice(draft.reason);
      return;
    }
    const gate = takeRetryGateReason({ job: inspectedJob, draftMotion: draft.draft.motion, currentTargetFrames: shot.targetFrames });
    if (gate) {
      setNotice(`${gate.code} — ${gate.message}`);
      return;
    }
    await quoteAndHold({
      kind: mode,
      pending: { target: "retry", label: FLOW_LABELS[mode], draft: draft.draft },
    });
  }

  async function submitChange(instruction: string) {
    if (busy || !inspectedRow) return;
    setNotice(null);
    setSelectionLines([]);
    if (!inspectedJob) {
      setNotice("The generation job behind this take isn't in the loaded data, so your direction can't be applied here.");
      return;
    }
    const draft = takeRetryCommandForTake({ job: inspectedJob, mode: "changeSomething", directionNote: instruction });
    if (!draft.ok) {
      setNotice(draft.reason);
      return;
    }
    const gate = takeRetryGateReason({ job: inspectedJob, draftMotion: draft.draft.motion, currentTargetFrames: shot.targetFrames });
    if (gate) {
      setNotice(`${gate.code} — ${gate.message}`);
      return;
    }
    setChangeOpen(false);
    await quoteAndHold({
      kind: "changeSomething",
      pending: { target: "retry", label: FLOW_LABELS.changeSomething, draft: draft.draft },
    });
  }

  async function quoteAndHold(input: { kind: FlowKind; pending: Extract<PendingFlow, { target: "retry" }> }) {
    const draft = input.pending.draft;
    setFlow({ kind: input.kind, phase: { kind: "quoting" }, pending: input.pending });
    const result = await requestTakeQuote({
      projectId,
      shotRevisionId: draft.shotRevisionId,
      anchorId: draft.anchorId,
      approvalId: draft.anchorApprovalId,
      motionSettings: draft.motion,
    });
    setFlow(result.ok
      ? { kind: input.kind, phase: { kind: "ready", quote: result.quote }, pending: input.pending }
      : { kind: input.kind, phase: { kind: result.blocked ? "blocked" : "failed", view: result.view }, pending: input.pending });
  }

  async function confirmFlow() {
    if (!flow || flow.phase.kind !== "ready") return;
    const { pending } = flow;
    const quote = flow.phase.quote;
    setFlow({ ...flow, phase: { kind: "enqueuing", quote } });
    const result = pending.target === "generate"
      ? await enqueueTake({
          projectId,
          shotId,
          shotRevisionId: pending.shotRevisionId,
          anchorId: pending.anchorId,
          approvalId: pending.approvalId,
          quoteId: quote.id,
          idempotencyKey: freshTakeIdempotencyKey(),
          motionSettings: pending.motion,
        })
      : await enqueueTake({
          projectId,
          shotId,
          shotRevisionId: pending.draft.shotRevisionId,
          anchorId: pending.draft.anchorId,
          approvalId: pending.draft.anchorApprovalId,
          quoteId: quote.id,
          idempotencyKey: pending.draft.retry.idempotencyKey,
          motionSettings: pending.draft.motion,
          retryOf: pending.draft.retry.retryOf,
        });
    if (result.ok) {
      setFlow({
        ...flow,
        phase: {
          kind: "done",
          ok: true,
          lines: [`${pending.label} is queued (status ${result.jobStatus}). It appears in the strip above — earlier takes stay put.`],
        },
      });
      onChanged?.();
    } else {
      setFlow({ ...flow, phase: { kind: result.blocked ? "blocked" : "failed", view: result.view } });
    }
  }

  function declineFlow() {
    setFlow(null);
    setNotice("Nothing was started — the cost check expires on its own.");
  }

  /* ---------------- Explicit selection ---------------- */

  async function useThisTake(takeId: string) {
    if (busy || selectionBusy) return;
    setNotice(null);
    setSelectionError(null);
    setSelectionBusy(true);
    const result = await selectTake({
      projectId,
      shotId,
      shotRevisionId: shot.id,
      takeId,
      expectedSelectionVersion: effectiveSelection.version,
    });
    setSelectionBusy(false);
    if (result.ok) {
      setLocalSelection({ takeId: result.takeId, version: result.selectionVersion });
      setSelectionLines([
        result.changed
          ? "This take is now the one your edit and first cut use."
          : "This take was already selected.",
      ]);
      onChanged?.();
    } else {
      setSelectionError(result.view);
    }
  }

  /* ---------------- Batch animation ---------------- */

  async function runBatch() {
    const results: BatchOutcome[] = [];
    for (const target of batchTargetsSafe) {
      const motion = panelTakeMotion({
        motionIntent: target.shot.motionIntent,
        targetFrames: target.shot.targetFrames,
        aspect,
        modelId,
        seed: null,
        directionNote: null,
      });
      const quote = await requestTakeQuote({
        projectId,
        shotRevisionId: target.shot.id,
        anchorId: target.anchor.id,
        approvalId: target.approvalId,
        motionSettings: motion,
      });
      if (!quote.ok) {
        results.push({ label: target.label, ok: false, message: `${quote.view.code} — ${quote.view.message}` });
        continue;
      }
      const enqueued = await enqueueTake({
        projectId,
        shotId: target.shotId,
        shotRevisionId: target.shot.id,
        anchorId: target.anchor.id,
        approvalId: target.approvalId,
        quoteId: quote.quote.id,
        idempotencyKey: freshTakeIdempotencyKey(),
        motionSettings: motion,
      });
      results.push(enqueued.ok
        ? { label: target.label, ok: true, message: `queued (status ${enqueued.jobStatus})` }
        : { label: target.label, ok: false, message: `${enqueued.view.code} — ${enqueued.view.message}` });
    }
    setBatchResults(results);
    onChanged?.();
  }

  /* ---------------- Render ---------------- */

  const ratio = aspect === "9:16" ? "9 / 16" : "16 / 9";
  const flowReady = flow?.phase.kind === "ready" ? flow.phase : null;
  const flowQuoteRange = flowReady ? quoteRange(flowReady.quote) : null;

  return (
    <div data-testid={`${base}.panel`} className="rounded-[10px] border border-border bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Takes — {scopeLabel ?? shot.shotId}</p>
        <p data-testid={`${base}.summary`} className="text-[12px] text-muted">{takeSummaryLine(historySummary)}</p>
      </div>

      {/* Selected / inspected preview */}
      {inspectedRow ? (
        <div className="mt-3">
          <MediaPreview state={inspectedRow.thumb} ratio={ratio} fit="contain" testId={`${base}.preview`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span data-testid={`${base}.approval`}>
              <ApprovalBadge state={inspectedRow.approvalState} />
            </span>
            {inspectedRow.recommended ? (
              <span data-testid={`${base}.recommended`}>
                <Badge tone="primary">Recommended</Badge>
              </span>
            ) : null}
            {inspectedRow.directionNote ? (
              <span className="text-[12px] text-muted">Your direction: “{inspectedRow.directionNote}”</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Take history strip */}
      <div className="mt-3">
        <VersionStrip
          versions={takeVersionThumbs(rows)}
          selectedId={inspectedRow?.id ?? null}
          onSelect={(takeId) => setInspectedId(takeId)}
          heading="Take history"
          emptyState={{
            title: "No takes yet",
            body: "Generate the first take from the approved anchor — every take stays in this history.",
          }}
          testId={`${base}.strip`}
        />
      </div>

      {/* Inspected take controls */}
      {inspectedRow ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={inspectedRow.selected ? "secondary" : "primary"}
              icon={inspectedRow.selected ? "check" : undefined}
              disabled={selectionBusy || busy || !inspectedRow.selectable}
              title={inspectedRow.selectable ? undefined : inspectedRow.selectableReason ?? undefined}
              onClick={() => void useThisTake(inspectedRow.id)}
              data-testid={`${base}.select`}
            >
              {inspectedRow.selected ? "Selected take" : "Use This Take"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              disabled={busy || !inspectedJob}
              title="Try again: same setup, a new result may still vary."
              onClick={() => void startRetry("tryAgain")}
              data-testid={`${base}.retry.again`}
            >
              Try Again
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="sparkle"
              disabled={busy || !inspectedJob}
              title="Different take: a deliberately new variation of the same setup."
              onClick={() => void startRetry("differentTake")}
              data-testid={`${base}.retry.different`}
            >
              Different Take
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="pen"
              disabled={busy || !inspectedJob}
              title="Ask for a change in your own words — it becomes a new take; your shot notes stay untouched."
              onClick={() => setChangeOpen((open) => !open)}
              data-testid={`${base}.change.toggle`}
            >
              Change Something
            </Button>
          </div>
          <p className="text-[12px] leading-snug text-muted">
            Try Again — {RETRY_HELP.tryAgain} Different Take — {RETRY_HELP.differentTake} Change Something — your words become a new take.
          </p>
          {!inspectedRow.selectable ? (
            <p className="text-[12px] leading-snug text-muted">{inspectedRow.selectableReason}</p>
          ) : null}
          {inspectedRow.phase === "failed" ? (
            <p className="text-[12px] leading-snug text-muted">
              This take didn&apos;t finish — your selected take stays untouched.
            </p>
          ) : null}

          {changeOpen ? (
            <div className="pt-1">
              <NaturalLanguageChangeBox
                label="Ask for a change"
                placeholder="Make Luna step closer and look nervous…"
                submitLabel="Apply as New Take"
                maxChars={2000}
                busy={busy}
                onSubmit={(instruction) => void submitChange(instruction)}
                testIdBase={`${base}.change`}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-muted">
          No takes yet. {approvedAnchor ? "Generate the first take below — every take stays in the history." : "This shot needs an approved anchor before a take can be generated."}
        </p>
      )}

      {/* Selection feedback */}
      {selectionLines.length > 0 ? <NoteList lines={selectionLines} tone="success" testId={`${base}.selection.status`} /> : null}
      {selectionError ? (
        <FailureAlert view={selectionError} lead="The selection could not be saved." testId={`${base}.selection.error`} />
      ) : null}

      {/* Flow feedback (quoting / confirm / enqueue / done) */}
      {flow ? (
        <div className="mt-3 space-y-2" data-testid={`${base}.${flow.kind}.flow`}>
          {flow.phase.kind === "quoting" ? (
            <p role="status" className="text-[13px] text-ink-soft" data-testid={`${base}.${flow.kind}.status`}>
              Checking the cost of “{flow.pending.label}”… nothing runs until you confirm.
            </p>
          ) : null}
          {flow.phase.kind === "enqueuing" ? (
            <p role="status" className="text-[13px] text-ink-soft" data-testid={`${base}.${flow.kind}.status`}>
              Starting “{flow.pending.label}”…
            </p>
          ) : null}
          {flow.phase.kind === "done" ? (
            <NoteList lines={flow.phase.lines} tone="success" testId={`${base}.${flow.kind}.results`} />
          ) : null}
          {flow.phase.kind === "blocked" ? (
            <BlockedAlertView view={flow.phase.view} lead="Generation is blocked — the server refused the cost check." testId={`${base}.${flow.kind}.blocked`} />
          ) : null}
          {flow.phase.kind === "failed" ? (
            <FailureAlert view={flow.phase.view} lead={`“${flow.pending.label}” could not be started.`} testId={`${base}.${flow.kind}.error`} />
          ) : null}
          {flow.phase.kind === "done" || flow.phase.kind === "blocked" || flow.phase.kind === "failed" ? (
            <Button variant="secondary" size="sm" icon="refresh" onClick={resetFlow} data-testid={`${base}.${flow.kind}.reset`}>
              Set up another take
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Cost confirm (after a successful free quote) */}
      {flowReady ? (
        flowQuoteRange ? (
          <div className="mt-3">
            <CostEstimateCard
              itemCount={1}
              itemNoun="take"
              estimateMin={flowQuoteRange.min}
              estimateMax={flowQuoteRange.max}
              currency={flowQuoteRange.currency}
              qualityStrategy="balanced"
              testIdBase={`${base}.${flow?.kind ?? "generate"}.cost`}
              confirmLabel="Start generating"
              declineLabel="Not now"
              onConfirm={() => void confirmFlow()}
              onDecline={declineFlow}
            />
          </div>
        ) : (
          <div className="mt-3 rounded-[12px] border border-border bg-raised p-4" data-testid={`${base}.${flow?.kind ?? "generate"}.cost`}>
            <p className="text-[15px] leading-[1.6] text-ink">
              This will generate one take. The provider returned no cost estimate.
            </p>
            <p className="mt-1 text-[12px] text-muted">You’ll see the actual cost when it finishes.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void confirmFlow()} data-testid={`${base}.${flow?.kind ?? "generate"}.cost.confirm`}>Start generating</Button>
              <Button size="sm" variant="secondary" onClick={declineFlow} data-testid={`${base}.${flow?.kind ?? "generate"}.cost.decline`}>Not now</Button>
            </div>
          </div>
        )
      ) : null}

      {notice ? <NoteList lines={[notice]} tone="warning" testId={`${base}.notice`} /> : null}

      {/* New take generation (motion options + free cost check) */}
      {approvedAnchor ? (
        <div className="mt-4 rounded-[10px] border border-border bg-raised p-3.5">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Generate a new take</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-soft">
              Model
              <select
                data-testid={`${base}.generate.model`}
                value={modelCatalog.loading ? "" : modelId}
                onChange={(event) => setModelId(event.target.value)}
                disabled={modelCatalog.loading || busy}
                className="h-10 rounded-[8px] border border-border-strong bg-raised px-2.5 text-sm font-medium text-ink focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
              >
                {modelCatalog.loading ? (
                  <option value="">Loading models…</option>
                ) : (
                  modelCatalog.options.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-soft">
              Seed (optional)
              <input
                data-testid={`${base}.generate.seed`}
                value={seedText}
                onChange={(event) => setSeedText(event.target.value)}
                disabled={busy}
                placeholder="Leave empty for a fresh look"
                className="h-10 rounded-[8px] border border-border-strong bg-raised px-2.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
              />
            </label>
          </div>
          {!seed.valid ? (
            <p role="status" className="mt-1.5 text-[12px] text-warning">The seed must be a whole number of zero or more.</p>
          ) : null}
          <GateList reasons={generationGates} testId={`${base}.gates`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon="sparkle"
              disabled={!generationOpen || busy}
              onClick={() => void startGenerate()}
              data-testid={`${base}.generate.check`}
            >
              Check the cost of a new take
            </Button>
            <span className="text-[12px] text-muted">
              {shot.targetFrames} frames at {aspect}. Checking the cost is free — nothing is generated until you confirm.
            </span>
          </div>
        </div>
      ) : null}

      {/* Batch animation with cost preflight */}
      {batchTargetsSafe.length > 0 ? (
        <div className="mt-3" data-testid={`${base}.batch.area`}>
          {!batchOpen ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="video"
                onClick={() => {
                  setBatchResults(null);
                  setBatchOpen(true);
                }}
                data-testid={`${base}.batch.open`}
              >
                Animate all anchored shots
              </Button>
              <span className="text-[12px] text-muted">
                {batchTargetsSafe.length} shot{batchTargetsSafe.length === 1 ? "" : "s"} with an approved anchor. The cost is checked before anything runs.
              </span>
            </div>
          ) : estimateRequest ? (
            <BatchCostGate
              projectId={projectId}
              itemCount={batchTargetsSafe.length}
              itemNoun="anchored shot"
              quoteRequest={estimateRequest}
              confirmLabel={`Animate ${batchTargetsSafe.length} shot${batchTargetsSafe.length === 1 ? "" : "s"}`}
              declineLabel="Not now"
              testIdBase={`${base}.batch`}
              onDecline={() => setBatchOpen(false)}
              onConfirm={() => runBatch()}
            />
          ) : null}
          {batchResults ? (
            <div className="mt-2 space-y-2" data-testid={`${base}.batch.results`}>
              <NoteList
                lines={batchResults.filter((result) => result.ok).map((result) => `${result.label} — ${result.message}.`)}
                tone="success"
                testId={`${base}.batch.results.queued`}
              />
              {batchResults.some((result) => !result.ok) ? (
                <NoteList
                  lines={batchResults.filter((result) => !result.ok).map((result) => `${result.label} — ${result.message}`)}
                  tone="warning"
                  testId={`${base}.batch.results.failed`}
                />
              ) : null}
              <p className="text-[12px] text-muted">
                Shots that didn’t start keep their selected take and approved anchor — nothing was replaced. Reload to see the new jobs.
              </p>
              <Button variant="secondary" size="sm" icon="refresh" onClick={() => setBatchOpen(false)} data-testid={`${base}.batch.close`}>
                Done
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
