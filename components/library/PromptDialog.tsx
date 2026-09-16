"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

/**
 * Small modal that asks for one line of text — rename flows for characters
 * and stories. ConfirmDialog-style shell (no provider, render when open).
 */
export function PromptDialog({
  open,
  title,
  label,
  initial = "",
  confirmLabel = "Save",
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  onSave(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-[20px] border border-border bg-raised p-6 shadow-lift">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        <label className="mt-4 block text-[12.5px] font-semibold text-muted">
          {label}
          <input
            type="text"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) onSave(value.trim());
              if (e.key === "Escape") onCancel();
            }}
            className="mt-1.5 h-11 w-full rounded-[12px] border border-border-strong bg-surface px-3 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
