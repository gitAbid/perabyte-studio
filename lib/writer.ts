"use client";

import type { WriterBrief } from "@/lib/domain/writer";
import { logClientEvent } from "@/lib/logging/logger";

/**
 * Browser access to the story-writer service. Mirrors lib/enhancement.ts:
 * typed payloads in, `{ error, field, retryable }` mapped errors out.
 */

export interface WriterTextResponse {
  text: string;
  model: string;
  provider: string;
}

export interface WriterSplitResponse {
  title: string;
  scenes: string[];
  model: string;
  provider: string;
}

export type WriterResponse = WriterTextResponse | WriterSplitResponse;

export type WriterPayload =
  | { action: "write"; brief: WriterBrief; modelId?: string }
  | { action: "enhance"; draft: string; instruction: string; modelId?: string }
  | {
      action: "split";
      draft: string;
      sceneCount: number;
      characterNames?: string[];
      /** What the split scenes will render as; omitted = image. */
      kind?: "image" | "video";
      modelId?: string;
    };

export class WriterError extends Error {
  field?: string;
  retryable: boolean;
  constructor(message: string, field?: string, retryable = true) {
    super(message);
    this.name = "WriterError";
    this.field = field;
    this.retryable = retryable;
  }
}

export async function requestWriterAction(
  payload: WriterPayload,
  signal?: AbortSignal,
): Promise<WriterResponse> {
  let response: Response;
  try {
    response = await fetch("/api/writer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    logClientEvent("writer request failed", { action: payload.action });
    throw new WriterError(
      "We could not reach the writer service. Check your connection and retry.",
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      retryable?: boolean;
    };
    throw new WriterError(
      body.error ?? "Something went wrong in the writer.",
      body.field,
      body.retryable ?? response.status >= 500,
    );
  }

  return (await response.json()) as WriterResponse;
}
