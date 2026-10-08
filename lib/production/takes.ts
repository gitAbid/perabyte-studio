import { z } from "zod";
import {
  AnchorCandidateSchema, MotionSettingsSchema, ShotRevisionSchema, TakeSchema,
  type AnchorCandidate, type ProductionJob, type ShotRevision, type Take,
} from "./contracts";
import { ProductionApplicationError } from "./errors";
import {
  changeSomethingCommand, differentTakeCommand, tryAgainCommand,
  type ChangeSomethingDelta, type RetryJobCommand, type RetryableJob,
} from "./job-retry";

/**
 * Wave-3 take commands (spec 10). Pure derivation only — no IO, no React, no job writes.
 * `buildTakeGenerationCommand` composes one take generation from the shot's motion intent and
 * the approved anchor (model-facing prompt, validated `MotionSettings`, anchor start-frame
 * input, creator-visible summary). `buildTakeRetryCommand` is a thin creator-mode wrapper over
 * the frozen Wave-0 retry derivations in `job-retry.ts` (CONTRACTS-FROZEN C9): Try Again
 * reuses the identical request snapshot, Different Take replaces the pinned seed, Change
 * Something applies a structured take delta — every mode returns a NEW job id, a retry-suffixed
 * idempotency key and a `retryOf` back-link, never a mutation of the source job.
 * `recommendTake` picks an advisory recommendation from eligible takes (approved + completed
 * only); it never approves anything (CONTRACTS-FROZEN C8).
 */

/** Alias of the frozen `MotionSettingsSchema` shape (contracts exports no named type for it). */
export type MotionSettings = z.infer<typeof MotionSettingsSchema>;
/** The frozen richer job-status vocabulary (`ProductionJob["status"]`), projected onto takes. */
export type TakeJobStatus = ProductionJob["status"];
/** Motion defaults mirroring the accepted production take baseline (`PRODUCTION_MODEL_BASELINE.take[0]` in lib/providers/production/sogni-h3.ts) and the default portrait project format. Kept local so this pure-domain module stays dependency-free. */
export const TAKE_MOTION_DEFAULTS = {
  providerId: "sogni",
  modelId: "minimax-h3-fl2va-fp8_i2v_turbo",
  aspect: "9:16",
} as const;

export type TakeReferenceInput = { assetId: string; role: string; required: boolean };

/**
 * Everything required to submit one take generation, with the human-readable summary kept
 * separate from the model-facing prompt. The caller still owns `projectId`, the current anchor
 * approval id, `quoteId` and `idempotencyKey` (see `CreateTakeCommandSchema`); the exact
 * current anchor approval is required by the take service, so it is not invented here.
 */
export type TakeCommandDraft = {
  shotRevisionId: string;
  /** The approved anchor this take animates (its frame rides as the required start-frame input). */
  anchorId: string;
  /** Model-facing motion prompt: the motion settings prompt, echoed verbatim. */
  prompt: string;
  /** One plain-language line a creator can read before spending money. */
  summary: string;
  /** Validated motion settings, echoed verbatim. */
  motion: MotionSettings;
  /** Creator direction note carried for display and lineage; null when none was given. */
  directionNote: string | null;
  /** Reference video inputs shaped like the snapshot `inputs`; the anchor frame rides first. */
  inputs: TakeReferenceInput[];
};

const BuildTakeCommandInputSchema = z.strictObject({
  shot: ShotRevisionSchema,
  anchor: AnchorCandidateSchema,
  motion: MotionSettingsSchema.optional(),
  directionNote: z.string().max(2000).nullable().optional(),
});

const SUMMARY_INTENT_MAX_CHARS = 160;

const isPlainJsonObject = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function failInvalidInput(context: string, error: z.ZodError): never {
  const issue = error.issues[0];
  throw new ProductionApplicationError(
    "INVALID_INPUT",
    `${context} does not match the frozen contracts at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`,
  );
}

function fail(code: "INVALID_INPUT" | "UNKNOWN_REFERENCE", message: string): never {
  throw new ProductionApplicationError(code, message);
}

const firstPromptLine = (prompt: string): string => {
  const line = prompt.split("\n", 1)[0]?.trim() ?? "";
  const capped = line.length <= SUMMARY_INTENT_MAX_CHARS ? line : `${line.slice(0, SUMMARY_INTENT_MAX_CHARS - 1)}…`;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
};

/** Direction notes are optional but, when given, must be real text within the frozen 2000-char cap. */
function normalizeDirectionNote(directionNote: string | null | undefined): string | null {
  if (directionNote === undefined || directionNote === null) return null;
  const trimmed = directionNote.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) fail("INVALID_INPUT", "A direction note is limited to 2000 characters.");
  return trimmed;
}

/**
 * The model-facing motion prompt for a shot's motion intent, with an explicit creator
 * direction note folded in when given — so a fresh take with a note and a Change-Something
 * retake carry the note in the hashed request alike.
 */
export const composeTakeMotionPrompt = (motionIntent: string, directionNote: string | null): string =>
  directionNote === null ? motionIntent : `${motionIntent}\nDirection note: ${directionNote}`;

/**
 * Builds the take generation draft for one shot. The anchor must belong to the shot
 * (UNKNOWN_REFERENCE otherwise), so a take is never composed from a foreign frame. When no
 * explicit `motion` is given, motion is composed from the shot itself: the shot's
 * `motionIntent` becomes the prompt, `targetFrames` carries the shot duration, and the
 * production take baseline fills provider/model/aspect with an open seed. A direction note is
 * folded into the motion prompt (and echoed on the draft) so the generated params hash records it.
 */
export function buildTakeGenerationCommand(input: {
  shot: ShotRevision;
  anchor: AnchorCandidate;
  motion?: MotionSettings;
  directionNote?: string | null;
}): TakeCommandDraft {
  const parsed = BuildTakeCommandInputSchema.safeParse(input);
  if (!parsed.success) failInvalidInput("Take command input", parsed.error);
  const { shot, anchor, motion, directionNote } = parsed.data;

  if (anchor.shotRevisionId !== shot.id) {
    fail("UNKNOWN_REFERENCE", `Anchor ${anchor.id} belongs to shot revision ${anchor.shotRevisionId}, not ${shot.id}; resolve the approved anchor before generating a take.`);
  }
  const note = normalizeDirectionNote(directionNote ?? null);

  const resolvedMotion =
    motion ??
    MotionSettingsSchema.parse({
      providerId: TAKE_MOTION_DEFAULTS.providerId,
      modelId: TAKE_MOTION_DEFAULTS.modelId,
      prompt: composeTakeMotionPrompt(shot.motionIntent, note),
      targetFrames: shot.targetFrames,
      aspect: TAKE_MOTION_DEFAULTS.aspect,
      seed: null,
    });

  const summary = [
    `New take from the approved anchor — ${firstPromptLine(resolvedMotion.prompt)}`,
    `${resolvedMotion.targetFrames} frames at ${resolvedMotion.aspect}.`,
    note === null ? null : `Your direction: ${note}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return {
    shotRevisionId: shot.id,
    anchorId: anchor.id,
    prompt: resolvedMotion.prompt,
    summary,
    motion: resolvedMotion,
    directionNote: note,
    inputs: [{ assetId: anchor.assetId, role: "start_frame", required: true }],
  };
}

/* ------------------------------------------------------------------ */
/* Retry commands (delegate to the frozen job-retry derivations)        */
/* ------------------------------------------------------------------ */

export type TakeRetryMode = "tryAgain" | "differentTake" | "changeSomething";

/**
 * One take retry, ready for quote + enqueue: the Wave-0 `RetryJobCommand` (new id, `retryOf`
 * back-link, retry-suffixed idempotency key, updated request snapshot) plus the take command
 * pieces reconstructed from the updated snapshot. `Try Again` re-enqueues the identical
 * request under the retry idempotency key, so a double press replays instead of duplicating.
 */
export type TakeRetryDraft = {
  mode: TakeRetryMode;
  retry: RetryJobCommand;
  projectId: string;
  shotRevisionId: string;
  anchorId: string;
  /** The anchor approval id pinned by the retried snapshot; the service re-validates currency. */
  anchorApprovalId: string;
  motion: MotionSettings;
  /** Direction note attached by this retry (changeSomething), or the one already on the snapshot; null when none. */
  directionNote: string | null;
};

/**
 * Explicit fresh randomness for a Different Take, drawn from the platform CSPRNG when
 * available. The creator's button press is the explicit new-randomness act (spec 10 §8); the
 * resolved seed is echoed on the draft so the variation is inspectable, never silent.
 */
export function freshTakeSeed(): number {
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] ?? 0;
  }
  return Math.floor(Math.random() * 0xffffffff);
}

/** Parses the creator-supplied seed text; `undefined` means "draw a fresh explicit seed". */
function parseSeedInput(seed: string | undefined): number {
  if (seed === undefined) return freshTakeSeed();
  const trimmed = seed.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail("INVALID_INPUT", `A different take needs a whole-number seed of zero or more, received ${JSON.stringify(seed)}.`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    fail("INVALID_INPUT", `The seed ${JSON.stringify(seed)} is too large to be a safe integer; pick a shorter number.`);
  }
  return value;
}

/**
 * Reads the take command pieces back out of a retried request snapshot. This is a structural
 * read, not a strict schema parse: the C9 retry derivations legitimately write the additive
 * top-level `directionNote` onto the snapshot, which the current strict
 * `ProviderRequestSnapshotSchema` does not model yet. Only the fields the reconstructed
 * enqueue command needs are read; anything else is carried verbatim by `retry.requestSnapshot`.
 */
function takePiecesFromRetriedSnapshot(job: RetryableJob, retry: RetryJobCommand): {
  projectId: string;
  shotRevisionId: string;
  anchorId: string;
  anchorApprovalId: string;
  motion: MotionSettings;
  directionNote: string | null;
} {
  const snapshot: unknown = retry.requestSnapshot;
  if (!isPlainJsonObject(snapshot)) {
    fail("INVALID_INPUT", `Job ${job.id} request snapshot is not a parsable provider request, so it cannot be retried as a take.`);
  }
  const target = isPlainJsonObject(snapshot["resultTarget"]) ? snapshot["resultTarget"] : null;
  if (!target || target["kind"] !== "take") {
    fail("INVALID_INPUT", `Job ${job.id} request snapshot is not a take request (no take result target); it cannot be retried as a take.`);
  }
  const text = (value: unknown, label: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) {
      fail("INVALID_INPUT", `Job ${job.id} snapshot has no usable ${label}, so the take command cannot be reconstructed for a retry.`);
    }
    return value;
  };
  const parameters = isPlainJsonObject(snapshot["parameters"]) ? snapshot["parameters"] : {};
  const frameCount = parameters["frameCount"];
  if (typeof frameCount !== "number" || !Number.isSafeInteger(frameCount) || frameCount <= 0) {
    fail("INVALID_INPUT", `Job ${job.id} snapshot has no usable frame count, so its motion settings cannot be reconstructed for a retry.`);
  }
  const aspectParse = z.enum(["9:16", "16:9"]).safeParse(parameters["aspect"]);
  if (!aspectParse.success) {
    fail("INVALID_INPUT", `Job ${job.id} snapshot aspect is not 9:16 or 16:9, so its motion settings cannot be reconstructed for a retry.`);
  }
  const rawSeed = parameters["seed"];
  const seed = typeof rawSeed === "number" && Number.isSafeInteger(rawSeed) && rawSeed >= 0 ? rawSeed : null;
  const motionParse = MotionSettingsSchema.safeParse({
    providerId: text(snapshot["providerId"], "provider id"),
    modelId: text(snapshot["modelId"], "model id"),
    prompt: text(snapshot["prompt"], "prompt"),
    targetFrames: frameCount,
    aspect: aspectParse.data,
    seed,
  });
  if (!motionParse.success) failInvalidInput(`Motion settings reconstructed from job ${job.id}`, motionParse.error);
  const rawNote = snapshot["directionNote"];
  return {
    projectId: text(snapshot["projectId"], "project id"),
    shotRevisionId: text(target["shotRevisionId"], "shot revision id"),
    anchorId: text(target["anchorId"], "anchor id"),
    anchorApprovalId: text(target["anchorApprovalId"], "anchor approval id"),
    motion: motionParse.data,
    directionNote: typeof rawNote === "string" && rawNote.length > 0 ? rawNote : null,
  };
}

/**
 * Bridge to the frozen Different-Take derivation. The take service stores the seed flat in
 * `parameters.seed` (lib/services/production/takes.ts `buildMediaContext`), while
 * `differentTakeCommand` replaces the seed inside a `randomness` block. For snapshots that
 * carry only the flat seed, project a `randomness` mirror of it so the seed replacement
 * itself still happens in the Wave-0 helper, then translate the replaced seed back onto the
 * real snapshot copy. Snapshots that already pin randomness (or pin neither shape) flow
 * through the helper untouched — including its fail-closed "no randomness" error.
 */
function bridgedDifferentTake(job: RetryableJob, seed: number): RetryJobCommand {
  const source: unknown = job.requestSnapshot;
  if (!isPlainJsonObject(source)) return differentTakeCommand(job, seed);
  const parameters = isPlainJsonObject(source.parameters) ? source.parameters : null;
  const hasRandomness = source.randomness !== undefined || parameters?.randomness !== undefined;
  const flatSeed = parameters && typeof parameters["seed"] === "number" ? (parameters["seed"] as number) : null;
  if (hasRandomness || flatSeed === null) return differentTakeCommand(job, seed);
  const projected = structuredClone(source) as { parameters: { seed: number }; randomness: { seed: number } };
  projected.randomness = { seed: flatSeed };
  const retry = differentTakeCommand({ ...job, requestSnapshot: projected as typeof job.requestSnapshot }, seed);
  const snapshot = retry.requestSnapshot as { parameters: { seed: number }; randomness?: { seed: number } };
  snapshot.parameters["seed"] = snapshot.randomness?.seed ?? seed;
  delete snapshot.randomness;
  return { ...retry, requestSnapshot: snapshot as typeof job.requestSnapshot };
}

/**
 * Builds one take retry by delegating to the Wave-0 job-retry helpers — there is deliberately
 * no parallel retry implementation here. `tryAgain` derives an identical request; `differentTake`
 * replaces the pinned seed (drawn explicitly when `seed` is omitted, since a different take
 * cannot exist without new randomness); `changeSomething` attaches the structured take delta,
 * folding `directionNote` in so the params hash records it. The source job must be a take job
 * with a parsable take request snapshot; violations fail closed before anything is enqueued.
 */
export function buildTakeRetryCommand(input: {
  job: RetryableJob;
  mode: TakeRetryMode;
  /** Creator-supplied seed for `differentTake`; a whole-number string. Omitted draws a fresh explicit seed. */
  seed?: string;
  /** Structured delta for `changeSomething`; requires at least one change field. */
  delta?: ChangeSomethingDelta;
  /** Creator direction note for `changeSomething`; folded into the delta. */
  directionNote?: string | null;
}): TakeRetryDraft {
  const { job, mode, seed, delta, directionNote } = input;
  if (!job || typeof job !== "object") fail("INVALID_INPUT", "A take retry requires the source generation job.");
  if (job.operation !== "take") {
    fail("INVALID_INPUT", `Job ${job.id} is a ${job.operation} job; only take jobs can be retried as takes.`);
  }

  let retry: RetryJobCommand;
  let note: string | null = null;
  switch (mode) {
    case "tryAgain":
      retry = tryAgainCommand(job);
      break;
    case "differentTake":
      retry = bridgedDifferentTake(job, parseSeedInput(seed));
      break;
    case "changeSomething": {
      note = normalizeDirectionNote(directionNote ?? null);
      if (delta !== undefined && delta.kind !== "take") {
        fail("INVALID_INPUT", `Change Something on a take requires a take delta, received a ${delta.kind} delta.`);
      }
      const base: ChangeSomethingDelta = delta ?? { kind: "take" };
      const merged: ChangeSomethingDelta = note === null ? base : { ...base, kind: "take", directionNote: note };
      retry = changeSomethingCommand(job, merged);
      break;
    }
    default:
      fail("INVALID_INPUT", `Unknown take retry mode ${String(mode)}; use tryAgain, differentTake or changeSomething.`);
  }

  const pieces = takePiecesFromRetriedSnapshot(job, retry);
  const appliedNote = mode === "changeSomething" ? note ?? pieces.directionNote : pieces.directionNote;
  return {
    mode,
    retry,
    projectId: pieces.projectId,
    shotRevisionId: pieces.shotRevisionId,
    anchorId: pieces.anchorId,
    anchorApprovalId: pieces.anchorApprovalId,
    // The note rides in the motion prompt too, so the re-enqueued request acts on it (and
    // hashes it) exactly like a fresh take generated with the same direction.
    motion: appliedNote === null ? pieces.motion : { ...pieces.motion, prompt: composeTakeMotionPrompt(pieces.motion.prompt, appliedNote) },
    directionNote: appliedNote,
  };
}

/* ------------------------------------------------------------------ */
/* Recommendation + history summary                                     */
/* ------------------------------------------------------------------ */

const TakeListSchema = z.array(TakeSchema).max(10_000);

/**
 * Eligibility context a caller with the full read model should provide. A take is only
 * recommendable when its generation job completed AND it carries a current human approval;
 * criteria whose set is omitted cannot be checked and are treated as satisfied (the caller
 * then owns the honesty of the input).
 */
export interface TakeEligibilityContext {
  /** Job ids whose take job reached `completed`. */
  completedJobIds?: ReadonlySet<string>;
  /** Take ids carrying a current human approval. */
  approvedTakeIds?: ReadonlySet<string>;
}

const hasRecommendationMarker = (take: Take): boolean =>
  take.recommendation === "recommended" || (take.recommendedAt ?? null) !== null;

/**
 * Recommends the strongest eligible take — mirror of the anchor ranking discipline
 * (lib/production/anchors.ts): eligibility first (approved + completed per the context),
 * then a pipeline-authored recommendation marker, then the newest take, then id order for
 * determinism. Returns null when nothing qualifies — a recommendation is advisory only and
 * never approves or selects anything (CONTRACTS-FROZEN C8).
 */
export function recommendTake(takes: Take[], context?: TakeEligibilityContext): Take | null {
  const parsed = TakeListSchema.safeParse(takes);
  if (!parsed.success) failInvalidInput("Take list", parsed.error);

  const eligible = parsed.data.filter((take) =>
    (context?.completedJobIds ? context.completedJobIds.has(take.jobId) : true) &&
    (context?.approvedTakeIds ? context.approvedTakeIds.has(take.id) : true));
  const sorted = [...eligible].sort((left, right) =>
    (hasRecommendationMarker(right) ? 1 : 0) - (hasRecommendationMarker(left) ? 1 : 0) ||
    right.createdAt - left.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sorted[0] ?? null;
}

export interface TakeHistoryContext {
  /** Currently selected take id for this shot (read-model selection pin), if any. */
  selectedTakeId?: string | null;
  /** Job status per job id; takes without a known status count toward `total` only. */
  jobStatusById?: ReadonlyMap<string, TakeJobStatus>;
}

export type TakeHistorySummary = {
  total: number;
  completed: number;
  failed: number;
  /** Known in-flight takes (queued, running, or otherwise not yet terminal). */
  running: number;
  selectedId: string | null;
};

/**
 * Counts one shot's take history by job status. `total` minus the three status buckets is the
 * number of takes whose job status is unknown to the caller, so the numbers never pretend a
 * take finished (or failed) without evidence.
 */
export function summarizeTakeHistory(takes: Take[], context?: TakeHistoryContext): TakeHistorySummary {
  const parsed = TakeListSchema.safeParse(takes);
  if (!parsed.success) failInvalidInput("Take list", parsed.error);

  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const take of parsed.data) {
    const status = context?.jobStatusById?.get(take.jobId);
    if (status === "completed") completed += 1;
    else if (status === "failed" || status === "canceled") failed += 1;
    else if (status !== undefined) running += 1;
  }
  return { total: parsed.data.length, completed, failed, running, selectedId: context?.selectedTakeId ?? null };
}
