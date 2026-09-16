import { asJobProvider, ProviderError, type GeneratedArtifact, type ImageProvider, type ProviderProgress, type VideoProvider } from "@/lib/providers/types";
import type { AspectKey, ResolutionKey } from "@/lib/constants";
import { getGenerationRegistry } from "@/lib/providers/registry";
import {
  getJobsRepository,
  listRecoverableJobsRepository,
  patchJobRepository,
  putJobRepository,
  type JobRecord,
} from "@/lib/repositories/jobs.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import {
  GenerationServiceError,
  persistArtifacts,
  prepareGeneration,
} from "@/lib/services/generation.service";
import { logger as rootLogger, type Logger } from "@/lib/logging/logger";

/**
 * The durable job engine (Phase B). One in-flight render per (provider,
 * kind) lane, FIFO; every job's provider ref is persisted at submit so a
 * restarted server re-attaches the poll loop from the record. Time is owned
 * here, not by a held-open request:
 *
 * - provider reports failure → job failed (retryable per provider);
 * - staleness — no successful poll for 2× the configured window
 *   (Settings → Render timeouts, "Staleness limit") → failed retryable.
 *   Polling every few seconds IS the probe; a backed-up render keeps
 *   polling indefinitely because every poll touches the heartbeat;
 * - absolute cap per job (30 min images / 60 min videos) → failed
 *   retryable — the safety valve over everything else.
 *
 * Jobs on non-job providers (Pollinations) run inline under a timeout
 * signal — they have no persisted ref, so only the cap applies.
 */

/** Absolute caps — the safety valve over staleness. */
export const JOB_CAP_MS = { image: 30 * 60_000, video: 60 * 60_000 } as const;

const DEFAULT_POLL_INTERVAL_MS = 2_500;
/** Progress persistence throttle (the file write, not the live tick). */
const PROGRESS_PERSIST_MS = 5_000;

export interface ExecutorOptions {
  pollIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  /** Test seams — default to the real generation service pipeline. */
  prepareImpl?: typeof prepareGeneration;
  persistImpl?: typeof persistArtifacts;
  /** Test hook: skip boot recovery (set manually instead). */
  autoRecover?: boolean;
}

export class JobExecutor {
  private lanes = new Map<string, { queue: string[]; busy: boolean }>();
  private readonly pollIntervalMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly prepare: typeof prepareGeneration;
  private readonly persist: typeof persistArtifacts;
  private recovered = false;

  constructor(options: ExecutorOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleepImpl =
      options.sleepImpl ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.log = (options.logger ?? rootLogger).child({ module: "job-executor" });
    this.prepare = options.prepareImpl ?? prepareGeneration;
    this.persist = options.persistImpl ?? persistArtifacts;
    if (options.autoRecover !== false) this.recover();
  }

  /** Persist a validated job as queued and slot it into its lane. */
  enqueue(job: JobRecord): JobRecord {
    const stored = putJobRepository(job);
    const key = this.laneKey(stored);
    this.lane(key).queue.push(stored.id);
    this.log.info("job queued", { jobId: stored.id, lane: key });
    this.kick(key);
    return stored;
  }

  /** Cancel a queued (dequeue + mark) or running (mark; the loop exits). */
  cancel(jobId: string): JobRecord | null {
    const job = getJobsRepository(jobId);
    if (!job) return null;
    if (job.status === "queued") {
      const lane = this.lanes.get(this.laneKey(job));
      if (lane) lane.queue = lane.queue.filter((id) => id !== jobId);
      return patchJobRepository(jobId, { status: "canceled", finishedAt: this.now() });
    }
    if (job.status === "running") {
      // The poll loop notices the status flip on its next iteration and
      // cancels the provider job best-effort.
      return patchJobRepository(jobId, { status: "canceled", finishedAt: this.now() });
    }
    return job;
  }

  /** Boot re-attach: queued jobs re-enter their lanes; running jobs with a
   * persisted ref resume their poll loops; anything else failed retryably. */
  recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    const jobs = listRecoverableJobsRepository();
    if (!jobs.length) return;
    this.log.info("recovering jobs after restart", { count: jobs.length });
    for (const job of jobs) {
      if (job.status === "queued") {
        const key = this.laneKey(job);
        this.lane(key).queue.push(job.id);
        this.kick(key);
        continue;
      }
      // running
      if (job.providerRef) {
        // A persisted provider ref is resumable: re-derive the effective
        // model through the normal pipeline (which owns frame bytes and the
        // possibly frame-swapped provider that holds the ref).
        this.log.info("re-attaching running job from persisted ref", {
          jobId: job.id,
          ref: job.providerRef,
        });
        const elapsed = this.now() - (job.startedAt ?? job.createdAt);
        void (async () => {
          try {
            const prepared = await this.prepare(
              job.request as unknown as Parameters<typeof prepareGeneration>[0],
              this.log.child({ jobId: job.id }),
            );
            const preparedJobProvider = asJobProvider(prepared.provider);
            if (!preparedJobProvider) {
              throw new ProviderError(
                "This render cannot be resumed after the restart. Please re-run it.",
                { retryable: true },
              );
            }
            await this.pollLoop(job.id, job.providerRef as string, preparedJobProvider, prepared, elapsed);
          } catch (error) {
            patchJobRepository(job.id, {
              status: "failed",
              error:
                (error as Error)?.message ??
                "This render could not be resumed after the restart. Please re-run it.",
              retryable: true,
              finishedAt: this.now(),
            });
          }
        })();
        continue;
      }
      patchJobRepository(job.id, {
        status: "failed",
        error:
          "The server restarted while this render was in flight and it cannot be resumed. Please re-run it.",
        retryable: true,
        finishedAt: this.now(),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lane machinery                                                    */
  /* ---------------------------------------------------------------- */

  private laneKey(job: Pick<JobRecord, "provider" | "kind">): string {
    return `${job.provider}:${job.kind}`;
  }

  private lane(key: string): { queue: string[]; busy: boolean } {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { queue: [], busy: false };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private kick(key: string): void {
    const lane = this.lane(key);
    if (lane.busy || !lane.queue.length) return;
    const jobId = lane.queue.shift() as string;
    lane.busy = true;
    void this.runJob(jobId).finally(() => {
      lane.busy = false;
      this.kick(key);
    });
  }

  private providerFor(job: Pick<JobRecord, "modelId">) {
    const resolved = getGenerationRegistry().resolve(job.modelId);
    return resolved?.provider ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Execution                                                         */
  /* ---------------------------------------------------------------- */

  private async runJob(jobId: string): Promise<void> {
    const startedAt = this.now();
    patchJobRepository(jobId, { status: "running", startedAt });
    const job = getJobsRepository(jobId);
    if (!job) return;

    let log: Logger = this.log.child({ jobId, provider: job.provider, kind: job.kind });
    try {
      const prepared = await this.prepare(
        job.request as unknown as Parameters<typeof prepareGeneration>[0],
        log,
      );
      log = prepared.log;
      if (prepared.swapped) {
        patchJobRepository(jobId, {
          effectiveModelId: prepared.model.id,
          effectiveModelLabel: prepared.model.label,
        });
      }

      const jobProvider = asJobProvider(prepared.provider);
      if (jobProvider) {
        const { ref } = await jobProvider.submitJob(prepared.normalized, prepared.model, {
          logger: log,
          onProgress: (progress) => this.recordProgress(jobId, progress),
        });
        patchJobRepository(jobId, { providerRef: ref });
        log.info("provider job submitted", { ref });
        await this.pollLoop(jobId, ref, jobProvider, prepared, 0);
        return;
      }

      // Non-job provider (Pollinations): inline under the absolute cap.
      const capMs = JOB_CAP_MS[job.kind];
      const ctx = {
        logger: log,
        signal: AbortSignal.timeout(capMs),
        onProgress: (progress: ProviderProgress) => this.recordProgress(jobId, progress),
      };
      const artifacts =
        job.kind === "video"
          ? await (prepared.provider as VideoProvider).generateVideo(prepared.normalized, prepared.model, ctx)
          : await (prepared.provider as ImageProvider).generateImage(prepared.normalized, prepared.model, ctx);
      await this.completeJob(jobId, artifacts, prepared, log);
    } catch (error) {
      this.failFromError(jobId, error, log);
    }
  }

  /**
   * The poll loop for a submitted (or re-attached) provider job. Every loop
   * re-reads the record — a `canceled` flip is honored within one interval.
   */
  private async pollLoop(
    jobId: string,
    ref: string,
    jobProvider: NonNullable<ReturnType<typeof asJobProvider>>,
    prepared: Awaited<ReturnType<typeof prepareGeneration>>,
    alreadyElapsedMs: number,
  ): Promise<void> {
    const stalenessMs = getProviderConfig().renderTimeouts.staleness * 1_000;
    const capMs = JOB_CAP_MS[prepared.normalized.kind] - alreadyElapsedMs;
    const startedAt = this.now();
    let heartbeat = startedAt;
    let lastProgressKey = "";
    let lastProgressPersist = 0;

    while (true) {
      const current = getJobsRepository(jobId);
      if (!current || current.status !== "running") {
        // Canceled (or removed) — stop the provider job best-effort.
        await jobProvider.cancelJob?.(ref).catch(() => {});
        this.log.info("job loop exited", { jobId, status: current?.status ?? "gone" });
        return;
      }
      if (this.now() - startedAt > capMs) {
        await jobProvider.cancelJob?.(ref).catch(() => {});
        patchJobRepository(jobId, {
          status: "failed",
          error: `This render hit the ${Math.round(JOB_CAP_MS[prepared.normalized.kind] / 60_000)}-minute limit while still running on the provider. Retry it, or raise the limit in Settings → Render timeouts.`,
          retryable: true,
          finishedAt: this.now(),
        });
        return;
      }
      if (this.now() - heartbeat > 2 * stalenessMs) {
        await jobProvider.cancelJob?.(ref).catch(() => {});
        patchJobRepository(jobId, {
          status: "failed",
          error: `The provider stopped reporting progress for over ${Math.round((2 * stalenessMs) / 60_000)} minutes, so this render was stopped. Retry it, or raise the staleness limit in Settings → Render timeouts.`,
          retryable: true,
          finishedAt: this.now(),
        });
        return;
      }

      let result;
      try {
        result = await jobProvider.pollJob(ref, prepared.normalized, prepared.model, {
          logger: this.log.child({ jobId }),
          onProgress: (progress) => this.recordProgress(jobId, progress),
        });
      } catch (error) {
        // A throwing poll is a transient probe failure, not a render failure
        // — keep polling; staleness catches a provider that never recovers.
        this.log.warn("poll errored — will retry", { jobId, error: describeError(error) });
        await this.sleepImpl(this.pollIntervalMs);
        continue;
      }

      if (result.status === "completed") {
        await this.completeJob(jobId, result.artifacts, prepared, this.log.child({ jobId }));
        return;
      }
      if (result.status === "failed") {
        patchJobRepository(jobId, {
          status: "failed",
          error: result.message,
          retryable: result.retryable,
          finishedAt: this.now(),
        });
        this.log.warn("job failed by provider", { jobId, message: result.message });
        return;
      }

      heartbeat = this.now();
      const progress = result.progress;
      if (progress) {
        const key = `${progress.message}:${progress.percent ?? ""}`;
        if (key !== lastProgressKey || this.now() - lastProgressPersist > PROGRESS_PERSIST_MS) {
          lastProgressKey = key;
          lastProgressPersist = this.now();
          patchJobRepository(jobId, { progress });
        }
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  private async completeJob(
    jobId: string,
    artifacts: GeneratedArtifact[],
    prepared: Awaited<ReturnType<typeof prepareGeneration>>,
    log: Logger,
  ): Promise<void> {
    try {
      const media = await this.persist(
        artifacts,
        prepared.normalized.aspect,
        prepared.normalized.resolution,
        log,
      );
      patchJobRepository(jobId, {
        status: "completed",
        result: media,
        progress: undefined,
        finishedAt: this.now(),
        frameUsed:
          prepared.hadStartImage && artifacts[0]?.frameDropped !== true
            ? true
            : artifacts[0]?.frameDropped === true
              ? false
              : undefined,
      });
      log.info("job completed", { jobId, media: media.length });
    } catch (error) {
      this.failFromError(jobId, error, log);
    }
  }

  private failFromError(jobId: string, error: unknown, log: Logger): void {
    const current = getJobsRepository(jobId);
    if (!current || (current.status !== "running" && current.status !== "queued")) return;
    if (error instanceof GenerationServiceError) {
      patchJobRepository(jobId, {
        status: "failed",
        error: error.message,
        retryable: error.retryable,
        finishedAt: this.now(),
      });
      return;
    }
    if (error instanceof ProviderError) {
      patchJobRepository(jobId, {
        status: "failed",
        error: error.message,
        retryable: error.retryable,
        finishedAt: this.now(),
      });
      log.warn("job failed by provider", { jobId, message: error.message });
      return;
    }
    patchJobRepository(jobId, {
      status: "failed",
      error: (error as Error)?.message ?? "The render failed unexpectedly.",
      retryable: true,
      finishedAt: this.now(),
    });
    log.error("job failed unexpectedly", { jobId, error });
  }

  private recordProgress(jobId: string, progress: ProviderProgress): void {
    const job = getJobsRepository(jobId);
    if (!job || job.status !== "running") return;
    patchJobRepository(jobId, { progress });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Process singleton                                                   */
/* ------------------------------------------------------------------ */

let instance: JobExecutor | null = null;
let override: JobExecutor | null = null;

/** The process executor (constructs lazily; recovery runs once). */
export function getJobExecutor(): JobExecutor {
  if (override) return override;
  instance ??= new JobExecutor();
  return instance;
}

/** Test hook: swap the executor wholesale. */
export function setJobExecutorForTests(executor: JobExecutor | null): void {
  override = executor;
}
