import { randomUUID } from "node:crypto";
import { MetricEventSchema, type MetricEvent, type MetricEventKind } from "../../production/contracts";
import { logger } from "../../logging/logger";
import type { ProductionStore } from "../../repositories/production/ports";

/* ────────────────────────────────────────────────────────────────────────────
 * C19 product metrics (spec 01 §7 / 17, M4). Metric writes are BEST-EFFORT:
 * a failed metric write never fails the domain operation. Projections are
 * pure, computed at read time, and null-safe when data is missing.
 * ──────────────────────────────────────────────────────────────────────────── */

const log = logger.child({ scope: "production-metrics" });

/** dims key marking a generation as proposal-driven; absence is the manual-prompt-count proxy. */
export const PROPOSAL_LINKAGE_DIM = "proposalId";
/** dims key (value "true") marking a completed generation whose take was selected into the cut. */
export const SELECTED_DIM = "selected";
/** dims key carrying the asset kind (character | environment | storyboard | take | …) for acceptance rates. */
export const ASSET_KIND_DIM = "assetKind";
/** dims key matching asset_recommended to asset_approved events for review-time deltas. */
export const ASSET_ID_DIM = "assetId";

export type RecordMetricEventInput = Omit<MetricEvent, "version" | "id"> & { id?: string };

/**
 * Records one product metric event. Stamps `version` (always 1) and `id` (when the
 * caller did not supply a valid one), then inserts inside its own store transaction.
 * NEVER throws: validation, store, and transaction failures are swallowed and logged
 * so a failed metric write can never fail the surrounding domain operation.
 */
export function recordMetricEvent(store: ProductionStore, command: RecordMetricEventInput): void {
  try {
    const event = MetricEventSchema.parse({ ...command, id: command.id ?? `metric-${randomUUID()}`, version: 1 });
    store.transaction((tx) => tx.insertMetricEvent(event));
  } catch (error) {
    log.warn("Metric event write failed; metric recording is best-effort and never blocks the domain operation.", {
      kind: command.kind,
      projectId: command.projectId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface GenerationMetricInput {
  projectId: string | null;
  workspaceId?: string | null;
  kind: MetricEventKind;
  /** Event time; defaults to the current wall clock. */
  at?: number;
  durationMs?: number | null;
  costMicros?: number | null;
  /** Bounded free-form dimensions interpreted by the projections. */
  dims?: Record<string, string>;
}

/** Convenience wrapper over recordMetricEvent with sensible defaults for lifecycle events. */
export function recordGeneration(store: ProductionStore, input: GenerationMetricInput): void {
  recordMetricEvent(store, {
    projectId: input.projectId,
    workspaceId: input.workspaceId ?? null,
    kind: input.kind,
    at: input.at ?? Date.now(),
    durationMs: input.durationMs ?? null,
    costMicros: input.costMicros ?? null,
    ...(input.dims ? { dims: input.dims } : {}),
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Projections (pure, computed at read)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProductionMetricsExtras {
  /** Project creation time — the origin for both time-to-first metrics. */
  projectCreatedAt?: number | null;
  /** When the first storyboard became available (animatic createdAt; shot plan fallback). */
  firstStoryboardAt?: number | null;
  /** When the first playable cut became available (first ready_for_review/approved export). */
  firstCutAt?: number | null;
  /** Finished runtime of the delivered cut, from the export manifest (frames ÷ fps). */
  finishedMinuteDurationMs?: number | null;
  /** Distinct takes selected into the delivered cut (manifest take set); preferred over the event dim. */
  selectedTakeCount?: number | null;
}

export interface AcceptanceRateProjection {
  approved: number;
  rejected: number;
  /** approved ÷ (approved + rejected); null while no decisions exist for the kind. */
  rate: number | null;
}

export interface ProductionMetricsProjection {
  eventCount: number;
  generations: {
    completed: number;
    failed: number;
    /** Proxy for manual prompt count: generation events without a proposal linkage dim. */
    manualPromptCount: number;
  };
  /** Per dims.assetKind acceptance rate (approved ÷ (approved + rejected)). */
  acceptanceRates: Record<string, AcceptanceRateProjection>;
  generatedSelected: {
    generated: number;
    selected: number | null;
    /** generated ÷ selected; null while nothing has been selected. */
    ratio: number | null;
  };
  cost: {
    totalMicros: number;
    /** totalMicros scaled to one finished minute of delivered runtime; null without a finished minute duration. */
    perFinishedMinuteMicros: number | null;
  };
  /** Median asset_recommended → asset_approved delta; null without matched pairs. */
  reviewTimeMedianMs: number | null;
  reviewTimeSamples: number;
  timeToFirstStoryboardMs: number | null;
  timeToFirstCutMs: number | null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const elapsedMs = (from: number | null | undefined, to: number | null | undefined): number | null =>
  isFiniteNumber(from) && isFiniteNumber(to) && from >= 0 && to >= from ? to - from : null;
const share = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null);
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const dimsOf = (event: MetricEvent): Record<string, string> => event.dims ?? {};
const REJECTION_KINDS = new Set<MetricEventKind>(["asset_approved", "review_completed"]);

export function projectProductionMetrics(
  events: readonly MetricEvent[],
  extras: ProductionMetricsExtras = {},
): ProductionMetricsProjection {
  const ordered = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const generations = ordered.filter((event) => event.kind === "generation_completed" || event.kind === "generation_failed");
  const completed = generations.filter((event) => event.kind === "generation_completed").length;

  const acceptance = new Map<string, { approved: number; rejected: number }>();
  for (const event of ordered) {
    const dims = dimsOf(event);
    const assetKind = dims[ASSET_KIND_DIM];
    if (!assetKind) continue;
    const rejected = dims.decision === "rejected" && REJECTION_KINDS.has(event.kind);
    const approved = event.kind === "asset_approved" && dims.decision !== "rejected";
    if (!approved && !rejected) continue;
    const bucket = acceptance.get(assetKind) ?? { approved: 0, rejected: 0 };
    if (approved) bucket.approved += 1;
    else bucket.rejected += 1;
    acceptance.set(assetKind, bucket);
  }
  const acceptanceRates: Record<string, AcceptanceRateProjection> = {};
  for (const [assetKind, bucket] of acceptance) {
    acceptanceRates[assetKind] = { ...bucket, rate: share(bucket.approved, bucket.approved + bucket.rejected) };
  }

  const selectedFromEvents = ordered.filter((event) => event.kind === "generation_completed" && dimsOf(event)[SELECTED_DIM] === "true").length;
  const selected = isFiniteNumber(extras.selectedTakeCount) ? extras.selectedTakeCount : selectedFromEvents;

  const totalMicros = ordered.reduce((sum, event) => sum + (isFiniteNumber(event.costMicros) ? event.costMicros : 0), 0);
  const finishedMinuteDurationMs = isFiniteNumber(extras.finishedMinuteDurationMs) ? extras.finishedMinuteDurationMs : null;
  const perFinishedMinuteMicros =
    finishedMinuteDurationMs !== null && finishedMinuteDurationMs > 0 ? Math.round((totalMicros * 60_000) / finishedMinuteDurationMs) : null;

  // Review-time median: for each asset_approved, the delta to the latest earlier
  // asset_recommended for the same assetId dim; pairs without a dim or a nonnegative
  // delta are skipped, so the median stays honest instead of invented.
  const latestRecommendedAt = new Map<string, number>();
  const reviewDeltas: number[] = [];
  for (const event of ordered) {
    const assetId = dimsOf(event)[ASSET_ID_DIM];
    if (!assetId) continue;
    if (event.kind === "asset_recommended") latestRecommendedAt.set(assetId, event.at);
    if (event.kind === "asset_approved") {
      const delta = elapsedMs(latestRecommendedAt.get(assetId), event.at);
      if (delta !== null) reviewDeltas.push(delta);
    }
  }

  return {
    eventCount: ordered.length,
    generations: { completed, failed: generations.length - completed, manualPromptCount: generations.filter((event) => dimsOf(event)[PROPOSAL_LINKAGE_DIM] === undefined).length },
    acceptanceRates,
    generatedSelected: { generated: completed, selected, ratio: selected !== null && selected > 0 ? completed / selected : null },
    cost: { totalMicros, perFinishedMinuteMicros },
    reviewTimeMedianMs: median(reviewDeltas),
    reviewTimeSamples: reviewDeltas.length,
    timeToFirstStoryboardMs: elapsedMs(extras.projectCreatedAt, extras.firstStoryboardAt),
    timeToFirstCutMs: elapsedMs(extras.projectCreatedAt, extras.firstCutAt),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Read-side snapshot loader (pure store reads; null when the project is unknown)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProductionMetricsSnapshot {
  project: { id: string; name: string; createdAt: number };
  events: MetricEvent[];
  extras: ProductionMetricsExtras;
  projection: ProductionMetricsProjection;
}

/**
 * Loads one project's metric events plus cheap extras derived from existing domain
 * data: the active animatic (shot-plan fallback) for the first storyboard, the first
 * ready_for_review/approved export for the first playable cut, and the newest
 * playable export's manifest for finished minutes (frames ÷ fps) and the selected
 * take set. Every extra is null when its artifact does not exist yet.
 */
export function loadProductionMetricsSnapshot(store: ProductionStore, projectId: string): ProductionMetricsSnapshot | null {
  const project = store.read.getProject(projectId);
  if (!project) return null;
  const events = store.read.listMetricEvents(projectId);
  const animatic = project.activeAnimaticRevisionId ? store.read.getAnimaticRevision(project.activeAnimaticRevisionId) : null;
  const shotPlan = project.activeShotPlanRevisionId ? store.read.getShotPlanRevision(project.activeShotPlanRevisionId) : null;
  const playableExports = store.read
    .listProjectExports(projectId)
    .filter((record) => record.status === "ready_for_review" || record.status === "approved")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const firstPlayable = playableExports[0] ?? null;
  const latestPlayable = playableExports[playableExports.length - 1] ?? null;
  const manifest = latestPlayable ? store.read.getManifest(latestPlayable.manifestId) : null;
  const manifestShots = manifest && Array.isArray(manifest.shots) ? manifest.shots : [];
  const fps = typeof manifest?.profile?.fps === "number" && manifest.profile.fps > 0 ? manifest.profile.fps : null;
  const totalFrames = manifestShots.reduce((sum, shot) => sum + (shot.endFrame - shot.startFrame), 0);
  const extras: ProductionMetricsExtras = {
    projectCreatedAt: project.createdAt,
    firstStoryboardAt: animatic?.createdAt ?? shotPlan?.createdAt ?? null,
    firstCutAt: firstPlayable?.createdAt ?? null,
    finishedMinuteDurationMs: manifestShots.length > 0 && fps !== null && totalFrames > 0 ? Math.round((totalFrames * 1000) / fps) : null,
    selectedTakeCount: manifest ? new Set(manifestShots.map((shot) => shot.takeId)).size : null,
  };
  return {
    project: { id: project.id, name: project.name, createdAt: project.createdAt },
    events,
    extras,
    projection: projectProductionMetrics(events, extras),
  };
}
