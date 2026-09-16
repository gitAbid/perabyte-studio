import { getGenerationRegistry } from "@/lib/providers/registry";
import {
  validateGenerationRequest,
  GenerationServiceError,
} from "@/lib/services/generation.service";
import {
  getJobsRepository,
  listActiveJobsRepository,
  patchJobRepository,
  type JobRecord,
} from "@/lib/repositories/jobs.repository";
import { getJobExecutor } from "@/lib/jobs/executor";

/**
 * Job intake and queries (Phase B). Creation validates through the same
 * pipeline the legacy path uses, snapshots the request (frame refs, not
 * bytes), and hands the record to the executor. Nothing here holds a
 * connection — clients poll.
 */

export interface JobSummary {
  id: string;
  provider: string;
  kind: "image" | "video";
  modelId: string;
  status: JobRecord["status"];
  progress?: JobRecord["progress"];
  clientTag?: string;
  error?: string;
  createdAt: number;
}

export function toSummary(job: JobRecord): JobSummary {
  return {
    id: job.id,
    provider: job.provider,
    kind: job.kind,
    modelId: job.modelId,
    status: job.status,
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.clientTag ? { clientTag: job.clientTag } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
  };
}

/** Validate the request body and enqueue a durable job. Throws
 * GenerationServiceError for validation problems (nothing persisted). */
export function createJob(body: Record<string, unknown>): JobRecord {
  const request = validateGenerationRequest(body);

  // Resolve the provider NOW so an unconfigured/unknown model is rejected at
  // submit time instead of failing inside the executor.
  const registry = getGenerationRegistry();
  const modelId = request.modelId ?? registry.defaultModel(request.kind).id;
  const resolved = registry.resolve(modelId);
  if (!resolved) {
    throw new GenerationServiceError("That model is not available right now.", {
      field: "model",
    });
  }
  if (!resolved.provider.isConfigured()) {
    throw new GenerationServiceError(
      `That model needs ${resolved.provider.label} set up first. Pick the free demo model or add its API key.`,
      { field: "model" },
    );
  }

  const rawTag = body.clientTag;
  const clientTag =
    typeof rawTag === "string"
      ? rawTag.replace(/[^\w:-]/g, "").slice(0, 120) || undefined
      : undefined;

  const job: JobRecord = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    provider: resolved.provider.id,
    kind: request.kind,
    modelId,
    // Serialized VALIDATED request — frame refs, not bytes; the executor
    // re-runs the shared prepare pipeline (frames, swap, LoRA, safety).
    request: { ...request },
    status: "queued",
    ...(clientTag ? { clientTag } : {}),
    createdAt: Date.now(),
  };
  return getJobExecutor().enqueue(job);
}

export function getJob(id: string): JobRecord | undefined {
  return getJobsRepository(id);
}

export function listActiveJobs(): JobSummary[] {
  return listActiveJobsRepository().map(toSummary);
}

export function cancelJob(id: string): JobRecord | null {
  return getJobExecutor().cancel(id);
}

/** Poll helper for the legacy shim: resolves when the job is terminal. */
export function waitForJob(
  id: string,
  options: { signal?: AbortSignal; onProgress?: (p: NonNullable<JobRecord["progress"]>) => void; intervalMs?: number } = {},
): Promise<JobRecord> {
  const intervalMs = options.intervalMs ?? 1_000;
  return new Promise<JobRecord>((resolve, reject) => {
    let lastProgress = "";
    const tick = () => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error("aborted"));
        return;
      }
      const job = getJobsRepository(id);
      if (!job) {
        reject(new GenerationServiceError("That render job no longer exists.", { retryable: false }));
        return;
      }
      if (job.progress && `${job.progress.message}:${job.progress.percent ?? ""}` !== lastProgress) {
        lastProgress = `${job.progress.message}:${job.progress.percent ?? ""}`;
        options.onProgress?.(job.progress);
      }
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "canceled"
      ) {
        resolve(job);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Boot recovery: the executor constructor runs it once per process; this
 * explicit call makes the intent visible at the service boundary. */
export function ensureJobsRecovered(): void {
  getJobExecutor().recover();
}
