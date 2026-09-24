"use client";

import { timeOfDayFromDate } from "@/lib/domain/enhancement";
import type { EnhancementContext } from "@/lib/domain/enhancement";
import type { GenerationKind } from "@/lib/constants";
import { logClientEvent } from "@/lib/logging/logger";

/**
 * Client access to the prompt-enhancement service. The caller passes the
 * current studio configuration; this layer adds the client-local time of day
 * (the server must never assume its own timezone matches the user's).
 */
export interface EnhancementRequest {
  prompt: string;
  kind: GenerationKind;
  /** Style preset name; only sent when the active model supports styles. */
  style?: string | null;
  stylesSupported?: boolean;
  aspect?: string | null;
  /** Video clip length, e.g. "5s". */
  duration?: string | null;
  /** Story mode position of the prompt being enhanced. */
  sceneIndex?: number | null;
  sceneCount?: number | null;
  /** Where this scene takes place — anchors the rewrite's environment. */
  location?: string | null;
  /** One-line summary of the previous scene — continuity context. */
  priorScene?: string | null;
  negativePrompt?: string | null;
  /** Uncensored Mode — keep adult/explicit intent in the rewrite. */
  uncensored?: boolean;
}

export interface EnhancementResult {
  enhanced: string;
  source: "ai" | "fallback";
}

export class EnhancementError extends Error {
  field?: string;
  retryable: boolean;
  constructor(message: string, field?: string, retryable = true) {
    super(message);
    this.name = "EnhancementError";
    this.field = field;
    this.retryable = retryable;
  }
}

export async function requestPromptEnhancement(
  request: EnhancementRequest,
  signal?: AbortSignal,
): Promise<EnhancementResult> {
  const payload = {
    prompt: request.prompt,
    kind: request.kind,
    style: request.style ?? null,
    stylesSupported: request.stylesSupported !== false,
    aspect: request.aspect ?? null,
    duration: request.duration ?? null,
    sceneIndex: request.sceneIndex ?? null,
    sceneCount: request.sceneCount ?? null,
    timeOfDay: timeOfDayFromDate(new Date()),
    location: request.location ?? null,
    priorScene: request.priorScene ?? null,
    negativePrompt: request.negativePrompt ?? null,
    uncensored: request.uncensored === true,
  };

  let response: Response;
  try {
    response = await fetch("/api/enhance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    logClientEvent("enhancement request failed", { kind: request.kind });
    throw new EnhancementError(
      "We could not reach the enhancement service. Check your connection and retry.",
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
    throw new EnhancementError(
      body.error ?? "Something went wrong while enhancing the prompt.",
      body.field,
      body.retryable ?? response.status >= 500,
    );
  }

  return (await response.json()) as EnhancementResult;
}
