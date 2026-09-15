import {
  ASPECTS,
  DURATIONS,
  IMAGE_STYLES,
  PROMPT_MAX,
  RESOLUTIONS,
  VIDEO_STYLES,
  type AspectKey,
  type DurationKey,
  type GenerationKind,
  type ResolutionKey,
} from "@/lib/constants";
import { durationToSeconds, type NormalizedGenerationRequest } from "@/lib/domain/models";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getGenerationRegistry } from "@/lib/providers/registry";
import {
  ProviderError,
  type GeneratedArtifact,
  type ImageProvider,
  type ProviderProgress,
  type VideoProvider,
} from "@/lib/providers/types";
import { getMediaRepository } from "@/lib/repositories/media.repository";
import { isPlausibleMp4 } from "@/lib/media/mp4";
import {
  isAllowedMediaUrl,
  randomSeed,
  resolveDimensions,
  styleWithPrompt,
} from "@/lib/renderer";
import type { GeneratedMedia, GenerationResponse } from "@/lib/types";

/**
 * Generation orchestration (Facade): validate the raw request, resolve the
 * model, delegate to the provider, persist media, and return the response
 * contract the UI already consumes. Route handlers stay thin.
 */
export interface RunGenerationOptions {
  signal?: AbortSignal;
  logger?: Logger;
  /**
   * Live progress sink for streaming controllers. Receives the provider's
   * ticks plus this service's own stages (e.g. caching the finished media).
   */
  onProgress?: (progress: ProviderProgress) => void;
}

export class GenerationServiceError extends Error {
  readonly field?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    options?: { field?: string; retryable?: boolean; status?: number },
  ) {
    super(message);
    this.name = "GenerationServiceError";
    this.field = options?.field;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? 400;
  }
}

/* ------------------------------------------------------------------ */
/* Validation (ported from the original route handler)                 */
/* ------------------------------------------------------------------ */

export interface ValidatedRequest {
  kind: GenerationKind;
  rawPrompt: string;
  aspect: AspectKey;
  resolution: ResolutionKey;
  style: string;
  duration: DurationKey;
  count: number;
  seed: number | null;
  negativePrompt: string;
  enhance: boolean;
  safe: boolean;
  modelId: string | null;
}

export function validateGenerationRequest(body: Record<string, unknown>): ValidatedRequest {
  const kind = body.kind === "video" ? "video" : "image";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    throw new GenerationServiceError(
      "Describe what you want to create before generating.",
      { field: "prompt" },
    );
  }
  if (prompt.length > PROMPT_MAX) {
    throw new GenerationServiceError(
      `Prompts are limited to ${PROMPT_MAX} characters. Shorten yours and try again.`,
      { field: "prompt" },
    );
  }

  const aspect = typeof body.aspect === "string" ? body.aspect : "16:9";
  if (!(aspect in ASPECTS)) {
    throw new GenerationServiceError("That aspect ratio is not supported.", {
      field: "aspect",
    });
  }

  const resolution = typeof body.resolution === "string" ? body.resolution : "1080p";
  if (!(resolution in RESOLUTIONS)) {
    throw new GenerationServiceError("That resolution is not supported.", {
      field: "resolution",
    });
  }

  const styleTable = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  const style = typeof body.style === "string" ? body.style : "Realistic";
  if (!(style in styleTable)) {
    throw new GenerationServiceError("That style preset is not supported.", {
      field: "style",
    });
  }

  const duration = typeof body.duration === "string" ? body.duration : "5s";
  if (!(DURATIONS as readonly string[]).includes(duration)) {
    throw new GenerationServiceError("That duration is not supported.", { field: "duration" });
  }

  const count =
    typeof body.count === "number" && Number.isFinite(body.count)
      ? Math.min(4, Math.max(1, Math.trunc(body.count)))
      : 1;

  let seed: number | null = null;
  if (typeof body.seed === "string" && body.seed.trim() !== "") {
    const parsed = Number(body.seed);
    seed = Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  } else if (typeof body.seed === "number" && Number.isFinite(body.seed)) {
    seed = Math.trunc(body.seed);
  }

  const negativePrompt =
    typeof body.negativePrompt === "string" ? body.negativePrompt : "";

  const modelId = typeof body.modelId === "string" && body.modelId ? body.modelId : null;

  return {
    kind,
    rawPrompt: prompt,
    aspect: aspect as AspectKey,
    resolution: resolution as ResolutionKey,
    style,
    duration: duration as DurationKey,
    count,
    seed,
    negativePrompt,
    enhance: body.enhance !== false,
    // Uncensored Mode sends safe:false explicitly; everything else stays safe.
    safe: body.safe !== false,
    modelId,
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

function mimeForExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    default:
      return "image/jpeg";
  }
}

/**
 * Providers may answer with a hosted URL instead of inline bytes. Hosts we
 * already proxy (Pollinations) keep their deterministic URL; anything else
 * (e.g. an apikey.fan object-storage link) is short-lived and cross-origin,
 * so the bytes are fetched server-side and stored in the media cache.
 */
async function materializeArtifact(
  artifact: GeneratedArtifact,
  log: Logger,
): Promise<GeneratedArtifact> {
  if (artifact.bytes || !artifact.url || isAllowedMediaUrl(artifact.url)) {
    return artifact;
  }
  try {
    const response = await fetch(artifact.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (artifact.ext === "mp4" && !isPlausibleMp4(bytes)) {
      // A placeholder mp4 decodes to a silent black player; that is a failed
      // render, not a cached one.
      throw new ProviderError(
        "The provider finished the video but the file is unreadable. Please retry.",
        { retryable: true, status: 502 },
      );
    }
    log.info("url-only artifact cached server-side", { size: bytes.length });
    return { ...artifact, bytes, url: null };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Last resort: hand over the raw URL (better than losing the render);
    // logged so the degradation is visible.
    log.warn("url-only artifact could not be cached — returning raw url", { error });
    return artifact;
  }
}

/** Persist artifacts and convert them to the client-facing media contract. */
async function persistArtifacts(
  artifacts: GeneratedArtifact[],
  aspect: AspectKey,
  resolution: ResolutionKey,
  log: Logger,
): Promise<GeneratedMedia[]> {
  const repository = getMediaRepository();
  const { width, height } = resolveDimensions(aspect, resolution);

  return Promise.all(
    artifacts.map(async (artifact, index) => {
      const materialized = await materializeArtifact(artifact, log);
      if (materialized.bytes) {
        const stored = await repository.put(materialized.bytes, materialized.ext);
        return {
          id: `m_${materialized.seed.toString(36)}_${index}`,
          url: `/api/media?f=${stored.ref}`,
          width,
          height,
          seed: materialized.seed,
          mime: stored.contentType,
        } satisfies GeneratedMedia;
      }
      // URL-only artifacts (Pollinations) keep their deterministic provider
      // URL and ride the existing proxy path.
      return {
        id: `m_${materialized.seed.toString(36)}_${index}`,
        url: materialized.url as string,
        width,
        height,
        seed: materialized.seed,
        mime: mimeForExt(materialized.ext),
      } satisfies GeneratedMedia;
    }),
  );
}

export async function runGeneration(
  body: Record<string, unknown>,
  options: RunGenerationOptions = {},
): Promise<GenerationResponse> {
  const started = Date.now();
  const request = validateGenerationRequest(body);
  const registry = getGenerationRegistry();
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Model resolution: explicit pick → default for the kind.
  let modelId = request.modelId;
  if (modelId) {
    const found = registry.findAnywhere(modelId);
    if (!found) {
      throw new GenerationServiceError("That model is not supported.", {
        field: "model",
      });
    }
    if (!found.provider.isConfigured()) {
      throw new GenerationServiceError(
        `That model needs ${found.provider.label} set up first. Pick the free demo model or add its API key.`,
        { field: "model" },
      );
    }
  } else {
    modelId = registry.defaultModel(request.kind).id;
  }
  const resolved = registry.resolve(modelId);
  if (!resolved) {
    throw new GenerationServiceError("That model is not available right now.", {
      field: "model",
    });
  }

  const log = (options.logger ?? rootLogger).child({
    requestId,
    kind: request.kind,
    provider: resolved.provider.id,
    model: resolved.model.model,
    safe: request.safe,
  });
  log.info("generation started", { count: request.count, aspect: request.aspect });

  const normalized: NormalizedGenerationRequest = {
    kind: request.kind,
    // Style presets are folded into the prompt only when the model supports
    // them (provider-workflow video models take just the raw prompt).
    prompt:
      resolved.model.stylesSupported === false
        ? request.rawPrompt
        : styleWithPrompt(request.rawPrompt, request.style),
    negativePrompt: request.negativePrompt,
    aspect: request.aspect,
    resolution: request.resolution,
    durationSeconds: durationToSeconds(request.duration),
    count: request.count,
    seed: request.seed ?? randomSeed(),
    safe: request.safe,
    enhance: request.enhance,
  };

  try {
    const artifacts =
      request.kind === "video"
        ? await (resolved.provider as VideoProvider).generateVideo(
            normalized,
            resolved.model,
            { logger: log, signal: options.signal, onProgress: options.onProgress },
          )
        : await (resolved.provider as ImageProvider).generateImage(
            normalized,
            resolved.model,
            { logger: log, signal: options.signal, onProgress: options.onProgress },
          );

    options.onProgress?.({
      stage: "downloading",
      message: "Finalising your render…",
    });
    const media = await persistArtifacts(artifacts, request.aspect, request.resolution, log);
    const elapsedMs = Date.now() - started;
    log.info("generation completed", {
      elapsedMs,
      variants: media.length,
      prewarmed: artifacts[0]?.prewarmed ?? undefined,
    });

    return {
      requestId,
      status: "completed",
      kind: request.kind,
      elapsedMs,
      ...(artifacts[0]?.prewarmed === undefined ? {} : { prewarmed: artifacts[0].prewarmed }),
      media,
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      log.error("provider failed", { message: error.message, retryable: error.retryable });
      throw new GenerationServiceError(error.message, {
        field: error.field,
        retryable: error.retryable,
        status: error.retryable ? 502 : 400,
      });
    }
    throw error;
  }
}
