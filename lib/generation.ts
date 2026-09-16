"use client";

import { useCallback, useRef, useState } from "react";
import { logClientEvent } from "@/lib/logging/logger";
import type { GenerationResponse, GenerationSettings } from "./types";

export class GenerationError extends Error {
  field?: string;
  retryable: boolean;
  constructor(message: string, field?: string, retryable = true) {
    super(message);
    this.name = "GenerationError";
    this.field = field;
    this.retryable = retryable;
  }
}

export interface GenerateInput {
  settings: GenerationSettings;
  prompt: string;
  /** True when Uncensored Mode is enabled in Settings (safe flag follows it). */
  uncensored?: boolean;
  /** Media-cache refs for continuity frames (story mode). */
  startImageRef?: string;
  endImageRef?: string;
  /**
   * Opaque association echoed back on detached-render recovery — the story
   * runner tags scenes `s_<story>:<sceneId>` so recovered media can be
   * attached to the right tile.
   */
  clientTag?: string;
  signal?: AbortSignal;
}

/** One live progress tick from the render pipeline. */
export interface GenerationProgress {
  stage: "submitted" | "rendering" | "downloading";
  message: string;
  percent?: number;
}

/**
 * Submit a durable render job and poll it to completion (Phase B). Same
 * signature and request body as the legacy call — solo, story, and
 * character renders all keep working — but the render now lives on the
 * server: navigating away, closing the tab, or a provider backlog never
 * loses it. Progress ticks come from the job record.
 */
const JOB_POLL_INTERVAL_MS = 2_000;
/** Test hook: shrink the poll cadence so suites run instantly. */
let jobPollIntervalMs = JOB_POLL_INTERVAL_MS;
export function setJobPollIntervalForTests(ms: number): void {
  jobPollIntervalMs = ms;
}

export async function requestGeneration(
  {
    settings,
    prompt,
    uncensored,
    startImageRef,
    endImageRef,
    clientTag,
    signal,
    onProgress,
  }: GenerateInput & { onProgress?: (progress: GenerationProgress) => void },
): Promise<GenerationResponse> {
  let submit: Response;
  try {
    submit = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: settings.kind,
        prompt,
        aspect: settings.aspect,
        resolution: settings.resolution,
        style: settings.style,
        duration: settings.duration,
        count: settings.count,
        seed: settings.seed,
        negativePrompt: settings.negativePrompt,
        enhance: settings.enhance,
        safe: settings.safe,
        modelId: settings.modelId,
        uncensored: uncensored ?? false,
        // LoRA selections ride with the request; the server re-validates them
        // against the model's capability band, so stale entries are safe.
        ...(settings.loras?.length ? { loras: settings.loras } : {}),
        ...(startImageRef ? { startImageRef } : {}),
        ...(endImageRef ? { endImageRef } : {}),
        ...(clientTag ? { clientTag } : {}),
      }),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    logClientEvent("generation request failed", { kind: settings.kind });
    throw new GenerationError(
      "We could not reach the studio service. Check your connection and retry.",
      undefined,
      true,
    );
  }

  if (!submit.ok) {
    const body = (await submit.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      retryable?: boolean;
    };
    throw new GenerationError(
      body.error ?? "Something went wrong while generating.",
      body.field,
      body.retryable ?? submit.status >= 500,
    );
  }

  const { job } = (await submit.json()) as { job?: { id: string } };
  if (!job?.id) {
    throw new GenerationError("The render job could not be created. Please retry.", undefined, true);
  }

  // Persist the job id so a page that reopens later can find the render
  // (the story page absorbs scene results via its own job poller instead).
  try {
    sessionStorage.setItem("perabyte.job_latest", job.id);
  } catch {
    /* storage blocked — polling still works in this session */
  }

  // Cancel is best-effort on abort: the server job is asked to stop, and the
  // caller's AbortError propagates so the UI unwinds.
  signal?.addEventListener(
    "abort",
    () => {
      void fetch(`/api/jobs/${encodeURIComponent(job.id)}?action=cancel`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    },
    { once: true },
  );

  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, jobPollIntervalMs));
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");

    let response: Response;
    try {
      response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { cache: "no-store" });
    } catch {
      continue; // transient network blip — the job is durable, keep polling
    }
    if (response.status === 404) {
      throw new GenerationError("That render job no longer exists. Please retry.", undefined, true);
    }
    if (!response.ok) continue;

    const record = (await response.json()) as { job?: JobRecordClient };
    const current = record.job;
    if (!current) continue;

    if (current.progress) {
      onProgress?.({
        stage: current.progress.stage,
        message: current.progress.message,
        percent:
          typeof current.progress.percent === "number"
            ? Math.round(current.progress.percent)
            : undefined,
      });
    }
    if (current.status === "completed" && current.result?.length) {
      return {
        requestId: current.id,
        status: "completed",
        kind: current.kind,
        elapsedMs: (current.finishedAt ?? Date.now()) - current.createdAt,
        ...(current.assetId ? { assetId: current.assetId } : {}),
        media: current.result,
        ...(current.effectiveModelId
          ? { effectiveModelId: current.effectiveModelId, effectiveModelLabel: current.effectiveModelLabel }
          : {}),
        ...(current.frameUsed === undefined ? {} : { frameUsed: current.frameUsed }),
      };
    }
    if (current.status === "failed") {
      throw new GenerationError(
        current.error ?? "Generation failed.",
        undefined,
        current.retryable ?? true,
      );
    }
    if (current.status === "canceled") {
      throw new DOMException("aborted", "AbortError");
    }
  }
}

/** Subset of the server JobRecord the poller consumes. */
interface JobRecordClient {
  id: string;
  kind: "image" | "video";
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: { stage: "submitted" | "rendering" | "downloading"; message: string; percent?: number };
  result?: GenerationResponse["media"];
  assetId?: string;
  error?: string;
  retryable?: boolean;
  effectiveModelId?: string;
  effectiveModelLabel?: string;
  frameUsed?: boolean;
  createdAt: number;
  finishedAt?: number;
}

/** Job lifecycle states surfaced in the UI while a request is in flight. */
export type JobPhase =
  | { phase: "idle" }
  | { phase: "queued" }
  | { phase: "generating"; startedAt: number; progress?: GenerationProgress }
  | { phase: "completed"; response: GenerationResponse }
  | { phase: "failed"; message: string; retryable: boolean };

/**
 * Story-level percent for the batch bar: finished scenes count fully and the
 * in-flight scene contributes its own provider percent. Returns undefined
 * while nothing is measurable (nothing finished, no live percent) so the UI
 * can stay indeterminate instead of fabricating a number.
 */
export function storyProgressPercent(
  completed: number,
  total: number,
  current?: GenerationProgress,
): number | undefined {
  if (total <= 0) return undefined;
  const base = Math.max(0, Math.min(completed, total)) / total;
  if (completed === 0 && current?.percent === undefined) return undefined;
  const currentFraction =
    current?.percent === undefined ? 0 : Math.max(0, Math.min(100, current.percent)) / 100 / total;
  return Math.round(Math.min(1, base + currentFraction) * 100);
}

export function useGeneration() {
  const [job, setJob] = useState<JobPhase>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setJob({ phase: "idle" });
  }, []);

  const run = useCallback(
    async (input: GenerateInput): Promise<GenerationResponse | null> => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;

      const startedAt = Date.now();
      setJob({ phase: "queued" });
      // Fall through to "generating" even without progress ticks.
      const staged = setTimeout(
        () =>
          setJob((prev) => (prev.phase === "queued" ? { phase: "generating", startedAt } : prev)),
        450,
      );

      try {
        const response = await requestGeneration({
          ...input,
          signal: next.signal,
          onProgress: (progress) =>
            setJob((prev) =>
              prev.phase === "queued" || prev.phase === "generating"
                ? { phase: "generating", startedAt, progress }
                : prev,
            ),
        });
        clearTimeout(staged);
        setJob({ phase: "completed", response });
        return response;
      } catch (error) {
        clearTimeout(staged);
        if ((error as Error)?.name === "AbortError") {
          setJob({ phase: "idle" });
          return null;
        }
        const err = error as GenerationError;
        logClientEvent("generation failed", {
          kind: input.settings.kind,
          message: err.message,
        });
        setJob({
          phase: "failed",
          message: err.message ?? "Generation failed.",
          retryable: err.retryable ?? true,
        });
        return null;
      }
    },
    [],
  );

  return { job, run, cancel, reset: () => setJob({ phase: "idle" }) };
}

/** Trigger a browser download through our media proxy. Handles both cached
 * files (`/api/media?f=…`) and provider URLs (`?u=…`). */
export function downloadMedia(url: string, filename: string) {
  const href = url.startsWith("/api/media")
    ? `${url}${url.includes("?") ? "&" : "?"}download=1&filename=${encodeURIComponent(filename)}`
    : `/api/media?u=${encodeURIComponent(url)}&download=1&filename=${encodeURIComponent(filename)}`;
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}