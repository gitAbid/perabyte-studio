"use client";

import { useCallback, useEffect, useState } from "react";
import {
  effectiveSensitive,
  mediaRefFromSrc,
  type ModerationVerdict,
} from "@/lib/domain/moderation";
import { useSettings } from "@/lib/repositories/settings.repository";

/**
 * Client side of smart masking: one verdict request per media ref per
 * session (module-level cache over the content-addressed ref), and the
 * `useSmartMask` hook that turns a static generation flag into a
 * content-aware mask decision. The static flag rules until a confident
 * verdict lands — no flash of unmasked explicit content, and an explicit
 * safe-mode render gains its veil a moment after display.
 */

const verdictCache = new Map<string, Promise<ModerationVerdict | null>>();

export function requestVerdict(
  ref: string,
  signal?: AbortSignal,
): Promise<ModerationVerdict | null> {
  const cached = verdictCache.get(ref);
  if (cached) return cached;
  const task = fetch("/api/moderate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
    signal,
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        verdict?: ModerationVerdict | null;
      } | null;
      return body?.verdict ?? null;
    })
    .catch(() => null);
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
  const ref = enabled ? mediaRefFromSrc(src) : null;

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

/** Test hook: clear the per-session verdict cache. */
export function resetModerationClientForTests(): void {
  verdictCache.clear();
}
