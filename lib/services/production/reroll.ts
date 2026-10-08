import { z } from "zod";
import {
  IdSchema, JobSchema, ProviderRequestSnapshotSchema,
  type JsonValue, type ProductionJob, type ShotRevision,
} from "../../production/contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { changeSomethingCommand, type ChangeSomethingDelta, type RetryCommandOptions } from "../../production/job-retry";
import { computeProductionInputsHash, ProductionJobQueue } from "../../jobs/production/queue";
import type { ProductionStore } from "../../repositories/production/ports";

/**
 * Continuity-guided re-roll (spec 11 §8, lane F2). One shot's latest take job is
 * re-derived as a NEW queued job via the frozen Wave-0 `changeSomethingCommand`
 * (fresh id, `-retry-<n>` idempotency key, `retryOf` back-link, patched snapshot
 * copy) and enqueued through the production job queue's public API — the same
 * outbox path every take generation rides. The guidance rides in the delta as a
 * structured `continuityGuidance` parameter (dimension + note) and is folded
 * into the motion prompt so the provider actually acts on it; the recomputed
 * `resultTarget.inputsHash` pins the changed request exactly like a first-run
 * take. Nothing is approved, quoted or submitted here: the worker revalidates
 * quote currency, approvals and eligibility before any paid submission.
 */

export const RerollGuidanceSchema = z.strictObject({
  dimension: z.enum(["identity", "outfit", "environment", "lighting"]),
  note: z.string().trim().min(1).max(2000),
});
export type RerollGuidance = z.infer<typeof RerollGuidanceSchema>;

export const RerollCommandSchema = z.strictObject({
  projectId: IdSchema,
  shotId: IdSchema,
  guidance: RerollGuidanceSchema,
});
export type RerollCommand = z.infer<typeof RerollCommandSchema>;

/** Route body for POST /api/production/projects/:projectId/reroll; the project id comes from the path. */
export const RerollRequestBodySchema = z.strictObject({ shotId: IdSchema, guidance: RerollGuidanceSchema });

export type RerollResult = Readonly<{
  job: ProductionJob;
  created: boolean;
  /** The source take job this re-roll links back to via `retryOf`. */
  retryOf: string;
}>;

export interface RerollServiceOptions { now?: () => number }

function fail(code: ProductionErrorCode, message: string, options: { retryable?: boolean; field?: string; shotId?: string; action?: string; details?: Record<string, JsonValue> } = {}): never {
  throw new ProductionApplicationError(code, message, options);
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) fail("INVALID_INPUT", `Invalid ${label}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  return result.data;
}

function clockNow(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_INPUT", "Clock must return a nonnegative safe integer timestamp");
  return value;
}

/** Highest existing `-retry-<n>` ordinal among jobs derived from this idempotency key (0 when none). */
function latestRetryOrdinal(jobs: readonly ProductionJob[], sourceKey: string): number {
  const prefix = `${sourceKey}-retry-`;
  let latest = 0;
  for (const job of jobs) {
    if (!job.idempotencyKey.startsWith(prefix)) continue;
    const ordinal = Number(/-retry-(\d+)$/.exec(job.idempotencyKey)?.[1] ?? 0);
    if (Number.isSafeInteger(ordinal) && ordinal > latest) latest = ordinal;
  }
  return latest;
}

/** Human-readable guidance line folded into the motion prompt (hashable, provider-visible). */
export const continuityGuidancePrompt = (guidance: RerollGuidance): string =>
  `Continuity guidance (${guidance.dimension}): ${guidance.note}`;

type TakeJobCandidate = { job: ProductionJob; shot: ShotRevision };

function findLatestTakeJobs(read: ProductionStore["read"], projectId: string, shotId: string): TakeJobCandidate[] {
  const project = read.getProject(projectId);
  if (!project) fail("UNKNOWN_REFERENCE", "Project not found");
  const candidates: TakeJobCandidate[] = [];
  for (const job of read.listProjectJobs(projectId)) {
    if (job.operation !== "take") continue;
    const snapshot = ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot);
    const target = snapshot.success ? snapshot.data.resultTarget : null;
    if (!snapshot.success || target?.kind !== "take") continue;
    const shot = read.getShotRevision(target.shotRevisionId);
    if (!shot || shot.shotId !== shotId) continue;
    const story = read.getStoryRevision(shot.storyRevisionId);
    if (!story || story.projectId !== project.id) continue;
    candidates.push({ job, shot });
  }
  // Latest first: newest job wins, id order breaks createdAt ties deterministically.
  return candidates.sort((left, right) => right.job.createdAt - left.job.createdAt || (left.job.id < right.job.id ? 1 : -1));
}

/**
 * Enqueues one continuity-guided re-roll of a shot's latest take job. Fails closed with
 * INVALID_INPUT (and an explicit remediation action) when the shot has no take job yet, and
 * before enqueue when the source job is workspace-scoped — that admission evidence cannot be
 * derived here, so a scoped re-roll must go through its own workspace flow.
 */
export function enqueueGuidedReroll(store: ProductionStore, raw: RerollCommand, options: RerollServiceOptions = {}): RerollResult {
  const command = parsed(RerollCommandSchema, raw, "re-roll command");
  const now = clockNow(options.now ?? Date.now);
  const read = store.read;
  const candidates = findLatestTakeJobs(read, command.projectId, command.shotId);
  if (candidates.length === 0) {
    fail("INVALID_INPUT", `Shot ${command.shotId} has no take job to re-roll yet.`, {
      shotId: command.shotId,
      action: "Generate a take for this shot from the storyboard first, then queue a guided re-roll.",
    });
  }
  const source = candidates[0]!;
  if (source.job.scope?.workspaceId) {
    fail("INVALID_INPUT", `Job ${source.job.id} is scoped to workspace ${source.job.scope.workspaceId}; a guided re-roll requires that workspace's isolation admission.`);
  }
  const sourceSnapshot = ProviderRequestSnapshotSchema.parse(source.job.requestSnapshot);

  const jobs = read.listProjectJobs(command.projectId);
  const ordinal = latestRetryOrdinal(jobs, source.job.idempotencyKey);
  const retryOptions: RetryCommandOptions | undefined = ordinal === 0 ? undefined : { retryIndex: ordinal + 1 };
  const delta: ChangeSomethingDelta = {
    kind: "take",
    prompt: `${sourceSnapshot.prompt}\n${continuityGuidancePrompt(command.guidance)}`,
    parameters: { continuityGuidance: { dimension: command.guidance.dimension, note: command.guidance.note } },
  };
  const retry = changeSomethingCommand(source.job, delta, retryOptions);

  // The retry derivations clone the source snapshot verbatim; a job-creation service re-stamps
  // the transport identity onto the copy (mirroring the take service's materialization) so the
  // enqueued request describes exactly this new job.
  const restamped = { ...(retry.requestSnapshot as { [key: string]: JsonValue }), jobId: retry.id, idempotencyKey: retry.idempotencyKey };
  const snapshot = ProviderRequestSnapshotSchema.parse(restamped);
  if (snapshot.resultTarget?.kind !== "take") fail("INVALID_INPUT", `Job ${source.job.id} request snapshot has no take result target; it cannot be re-rolled.`);
  let inputsHash: string;
  try {
    inputsHash = computeProductionInputsHash(read, "take", snapshot);
  } catch (error) {
    fail("INVALID_INPUT", `The pinned inputs of take job ${source.job.id} are no longer resolvable, so this shot cannot be re-rolled: ${error instanceof Error ? error.message : "unknown error"}`, {
      shotId: command.shotId,
      action: "Re-approve the shot's anchor (or re-pin its canon) from the storyboard, then retry.",
    });
  }
  const finalSnapshot = ProviderRequestSnapshotSchema.parse({ ...snapshot, resultTarget: { ...snapshot.resultTarget!, inputsHash } });
  const job = JobSchema.parse({
    version: 1, id: retry.id, projectId: source.job.projectId, operation: "take", status: "queued",
    idempotencyKey: retry.idempotencyKey, requestSnapshot: finalSnapshot, requestHash: hashCanonicalJson(finalSnapshot),
    providerId: source.job.providerId, modelId: source.job.modelId, providerRef: null, quoteId: source.job.quoteId,
    receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null,
    attempt: 0, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now,
    scope: source.job.scope ?? null, retryOf: retry.retryOf, resolvedReferenceIds: source.job.resolvedReferenceIds ?? [],
  });
  const queued = new ProductionJobQueue(store, options.now ?? Date.now).enqueue(job);
  return { job: queued.job, created: queued.created, retryOf: source.job.id };
}
