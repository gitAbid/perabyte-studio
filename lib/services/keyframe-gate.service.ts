import { createHash } from "node:crypto";
import { CLASSIFIABLE_REF_RE } from "@/lib/domain/moderation";
import {
  GATE_PASS_THRESHOLD,
  gateInstruction,
  parseGateReply,
  type GateExpectations,
} from "@/lib/domain/keyframe-gate";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import { sogniVisionComplete } from "@/lib/providers/sogni/sogni.vision";
import { getMediaRepository, isValidMediaRef } from "@/lib/repositories/media.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import type { SceneScore } from "@/lib/types";
import sharp from "sharp";

/**
 * Keyframe quality gate (story consistency): one vision score per media ref
 * and expectation set, cached in memory, joined across concurrent callers,
 * and never throwing — every failure degrades to `source: "unavailable"` so
 * the caller keeps the keyframe instead of blocking the scene. The shared
 * Sogni key pool is the scarce resource, so concurrent vision calls are
 * capped. Failures are remembered exactly like the moderation gate: a
 * per-key cooldown stops one bad image from being re-scored on every
 * attempt, and a circuit breaker stops an endpoint outage from turning
 * each scene into a full vision sweep.
 */

export interface KeyframeGateDecision {
  verdict: (SceneScore & { passed: boolean }) | null;
  source: "vision" | "cache" | "unavailable";
}

/** Re-exported for callers that compose expectations (lib/story/keyframe.ts). */
export type { GateExpectations };

/** Endpoint cap: "Inline image exceeds maximum dimensions of 1024px on its
 * longest side" (same endpoint as the moderation gate). */
const VISION_MAX_SIDE = 1024;
const MAX_VISION_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 2;

/** A key whose scoring just failed is not retried until this cooldown
 * passes — covers endpoint errors, junk replies, and media whose bytes
 * are missing or oversized. */
const FAILURE_COOLDOWN_MS = 15 * 60_000;
/** Consecutive endpoint failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;
/** While open, every scoring ask is answered as unavailable without
 * touching the endpoint — one outage sweep, not one per scene. */
const BREAKER_OPEN_MS = 10 * 60_000;

/** Cache/failure key: the ref plus a digest of the expectations, since the
 * same image scores differently against a different character description. */
function gateKey(ref: string, expectations: GateExpectations): string {
  const digest = createHash("sha1")
    .update(JSON.stringify(expectations))
    .digest("hex");
  return `${ref}:${digest}`;
}

const cache = new Map<string, SceneScore & { passed: boolean }>();
const failedAt = new Map<string, number>();
let endpointFailures = 0;
let breakerOpenUntil = 0;

/** Fit the bytes to the endpoint's 1024px inline-image cap; undecodable
 * payloads pass through unchanged so the endpoint's own error (→
 * unavailable) stays the honest verdict path. */
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

const pending = new Map<string, Promise<KeyframeGateDecision>>();

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

export async function scoreKeyframeRef(
  ref: string,
  expectations: GateExpectations,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<KeyframeGateDecision> {
  const key = gateKey(ref, expectations);
  const log = (options.logger ?? rootLogger).child({
    surface: "keyframe-gate",
    ref: ref.slice(0, 12),
  });
  const fallback: KeyframeGateDecision = { verdict: null, source: "unavailable" };
  if (!isValidMediaRef(ref) || !CLASSIFIABLE_REF_RE.test(ref)) return fallback;

  const cached = cache.get(key);
  if (cached) return { verdict: cached, source: "cache" };

  const now = Date.now();
  if (now < breakerOpenUntil) return fallback;
  if (now - (failedAt.get(key) ?? -Infinity) < FAILURE_COOLDOWN_MS) return fallback;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const task = runScoring(ref, expectations, key, log, options.signal).finally(() =>
    pending.delete(key),
  );
  pending.set(key, task);
  return task;
}

/** Record a failed attempt: per-key cooldown always, plus a step toward
 * opening the breaker when the endpoint itself looks unhealthy. */
function noteFailure(key: string, log: Logger, endpointUnhealthy: boolean): void {
  failedAt.set(key, Date.now());
  if (!endpointUnhealthy) return;
  endpointFailures += 1;
  if (endpointFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    endpointFailures = 0;
    log.warn("vision endpoint failing — keyframe gate breaker open", {
      openForMs: BREAKER_OPEN_MS,
    });
  }
}

function passedFor(score: SceneScore): boolean {
  return (
    score.identity >= GATE_PASS_THRESHOLD &&
    score.outfit >= GATE_PASS_THRESHOLD &&
    score.location >= GATE_PASS_THRESHOLD
  );
}

async function runScoring(
  ref: string,
  expectations: GateExpectations,
  key: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<KeyframeGateDecision> {
  const fallback: KeyframeGateDecision = { verdict: null, source: "unavailable" };
  if (!visionAvailable()) {
    log.debug("vision unavailable — keyframe gate open");
    return fallback;
  }
  await acquire();
  try {
    const stored = await getMediaRepository().get(ref);
    if (!stored || stored.bytes.length === 0) {
      log.warn("media bytes unavailable for scoring — keyframe gate open", {
        size: stored?.bytes.length ?? 0,
      });
      noteFailure(key, log, false);
      return fallback;
    }
    const vision = await prepareVisionImage(stored.bytes, stored.contentType, log);
    // The endpoint's 4MB inline cap applies to what we SEND, so the size
    // gate runs on the resized payload — big renders score instead of
    // permanently failing on their original bytes.
    if (vision.bytes.length > MAX_VISION_BYTES) {
      log.warn("vision payload exceeds the inline cap even resized — keyframe gate open", {
        size: vision.bytes.length,
      });
      noteFailure(key, log, false);
      return fallback;
    }
    const reply = await sogniVisionComplete(
      gateInstruction(expectations),
      { bytes: vision.bytes, contentType: vision.contentType },
      { signal },
    );
    if (signal?.aborted) {
      log.info("keyframe scoring aborted");
      return fallback;
    }
    const score = parseGateReply(reply);
    if (!score) {
      log.warn("vision reply unparsable — keyframe gate open", { reply: reply.slice(0, 120) });
      noteFailure(key, log, true);
      return fallback;
    }
    const verdict: SceneScore & { passed: boolean } = {
      ...score,
      passed: passedFor(score),
    };
    cache.set(key, verdict);
    endpointFailures = 0;
    failedAt.delete(key);
    log.info("keyframe scored", {
      identity: verdict.identity,
      outfit: verdict.outfit,
      location: verdict.location,
      passed: verdict.passed,
      notes: verdict.notes,
    });
    return { verdict, source: "vision" };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      log.info("keyframe scoring aborted");
      return fallback;
    }
    log.warn("keyframe scoring failed — gate open", {
      message: (error as Error)?.message,
    });
    noteFailure(key, log, true);
    return fallback;
  } finally {
    release();
  }
}

/** Test hook: drop in-flight tasks, the score cache, the concurrency gate,
 * failure cooldowns, and the breaker. */
export function resetKeyframeGateForTests(): void {
  cache.clear();
  pending.clear();
  failedAt.clear();
  endpointFailures = 0;
  breakerOpenUntil = 0;
  active = 0;
  waiters.length = 0;
}
