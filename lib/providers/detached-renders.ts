import { getMediaRepository } from "@/lib/repositories/media.repository";
import {
  addPendingRender,
  updatePendingRender,
  type PendingRender,
} from "@/lib/repositories/pending-renders.repository";
import type { Logger } from "@/lib/logging/logger";

/**
 * Shared plumbing for detached render continuations. When our render timeout
 * wins the race, the provider usually keeps rendering — Sogni projects run to
 * completion server-side and apikey.fan jobs stay pollable for ~24 h. The
 * continuation that keeps waiting records the job here, and when it
 * eventually finishes the result is downloaded into the media cache so the
 * studio UI can absorb it (story scene or History).
 */

export interface DetachedRenderInfo {
  provider: string;
  kind: "image" | "video";
  modelId: string;
  prompt: string;
  clientTag?: string;
}

/** Download a finished provider URL into our media cache. */
export async function materializeToMediaCache(
  url: string,
  ext: string,
): Promise<{ url: string; mime: string }> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`download failed with status ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const stored = await getMediaRepository().put(bytes, ext);
  return { url: `/api/media?f=${stored.ref}`, mime: stored.contentType };
}

/** Record an abandoned-but-still-running render and get its registry id. */
export function recordDetachedRender(info: DetachedRenderInfo): PendingRender {
  return addPendingRender({ ...info, status: "detached" });
}

/** Flip a detached record to recovered once its media is on our origin. */
export function markRenderRecovered(
  id: string,
  media: { url: string; mime: string },
): void {
  updatePendingRender(id, { status: "recovered", media });
}

/** Flip a detached record to failed (provider job failed, expired, lost). */
export function markRenderFailed(id: string, note?: string): void {
  updatePendingRender(id, { status: "failed", note });
}

/** Log helper so detached outcomes stay visible in production logs. */
export function detachedLog(
  logger: Logger | undefined,
  id: string,
  event: string,
  extra?: Record<string, unknown>,
): void {
  logger?.child({ module: "detached-renders", pendingId: id }).info(event, extra);
}
