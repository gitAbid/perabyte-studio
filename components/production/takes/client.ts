/**
 * Takes screen HTTP helpers (spec 10). Speaks HTTP only and reuses the accepted story-screen
 * client (components/production/story/client.ts) for the shared POST shapes: same-origin JSON,
 * error envelopes parsed by the shared derivation, responses validated against the frozen
 * contracts before use. Nothing here is auto-invoked; every mutation is triggered by an
 * explicit creator action (a checked cost, a retry button, an explicit selection).
 */

import { QuoteSchema, type ProductionQuote, type SelectTakeCommand } from "@/lib/production/contracts";
import type { MotionSettings } from "@/lib/production/takes";
import { deriveMutationFailure, type ErrorEnvelopeView } from "@/components/production/project-canon";
import { freshRequestId, postJson, responsePayload } from "@/components/production/story/client";

export { freshRequestId };

export type { ErrorEnvelopeView };

/* ------------------------------------------------------------------ */
/* Take quote (POST /api/production/media-quotes)                      */
/* ------------------------------------------------------------------ */

export type TakeQuoteResult =
  | { ok: true; quote: ProductionQuote }
  | { ok: false; view: ErrorEnvelopeView; blocked: boolean };

/**
 * Requests a cost quote for one take generation (approved anchor + its exact current approval
 * id bound in). No money moves and no job is created; BUDGET_BLOCKED envelopes are reported as
 * the blocked state.
 */
export async function requestTakeQuote(input: {
  projectId: string;
  shotRevisionId: string;
  anchorId: string;
  approvalId: string;
  motionSettings: MotionSettings;
}): Promise<TakeQuoteResult> {
  const call = await postJson("/api/production/media-quotes", {
    kind: "take",
    command: {
      projectId: input.projectId,
      shotRevisionId: input.shotRevisionId,
      anchorId: input.anchorId,
      approvalId: input.approvalId,
      motionSettings: input.motionSettings,
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
/* Take enqueue (POST /api/production/shots/[shotId]/takes)            */
/* ------------------------------------------------------------------ */

export type TakeEnqueueResult =
  | { ok: true; jobId: string; jobStatus: string; created: boolean }
  | { ok: false; view: ErrorEnvelopeView; blocked: boolean };

/**
 * Enqueues one take job against an existing quote; the quote id binds the cost to the job.
 * Retries pass their retry-suffixed `idempotencyKey` (from the Wave-0 derivation), so a double
 * press replays the same retry instead of creating an extra job.
 */
export async function enqueueTake(input: {
  projectId: string;
  shotId: string;
  shotRevisionId: string;
  anchorId: string;
  approvalId: string;
  quoteId: string;
  idempotencyKey: string;
  motionSettings: MotionSettings;
  /** Source job id for retry flows; null/undefined on first runs. */
  retryOf?: string | null;
}): Promise<TakeEnqueueResult> {
  const call = await postJson(`/api/production/shots/${encodeURIComponent(input.shotId)}/takes`, {
    projectId: input.projectId,
    shotRevisionId: input.shotRevisionId,
    anchorId: input.anchorId,
    approvalId: input.approvalId,
    quoteId: input.quoteId,
    idempotencyKey: input.idempotencyKey,
    motionSettings: input.motionSettings,
    retryOf: input.retryOf ?? null,
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
        message: "The take endpoint returned no job id; the job may have been created — reload before retrying.",
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
/* Take selection (POST /api/production/shots/[shotId]/selection)      */
/* ------------------------------------------------------------------ */

export type TakeSelectionResult =
  | { ok: true; takeId: string | null; selectionVersion: number; changed: boolean }
  | { ok: false; view: ErrorEnvelopeView };

/**
 * Records the explicit take selection (or clears it with `takeId: null`). The frozen CAS
 * command carries the selection version exactly as read, never guessed; a stale version is a
 * reported failure, not a silent overwrite.
 */
export async function selectTake(input: SelectTakeCommand & { shotId: string }): Promise<TakeSelectionResult> {
  const call = await postJson(`/api/production/shots/${encodeURIComponent(input.shotId)}/selection`, {
    projectId: input.projectId,
    shotRevisionId: input.shotRevisionId,
    takeId: input.takeId,
    expectedSelectionVersion: input.expectedSelectionVersion,
  });
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    return { ok: false, view: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed) };
  }
  const result = payload as { selection?: { takeId?: unknown; version?: unknown }; changed?: unknown } | null;
  const version = typeof result?.selection?.version === "number" ? result.selection.version : null;
  if (version === null) {
    return {
      ok: false,
      view: {
        code: "UNKNOWN_RESPONSE",
        message: "The selection endpoint returned no selection version; no success is claimed.",
        requestId: "unavailable",
        action: "Reload to check whether the selection landed.",
        retryable: true,
        status: call.response.status,
        shape: "unparseable",
      },
    };
  }
  return {
    ok: true,
    takeId: typeof result?.selection?.takeId === "string" ? result.selection.takeId : null,
    selectionVersion: version,
    changed: result?.changed === true,
  };
}

/** Fresh idempotency key for one new take submit attempt (retries use their derived key instead). */
export function freshTakeIdempotencyKey(): string {
  return `take-${freshRequestId()}`;
}
