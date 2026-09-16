import {
  enhanceDraftInstruction,
  extractStoryScenes,
  parseEnhanceBody,
  parseSplitBody,
  parseWriteBody,
  splitScenesInstruction,
  STRICT_SPLIT_SUFFIX,
  writeStoryInstruction,
} from "@/lib/domain/writer";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { ProviderError } from "@/lib/providers/types";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { resolveTextEngines } from "@/lib/services/text-engine-chain";

/**
 * Story Writer orchestration (Facade): write, enhance and split over the
 * shared text-engine chain. Unlike prompt enhancement there is NO
 * deterministic fallback — a template cannot write a story — so a total
 * engine failure surfaces as a retryable error, and there is no reply cache
 * (regenerate must re-roll, never replay).
 */

export interface WriterTextResult {
  text: string;
  model: string;
  provider: string;
}

export interface WriterSplitResult {
  title: string;
  scenes: string[];
  model: string;
  provider: string;
}

export class WriterServiceError extends Error {
  readonly field?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    options?: { field?: string; retryable?: boolean; status?: number },
  ) {
    super(message);
    this.name = "WriterServiceError";
    this.field = options?.field;
    this.retryable = options?.retryable ?? true;
    this.status = options?.status ?? 400;
  }
}

function engineLabel(entry: {
  providerId: string;
  modelId?: string;
}): { model: string; provider: string } {
  const modelId = entry.modelId ?? `${entry.providerId}:default`;
  const at = modelId.indexOf(":");
  return {
    provider: at > 0 ? modelId.slice(0, at) : entry.providerId,
    model: at > 0 ? modelId.slice(at + 1) : modelId,
  };
}

/** Sogni's chat endpoint defaults to 700 output tokens; a 12-scene JSON
 * reply needs far more, and truncation is unrepairable. */
const SPLIT_MAX_TOKENS = 2048;

/** Session override from the /writer pill; falls back to the Settings pick. */
function sessionModelId(body: Record<string, unknown>): string | undefined {
  const value = body.modelId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function completeViaChain(
  instruction: string,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    modelId?: string;
    logger: Logger;
  },
): Promise<{ text: string; engine: { providerId: string; modelId?: string } }> {
  const engines = resolveTextEngines(options.modelId ?? getProviderConfig().tasks.writer);
  if (!engines.length) {
    throw new WriterServiceError(
      "No text model is available. Enable a provider in Settings and retry.",
      { retryable: false },
    );
  }
  let lastError: unknown;
  for (const engine of engines) {
    try {
      const reply = await engine.complete(instruction, {
        signal: options.signal,
        modelId: engine.modelId,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      });
      if (!reply.trim()) throw new Error("Empty reply");
      return { text: reply, engine };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      lastError = error;
      options.logger.warn("writer engine failed — trying the next one", {
        engine: engine.providerId,
        model: engine.modelId,
        message: (error as Error)?.message,
      });
    }
  }
  // Total chain failure: surface as a WriterServiceError so the route can map
  // it onto the API's retryable contract (a raw ProviderError would leak).
  const message =
    lastError instanceof Error && lastError.message
      ? lastError.message
      : "The writer models are unavailable right now — try again.";
  const retryable = lastError instanceof ProviderError ? lastError.retryable : true;
  throw new WriterServiceError(message, { retryable });
}

export async function runWriterAction(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<WriterTextResult | WriterSplitResult> {
  const log = (options.logger ?? rootLogger).child({ surface: "writer" });
  const action = body.action;
  const modelId = sessionModelId(body);

  if (action === "write") {
    const brief = parseWriteBody(body);
    const started = Date.now();
    const { text, engine } = await completeViaChain(writeStoryInstruction(brief), {
      signal: options.signal,
      modelId,
      logger: log,
    });
    log.info("story written", { ...engineLabel(engine), elapsedMs: Date.now() - started });
    return { text, ...engineLabel(engine) };
  }

  if (action === "enhance") {
    const request = parseEnhanceBody(body);
    const started = Date.now();
    const { text, engine } = await completeViaChain(
      enhanceDraftInstruction(request.draft, request.instruction),
      { signal: options.signal, modelId, logger: log },
    );
    log.info("story enhanced", { ...engineLabel(engine), elapsedMs: Date.now() - started });
    return { text, ...engineLabel(engine) };
  }

  if (action === "split") {
    const request = parseSplitBody(body);
    const started = Date.now();
    const base = splitScenesInstruction(
      request.draft,
      request.sceneCount,
      request.characterNames,
    );
    // One stricter retry when the reply isn't parseable (spec: parse failure).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const instruction =
        attempt === 0 ? base : `${base}\n${STRICT_SPLIT_SUFFIX}`;
      const { text, engine } = await completeViaChain(instruction, {
        signal: options.signal,
        maxTokens: SPLIT_MAX_TOKENS,
        modelId,
        logger: log,
      });
      const parsed = extractStoryScenes(text, request.sceneCount);
      if (parsed) {
        log.info("story split", {
          ...engineLabel(engine),
          scenes: parsed.scenes.length,
          attempts: attempt + 1,
          elapsedMs: Date.now() - started,
        });
        return { ...parsed, ...engineLabel(engine) };
      }
      log.warn("split reply unparseable", { attempt: attempt + 1 });
    }
    throw new WriterServiceError(
      "The writer could not split that draft into scenes — try rephrasing or retry.",
      { retryable: true },
    );
  }

  throw new WriterServiceError("Unknown writer action.", { field: "action", retryable: false });
}
