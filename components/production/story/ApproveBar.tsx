"use client";

import { useState } from "react";
import { Button, FieldShell } from "@/components/ui";
import { ApprovalBadge } from "@/components/production/primitives/approval";
import {
  STORY_APPROVAL_CHECKLIST_VIEW,
  deriveStoryApprovalCommand,
  type StoryApprovalChecklistEntry,
} from "@/components/production/project-canon";
import type { CreateApprovalCommand, StoryRevision } from "@/lib/production/contracts";
import type { StoryApprovalFacts } from "@/lib/production/story-view-model";
import { postJson, freshRequestId, responsePayload } from "@/components/production/story/client";
import { deriveMutationFailure, type ErrorEnvelopeView } from "@/components/production/project-canon";

/* ------------------------------------------------------------------ */
/* ApproveBar — the explicit human decision (spec 08 §6 bottom bar)    */
/* ------------------------------------------------------------------ */
/* ApprovalBadge (C8 vocabulary) plus exactly one path to "approved":  */
/* the creator ticking the full story checklist. "Request changes"     */
/* records a rejected decision with the creator's reason. Nothing here */
/* approves automatically — not viewing, not saving, not recommending. */

export interface ApproveBarProps {
  projectId: string;
  story: StoryRevision;
  approvalFacts: StoryApprovalFacts;
  /** Panel reload after a recorded decision. */
  onRecorded: () => void;
}

const CHECKLIST_LABELS: Record<string, string> = {
  protagonist_goal: "We know what the main character wants",
  cause_consequence_order: "Events happen in a cause-and-effect order",
  earned_resolution: "The ending is earned by the story",
  plot_fidelity: "The story keeps its own promises",
  spoken_lines: "Spoken lines read naturally",
};

type Decision = "approve" | "reject";

export function ApproveBar({ projectId, story, approvalFacts, onRecorded }: ApproveBarProps) {
  const [openPanel, setOpenPanel] = useState<Decision | null>(null);
  const [checks, setChecks] = useState<Record<string, StoryApprovalChecklistEntry>>(() =>
    Object.fromEntries(STORY_APPROVAL_CHECKLIST_VIEW.map((id) => [id, { id, passed: false, note: "" } as StoryApprovalChecklistEntry])),
  );
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ErrorEnvelopeView | null>(null);
  const [recorded, setRecorded] = useState<{ approvalId: string; created: boolean; decision: "approved" | "rejected" } | null>(null);

  const checklist = STORY_APPROVAL_CHECKLIST_VIEW.map((id) => checks[id] ?? { id, passed: false, note: "" });
  const allTicked = checklist.every((entry) => entry.passed);
  const rejectReasonReady = notes.trim().length > 0;

  async function submit(decision: "approved" | "rejected") {
    if (submitting) return;
    setFailure(null);
    if (decision === "approved" && !allTicked) return;
    if (decision === "rejected" && !rejectReasonReady) return;
    setSubmitting(true);
    try {
      const body =
        decision === "approved"
          ? deriveStoryApprovalCommand({ projectId, idempotencyKey: freshRequestId(), story, checklist, notes })
          : {
              projectId,
              idempotencyKey: freshRequestId(),
              command: {
                targetKind: "story",
                targetId: story.id,
                expectedHash: story.contentHash,
                decision: "rejected",
                checklist: STORY_APPROVAL_CHECKLIST_VIEW.map((id) => ({ id, passed: false, note: "" })),
                notes,
                advisoryAcknowledgements: [],
              } satisfies CreateApprovalCommand,
            };
      if (!body) return; // Unreachable: the submit button stays disabled until every item is ticked.
      const call = await postJson("/api/production/approvals", body);
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        setFailure(deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
        return;
      }
      const record = payload as { approval?: { id?: unknown }; created?: unknown } | null;
      const approvalId = typeof record?.approval?.id === "string" ? record.approval.id : null;
      if (!approvalId) {
        setFailure({
          code: "UNKNOWN_RESPONSE",
          message: "The approval endpoint returned an unexpected payload; no success is claimed.",
          requestId: "unavailable",
          action: "Reload to check whether the decision landed.",
          retryable: true,
          status: call.response.status,
          shape: "unparseable",
        });
        return;
      }
      setRecorded({ approvalId, created: record?.created === true, decision });
      setOpenPanel(null);
      onRecorded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Approve story" data-testid="story.approve.bar" className="rounded-[12px] border border-border bg-raised p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ApprovalBadge state={approvalFacts.state} testId="story.approval.badge" />
          <p className="text-[13px] text-muted">
            {approvalFacts.approvedCurrent
              ? "This story is approved. Downstream work can build on it."
              : "Approving locks this story as the one everything else builds on. PeraByte may recommend, but only you approve."}
          </p>
        </div>
        {!approvalFacts.approvedCurrent ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon="pen"
              aria-expanded={openPanel === "reject"}
              onClick={() => setOpenPanel(openPanel === "reject" ? null : "reject")}
              data-testid="story.reject.toggle"
            >
              Request changes
            </Button>
            <Button
              icon="check"
              aria-expanded={openPanel === "approve"}
              onClick={() => setOpenPanel(openPanel === "approve" ? null : "approve")}
              data-testid="story.approve.toggle"
            >
              Approve story
            </Button>
          </div>
        ) : null}
      </div>

      {recorded ? (
        <div role="status" data-testid="story.approve.status" className="mt-3 rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
          {recorded.decision === "approved"
            ? recorded.created
              ? "Story approved"
              : "Story approval already recorded (identical replay)"
            : recorded.created
              ? "Change request recorded"
              : "Change request already recorded (identical replay)"}{" "}
          — approval <span className="font-mono text-[12px]">{recorded.approvalId}</span>.
        </div>
      ) : null}
      {failure ? (
        <div className="mt-3">
          <FailureAlert view={failure} />
        </div>
      ) : null}

      {openPanel === "approve" && !approvalFacts.approvedCurrent ? (
        <fieldset className="mt-4 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="story.approve.form">
          <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Approve — tick every check</legend>
          <div className="space-y-2.5">
            {STORY_APPROVAL_CHECKLIST_VIEW.map((id) => {
              const entry = checks[id] ?? { id, passed: false, note: "" };
              return (
                <div key={id} className="grid gap-2 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                  <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-primary)]"
                      checked={entry.passed}
                      onChange={(event) => setChecks((previous) => ({ ...previous, [id]: { ...entry, passed: event.target.checked } }))}
                      data-testid={`story.approve.check.${id}`}
                    />
                    {CHECKLIST_LABELS[id] ?? id}
                  </label>
                  <input
                    aria-label={`Note for “${CHECKLIST_LABELS[id] ?? id}”`}
                    value={entry.note}
                    onChange={(event) => setChecks((previous) => ({ ...previous, [id]: { ...entry, note: event.target.value } }))}
                    placeholder="Optional note for your records"
                    className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
          <FieldShell label="Notes" htmlFor="story-approve-notes" hint="Optional context recorded with your approval.">
            <textarea
              id="story-approve-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="check" disabled={!allTicked || submitting} loading={submitting} onClick={() => void submit("approved")} data-testid="story.approve.submit">
              {submitting ? "Recording approval…" : "Approve this story"}
            </Button>
            {!allTicked ? <span className="text-[12px] text-muted">Tick every check to enable the approval.</span> : null}
          </div>
        </fieldset>
      ) : null}

      {openPanel === "reject" && !approvalFacts.approvedCurrent ? (
        <fieldset className="mt-4 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="story.reject.form">
          <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Request changes</legend>
          <p className="text-[12.5px] text-muted">
            Tell PeraByte what to change. This records your “not yet” on the current revision — the story itself is never rewritten by this decision.
          </p>
          <FieldShell label="What should change?" htmlFor="story-reject-notes" error={notes.trim().length === 0 ? "Describe the change you want so the request is actionable." : undefined}>
            <textarea
              id="story-reject-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="For example: “The dragon wakes too early — build up to it first.”"
              className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon="pen" disabled={!rejectReasonReady || submitting} loading={submitting} onClick={() => void submit("rejected")} data-testid="story.reject.submit">
              {submitting ? "Recording request…" : "Record change request"}
            </Button>
          </div>
        </fieldset>
      ) : null}

      {approvalFacts.latest && !approvalFacts.approvedCurrent ? (
        <p className="mt-3 text-[12px] text-muted">
          Latest recorded decision: {approvalFacts.latest.decision === "approved" ? "approved (no longer matches this revision)" : "change requested"}. You can decide again.
        </p>
      ) : null}
    </section>
  );
}

function FailureAlert({ view }: { view: ErrorEnvelopeView }) {
  return (
    <div role="alert" data-testid="story.approve.error" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">The decision could not be recorded.</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{view.code} — {view.message}</p>
      <p className="mt-1 text-[12px] text-muted">Nothing was lost. You can retry.</p>
    </div>
  );
}
