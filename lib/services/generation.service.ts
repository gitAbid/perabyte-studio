import {
  ASPECTS,
  DURATIONS,
  IMAGE_STYLES,
  RESOLUTIONS,
  VIDEO_STYLES,
  type AspectKey,
  type DurationKey,
  type GenerationKind,
  type ResolutionKey,
} from "@/lib/constants";
import { durationToSeconds, type FrameImage, type ModelDescriptor, type NormalizedGenerationRequest } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getGenerationRegistry } from "@/lib/providers/registry";
import {
  jevConfigured,
  shouldBlock,
  triagePrompt,
  vaguenessHint,
  type PromptTriage,
} from "@/lib/jev/triage";
import { fetchLoraCatalog } from "@/lib/providers/sogni/lora-catalog";
import {
  ProviderError,
  type GeneratedArtifact,
  type ImageProvider,
  type ProviderProgress,
  type VideoProvider,
} from "@/lib/providers/types";
import { getMediaRepository, isValidMediaRef } from "@/lib/repositories/media.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { isPlausibleMp4 } from "@/lib/media/mp4";
import {
  isAllowedMediaUrl,
  randomSeed,
  resolveDimensions,
  styleWithPrompt,
} from "@/lib/renderer";
import type { GeneratedMedia, GenerationResponse, LoraSelection } from "@/lib/types";

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
  /** True when the render was detached and is still recoverable — the UI
   * should tell the user it will be attached automatically. */
  readonly pending?: boolean;

  constructor(
    message: string,
    options?: { field?: string; retryable?: boolean; status?: number; pending?: boolean },
  ) {
    super(message);
    this.name = "GenerationServiceError";
    this.field = options?.field;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? 400;
    this.pending = options?.pending;
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
  startImageRef: string | null;
  endImageRef: string | null;
  loras: LoraSelection[];
}

/** Continuity-frame cache refs must be real image refs from our media cache. */
function validateFrameRef(value: unknown, field: "startImage" | "endImage"): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!isValidMediaRef(value) || value.endsWith(".mp4")) {
    throw new GenerationServiceError("That continuity frame reference is not valid.", { field });
  }
  return value;
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
  // Prompt budget is user-configurable (Settings → General); the live value,
  // not the compiled default, is what every surface is validated against.
  const promptMax = getProviderConfig().promptMaxChars;
  if (prompt.length > promptMax) {
    throw new GenerationServiceError(
      `Prompts are limited to ${promptMax} characters. Shorten yours and try again.`,
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

  // Style table is kind-specific; an unknown value (e.g. an image style left
  // over after switching to video) clamps to the kind's default instead of
  // failing the render — the pill only ever offers valid values, staleness
  // shouldn't cost the user their generation.
  const styleTable = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  const defaultStyle = kind === "video" ? "Cinematic" : "Realistic";
  const rawStyle = typeof body.style === "string" ? body.style : defaultStyle;
  const style = rawStyle in styleTable ? rawStyle : defaultStyle;

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
    startImageRef: validateFrameRef(body.startImageRef, "startImage"),
    endImageRef: validateFrameRef(body.endImageRef, "endImage"),
    loras: validateLoras(body.loras),
  };
}

/** Hard loader bounds; per-LoRA catalog ranges are narrower and enforced
 * server-side by Sogni — this only stops nonsense from reaching it. */
const LORA_HARD_MIN = -100;
const LORA_HARD_MAX = 100;
const MAX_LORAS = 8;

/**
 * Lenient LoRA parsing: malformed entries are dropped (not rejected) so a
 * stale client selection can never cost the user their generation. Duplicate
 * ids keep their first position.
 */
function validateLoras(value: unknown): LoraSelection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const selections: LoraSelection[] = [];
  for (const entry of value) {
    if (selections.length >= MAX_LORAS) break;
    const loraId =
      typeof (entry as Record<string, unknown>)?.loraId === "string"
        ? ((entry as Record<string, unknown>).loraId as string)
        : "";
    if (!loraId || seen.has(loraId)) continue;
    const rawStrength = (entry as Record<string, unknown>)?.strength;
    const strength = typeof rawStrength === "number" && Number.isFinite(rawStrength)
      ? rawStrength
      : 1;
    seen.add(loraId);
    selections.push({
      loraId,
      strength: Math.min(LORA_HARD_MAX, Math.max(LORA_HARD_MIN, strength)),
    });
  }
  return selections;
}

/**
 * Validate the client's LoRA selections against the live catalog before the
 * request leaves the app. Sogni's worker fails the whole render on an unknown
 * loraId (verified live 2026-09-15), so anything the catalog doesn't list for
 * this model — stale client state, renamed ids — is stripped here. nsfw/sexual
 * adapters require the provider's Sensitive Content Filter off, so they're
 * dropped from safe (non-Uncensored) requests regardless of client state. If
 * the catalog itself is unreachable the adapters are dropped entirely: a render
 * without its LoRAs beats no render at all.
 */
/** Exported for the gating regression tests; not part of the public surface. */
export async function resolveLoras(
  selections: LoraSelection[],
  rawModelId: string,
  safe: boolean,
  log: Logger,
): Promise<LoraSelection[]> {
  const catalog = await fetchLoraCatalog().catch(() => null);
  const known = new Set(
    (catalog?.loras ?? [])
      .filter((entry) => entry.modelIds.includes(rawModelId))
      .filter((entry) => !safe || (!entry.nsfw && !entry.sexual))
      .map((entry) => entry.loraId),
  );
  const kept = selections.filter((s) => known.has(s.loraId));
  if (kept.length !== selections.length) {
    log.warn("dropped unknown or model-incompatible lora selections", {
      model: rawModelId,
      dropped: selections.filter((s) => !known.has(s.loraId)).map((s) => s.loraId),
      catalogAvailable: catalog !== null,
    });
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* Continuity frames                                                    */
/* ------------------------------------------------------------------ */

/** Load a continuity frame's bytes from the content-addressed media cache. */
async function loadFrame(ref: string, field: "startImage" | "endImage"): Promise<FrameImage> {
  const stored = await getMediaRepository().get(ref);
  if (!stored) {
    throw new GenerationServiceError(
      field === "startImage"
        ? "Continuity frame missing. Re-generate the previous scene or turn Continuity off."
        : "That end frame is no longer cached. Upload it again.",
      { field },
    );
  }
  return { bytes: stored.bytes, contentType: stored.contentType };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                        */
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

/**
 * Fetch + cache a provider-exported companion image (the exact final frame,
 * Seedance 2.5 `returnLastFrame`). Failure never fails the clip — chaining
 * falls back to client-side frame extraction.
 */
async function materializeCompanionFrame(
  artifact: GeneratedArtifact,
  log: Logger,
): Promise<string | undefined> {
  const url = artifact.companionFrameUrl;
  if (!url) return undefined;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const stored = await getMediaRepository().put(bytes);
    return `/api/media?f=${stored.ref}`;
  } catch (error) {
    log.warn("companion frame could not be cached", { error });
    return undefined;
  }
}

/** Persist artifacts and convert them to the client-facing media contract. */
export async function persistArtifacts(
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
      const endFrameUrl = await materializeCompanionFrame(materialized, log);
      if (materialized.bytes) {
        const stored = await repository.put(materialized.bytes, materialized.ext);
        return {
          id: `m_${materialized.seed.toString(36)}_${index}`,
          url: `/api/media?f=${stored.ref}`,
          width,
          height,
          seed: materialized.seed,
          mime: stored.contentType,
          ...(endFrameUrl ? { endFrameUrl } : {}),
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
        ...(endFrameUrl ? { endFrameUrl } : {}),
      } satisfies GeneratedMedia;
    }),
  );
}

export interface PreparedGeneration {
  normalized: NormalizedGenerationRequest;
  /** The provider + (possibly frame-swapped) model the render will use. */
  provider: ImageProvider & Partial<VideoProvider> | VideoProvider;
  model: ModelDescriptor;
  swapped: boolean;
  framesActive: boolean;
  hadStartImage: boolean;
  log: Logger;
}

/**
 * Shared pre-flight for both render paths (request-scoped and durable jobs):
 * resolve the model, load continuity-frame bytes from their refs, swap to a
 * frame-capable model when needed, and normalize under the safety gate.
 */
export async function prepareGeneration(
  request: ValidatedRequest,
  baseLog: Logger,
): Promise<PreparedGeneration> {
  const registry = getGenerationRegistry();

  // Jev prompt triage (optional accelerator): one parallel pass answers
  // safety, vagueness, and style-intent for the prompt in ~100ms at
  // negligible cost. Unconfigured or failed calls degrade to nulls and the
  // pipeline proceeds exactly as before — Jev refines, never gates.
  const log0 = (options.logger ?? rootLogger).child({ requestId });
  let triage: PromptTriage = {
    unsafeProbability: null,
    vagueProbability: null,
    styleHint: null,
  };
  if (jevConfigured()) {
    const t0 = Date.now();
    triage = await triagePrompt(request.rawPrompt);
    log0.info("jev triage", { ms: Date.now() - t0, ...triage });
    if (shouldBlock(triage)) {
      throw new GenerationServiceError(
        "This prompt was flagged as unsafe. Try rephrasing what you want to create.",
        { field: "prompt" },
      );
    }
  }
  const vagueness = vaguenessHint(triage);

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

  const log = baseLog.child({
    kind: request.kind,
    provider: resolved.provider.id,
    model: resolved.model.model,
    safe: request.safe,
  });
  log.info("generation started", { count: request.count, aspect: request.aspect });

  // Continuity frames: load refs first so a missing frame fails before any
  // provider call, then swap to a frame-capable model when needed.
  const startImage = request.startImageRef
    ? await loadFrame(request.startImageRef, "startImage")
    : undefined;
  const endImageRaw = request.endImageRef
    ? await loadFrame(request.endImageRef, "endImage")
    : undefined;

  let effective = resolved;
  let swapped = false;
  if (startImage && !resolved.model.frameInput?.start) {
    const swapId = resolved.model.i2vModelId;
    const swappedModel = swapId ? registry.resolve(swapId) : null;
    if (swappedModel?.model.frameInput?.start) {
      effective = swappedModel;
      swapped = true;
      log.info("frame capability swap", { from: resolved.model.id, to: effective.model.id });
    } else {
      log.warn("start frame provided but no capable model available — dropping frames", {
        model: resolved.model.id,
      });
    }
  }
  const endImage = endImageRaw && effective.model.frameInput?.end ? endImageRaw : undefined;
  if (endImageRaw && !endImage) {
    log.warn("end frame dropped — model cannot condition on a final frame", {
      model: effective.model.id,
    });
  }
  const framesActive = Boolean(startImage) && effective.model.frameInput?.start === true;

  // Sensored models (no uncensored capability) always keep the safety
  // checker on, whatever the Uncensored Mode toggle says. LoRA gating uses
  // the same effective flag so the adapters can never outrun the filter.
  const effectiveSafe = effective.model.uncensored === false ? true : request.safe;
  const normalized: NormalizedGenerationRequest = {
    kind: request.kind,
    // Style presets are folded into the prompt only when the model supports
    // them (provider-workflow video models take just the raw prompt). Jev's
    // vagueness hint appends enrichment context when the prompt scored as
    // underspecified — empty string when Jev is off or the prompt was fine.
    prompt:
      effective.model.stylesSupported === false
        ? `${request.rawPrompt}${vagueness ? ` ${vagueness}` : ""}`.trim()
        : styleWithPrompt(`${request.rawPrompt}${vagueness ? ` ${vagueness}` : ""}`.trim(), request.style),
    negativePrompt: request.negativePrompt,
    aspect: request.aspect,
    resolution: request.resolution,
    durationSeconds: durationToSeconds(request.duration),
    count: request.count,
    seed: request.seed ?? randomSeed(),
    safe: effectiveSafe,
    enhance: request.enhance,
    // LoRA adapters only ride along when the resolved model accepts them —
    // silently dropped otherwise (same degrade-don't-fail pattern as frames).
    ...(effective.model.loraCapable && request.loras.length
      ? { loras: await resolveLoras(request.loras, effective.model.model, effectiveSafe, log) }
      : {}),
    startImage: framesActive ? startImage : undefined,
    endImage,
  };

  return {
    normalized,
    provider: effective.provider,
    model: effective.model,
    swapped,
    framesActive,
    hadStartImage: Boolean(startImage),
    log,
  };
}

export async function runGeneration(
  body: Record<string, unknown>,
  options: RunGenerationOptions = {},
): Promise<GenerationResponse> {
  const started = Date.now();
  const request = validateGenerationRequest(body);
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const prepared = await prepareGeneration(request, (options.logger ?? rootLogger).child({ requestId }));
  const { normalized, provider: effectiveProvider, model: effectiveModel, swapped, framesActive, hadStartImage, log } = prepared;

  // Overall render budget (Settings → Render timeouts): a safety net around
  // every provider. A video budget applies per clip so multi-clip requests
  // keep their per-job allowance; client cancellation still propagates.
  const env = getStudioEnv();
  const budgetMs =
    request.kind === "video"
      ? env.videoRenderTimeoutMs * Math.max(1, request.count)
      : env.imageRenderTimeoutMs;
  const budgetSignal = AbortSignal.timeout(budgetMs);
  const renderSignal = options.signal
    ? AbortSignal.any([options.signal, budgetSignal])
    : budgetSignal;
  // Opaque client association for detached-render recovery (story scene id).
  const clientTag = sanitizeClientTag(body.clientTag);

  try {
    const artifacts =
      request.kind === "video"
        ? await (effectiveProvider as VideoProvider).generateVideo(
            normalized,
            effectiveModel,
            { logger: log, signal: renderSignal, onProgress: options.onProgress, clientTag },
          )
        : await (effectiveProvider as ImageProvider).generateImage(
            normalized,
            effectiveModel,
            { logger: log, signal: renderSignal, onProgress: options.onProgress, clientTag },
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
      ...(swapped
        ? {
            effectiveModelId: effectiveModel.id,
            effectiveModelLabel: effectiveModel.label,
          }
        : {}),
      ...(hadStartImage ? { frameUsed: framesActive && artifacts[0]?.frameDropped !== true } : {}),
      media,
    };
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      const minutes = Math.round(budgetMs / 60_000);
      log.warn("generation hit the render timeout", { budgetMs });
      throw new GenerationServiceError(
        `Your ${request.kind} render hit the ${minutes}-minute time limit. It may still be running on the provider — the durable job queue handles long renders better than this legacy path. You can retry, or raise the limit in Settings → Render timeouts.`,
        { retryable: true, status: 504, pending: true },
      );
    }
    if (error instanceof ProviderError) {
      log.error("provider failed", { message: error.message, retryable: error.retryable });
      throw new GenerationServiceError(error.message, {
        field: error.field,
        retryable: error.retryable,
        status: error.retryable ? 502 : 400,
        // A provider message announcing a detached render keeps the flag so
        // the UI can tell the user the render is not lost.
        pending: /detach/i.test(error.message),
      });
    }
    throw error;
  }
}

/** Opaque story-scene association (`s_x:sc_y`), sanitized for echo-only use. */
function sanitizeClientTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^\w:-]/g, "").slice(0, 120);
  return cleaned || undefined;
}
