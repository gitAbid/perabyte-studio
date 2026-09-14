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

/** Call our own render API. All provider access stays server-side. */
export async function requestGeneration({
  settings,
  prompt,
  uncensored,
  signal,
}: GenerateInput): Promise<GenerationResponse> {
  let response: Response;
  try {
    response = await fetch("/api/generate", {
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

  return (await response.json()) as GenerationResponse;
}

/** Job lifecycle states surfaced in the UI while a request is in flight. */
export type JobPhase =
  | { phase: "idle" }
  | { phase: "queued" }
  | { phase: "generating"; startedAt: number }
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

      setJob({ phase: "queued" });
      const staged = setTimeout(
        () => setJob({ phase: "generating", startedAt: Date.now() }),
        450,
      );

      try {
        const response = await requestGeneration({ ...input, signal: next.signal });
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