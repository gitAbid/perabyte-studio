import {
  CLASSIFIABLE_REF_RE,
  MODERATION_USER_INSTRUCTION,
  mediaRefFromSrc,
  parseVerdictReply,
  type ModerationSource,
  type ModerationVerdict,
} from "@/lib/domain/moderation";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import {
  sogniVisionComplete,
  SOGNI_VISION_MODEL,
} from "@/lib/providers/sogni/sogni.vision";
import { getMediaRepository, isValidMediaRef } from "@/lib/repositories/media.repository";
import {
  getModerationRepository,
  putModerationRepository,
} from "@/lib/repositories/moderation.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import sharp from "sharp";

/**
 * Content-aware 18+ classification (spec 2026-09-16-smart-masking): one
 * vision verdict per unique media, cached by the content-addressed ref,
 * joined across concurrent callers, and never throwing — every failure
 * degrades to `source: "static"` so the UI falls back to the generation
 * flag. The shared Sogni key pool is the scarce resource, so concurrent
 * vision calls are capped. Failures are remembered: a per-ref cooldown
 * stops one bad image from being re-attempted on every view, and a
 * circuit breaker stops an endpoint outage from turning each page view
 * into a full vision sweep over the whole library.
 */

export interface ModerationDecision {
  verdict: ModerationVerdict | null;
  source: ModerationSource;
}

/** Endpoint cap: "Inline image exceeds maximum dimensions of 1024px on its
 * longest side" (verified live 2026-09-16). Larger renders are downscaled. */
const VISION_MAX_SIDE = 1024;
const MAX_VISION_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 2;

/** A ref whose classification just failed is not retried until this
 * cooldown passes — covers endpoint errors, junk replies, and media whose
 * bytes are missing or oversized. */
const FAILURE_COOLDOWN_MS = 15 * 60_000;
/** Consecutive endpoint failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;
/** While open, every classification is answered from the static flag
 * without touching the endpoint — one outage sweep, not one per view. */
const BREAKER_OPEN_MS = 10 * 60_000;

const failedAt = new Map<string, number>();
let endpointFailures = 0;
let breakerOpenUntil = 0;

/** Fit the bytes to the endpoint's 1024px inline-image cap; undecodable
 * payloads pass through unchanged so the endpoint's own error (→ static
 * fallback) stays the honest verdict path. */
async function prepareVisionImage(
  bytes: Buffer,
  contentType: string,
  log: Logger,
): Promise<{ bytes: Buffer; contentType: string }> {
  try {
    const meta = await sharp(bytes).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longest <= VISION_MAX_SIDE) return { bytes, contentType };
    const resized = await sharp(bytes)
      .resize({ width: VISION_MAX_SIDE, height: VISION_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    log.debug("vision image downscaled to the 1024px endpoint cap", {
      from: `${meta.width}x${meta.height}`,
      bytes: resized.length,
    });
    return { bytes: resized, contentType: "image/png" };
  } catch {
    return { bytes, contentType };
  }
}

const pending = new Map<string, Promise<ModerationDecision>>();

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

function visionAvailable(): boolean {
  const env = getStudioEnv();
  if (!env.sogniApiKey) return false;
  return getProviderConfig().providers.sogni?.enabled !== false;
}

export async function classifyMediaRef(
  ref: string,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<ModerationDecision> {
  const log = (options.logger ?? rootLogger).child({
    surface: "moderation",
    ref: ref.slice(0, 12),
  });
  const fallback: ModerationDecision = { verdict: null, source: "static" };
  if (!isValidMediaRef(ref) || !CLASSIFIABLE_REF_RE.test(ref)) return fallback;

  const cached = getModerationRepository(ref);
  if (cached) return { verdict: cached, source: "cache" };

  const now = Date.now();
  if (now < breakerOpenUntil) return fallback;
  if (now - (failedAt.get(ref) ?? -Infinity) < FAILURE_COOLDOWN_MS) return fallback;

  const inFlight = pending.get(ref);
  if (inFlight) return inFlight;

  const task = runClassification(ref, log, options.signal).finally(() =>
    pending.delete(ref),
  );
  pending.set(ref, task);
  return task;
}

/** Record a failed attempt: per-ref cooldown always, plus a step toward
 * opening the breaker when the endpoint itself looks unhealthy. */
function noteFailure(ref: string, log: Logger, endpointUnhealthy: boolean): void {
  failedAt.set(ref, Date.now());
  if (!endpointUnhealthy) return;
  endpointFailures += 1;
  if (endpointFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    endpointFailures = 0;
    log.warn("vision endpoint failing — moderation breaker open", {
      openForMs: BREAKER_OPEN_MS,
    });
  }
}

async function runClassification(
  ref: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<ModerationDecision> {
  const fallback: ModerationDecision = { verdict: null, source: "static" };
  if (!visionAvailable()) {
    log.debug("vision unavailable — static mask policy");
    return fallback;
  }
  await acquire();
  try {
    const stored = await getMediaRepository().get(ref);
    if (!stored || stored.bytes.length === 0) {
      log.warn("media bytes unavailable for classification — static mask policy", {
        size: stored?.bytes.length ?? 0,
      });
      noteFailure(ref, log, false);
      return fallback;
    }
    const vision = await prepareVisionImage(stored.bytes, stored.contentType, log);
    // The endpoint's 4MB inline cap applies to what we SEND, so the size
    // gate runs on the resized payload — big renders classify instead of
    // permanently failing on their original bytes.
    if (vision.bytes.length > MAX_VISION_BYTES) {
      log.warn("vision payload exceeds the inline cap even resized — static mask policy", {
        size: vision.bytes.length,
      });
      noteFailure(ref, log, false);
      return fallback;
    }
    const reply = await sogniVisionComplete(
      MODERATION_USER_INSTRUCTION,
      { bytes: vision.bytes, contentType: vision.contentType },
      { signal },
    );
    if (signal?.aborted) {
      log.info("classification aborted");
      return fallback;
    }
    const verdict = parseVerdictReply(reply, SOGNI_VISION_MODEL);
    if (!verdict) {
      log.warn("vision reply unparsable — static mask policy", { reply: reply.slice(0, 120) });
      noteFailure(ref, log, true);
      return fallback;
    }
    putModerationRepository(ref, verdict);
    endpointFailures = 0;
    failedAt.delete(ref);
    log.info("media classified", {
      sensitive: verdict.sensitive,
      category: verdict.category,
      confidence: verdict.confidence,
      uncertain: verdict.uncertain ?? false,
      reason: verdict.reason,
    });
    return { verdict, source: "ai" };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      log.info("classification aborted");
      return fallback;
    }
    log.warn("vision classification failed — static mask policy", {
      message: (error as Error)?.message,
    });
    noteFailure(ref, log, true);
    return fallback;
  } finally {
    release();
  }
}

/**
 * Fire-and-forget server warm-up: classify ahead of the client asking.
 * Accepts a full media URL and ignores anything without a cache ref.
 */
export function warmModeration(url: string | null | undefined, logger?: Logger): void {
  const ref = mediaRefFromSrc(url);
  if (!ref) return;
  void classifyMediaRef(ref, { logger }).catch(() => undefined);
}

/** Test hook: drop in-flight tasks and reset the concurrency gate,
 * failure cooldowns, and the breaker. */
export function resetModerationServiceForTests(): void {
  pending.clear();
  failedAt.clear();
  endpointFailures = 0;
  breakerOpenUntil = 0;
  active = 0;
  waiters.length = 0;
}
