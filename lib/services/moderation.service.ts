import {
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
 * vision calls are capped.
 */

export interface ModerationDecision {
  verdict: ModerationVerdict | null;
  source: ModerationSource;
}

/** Only stills can ride the vision endpoint; mp4 scenes keep the flag. */
const CLASSIFIABLE_REFS = /\.(png|jpe?g|webp)$/;
const MAX_VISION_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 2;
/** Endpoint cap: "Inline image exceeds maximum dimensions of 1024px on its
 * longest side" (verified live 2026-09-16). Larger renders are downscaled. */
const VISION_MAX_SIDE = 1024;

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
  if (!isValidMediaRef(ref) || !CLASSIFIABLE_REFS.test(ref)) return fallback;

  const cached = getModerationRepository(ref);
  if (cached) return { verdict: cached, source: "cache" };

  const inFlight = pending.get(ref);
  if (inFlight) return inFlight;

  const task = runClassification(ref, log, options.signal).finally(() =>
    pending.delete(ref),
  );
  pending.set(ref, task);
  return task;
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
    if (!stored || stored.bytes.length === 0 || stored.bytes.length > MAX_VISION_BYTES) {
      log.warn("media bytes unavailable for classification — static mask policy", {
        size: stored?.bytes.length ?? 0,
      });
      return fallback;
    }
    const vision = await prepareVisionImage(stored.bytes, stored.contentType, log);
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
      return fallback;
    }
    putModerationRepository(ref, verdict);
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

/** Test hook: drop in-flight tasks and reset the concurrency gate. */
export function resetModerationServiceForTests(): void {
  pending.clear();
  active = 0;
  waiters.length = 0;
}
