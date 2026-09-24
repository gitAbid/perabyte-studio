import { createHash } from "node:crypto";
import {
  ASPECTS,
  DURATIONS,
  IMAGE_STYLES,
  VIDEO_STYLES,
  type GenerationKind,
} from "@/lib/constants";
import {
  TIME_OF_DAYS,
  deterministicEnhancement,
  enhancementInstruction,
  sanitizeEnhancedText,
  type EnhancementContext,
  type TimeOfDay,
} from "@/lib/domain/enhancement";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { ProviderError } from "@/lib/providers/types";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { resolveTextEngines } from "@/lib/services/text-engine-chain";

/**
 * Prompt-enhancement orchestration (Facade): validate the raw request, ask the
 * AI engine, and degrade to the deterministic enhancer when the free text
 * model is out of capacity. The action never fails the user — worst case the
 * prompt is enriched offline, and the response says which engine ran.
 */

export interface PromptEnhancementResult {
  /** The prompt exactly as received (echoed for the UI to diff/replace). */
  prompt: string;
  enhanced: string;
  source: "ai" | "fallback";
}

interface ValidatedEnhancement extends EnhancementContext {
  prompt: string;
}

export function validateEnhancementRequest(
  body: Record<string, unknown>,
): ValidatedEnhancement {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    throw new EnhancementServiceError(
      "Write a prompt before enhancing it.",
      { field: "prompt" },
    );
  }
  // Prompt budget is user-configurable (Settings → General); the engines and
  // the sanitizer must fit the same live value validation enforces.
  const promptMax = getProviderConfig().promptMaxChars;
  if (prompt.length > promptMax) {
    throw new EnhancementServiceError(
      `Prompts are limited to ${promptMax} characters.`,
      { field: "prompt" },
    );
  }

  const kind: GenerationKind = body.kind === "video" ? "video" : "image";
  const styleTable = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  // Unknown or stale style names simply carry no context — enhancement still
  // runs, mirroring how generation clamps instead of failing.
  const style =
    typeof body.style === "string" && body.style in styleTable ? body.style : null;
  const stylesSupported = body.stylesSupported !== false;

  const aspect =
    typeof body.aspect === "string" && body.aspect in ASPECTS ? body.aspect : null;

  const rawDuration = typeof body.duration === "string" ? body.duration : "";
  const duration = (DURATIONS as readonly string[]).includes(rawDuration)
    ? rawDuration
    : null;

  const toInt = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(1, Math.trunc(value))
      : null;
  const sceneCount = toInt(body.sceneCount);
  const sceneIndex = toInt(body.sceneIndex);

  const timeOfDay: TimeOfDay | null =
    typeof body.timeOfDay === "string" &&
    (TIME_OF_DAYS as readonly string[]).includes(body.timeOfDay)
      ? (body.timeOfDay as TimeOfDay)
      : null;

  const negativePrompt =
    typeof body.negativePrompt === "string" ? body.negativePrompt : "";

  const location =
    typeof body.location === "string" && body.location.trim()
      ? body.location.trim().slice(0, 300)
      : null;
  const priorScene =
    typeof body.priorScene === "string" && body.priorScene.trim()
      ? body.priorScene.trim().slice(0, 300)
      : null;

  return {
    prompt,
    maxChars: promptMax,
    kind,
    style,
    stylesSupported,
    aspect,
    duration,
    sceneIndex,
    sceneCount,
    timeOfDay,
    location,
    priorScene,
    negativePrompt,
    uncensored: body.uncensored === true,
  };
}

/**
 * Small LRU-ish reply cache: the shared key pool is the scarce resource, so
 * repeat clicks on an unchanged prompt + context must not spend it.
 */
const CACHE_LIMIT = 100;
const cache = new Map<string, string>();

function cacheKey(request: ValidatedEnhancement, taskEnhanceModel: string | null): string {
  const context = { ...request };
  delete (context as { prompt?: string }).prompt;
  return createHash("sha1")
    .update(JSON.stringify({ prompt: request.prompt, context, taskEnhanceModel }))
    .digest("hex");
}

export async function runPromptEnhancement(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<PromptEnhancementResult> {
  const request = validateEnhancementRequest(body);
  const log = (options.logger ?? rootLogger).child({
    surface: "enhance",
    kind: request.kind,
  });

  const config = getProviderConfig();
  const key = cacheKey(request, config.tasks.enhance);
  const cached = cache.get(key);
  if (cached) {
    // Refresh for LRU ordering.
    cache.delete(key);
    cache.set(key, cached);
    log.debug("enhancement cache hit", { source: "ai" });
    return { prompt: request.prompt, enhanced: cached, source: "ai" };
  }

  const started = Date.now();
  try {
    const instruction = enhancementInstruction(request.prompt, request);
    let lastError: unknown;
    const engines = resolveTextEngines(config.tasks.enhance, {
      preferUncensored: request.uncensored,
    });
    for (const engine of engines) {
      try {
        const reply = await engine.complete(instruction, {
          signal: options.signal,
          modelId: engine.modelId,
        });
        if (options.signal?.aborted) {
          // The user navigated away or re-clicked; don't spend or cache the reply.
          throw new DOMException("Aborted", "AbortError");
        }
        const enhanced = sanitizeEnhancedText(reply, request.prompt, request.maxChars);
        if (!enhanced) throw new ProviderError("The enhancer reply was unusable.");

        cache.set(key, enhanced);
        if (cache.size > CACHE_LIMIT) {
          cache.delete(cache.keys().next().value as string);
        }
        log.info("prompt enhanced", {
          source: "ai",
          engine: engine.providerId,
          model: engine.modelId,
          elapsedMs: Date.now() - started,
        });
        return { prompt: request.prompt, enhanced, source: "ai" };
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        lastError = error;
        log.warn("enhancement engine failed — trying the next one", {
          engine: engine.providerId,
          model: engine.modelId,
          message: (error as Error)?.message,
        });
      }
    }
    throw lastError;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    log.warn("ai enhancement unavailable — using deterministic fallback", {
      message: (error as Error)?.message,
      elapsedMs: Date.now() - started,
    });
    return {
      prompt: request.prompt,
      enhanced: deterministicEnhancement(request.prompt, request),
      source: "fallback",
    };
  }
}

export class EnhancementServiceError extends Error {
  readonly field?: string;
  readonly retryable = false;
  readonly status = 400;

  constructor(message: string, options?: { field?: string }) {
    super(message);
    this.name = "EnhancementServiceError";
    this.field = options?.field;
  }
}

/** Test hook: clear the in-memory reply cache. */
export function resetEnhancementCacheForTests(): void {
  cache.clear();
}
