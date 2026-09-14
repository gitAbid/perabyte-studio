"use client";

import { useMemo } from "react";
import { Icon } from "@/components/Icon";
import { mapSpecToAvatar } from "@/lib/avatarParams";
import type { CharacterSpec } from "@/lib/character";
import { AvatarScene } from "./AvatarScene";

/**
 * Live 3D preview panel: shows every wizard selection on a parametric
 * human in real time. Drag to rotate, scroll to zoom.
 */
export default function AvatarPreview({ spec }: { spec: CharacterSpec }) {
  const params = useMemo(() => mapSpecToAvatar(spec), [spec]);

  return (
    <div className="rounded-[20px] border border-border bg-white shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-primary-soft text-primary">
            <Icon name="user" size={14} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[13.5px] font-bold tracking-[-0.01em] text-ink">
              Live 3D Preview
            </h2>
            <p className="text-[11px] text-muted">Drag to rotate · scroll to zoom</p>
          </div>
        </div>
        {params.silhouetteOnly && (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning">
            Silhouette
          </span>
        )}
      </div>

      <div className="relative aspect-[4/5] w-full overflow-hidden bg-surface-2">
        <AvatarScene params={params} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/5 to-transparent" />
      </div>

      {params.notes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
          {params.notes.map((note) => (
            <span
              key={note}
              className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-soft"
            >
              {note}
            </span>
          ))}
        </div>
      )}

      <p className="border-t border-border px-4 py-2.5 text-[10.5px] leading-snug text-muted">
        Stylized CG preview of your configuration — the final AI render applies
        your style, scene and photoreal detail.
      </p>
    </div>
  );
}
