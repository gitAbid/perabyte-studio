"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { uploadFrameRef } from "@/lib/media/frame";

/** Media-cache refs for manual frames: `startImageRef` = first/reference
 * frame, `endImageRef` = last frame. Same shape the generation API takes. */
export interface FrameRefs {
  startImageRef?: string;
  endImageRef?: string;
}

export interface FrameSlotSpec {
  /** Which ref the slot fills. */
  key: keyof FrameRefs;
  /** User-facing name — "First frame", "Last frame", "Reference image". */
  label: string;
}

const ACCEPTED = "image/png,image/jpeg,image/webp";

/**
 * Frame attachment row for the prompt composer: dashed "add" pills that
 * morph into thumbnail chips once a frame is uploaded. Click a pill to pick
 * a file, click a chip to replace it, hover a chip for the remove badge.
 * Dropping an image anywhere on the row — or pasting one while the composer
 * is mounted — fills the first empty slot.
 */
export function FrameDock({
  slots,
  refs,
  disabled,
  onChange,
  onError,
  className = "",
}: {
  slots: FrameSlotSpec[];
  refs: FrameRefs;
  disabled?: boolean;
  onChange: (patch: FrameRefs) => void;
  onError?: (message: string) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const slotAwaitingFile = useRef<keyof FrameRefs>("startImageRef");
  const [busySlot, setBusySlot] = useState<keyof FrameRefs | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function attach(slotKey: keyof FrameRefs, file: File | undefined) {
    if (!file || disabled) return;
    if (!file.type.startsWith("image/")) {
      onError?.("That file isn't an image — PNG, JPEG or WebP works best.");
      return;
    }
    setBusySlot(slotKey);
    try {
      const ref = await uploadFrameRef(file);
      onChange({ [slotKey]: ref } as FrameRefs);
    } catch (error) {
      onError?.((error as Error).message ?? "That frame could not be uploaded.");
    } finally {
      setBusySlot(null);
    }
  }

  /** First empty slot; a lone slot also takes replacements, a full multi-slot
   * dock asks the user to clear one first. */
  function targetSlot(): keyof FrameRefs | null {
    const empty = slots.find((slot) => !refs[slot.key]);
    if (empty) return empty.key;
    if (slots.length === 1) return slots[0].key;
    return null;
  }

  function openPicker(slotKey: keyof FrameRefs) {
    slotAwaitingFile.current = slotKey;
    input.current?.click();
  }

  // Paste an image anywhere while the composer is up — it lands in the first
  // empty slot. Only image pastes are intercepted; text is untouched.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (disabled) return;
      const file = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      if (!file) return;
      const slotKey = targetSlot();
      if (!slotKey) {
        onError?.("Both frame slots are filled — remove one first.");
        return;
      }
      event.preventDefault();
      void attach(slotKey, file);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebind when the slot picture changes
  }, [disabled, slots, refs]);

  if (slots.length === 0) return null;

  return (
    // Negative margins grow the drop-target tint past the row without
    // shifting its siblings.
    <div
      className={`-my-1 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-[12px] px-1.5 py-1 transition-colors ${
        dragOver ? "bg-primary-soft/60" : ""
      } ${className}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (disabled) return;
        const slotKey = targetSlot();
        if (!slotKey) {
          onError?.("Both frame slots are filled — remove one first.");
          return;
        }
        void attach(slotKey, event.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={(event) => {
          void attach(slotAwaitingFile.current, event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {slots.map((slot) => {
        const ref = refs[slot.key];
        const slotBusy = busySlot === slot.key;
        return ref ? (
          <div key={slot.key} className="group relative h-8 w-16 shrink-0">
            <button
              type="button"
              disabled={disabled || busySlot !== null}
              onClick={() => openPicker(slot.key)}
              aria-label={`Replace ${slot.label.toLowerCase()}`}
              title={`${slot.label} — click to replace`}
              className="block size-full overflow-hidden rounded-full border border-border transition-colors hover:border-primary disabled:opacity-60"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media?f=${ref}`}
                alt=""
                className="size-full object-cover"
              />
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ [slot.key]: undefined } as FrameRefs)}
              aria-label={`Remove ${slot.label.toLowerCase()}`}
              title={`Remove ${slot.label.toLowerCase()}`}
              className={`absolute -right-1 -top-1 inline-flex size-4 items-center justify-center rounded-full bg-black/60 text-white transition-opacity hover:bg-black/80 ${
                slotBusy ? "opacity-0" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
              }`}
            >
              <Icon name="close" size={9} />
            </button>
            {slotBusy && (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white">
                <Icon name="clock" size={12} className="animate-pulse" />
              </div>
            )}
          </div>
        ) : (
          <button
            key={slot.key}
            type="button"
            disabled={disabled || busySlot !== null}
            onClick={() => openPicker(slot.key)}
            aria-label={`Add ${slot.label.toLowerCase()}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 text-[11.5px] font-semibold text-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon
              name={slotBusy ? "clock" : "plus"}
              size={12}
              className={slotBusy ? "animate-pulse" : undefined}
            />
            {slotBusy ? "Uploading…" : slot.label}
          </button>
        );
      })}
    </div>
  );
}
