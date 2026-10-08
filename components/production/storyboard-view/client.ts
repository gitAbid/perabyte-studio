/**
 * Storyboard screen HTTP helpers (spec 09). Speaks HTTP only and reuses the accepted
 * story-screen client (components/production/story/client.ts) for the shared POST/GET shapes:
 * same-origin JSON, error envelopes parsed by the shared derivation, responses validated
 * against the frozen contracts before use. Nothing here is auto-invoked; every mutation is
 * triggered by an explicit creator action.
 */

import { QuoteSchema, type ProductionQuote } from "@/lib/production/contracts";
import type { AnchorRenderSettings } from "@/lib/production/anchors";
import { deriveMutationFailure, type ErrorEnvelopeView } from "@/components/production/project-canon";
import { freshRequestId, postJson, responsePayload } from "@/components/production/story/client";

export { freshRequestId };

export type { ErrorEnvelopeView };

/* ------------------------------------------------------------------ */
/* Read model + scenes (same helpers the story screen uses)            */
/* ------------------------------------------------------------------ */

import { fetchScenes, fetchStoryReadModel, type ReadModelResult, type ScenesResult } from "@/components/production/story/client";
export { fetchScenes, fetchStoryReadModel, type ReadModelResult, type ScenesResult };

/* ------------------------------------------------------------------ */
/* Anchor quote (POST /api/production/media-quotes)                    */
/* ------------------------------------------------------------------ */

export type AnchorQuoteResult =
  | { ok: true; quote: ProductionQuote }
  | { ok: false; view: ErrorEnvelopeView; blocked: boolean };

/**
 * Requests a cost quote for one anchor generation. No money moves and no job is created;
 * BUDGET_BLOCKED envelopes are reported as the blocked state.
 */
export async function requestAnchorQuote(input: {
  projectId: string;
  shotRevisionId: string;
  renderSettings: AnchorRenderSettings;
}): Promise<AnchorQuoteResult> {
  const call = await postJson("/api/production/media-quotes", {
    kind: "anchor",
    command: {
      projectId: input.projectId,
      shotRevisionId: input.shotRevisionId,
      renderSettings: input.renderSettings,
    },
  });
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    const view = deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed);
    return { ok: false, view, blocked: view.code === "BUDGET_BLOCKED" };
  }
  const parsed = QuoteSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      blocked: false,
      view: {
        code: "UNKNOWN_RESPONSE",
        message: "The cost quote did not match the accepted quote contract; nothing was started.",
        requestId: "unavailable",
        action: "Retry the cost check; if it repeats, inspect the local server logs.",
        retryable: true,
        status: call.response.status,
        shape: "unparseable",
      },
    };
  }
  return { ok: true, quote: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Anchor enqueue (POST /api/production/shots/[shotId]/anchors)        */
/* ------------------------------------------------------------------ */

export type AnchorEnqueueResult =
  | { ok: true; jobId: string; jobStatus: string; created: boolean }
  | { ok: false; view: ErrorEnvelopeView; blocked: boolean };

/** Enqueues one anchor job against an existing quote; the quote id binds the cost to the job. */
export async function enqueueAnchor(input: {
  projectId: string;
  shotId: string;
  shotRevisionId: string;
  quoteId: string;
  renderSettings: AnchorRenderSettings;
}): Promise<AnchorEnqueueResult> {
  const call = await postJson(`/api/production/shots/${encodeURIComponent(input.shotId)}/anchors`, {
    projectId: input.projectId,
    shotRevisionId: input.shotRevisionId,
    quoteId: input.quoteId,
    idempotencyKey: `anchor-${freshRequestId()}`,
    renderSettings: input.renderSettings,
  });
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    const view = deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed);
    return { ok: false, view, blocked: view.code === "BUDGET_BLOCKED" };
  }
  const job = (payload as { job?: { id?: unknown; status?: unknown } } | null)?.job;
  if (typeof job?.id !== "string") {
    return {
      ok: false,
      blocked: false,
      view: {
        code: "UNKNOWN_RESPONSE",
        message: "The anchor endpoint returned no job id; the job may have been created — reload before retrying.",
        requestId: "unavailable",
        action: "Reload the storyboard to check whether the job landed.",
        retryable: true,
        status: call.response.status,
        shape: "unparseable",
      },
    };
  }
  return {
    ok: true,
    jobId: job.id,
    jobStatus: typeof job.status === "string" ? job.status : "unknown",
    created: (payload as { created?: unknown } | null)?.created === true,
  };
}

/* ------------------------------------------------------------------ */
/* Approvals (POST /api/production/approvals, ApproveBar call shape)   */
/* ------------------------------------------------------------------ */

export type ApprovalRecordResult =
  | { ok: true; approvalId: string; created: boolean }
  | { ok: false; view: ErrorEnvelopeView };

export type ApprovalCommandBody = {
  projectId: string;
  idempotencyKey: string;
  command: {
    targetKind: string;
    targetId: string;
    expectedHash: string;
    decision: "approved" | "rejected";
    checklist: { id: string; passed: boolean; note: string }[];
    notes: string;
    advisoryAcknowledgements: { code: string; reason: string }[];
  };
};

/** Records one explicit approval decision; identical replays return the same approval id. */
export async function recordApproval(body: ApprovalCommandBody): Promise<ApprovalRecordResult> {
  const call = await postJson("/api/production/approvals", body);
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    return { ok: false, view: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed) };
  }
  const record = payload as { approval?: { id?: unknown }; created?: unknown } | null;
  const approvalId = typeof record?.approval?.id === "string" ? record.approval.id : null;
  if (!approvalId) {
    return {
      ok: false,
      view: {
        code: "UNKNOWN_RESPONSE",
        message: "The approval endpoint returned an unexpected payload; no success is claimed.",
        requestId: "unavailable",
        action: "Reload to check whether the decision landed.",
        retryable: true,
        status: call.response.status,
        shape: "unparseable",
      },
    };
  }
  return { ok: true, approvalId, created: record?.created === true };
}
