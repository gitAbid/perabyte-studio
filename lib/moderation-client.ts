"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CLASSIFIABLE_REF_RE,
  effectiveSensitive,
  isModerationVerdict,
  mediaRefFromSrc,
  type ModerationVerdict,
} from "@/lib/domain/moderation";
import { useSettings } from "@/lib/repositories/settings.repository";

/**
 * Client side of smart masking: one verdict request per media ref, cached
 * for the session in memory and across sessions in localStorage (the ref
 * is the sha256 of the bytes, so a stored verdict can never go stale).
 * Requests run through a small queue with a timeout so a slow or down
 * vision endpoint cannot flood the browser's per-origin connection pool
 * and stall every other call — that queueing is what made the library
 * page hang. Non-classifiable refs (mp4/webm) never hit the network.
 */

const verdictCache = new Map<string, Promise<ModerationVerdict | null>>();

const STORE_PREFIX = "perabyte.moderation.v1:";
/** Per-request cap: the server classifies with its own 25s budget. */
const FETCH_TIMEOUT_MS = 20_000;
/** Verdict fetches in flight at once — keep slots free for real media. */
const MAX_CONCURRENT_FETCHES = 2;

function readStoredVerdict(ref: string): ModerationVerdict | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + ref);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isModerationVerdict(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredVerdict(ref: string, verdict: ModerationVerdict): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + ref, JSON.stringify(verdict));
  } catch {
    // Private mode / full quota: the session cache still works.
  }
}

const waiters: Array<() => void> = [];
let activeFetches = 0;

async function withFetchSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    await new Promise<void>((release) => waiters.push(release));
  }
  activeFetches += 1;
  try {
    return await task();
  } finally {
    activeFetches -= 1;
    waiters.shift()?.();
  }
}

function fetchVerdict(ref: string): Promise<ModerationVerdict | null> {
  return withFetchSlot(() =>
    fetch("/api/moderate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json().catch(() => null)) as {
          verdict?: ModerationVerdict | null;
        } | null;
        return body?.verdict ?? null;
      })
      .catch(() => null),
  );
}

export function requestVerdict(ref: string): Promise<ModerationVerdict | null> {
  const cached = verdictCache.get(ref);
  if (cached) return cached;

  const stored = readStoredVerdict(ref);
  if (stored) {
    const task = Promise.resolve(stored);
    verdictCache.set(ref, task);
    return task;
  }

  const task = fetchVerdict(ref).then((verdict) => {
    if (verdict) writeStoredVerdict(ref, verdict);
    else verdictCache.delete(ref); // a miss stays retryable within the session
    return verdict;
  });
  verdictCache.set(ref, task);
  return task;
}

export interface SmartMask {
  /** Content-aware decision: confident verdict, else the static flag. */
  sensitive: boolean;
  masked: boolean;
  reveal: () => void;
}

/**
 * Content-aware replacement for the raw `sensitive && maskUncensored`
 * check. Pass the caller's static flag and the served src; when smart
 * masking (and masking itself) is on, the frame's verdict is requested
 * once and overrides the static flag in both directions.
 */
export function useSmartMask(
  staticSensitive: boolean | undefined,
  src: string | null,
): SmartMask {
  const { settings } = useSettings();
  const [verdict, setVerdict] = useState<ModerationVerdict | null>(null);
  const [revealed, setRevealed] = useState(false);

  const enabled = settings.maskUncensored && settings.smartMask;
  const mediaRef = enabled ? mediaRefFromSrc(src) : null;
  // Videos never ride the vision endpoint — don't spend a request on them.
  const ref = mediaRef && CLASSIFIABLE_REF_RE.test(mediaRef) ? mediaRef : null;

  useEffect(() => {
    if (!ref) {
      setVerdict(null);
      return;
    }
    let alive = true;
    void requestVerdict(ref).then((v) => {
      if (alive) setVerdict(v);
    });
    return () => {
      alive = false;
    };
  }, [ref]);

  const sensitive = effectiveSensitive(Boolean(staticSensitive), verdict);

  // Reveal is per frame instance and resets whenever the source or the
  // sensitivity flips — a late "this is actually explicit" verdict must
  // not be silently overridden by an earlier reveal of tame content.
  useEffect(() => setRevealed(false), [src, sensitive]);

  return {
    sensitive,
    masked: enabled && sensitive && !revealed,
    reveal: useCallback(() => setRevealed(true), []),
  };
}

/** Test hook: clear the session verdict cache (localStorage entries are
 * content-addressed and intentionally survive). */
export function resetModerationClientForTests(): void {
  verdictCache.clear();
}
