"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PillSelect } from "@/components/PillSelect";
import { Button } from "@/components/ui";
import type { ModelOption } from "@/lib/model-catalog";

/**
 * Confirmation popover for image-story → video-story conversion (spec §9):
 * shows the clip count and an end-capable model picker BEFORE anything
 * renders. Confirming enqueues the clips; escape dismisses untouched.
 */
export function ConvertDialog({
  clipCount,
  models,
  defaultModelId,
  onConfirm,
  onClose,
}: {
  clipCount: number;
  /** End-capable models only (no dead choices). */
  models: ModelOption[];
  defaultModelId: string | null;
  onConfirm: (modelId: string) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(defaultModelId);

  // The end-capable catalog loads async — adopt the default when it arrives.
  useEffect(() => {
    setChosen((current) => current ?? defaultModelId);
  }, [defaultModelId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center rounded-[20px] bg-black/20 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Convert image story to video"
    >
      <div className="w-full max-w-[340px] rounded-[16px] border border-border bg-white p-4 shadow-card">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[14px] font-extrabold text-ink">Animate your story</p>
            <p className="mt-0.5 text-[12px] text-muted">
              {clipCount} clip{clipCount === 1 ? "" : "s"} · each image becomes the first and last
              frame of one clip.
            </p>
          </div>
          <button
            type="button"
            aria-label="Cancel conversion"
            onClick={onClose}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Video model
          </p>
          <PillSelect
            icon="video"
            label="Model"
            value={chosen ?? models[0]?.id ?? ""}
            onChange={setChosen}
            options={models.map((model) => ({
              value: model.id,
              label: model.label,
              hint: model.providerLabel,
            }))}
          />
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            icon="video"
            disabled={!chosen}
            onClick={() => chosen && onConfirm(chosen)}
          >
            Convert
          </Button>
        </div>
      </div>
    </div>
  );
}
