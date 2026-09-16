import type { GeneratedArtifact, JobProvider } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { ProviderContext } from "@/lib/providers/types";

const POLL_INTERVAL_MS = 2_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Drives submit/poll to a wall-clock deadline for the legacy request-scoped
 * path (`generateImage`/`generateVideo`). The durable job engine does not
 * use this — it owns time via staleness and absolute caps. On deadline the
 * provider job keeps running server-side; the caller gets a retryable 504.
 * Caller cancellation cancels the provider job best-effort.
 */
export async function driveJobToDeadline(options: {
  provider: JobProvider;
  /** Display name for timeout errors. */
  providerLabel: string;
  request: NormalizedGenerationRequest;
  model: ModelDescriptor;
  ctx: ProviderContext;
  kind: "image" | "video";
  deadlineMs: number;
}): Promise<GeneratedArtifact[]> {
  const { provider, providerLabel, request, model, ctx, kind, deadlineMs } = options;
  const started = Date.now();
  const { ref } = await provider.submitJob(request, model, ctx);
  let lastMessage = "";
  let lastPercent: number | undefined;
  try {
    while (Date.now() - started < deadlineMs) {
      if (ctx.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const result = await provider.pollJob(ref, request, model, ctx);
      if (result.status === "completed") return result.artifacts;
      if (result.status === "failed") {
        throw new ProviderError(result.message, {
          retryable: result.retryable,
          status: 502,
        });
      }
      // Unchanged state is suppressed — no tick spam while nothing moves.
      const progress = result.progress;
      if (progress && (progress.message !== lastMessage || progress.percent !== lastPercent)) {
        lastMessage = progress.message;
        lastPercent = progress.percent;
        ctx.onProgress?.(progress);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, deadlineMs), ctx.signal);
    }
    const minutes = Math.round(deadlineMs / 60_000);
    throw new ProviderError(
      `Your ${kind} render hit the ${minutes}-minute time limit and is still running on ${providerLabel}. You can retry, or raise the limit in Settings → Render timeouts.`,
      { retryable: true, status: 504 },
    );
  } catch (error) {
    if (ctx.signal?.aborted || (error as Error)?.name === "AbortError") {
      await provider.cancelJob?.(ref).catch(() => {});
    }
    throw error;
  }
}
