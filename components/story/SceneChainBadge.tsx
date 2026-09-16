"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useSmartMask } from "@/lib/moderation-client";
import type { EffectiveChainRef } from "@/lib/story/chain";

/**
 * Chain-reference badge for one story scene card: shows the exact frame the
 * scene starts from — the previous scene's derived final frame, or the
 * scene's own manual start frame — overlaid bottom-left on the card. Pending
 * chains (frame not derived yet) show a pulsing link instead of a thumb.
 * Click a thumb to enlarge; an 18+ veiled thumb stays blurred and doesn't
 * enlarge (same smart-mask policy as MediaFrame).
 */
export function SceneChainBadge({
  resolution,
  sensitive,
}: {
  resolution: EffectiveChainRef;
  /** The frame's source scene rendered with the safety checker off. */
  sensitive?: boolean;
}) {
  const [zoomed, setZoomed] = useState(false);
  // The hook must run before the early return below, so resolve the frame
  // ref first — the badge masks by the same content-aware verdict as the
  // scene card itself.
  const chainRef =
    resolution.state === "manual" || resolution.state === "chained"
      ? resolution.ref
      : undefined;
  const { masked } = useSmartMask(sensitive, chainRef ? `/api/media?f=${chainRef}` : null);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (resolution.state === "none") return null;
  const ref = chainRef;
  const label =
    resolution.state === "manual"
      ? "Your start frame"
      : resolution.state === "chained"
        ? `From Scene ${resolution.predecessorIndex + 1}`
        : `Scene ${resolution.predecessorIndex + 1}'s last frame`;

  return (
    <>
      <div className="absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1.5">
        {ref ? (
          <button
            type="button"
            aria-label="Enlarge the reference frame"
            title={masked ? "Reference frame (veiled)" : "Enlarge the reference frame"}
            onClick={() => {
              if (!masked) setZoomed(true);
            }}
            className="shrink-0 overflow-hidden rounded-[10px] border border-border shadow-card"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media?f=${ref}`}
              alt=""
              className={`size-[52px] object-cover ${masked ? "scale-105 blur-md" : ""}`}
            />
          </button>
        ) : (
          <span
            title={`Continues from Scene ${resolution.state === "pending" ? resolution.predecessorIndex + 1 : ""}'s final frame`}
            className="inline-flex size-[52px] shrink-0 items-center justify-center rounded-[10px] border border-dashed border-white/40 bg-black/55"
          >
            <Icon name="link" size={16} className="animate-pulse text-white" />
          </span>
        )}
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-white/20 bg-black/55 px-2 py-1 text-[10.5px] font-semibold text-white shadow-card backdrop-blur-sm">
          <Icon name="link" size={11} className="shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      </div>
      {zoomed && ref && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reference frame"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setZoomed(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media?f=${ref}`}
            alt="Reference frame"
            className="max-h-full max-w-full rounded-[16px] border border-white/10 bg-white object-contain shadow-lift"
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setZoomed(false)}
            className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-card transition-colors hover:bg-black/70"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </>
  );
}
