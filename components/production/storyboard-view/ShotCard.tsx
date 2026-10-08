"use client";

/**
 * ShotCard — one shot on the storyboard (spec 09 §6): framing, duration, the anchor
 * candidate strip, the selected-anchor highlight, the approval badge and the stale badge.
 *
 * Approval is always an explicit creator action (CONTRACTS-FROZEN C8): the checklist is
 * gated exactly like the accepted anchor approval preflight, the expected hash comes only
 * from the read model's latest decision, and a candidate without one stays disabled with
 * that honest reason. Nothing here approves, selects or generates by itself.
 */

import { useMemo, useState } from "react";
import { Badge, Button, FieldShell } from "@/components/ui";
import { ApprovalBadge } from "@/components/production/primitives/approval";
import { CompareModal, VariantGrid } from "@/components/production/primitives/variants";
import { GenerationStatus } from "@/components/production/primitives/status";
import {
  APPROVAL_CHECKLISTS_VIEW, deriveApprovalCommand, deriveApprovalReadiness, latestDecisionFor,
  type ChecklistEntry,
} from "@/components/production/storyboard";
import {
  ANCHOR_CHECKLIST_LABELS, DEFAULT_ANCHOR_SETTINGS, anchorCommandForShot, deriveShotAnchorModel,
  framingLabel, jobGenerationPhase, shotDurationLine, STALE_BADGE_LABEL, STALE_REASON_TEXT,
  type ShotCardView,
} from "./view-model";
import { freshRequestId, recordApproval } from "./client";
import { AnchorWorkflowPanel } from "./AnchorWorkflowPanel";
import { ErrorAlert, GateReasons, StatusNote } from "./feedback";
import { TakesPanel } from "@/components/production/takes/TakesPanel";
import type { AnchorCandidate, Approval, ApprovalState, CanonRevision, CreateApprovalCommand } from "@/lib/production/contracts";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";

export interface ShotCardProps {
  projectId: string;
  view: ShotCardView;
  /** The project's currently selected canon revisions, for the anchor command derivation. */
  canonRevisions: readonly CanonRevision[];
  /** Shared client-side generation gate reasons for this shot. */
  gateReasons: readonly { code: string; message: string }[];
  onReload: () => void;
}

type ApproveState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "saved"; approvalId: string; created: boolean }
  | { kind: "error"; view: ErrorEnvelopeView };

const CHECKLIST_LABEL = (id: string): string => ANCHOR_CHECKLIST_LABELS[id] ?? id;

export function ShotCard({ projectId, view, canonRevisions, gateReasons, onReload }: ShotCardProps) {
  const { entry } = view;
  const shot = entry.shotRevision;
  const anchorModel = useMemo(() => deriveShotAnchorModel(entry), [entry]);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewedId, setReviewedId] = useState<string | null>(null);
  const [compareIndex, setCompareIndex] = useState<number | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [takesOpen, setTakesOpen] = useState(false);

  const reviewed: AnchorCandidate | null =
    anchorModel.views.find((view2) => view2.row.anchor.id === reviewedId)?.row.anchor ??
    anchorModel.primary;
  const reviewedApproval = reviewed ? anchorModel.views.find((view2) => view2.row.anchor.id === reviewed.id)?.approvalState ?? "draft" : "draft";

  return (
    <article
      data-testid="storyboard.shot.card"
      data-shot-id={shot.shotId}
      className={`rounded-[12px] border bg-raised p-4 ${view.stale ? "border-warning/50" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold tabular-nums text-primary">
          {view.number}
        </span>
        <span className="text-sm font-semibold text-ink">{shot.shotId}</span>
        <Badge tone="neutral">{framingLabel(shot.framing)}</Badge>
        <span className="text-[12px] tabular-nums text-muted">{shotDurationLine(shot)}</span>
        {view.stale ? (
          <span title={STALE_REASON_TEXT[view.stale.reason]} data-testid="storyboard.shot.stale" data-reason={view.stale.reason}>
            <Badge tone="warning">{STALE_BADGE_LABEL}</Badge>
          </span>
        ) : null}
        <span className="ml-auto" data-testid="storyboard.shot.approval">
          <ApprovalBadge state={reviewedApproval} testId="storyboard.shot.approval.badge" />
        </span>
      </div>

      <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">{shot.visualIntent}</p>
      {view.stale ? (
        <p role="note" className="mt-1 text-[12.5px] text-warning">
          {STALE_REASON_TEXT[view.stale.reason]} Generate a fresh anchor to catch this shot up with the story.
        </p>
      ) : null}

      <details className="mt-2.5" open>
        <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-soft">
          Anchor candidates ({anchorModel.rows.length})
        </summary>
        <div className="mt-2.5 space-y-2.5">
          {anchorModel.rows.length === 0 ? (
            <p role="status" className="rounded-[8px] border border-dashed border-border-strong bg-surface px-3.5 py-3 text-[13px] text-muted">
              No anchors yet for this shot. Generate one below — the scene’s “Generate anchors” button does every shot that needs one.
            </p>
          ) : (
            <>
              <VariantGrid
                testId={`storyboard.anchor.${shot.shotId}`}
                candidates={anchorModel.views.map((view2) => view2.candidate)}
                selectedId={anchorModel.selected?.id ?? null}
                columns={2}
                ratio="16 / 9"
                ariaLabel={`Anchor candidates for ${shot.shotId}`}
                onCompare={anchorModel.views.length > 1 ? (candidateId) => {
                  const index = anchorModel.views.findIndex((view2) => view2.row.anchor.id === candidateId);
                  if (index >= 0) setCompareIndex(index);
                } : undefined}
                cardActions={(candidate) => {
                  const index = anchorModel.views.findIndex((view2) => view2.row.anchor.id === candidate.id);
                  const isReviewed = reviewed !== null && reviewed.id === candidate.id && reviewOpen;
                  return (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="check"
                      aria-expanded={isReviewed}
                      onClick={() => {
                        setReviewedId(candidate.id);
                        setReviewOpen(true);
                      }}
                      data-testid={`storyboard.shot.review-${index}`}
                    >
                      Review
                    </Button>
                  );
                }}
              />
              <p className="text-[12px] text-muted" data-testid="storyboard.shot.selected-anchor">
                {anchorModel.selected
                  ? `Selected anchor: ${anchorModel.selected.id}${anchorModel.recommended?.id === anchorModel.selected.id ? " (also the recommended one)" : ""}.`
                  : "No anchor is selected for this shot yet."}
              </p>
            </>
          )}

          {reviewed && reviewOpen ? (
            <AnchorApprovalForm
              projectId={projectId}
              shotId={shot.shotId}
              candidate={reviewed}
              approvals={entry.approvals}
              approvalState={reviewedApproval}
              shotCurrent={view.gate.shotCurrent}
              pendingJob={view.gate.pendingMediaJob}
              onClose={() => setReviewOpen(false)}
              onReload={onReload}
            />
          ) : null}
        </div>
      </details>

      {view.pendingJobs.length > 0 ? (
        <div className="mt-3 space-y-2">
          {view.pendingJobs.map((job) => (
            <GenerationStatus
              key={job.id}
              testId="storyboard.shot.job"
              phase={jobGenerationPhase(job)}
              stage={jobGenerationPhase(job) === "running" ? "Generating the anchor frame…" : "Waiting for a free slot…"}
              currentItem={`Job ${job.id}`}
            />
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        {generateOpen ? (
          <AnchorWorkflowPanel
            projectId={projectId}
            scopeLabel={`Shot ${shot.shotId}`}
            targets={[{
              label: shot.shotId,
              shotId: shot.shotId,
              shotRevisionId: shot.id,
              command: anchorCommandForShot(shot, canonRevisions, DEFAULT_ANCHOR_SETTINGS),
            }]}
            gateReasons={gateReasons}
            onDone={onReload}
            testIdBase="storyboard.shot.generate"
            checkLabel="Check the cost of this anchor"
          />
        ) : null}
        {takesOpen ? (
          <div className="mb-3" data-testid="storyboard.shot.takes-panel">
            <TakesPanel
              projectId={projectId}
              shotId={shot.shotId}
              shot={shot}
              approvedAnchor={view.approvedAnchor}
              takeHistory={entry.takeHistory}
              jobs={view.takeJobs}
              approvals={entry.approvals}
              selectedTakeId={entry.takeSelection.takeId}
              selectionVersion={entry.takeSelection.version}
              aspect={view.aspect}
              gateReasons={gateReasons}
              onChanged={onReload}
              scopeLabel={`Shot ${shot.shotId}`}
              testIdBase="storyboard.shot.takes"
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={generateOpen ? "secondary" : "primary"}
            size="sm"
            icon="sparkle"
            aria-expanded={generateOpen}
            onClick={() => setGenerateOpen((open) => !open)}
            data-testid="storyboard.shot.generate.toggle"
          >
            {generateOpen ? "Hide anchor generation" : view.stale ? "Re-anchor this shot" : "Generate an anchor"}
          </Button>
          <Button
            variant={takesOpen ? "secondary" : "ghost"}
            size="sm"
            icon="video"
            aria-expanded={takesOpen}
            onClick={() => setTakesOpen((open) => !open)}
            data-testid="storyboard.shot.takes.toggle"
          >
            {takesOpen ? "Hide takes" : entry.takeHistory.length > 0 ? `Takes (${entry.takeHistory.length})` : "Takes"}
          </Button>
        </div>
      </div>

      <CompareModal
        open={compareIndex !== null && anchorModel.views[compareIndex] !== undefined}
        onClose={() => setCompareIndex(null)}
        testId={`storyboard.compare.${shot.shotId}`}
        title={`Compare anchors — ${shot.shotId}`}
        ratio="16 / 9"
        left={compareIndex !== null && anchorModel.views[compareIndex] !== undefined
          ? { label: anchorModel.views[compareIndex].candidate.label, preview: anchorModel.views[compareIndex].candidate.preview }
          : null}
        right={(() => {
          if (compareIndex === null || anchorModel.views[compareIndex] === undefined) return null;
          const fallback = anchorModel.views.findIndex((view2, index) => index !== compareIndex);
          const rightIndex = fallback >= 0 ? fallback : compareIndex;
          return { label: anchorModel.views[rightIndex].candidate.label, preview: anchorModel.views[rightIndex].candidate.preview };
        })()}
      />
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Anchor approval — explicit, checklist-gated, hash-honest            */
/* ------------------------------------------------------------------ */

function AnchorApprovalForm({ projectId, shotId, candidate, approvals, approvalState, shotCurrent, pendingJob, onClose, onReload }: {
  projectId: string;
  shotId: string;
  candidate: AnchorCandidate;
  approvals: readonly Approval[];
  approvalState: ApprovalState;
  shotCurrent: boolean;
  pendingJob: boolean;
  onClose: () => void;
  onReload: () => void;
}) {
  const required = APPROVAL_CHECKLISTS_VIEW.anchor;
  const [checks, setChecks] = useState<Record<string, ChecklistEntry>>(
    () => Object.fromEntries(required.map((id) => [id, { id, passed: null, note: "" } as ChecklistEntry])),
  );
  const [notes, setNotes] = useState("");
  const [ackReason, setAckReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => `anchor-approval-${freshRequestId()}`);
  const [phase, setPhase] = useState<ApproveState>({ kind: "idle" });

  const latestDecision = latestDecisionFor(approvals, "anchor", candidate.id);
  const visionStatus = candidate.visionAssessment?.status ?? null;
  const visionRequired = visionStatus !== null && visionStatus !== "pass";
  const visionCode = `vision_${visionStatus ?? "unavailable"}`;
  const checklist = required.map((id) => checks[id] ?? { id, passed: null, note: "" });

  const readiness = deriveApprovalReadiness({
    projectId,
    idempotencyKey,
    targetKind: "anchor",
    targetId: candidate.id,
    current: shotCurrent,
    pendingJob,
    visionStatus,
    latestDecision,
    displayedRevisionHash: null,
    decision: "approved",
    checklist,
    notes,
    acknowledgements: visionRequired ? [{ code: visionCode, reason: ackReason }] : [],
  });

  async function submit() {
    if (!readiness.ok || phase.kind === "submitting") return;
    setPhase({ kind: "submitting" });
    const command: CreateApprovalCommand = {
      targetKind: "anchor",
      targetId: candidate.id,
      expectedHash: readiness.expectedHash,
      decision: "approved",
      checklist: required.map((id) => {
        const entry = checks[id] ?? { id, passed: null, note: "" };
        return { id, passed: entry.passed === true, note: entry.note };
      }),
      notes,
      advisoryAcknowledgements: visionRequired ? [{ code: visionCode, reason: ackReason }] : [],
    };
    const result = await recordApproval({ projectId, idempotencyKey, command });
    if (result.ok) {
      setPhase({ kind: "saved", approvalId: result.approvalId, created: result.created });
      setIdempotencyKey(`anchor-approval-${freshRequestId()}`);
      onReload();
    } else {
      setPhase({ kind: "error", view: result.view });
      setIdempotencyKey(`anchor-approval-${freshRequestId()}`);
    }
  }

  return (
    <fieldset className="space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="storyboard.shot.approve-checklist">
      <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
        Approve anchor — shot {shotId}
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        <ApprovalBadge state={approvalState} testId="storyboard.shot.approve.state" />
        <span className="text-[12.5px] text-muted">
          Candidate <span className="font-mono text-[11.5px]">{candidate.id}</span>
          {visionStatus ? ` · vision check: ${visionStatus}` : " · no vision check recorded"}
        </span>
      </div>
      {!readiness.ok ? <GateReasons reasons={readiness.reasons} testId="storyboard.shot.approve.gates" /> : null}

      <div className="space-y-2.5">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
          Look checks ({required.length} — tick every check you verified)
        </p>
        {required.map((id) => {
          const entry = checks[id] ?? { id, passed: null, note: "" };
          return (
            <div key={id} className="grid gap-2 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={entry.passed === true}
                  onChange={(event) =>
                    setChecks((previous) => ({ ...previous, [id]: { ...entry, passed: event.target.checked } }))}
                  data-testid={`storyboard.shot.approve.check.${id}`}
                />
                {CHECKLIST_LABEL(id)}
              </label>
              <input
                aria-label={`Note for “${CHECKLIST_LABEL(id)}” on shot ${shotId}`}
                value={entry.note}
                onChange={(event) => setChecks((previous) => ({ ...previous, [id]: { ...entry, note: event.target.value } }))}
                placeholder="Optional note for your records"
                className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
              />
            </div>
          );
        })}
      </div>

      <FieldShell label="Notes" htmlFor={`anchor-approve-${candidate.id}-notes`} hint="Optional context recorded with your approval.">
        <textarea
          id={`anchor-approve-${candidate.id}-notes`}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
        />
      </FieldShell>

      {visionRequired ? (
        <FieldShell
          label={`One more confirmation (${visionCode})`}
          htmlFor={`anchor-approve-${candidate.id}-ack`}
          hint={`The automatic vision check came back “${visionStatus}”. Say why you’re approving anyway — the server requires it.`}
        >
          <input
            id={`anchor-approve-${candidate.id}-ack`}
            value={ackReason}
            onChange={(event) => setAckReason(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={!readiness.ok || phase.kind === "submitting"}
          loading={phase.kind === "submitting"}
          onClick={() => void submit()}
          data-testid="storyboard.shot.approve"
        >
          {phase.kind === "submitting" ? "Recording approval…" : "Approve this anchor"}
        </Button>
        <Button variant="ghost" size="sm" icon="close" onClick={onClose} data-testid="storyboard.shot.approve.cancel">
          Cancel
        </Button>
        {!readiness.ok ? <span className="text-[12px] text-muted">Approve unlocks when every reason above is resolved.</span> : null}
      </div>

      {phase.kind === "saved" ? (
        <StatusNote
          tone="success"
          lines={[`${phase.created ? "Approval recorded" : "Approval already recorded (identical replay)"} — ${phase.approvalId}.`]}
          testId="storyboard.shot.approve.status"
        />
      ) : null}
      {phase.kind === "error" ? <ErrorAlert view={phase.view} lead="The approval could not be recorded." testId="storyboard.shot.approve.error" /> : null}
    </fieldset>
  );
}
