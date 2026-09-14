"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface PillOption {
  value: string;
  label: string;
  hint?: string;
}

const PILL_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors";
const PILL_IDLE =
  "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink";

/**
 * A badge-shaped dropdown. Values live inline in the prompt box so the whole
 * studio stays on one screen, without a separate settings column. Shared by
 * the prompt composer and the character review step.
 */
export function PillSelect({
  icon,
  label,
  value,
  options,
  onChange,
  align = "left",
}: {
  icon: IconName;
  label: string;
  value: string;
  options: PillOption[];
  onChange: (value: string) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={shellRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        onClick={() => setOpen((v) => !v)}
        className={`${PILL_BASE} ${
          open
            ? "border-primary bg-primary-soft text-primary"
            : PILL_IDLE
        }`}
      >
        <Icon name={icon} size={13} />
        <span className="whitespace-nowrap">{current?.label ?? value}</span>
        <Icon name="chevron-down" size={12} className="opacity-70" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={label}
          className={`thin-scrollbar absolute bottom-[calc(100%+8px)] z-30 max-h-64 w-56 overflow-y-auto rounded-[14px] border border-border bg-white p-1.5 shadow-lift ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
            {label}
          </p>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  active
                    ? "bg-primary-soft font-semibold text-primary"
                    : "text-ink-soft hover:bg-surface-2"
                }`}
              >
                <span className="flex-1 truncate">
                  {option.label}
                  {option.hint && (
                    <span className="ml-1.5 text-[11.5px] font-normal text-muted">
                      {option.hint}
                    </span>
                  )}
                </span>
                {active && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
