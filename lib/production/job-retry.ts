import { IdSchema, type JsonValue, type ProductionJob } from "./contracts";
import { ProductionApplicationError } from "./errors";

/**
 * GenerationJob retry derivations (CONTRACTS-FROZEN C9, spec 02 §8, spec 10 §8).
 *
 * All three commands are pure: they never touch the queue or store. Each returns the pieces a
 * job-creation service needs to assemble and enqueue a NEW job that links back to its source
 * via `retryOf` — identical request semantics for Try Again, deliberate new randomness for
 * Different Take, and a structured patch for Change Something. The `requestSnapshot` is always
 * a fresh deep copy; the source job and its snapshot are never mutated.
 *
 * The retry ordinal defaults to (previous `-retry-<n>` suffix on the idempotency key) + 1, so
 * retry chains derive deterministically; pass `retryIndex` explicitly when creating several
 * different retries of the same source job (e.g. one Different Take and one Change Something),
 * because the idempotency key must stay unique per new request.
 *
 * Retry jobs start at attempt zero and inherit nothing else; timestamps, provider fields and
 * result fields are authored by the enqueueing service, exactly like any first-run job.
 */
export interface RetryJobCommand {
  readonly id: string;
  readonly retryOf: string;
  readonly idempotencyKey: string;
  readonly requestSnapshot: JsonValue;
}

export interface RetryCommandOptions {
  /** Explicit retry ordinal; must be a positive safe integer. Defaults to the derived next ordinal. */
  readonly retryIndex?: number;
}

/** The `ProductionJob` fields the retry commands read; the full C9-extended job satisfies it. */
export type RetryableJob = Pick<ProductionJob, "id" | "idempotencyKey" | "operation" | "requestSnapshot">;

/** Structured Change-Something patch, typed per job kind. At least one field is required. */
export type ChangeSomethingDelta =
  | Readonly<{ kind: "anchor"; prompt?: string; parameters?: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "take"; directionNote?: string; prompt?: string; parameters?: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "audio"; parameters?: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "export"; parameters?: Readonly<Record<string, JsonValue>> }>;

function fail(message: string): never {
  throw new ProductionApplicationError("INVALID_INPUT", message);
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryOrdinal(idempotencyKey: string): number {
  const match = /-retry-(\d+)$/.exec(idempotencyKey);
  return match ? Number(match[1]) + 1 : 1;
}

function resolveOrdinal(idempotencyKey: string, options: RetryCommandOptions | undefined): number {
  if (options?.retryIndex === undefined) return retryOrdinal(idempotencyKey);
  if (!Number.isSafeInteger(options.retryIndex) || options.retryIndex < 1) {
    fail(`retryIndex must be a positive safe integer, received ${String(options.retryIndex)}.`);
  }
  return options.retryIndex;
}

function baseRetryCommand(job: RetryableJob, options: RetryCommandOptions | undefined): { id: string; retryOf: string; idempotencyKey: string } {
  if (typeof job?.id !== "string" || job.id.length === 0) fail("Retry requires a source job id.");
  if (typeof job?.idempotencyKey !== "string" || job.idempotencyKey.length === 0) fail(`Retry of job ${job.id} requires a source idempotency key.`);
  const ordinal = resolveOrdinal(job.idempotencyKey, options);
  const id = `${job.id}-retry-${ordinal}`;
  const idempotencyKey = `${job.idempotencyKey}-retry-${ordinal}`;
  for (const [label, value] of [["job id", id], ["idempotency key", idempotencyKey]] as const) {
    const parsed = IdSchema.safeParse(value);
    if (!parsed.success) fail(`Retrying job ${job.id} produces an invalid ${label} (${value}); ids and idempotency keys are capped at 200 characters.`);
  }
  return { id, retryOf: job.id, idempotencyKey };
}

function clonedSnapshot(job: RetryableJob): { [key: string]: JsonValue } {
  if (!isPlainObject(job.requestSnapshot)) fail(`Job ${job.id} request snapshot must be a JSON object to derive a retry.`);
  return structuredClone(job.requestSnapshot) as { [key: string]: JsonValue };
}

function validatedText(value: string, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty, non-whitespace string.`);
  if (value.length > max) fail(`${label} exceeds its ${max}-character limit.`);
  return value;
}

/**
 * Try Again: an identical request (exact same request snapshot, references included) under a
 * NEW job id, an idempotency key suffixed `-retry-<n>`, and `retryOf` pointing at the source.
 */
export function tryAgainCommand(job: RetryableJob, options?: RetryCommandOptions): RetryJobCommand {
  const base = baseRetryCommand(job, options);
  return { ...base, requestSnapshot: clonedSnapshot(job) };
}

/**
 * Different Take: deliberate new randomness. The snapshot copy keeps every pinned reference
 * and parameter except the seed inside its `randomness` block (top-level, else inside
 * `parameters`), which is replaced with the explicitly supplied nonnegative safe-integer seed.
 * Fails closed when the snapshot carries no randomness block: a different take cannot be
 * derived from a request that pinned none.
 */
export function differentTakeCommand(job: RetryableJob, seed: number, options?: RetryCommandOptions): RetryJobCommand {
  if (!Number.isSafeInteger(seed) || seed < 0) fail(`A different take requires an explicit nonnegative safe-integer seed, received ${String(seed)}.`);
  const base = baseRetryCommand(job, options);
  const snapshot = clonedSnapshot(job);
  const randomness = isPlainObject(snapshot.randomness)
    ? snapshot.randomness
    : isPlainObject(snapshot.parameters) && isPlainObject(snapshot.parameters.randomness)
      ? snapshot.parameters.randomness
      : null;
  if (!randomness) fail(`Job ${job.id} request snapshot has no randomness block; a different take requires pinned randomness to replace.`);
  randomness.seed = seed;
  return { ...base, requestSnapshot: snapshot };
}

/**
 * Change Something: the same selected source plus a structured, job-kind-typed delta applied
 * to a copy of the request snapshot. `prompt` replaces the snapshot prompt; `parameters` are
 * shallow-merged (per-key upsert, never a deep merge); `directionNote` (take jobs only, per
 * spec 10 §8) is written to the snapshot so the params hash records it. The delta kind must
 * match the job operation and at least one change field is required, otherwise this would be
 * an unnamed Try Again.
 */
export function changeSomethingCommand(job: RetryableJob, delta: ChangeSomethingDelta, options?: RetryCommandOptions): RetryJobCommand {
  if (!delta || typeof delta !== "object") fail("Change Something requires a structured delta.");
  if (delta.kind !== job.operation) fail(`Change Something delta kind ${String(delta.kind)} does not match job ${job.id} operation ${job.operation}.`);
  const base = baseRetryCommand(job, options);
  const snapshot = clonedSnapshot(job);
  let changed = false;
  if ("directionNote" in delta && delta.directionNote !== undefined) {
    snapshot.directionNote = validatedText(delta.directionNote, "directionNote", 2000);
    changed = true;
  }
  if ("prompt" in delta && delta.prompt !== undefined) {
    snapshot.prompt = validatedText(delta.prompt, "prompt", 100_000);
    changed = true;
  }
  if ("parameters" in delta && delta.parameters !== undefined) {
    if (!isPlainObject(delta.parameters) || Object.keys(delta.parameters).length === 0) fail("Change Something parameters delta must be a non-empty JSON object.");
    if (!isPlainObject(snapshot.parameters)) fail(`Job ${job.id} request snapshot has no parameters object to patch.`);
    for (const [key, value] of Object.entries(delta.parameters)) snapshot.parameters[key] = value;
    changed = true;
  }
  if (!changed) fail("Change Something requires at least one delta field (directionNote, prompt, or parameters); use tryAgainCommand for an identical retry.");
  return { ...base, requestSnapshot: snapshot };
}
