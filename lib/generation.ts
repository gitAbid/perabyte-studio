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
  signal?: AbortSignal;
}

/** One live progress tick from the render pipeline. */
export interface GenerationProgress {
  stage: "submitted" | "rendering" | "downloading";
  message: string;
  percent?: number;
}

/**
 * Call our own render API. All provider access stays server-side. The server
 * streams NDJSON progress lines (then the result) whenever we advertise
 * support via the accept header; plain-JSON replies still work.
 */
export async function requestGeneration(
  {
    settings,
    prompt,
    uncensored,
    signal,
    onProgress,
  }: GenerateInput & { onProgress?: (progress: GenerationProgress) => void },
): Promise<GenerationResponse> {
  let response: Response;
  try {
    response = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson, application/json",
      },
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

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      retryable?: boolean;
    };
    throw new GenerationError(
      body.error ?? "Something went wrong while generating.",
      body.field,
      body.retryable ?? response.status >= 500,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-ndjson")) {
    return consumeProgressStream(response, onProgress);
  }
  return (await response.json()) as GenerationResponse;
}

/**
 * Reads the NDJSON progress stream: every `progress` line feeds `onProgress`,
 * the `result` line resolves, an `error` line throws. A stream that ends
 * without a result is a failed generation, not a success.
 */
async function consumeProgressStream(
  response: Response,
  onProgress?: (progress: GenerationProgress) => void,
): Promise<GenerationResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new GenerationError("The render stream could not be read. Please retry.", undefined, true);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: GenerationResponse | null = null;

  const handleLine = (line: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Ignore partial/garbage lines rather than failing the render.
    }
    if (event.type === "progress") {
      onProgress?.({
        stage: (event.stage as GenerationProgress["stage"]) ?? "rendering",
        message: String(event.message ?? ""),
        percent: typeof event.percent === "number" ? Math.round(event.percent) : undefined,
      });
    } else if (event.type === "result") {
      result = event as unknown as GenerationResponse;
    } else if (event.type === "error") {
      throw new GenerationError(
        String(event.error ?? "Generation failed."),
        typeof event.field === "string" ? event.field : undefined,
        (event.retryable as boolean | undefined) ?? true,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (line) handleLine(line);
      newlineAt = buffer.indexOf("\n");
    }
  }

  if (!result) {
    throw new GenerationError(
      "The render stream ended before the render finished. Please retry.",
      undefined,
      true,
    );
  }
  return result;
}

/** Job lifecycle states surfaced in the UI while a request is in flight. */
export type JobPhase =
  | { phase: "idle" }
  | { phase: "queued" }
  | { phase: "generating"; startedAt: number; progress?: GenerationProgress }
  | { phase: "completed"; response: GenerationResponse }
  | { phase: "failed"; message: string; retryable: boolean };

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