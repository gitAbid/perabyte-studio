"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { uploadFrameRef } from "@/lib/media/frame";

export interface SceneRefs {
  startImageRef?: string;
  endImageRef?: string;
}

/**
 * Manual start/end frame upload slots for the scene being authored in the
 * story composer. The end-frame slot renders only when the selected model can
 * condition on a final frame. A manual start frame overrides auto-chaining
 * for that scene.
 */
export function SceneRefChips({
  startRef,
  endRef,
  endSupported,
  disabled,
  onChange,
  onError,
}: {
  startRef?: string;
  endRef?: string;
  /** The selected model can take an end frame — show the slot. */
  endSupported: boolean;
  disabled?: boolean;
  onChange: (patch: SceneRefs) => void;
  onError?: (message: string) => void;
}) {
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"start" | "end" | null>(null);

  async function pick(slot: "start" | "end", file: File | undefined) {
    if (!file || disabled) return;
    setBusy(slot);
    try {
      const ref = await uploadFrameRef(file);
      onChange(slot === "start" ? { startImageRef: ref } : { endImageRef: ref });
    } catch (error) {
      onError?.((error as Error).message ?? "That frame could not be uploaded.");
    } finally {
      setBusy(null);
    }
  }

  function chip(
    slot: "start" | "end",
    label: string,
    ref: string | undefined,
    input: React.RefObject<HTMLInputElement | null>,
  ) {
    return (
      <div className="min-w-0">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {label}
        </p>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            void pick(slot, event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {ref ? (
          <div className="group relative w-full overflow-hidden rounded-[10px] border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media?f=${ref}`}
              alt={`${label} reference`}
              className="aspect-video w-full object-cover"
            />
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()}`}
              disabled={disabled}
              onClick={() => onChange(slot === "start" ? { startImageRef: undefined } : { endImageRef: undefined })}
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => input.current?.click()}
            className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-border-strong bg-raised text-muted transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
          >
            <Icon name={busy === slot ? "clock" : "upload"} size={14} />
            <span className="text-[10px] font-semibold">
              {busy === slot ? "Uploading…" : "Upload"}
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`gap-2 ${endSupported ? "grid grid-cols-2" : "flex max-w-[140px]"}`}>
      {chip("start", "Start frame", startRef, startInput)}
      {endSupported ? chip("end", "End frame", endRef, endInput) : null}
    </div>
  );
}
