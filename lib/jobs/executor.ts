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
import { getStoriesRepository, patchStoryRepository } from "@/lib/repositories/stories.repository";
import { deriveEndFrameRefServerSide } from "@/lib/media/frame-server";
import {
  advanceSceneAfterKeyframe,
  advanceStoryChain,
  storyCast,
} from "@/lib/story/server-runner";
import { sceneCast } from "@/lib/story/compose-shot";
import { buildGateExpectations } from "@/lib/story/keyframe";
import { getLocationsRepository } from "@/lib/repositories/locations.repository";
import { scoreKeyframeRef } from "@/lib/services/keyframe-gate.service";
import { onKeyframeGate } from "@/lib/story/consistency-hooks";
import { putRecord } from "@/lib/services/records.service";
import { warmModeration } from "@/lib/services/moderation.service";
import { titleFromPrompt } from "@/lib/constants";
import type { Asset, GenerationSettings, SceneScore } from "@/lib/types";
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
      const job = getJobsRepository(jobId);
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

      // Server-side absorption (Phase B): a completed job lands in its
      // consumer even when no browser is watching — a story scene patch for
      // tagged jobs, a keyframe + gate for `k_`-tagged jobs, a History asset
      // for solo renders. Idempotent with the client runner's own writes
      // (same values, same ids).
      if (!job) return;
      const tag = parseStoryTag(job.clientTag);
      if (tag?.kind === "scene") {
        this.absorbStoryScene(jobId, tag.storyId, tag.sceneId, media, prepared, log);
      } else if (tag?.kind === "keyframe") {
        await this.absorbStoryKeyframe(jobId, tag.storyId, tag.sceneId, media, prepared, log);
      } else {
        const assetId = this.absorbSoloAsset(jobId, job, media, prepared, log);
        patchJobRepository(jobId, { assetId });
      }
    } catch (error) {
      this.failFromError(jobId, error, log);
    }
  }

  /** Attach a finished job's media to its story scene — only while the
   * scene is still generating (a re-queued scene wants the NEW render) —
   * then advance the server-side chain. */
  private async absorbStoryScene(
    jobId: string,
    storyId: string,
    sceneId: string,
    media: Awaited<ReturnType<typeof this.persist>>,
    prepared: Awaited<ReturnType<typeof prepareGeneration>>,
    log: Logger,
  ): Promise<void> {
    const story = getStoriesRepository(storyId);
    if (!story?.scenes) return;
    const scene = story.scenes.find((sc) => sc.id === sceneId);
    if (!scene || scene.status !== "generating") {
      log.info("scene absorb skipped (scene not generating)", { jobId, sceneId });
      return;
    }
    const primary = media[0];
    // Chain end frame, server-side: provider export → the image itself →
    // ffmpeg grab; null degrades to prompt-only chaining (the client
    // backfill semantics). A bare cache ref, never the full URL.
    const endFrameRef = primary
      ? await deriveEndFrameRefServerSide(
          { url: primary.url, ...(primary.endFrameUrl ? { endFrameUrl: primary.endFrameUrl } : {}) },
          prepared.normalized.kind,
        )
      : null;
    patchStoryRepository(storyId, {
      scenes: story.scenes.map((sc) =>
        sc.id === sceneId
          ? {
              ...sc,
              url: primary?.url ?? null,
              mime: primary?.mime,
              status: "completed" as const,
              error: undefined,
              progress: undefined,
              safe: prepared.normalized.safe,
              ...(prepared.model.id ? { effectiveModelId: prepared.model.id } : {}),
              ...(endFrameRef ? { endFrameRef } : {}),
            }
          : sc,
      ),
    });
    log.info("job absorbed into story scene", { jobId, storyId, sceneId });
    warmModeration(primary?.url ?? null, log);
    await advanceStoryChain(storyId);
  }

  /** Attach a finished keyframe still to its scene, then run the quality
   * gate (story consistency): a failing score re-queues the scene for one
   * more keyframe (a different roll — the attempt number enters the seed);
   * a pass, an unavailable gate, or an exhausted attempt ladder starts the
   * scene's own render, anchored on the keyframe. */
  private async absorbStoryKeyframe(
    jobId: string,
    storyId: string,
    sceneId: string,
    media: Awaited<ReturnType<typeof this.persist>>,
    _prepared: Awaited<ReturnType<typeof prepareGeneration>>,
    log: Logger,
  ): Promise<void> {
    const story = getStoriesRepository(storyId);
    if (!story?.scenes) return;
    const scene = story.scenes.find((sc) => sc.id === sceneId);
    if (!scene || scene.status !== "generating") {
      log.info("keyframe absorb skipped (scene not generating)", { jobId, sceneId });
      return;
    }
    const primary = media[0];
    // The keyframe IS a still: the ref is the image itself — the same
    // media-persistence helper the scene absorb uses, but no frame export
    // or ffmpeg work. A bare cache ref, never the full URL.
    const ref = primary
      ? await deriveEndFrameRefServerSide(
          { url: primary.url, ...(primary.endFrameUrl ? { endFrameUrl: primary.endFrameUrl } : {}) },
          "image",
        )
      : null;
    if (!ref) {
      // Without a stored ref there is nothing to anchor or animate — the
      // honest outcome is a failed scene and a halted run.
      patchStoryRepository(storyId, {
        scenes: story.scenes.map((sc) =>
          sc.id === sceneId
            ? {
                ...sc,
                status: "failed" as const,
                error: "The keyframe render could not be stored. Re-run the scene.",
                progress: undefined,
              }
            : sc,
        ),
        meta: { ...(story.meta ?? {}), running: false },
      });
      log.warn("story run halted on unusable keyframe media", { jobId, storyId, sceneId });
      return;
    }
    patchStoryRepository(storyId, {
      scenes: story.scenes.map((sc) =>
        sc.id === sceneId ? { ...sc, keyframeRef: ref, progress: undefined } : sc,
      ),
    });
    log.info("keyframe absorbed into story scene", { jobId, storyId, sceneId, ref });

    // Gate: the same expectations the keyframe strategy was built from,
    // recomputed here from the live record. No expectations (no cast, no
    // location) means nothing to score — the keyframe is accepted as-is.
    const cast = sceneCast(scene.state, { characters: storyCast(story) });
    const location = getLocationsRepository(
      scene.state?.locationId ?? story.world?.locationIds?.[0] ?? "",
    );
    const expectations = buildGateExpectations(scene, cast, location);
    let verdict: (SceneScore & { passed: boolean }) | null = null;
    if (expectations) {
      const decision = await scoreKeyframeRef(ref, expectations);
      verdict = decision.verdict;
      if (verdict) {
        await onKeyframeGate({ storyId, sceneId, ref, score: verdict, passed: verdict.passed });
      }
    }

    if (verdict && !verdict.passed && (scene.attempts ?? 0) < 2) {
      const attempts = (scene.attempts ?? 0) + 1;
      patchStoryRepository(storyId, {
        scenes: (getStoriesRepository(storyId)?.scenes ?? story.scenes).map((sc) =>
          sc.id === sceneId
            ? {
                ...sc,
                attempts,
                keyframeRef: undefined,
                score: verdict,
                status: "queued" as const,
              }
            : sc,
        ),
      });
      log.warn("keyframe failed the gate — re-rolling", {
        storyId,
        sceneId,
        attempt: attempts,
        score: verdict,
      });
      await advanceStoryChain(storyId);
      return;
    }
    if (verdict && !verdict.passed) {
      // Attempts exhausted on a failing score: flag it (the UI shows the
      // low-consistency chip) and animate anyway rather than stranding the run.
      log.warn("keyframe failed the gate with attempts exhausted — animating anyway", {
        storyId,
        sceneId,
        score: verdict,
      });
    }
    patchStoryRepository(storyId, {
      scenes: (getStoriesRepository(storyId)?.scenes ?? story.scenes).map((sc) =>
        sc.id === sceneId ? { ...sc, score: verdict ?? undefined } : sc,
      ),
    });
    await advanceSceneAfterKeyframe(storyId, sceneId);
  }

  /** Solo renders become History assets server-side, so closing the tab
   * never loses a finished render. Clients reuse this exact id. */
  private absorbSoloAsset(
    jobId: string,
    job: JobRecord,
    media: Awaited<ReturnType<typeof this.persist>>,
    prepared: Awaited<ReturnType<typeof prepareGeneration>>,
    log: Logger,
  ): string {
    const request = job.request as {
      rawPrompt?: string;
      style?: string;
      aspect?: string;
      resolution?: string;
      duration?: string;
      count?: number;
      negativePrompt?: string;
      enhance?: boolean;
      modelId?: string | null;
    };
    const primary = media[0];
    const settings = {
      kind: job.kind,
      aspect: (request.aspect ?? "16:9") as GenerationSettings["aspect"],
      resolution: (request.resolution ?? "1080p") as GenerationSettings["resolution"],
      style: request.style ?? "None",
      duration: (request.duration ?? "5s") as GenerationSettings["duration"],
      count: request.count ?? 1,
      negativePrompt: request.negativePrompt ?? "",
      enhance: request.enhance ?? false,
      safe: prepared.normalized.safe,
      seed: String(prepared.normalized.seed ?? ""),
      modelId: request.modelId ?? undefined,
    } satisfies GenerationSettings;
    const asset: Asset = {
      id: `a_${job.id}`,
      kind: job.kind,
      title: titleFromPrompt(request.rawPrompt ?? prepared.normalized.prompt),
      prompt: request.rawPrompt ?? prepared.normalized.prompt,
      url: primary?.url ?? "",
      variants: media.map((m) => m.url),
      ...(primary?.url ? { posterUrl: primary.url } : {}),
      settings,
      createdAt: job.createdAt,
      favorite: false,
      mode: job.kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
      meta: {
        requestId: jobId,
        seeds: media.map((m) => m.seed).join(", "),
        example: false,
      },
    };
    putRecord(asset);
    log.info("solo job absorbed into history", { jobId, assetId: asset.id });
    warmModeration(primary?.url ?? null, log);
    return asset.id;
  }

  private failFromError(jobId: string, error: unknown, log: Logger): void {
    const current = getJobsRepository(jobId);
    if (!current || (current.status !== "running" && current.status !== "queued")) return;
    let message = (error as Error)?.message ?? "The render failed unexpectedly.";
    let retryable = true;
    if (error instanceof GenerationServiceError) {
      message = error.message;
      retryable = error.retryable;
    } else if (error instanceof ProviderError) {
      message = error.message;
      retryable = error.retryable;
      log.warn("job failed by provider", { jobId, message });
    } else {
      log.error("job failed unexpectedly", { jobId, error });
    }
    patchJobRepository(jobId, {
      status: "failed",
      error: message,
      retryable,
      finishedAt: this.now(),
    });
    // A failed story-scene or keyframe job writes the failure into its scene
    // and halts the run — a stuck "generating" tile must never wait on a
    // dead job.
    const tag = parseStoryTag(current.clientTag);
    if (tag) {
      const story = getStoriesRepository(tag.storyId);
      if (story?.scenes) {
        patchStoryRepository(tag.storyId, {
          scenes: story.scenes.map((sc) =>
            sc.id === tag.sceneId && sc.status === "generating"
              ? { ...sc, status: "failed" as const, error: message, progress: undefined }
              : sc,
          ),
          meta: { ...(story.meta ?? {}), running: false },
        });
        log.warn(tag.kind === "keyframe" ? "story run halted on keyframe failure" : "story run halted on scene failure", {
          jobId,
          storyId: tag.storyId,
          sceneId: tag.sceneId,
          message,
        });
      }
    }
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

/** Story absorption tags: `<storyId>:<sceneId>` for scene renders and
 * `k_<storyId>:<sceneId>` for keyframe renders. Anything else (solo asset
 * tags) parses to null and falls through to the History absorb. */
type StoryTag = { kind: "scene" | "keyframe"; storyId: string; sceneId: string };

function parseStoryTag(tag: string | null | undefined): StoryTag | null {
  if (!tag) return null;
  let rest = tag;
  let kind: StoryTag["kind"] = "scene";
  if (rest.startsWith("k_")) {
    kind = "keyframe";
    rest = rest.slice(2);
  }
  const at = rest.indexOf(":");
  if (at <= 0) return null;
  const storyId = rest.slice(0, at);
  const sceneId = rest.slice(at + 1);
  if (!storyId.startsWith("s_") || !sceneId) return null;
  return { kind, storyId, sceneId };
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
