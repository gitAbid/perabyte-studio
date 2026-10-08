"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { labelForAspect, type ContinuityFinding } from "./continuity-model";

/* ------------------------------------------------------------------ */
/* RerollButton — spec 11 §8 guided re-roll (client island)            */
/* ------------------------------------------------------------------ */
/*
 * One press queues a continuity-guided take re-roll through
 * POST /api/production/projects/:projectId/reroll. The guidance is the row's
 * worst failing finding (dimension + engine note), so the re-roll acts on what
 * the check actually flagged. Success shows an inline "Re-roll queued"
 * confirmation; failures surface the server envelope's message and action.
 * Advisory only — queueing never approves, selects or spends anything by
 * itself; the job pipeline still enforces quotes and approvals.
 */

/** Matches the endpoint's guidance contract (RerollGuidanceSchema note cap). */
const MAX_NOTE_CHARS = 2000;

type RerollPhase =
  | { kind: "idle" }
  | { kind: "queuing" }
  | { kind: "queued"; jobId: string }
  | { kind: "failed"; message: string; action: string | null };

export interface RerollButtonProps {
  projectId: string;
  /** Logical shot id the guidance came from (continuity report row key). */
  shotId: string;
  /** The worst failing finding for this shot — the guidance that is sent. */
  guidance: ContinuityFinding;
  /** Targeted repair note (spec 11 §9 generator) that overrides the finding note when present. */
  note?: string;
}

export function RerollButton({ projectId, shotId, guidance, note }: RerollButtonProps) {
  const [phase, setPhase] = useState<RerollPhase>({ kind: "idle" });
  const busy = phase.kind === "queuing";
  const settled = phase.kind === "queued" || phase.kind === "failed";

  async function queueReroll() {
    if (busy || phase.kind === "queued") return;
    setPhase({ kind: "queuing" });
    try {
      const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/reroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          shotId,
          guidance: { dimension: guidance.aspect, note: (note ?? guidance.note).slice(0, MAX_NOTE_CHARS) },
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const envelope = (payload ?? {}) as { jobId?: unknown; error?: { message?: unknown; action?: unknown } };
      const jobId = typeof envelope.jobId === "string" ? envelope.jobId : null;
      if (response.ok && jobId) {
        setPhase({ kind: "queued", jobId });
        return;
      }
      const error = envelope.error && typeof envelope.error === "object" ? envelope.error : null;
      setPhase({
        kind: "failed",
        message: typeof error?.message === "string" && error.message.length > 0 ? error.message : "The re-roll could not be queued.",
        action: typeof error?.action === "string" && error.action.length > 0 ? error.action : null,
      });
    } catch {
      setPhase({
        kind: "failed",
        message: "The re-roll could not be queued — the studio server didn't answer.",
        action: "Check the connection and try again.",
      });
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon="refresh"
          loading={busy}
          disabled={phase.kind === "queued"}
          onClick={() => void queueReroll()}
          data-testid="continuity.shot.reroll"
        >
          {phase.kind === "queued" ? "Re-roll queued" : busy ? "Queuing…" : "Re-roll with guidance"}
        </Button>
        {!settled ? (
          <span className="text-[12px] text-muted">
            Queues a new take guided by {labelForAspect(guidance.aspect).toLowerCase()} — nothing is spent or selected yet.
          </span>
        ) : null}
      </div>
      {phase.kind === "queued" ? (
        <p data-testid="continuity.shot.reroll.queued" className="text-[12px] leading-relaxed text-success">
          Re-roll queued ({phase.jobId}). It runs through the normal take pipeline — quotes and approvals
          are still checked before anything is generated. Follow it on the storyboard.
        </p>
      ) : null}
      {phase.kind === "failed" ? (
        <p data-testid="continuity.shot.reroll.error" role="alert" className="text-[12px] leading-relaxed text-danger">
          {phase.message}
          {phase.action ? ` ${phase.action}` : ""}
        </p>
      ) : null}
    </div>
  );
}
