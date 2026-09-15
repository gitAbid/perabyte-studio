"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { groupLorasByCategory } from "@/lib/lora-options";
import type { LoraOption } from "@/lib/providers/sogni/lora-catalog";
import type { LoraSelection } from "@/lib/types";

/**
 * LoRA picker pill + popover for the composer's badge row. Entries are the
 * visible catalog for the active model (model join + nsfw gate applied by the
 * parent); toggling a LoRA on starts it at its own `default` strength — which
 * is often 0 or 0.8, deliberately NOT the provider's implicit 1.0.
 */

const PILL_IDLE =
  "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink";

function LoraRow({
  entry,
  selected,
  onToggle,
  onStrength,
}: {
  entry: LoraOption;
  selected?: LoraSelection;
  onToggle: () => void;
  onStrength: (value: number) => void;
}) {
  const active = Boolean(selected);
  return (
    <div className={`rounded-[10px] border px-2.5 py-2 transition-colors ${
      active ? "border-primary/40 bg-primary-soft/40" : "border-border bg-white"
    }`}>
      <button
        type="button"
        aria-pressed={active}
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={`inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
            active ? "border-primary bg-primary text-white" : "border-border-strong bg-white text-transparent"
          }`}
        >
          <Icon name="check" size={10} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-ink">
            {entry.name}
            {entry.rangeLabels && (
              <span className="ml-1.5 font-normal text-muted">
                {entry.rangeLabels.min} ↔ {entry.rangeLabels.max}
              </span>
            )}
          </span>
          {entry.description && (
            <span className="mt-0.5 block truncate text-[11px] font-normal text-muted">
              {entry.description}
            </span>
          )}
        </span>
        {active && (
          <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-primary">
            {selected!.strength > 0 ? "+" : ""}
            {selected!.strength}
          </span>
        )}
      </button>
      {active && selected && (
        <input
          type="range"
          aria-label={`${entry.name} strength`}
          min={entry.min}
          max={entry.max}
          step={entry.step}
          value={selected.strength}
          onChange={(e) => onStrength(Number(e.target.value))}
          className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-primary"
        />
      )}
    </div>
  );
}

export function LoraPicker({
  entries,
  selection,
  onChange,
  maxPerRequest,
}: {
  /** Visible catalog entries for the active model (nsfw already gated). */
  entries: LoraOption[];
  selection: LoraSelection[];
  onChange: (selection: LoraSelection[]) => void;
  maxPerRequest: number;
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

  const atCap = selection.length >= maxPerRequest;
  const sections = groupLorasByCategory(entries);

  function toggle(entry: LoraOption) {
    const existing = selection.find((s) => s.loraId === entry.loraId);
    if (existing) {
      onChange(selection.filter((s) => s.loraId !== entry.loraId));
    } else {
      onChange([...selection, { loraId: entry.loraId, strength: entry.default }]);
    }
  }

  function setStrength(entry: LoraOption, strength: number) {
    onChange(
      selection.map((s) => (s.loraId === entry.loraId ? { ...s, strength } : s)),
    );
  }

  return (
    // `contents` keeps pill and popover as flex items of the badge row while
    // the ref still covers both for the outside-click handler.
    <div ref={shellRef} className="contents">
      <button
        type="button"
        aria-label="LoRA adapters"
        aria-expanded={open}
        title="LoRA adapters — style, lighting and character sliders"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${
          open || selection.length ? "border-primary bg-primary-soft text-primary" : PILL_IDLE
        }`}
      >
        <Icon name="sliders" size={13} />
        LoRA
        {selection.length > 0 && (
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-bold leading-4 text-white">
            {selection.length}
          </span>
        )}
      </button>

      {open && (
        // Same shell as the advanced panel: inline block on mobile, popover
        // above the badge row from sm up.
        <div className="order-last w-full rounded-[14px] border border-border bg-white p-3.5 shadow-card sm:absolute sm:bottom-full sm:right-0 sm:z-30 sm:mb-2 sm:w-80 sm:shadow-lift">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
              LoRA adapters
            </p>
            <p className="text-[11px] font-semibold tabular-nums text-muted">
              {selection.length}/{maxPerRequest}
            </p>
          </div>

          {atCap && (
            <p className="mt-1.5 text-[11.5px] font-medium text-warning">
              Cap reached — remove one to add another.
            </p>
          )}

          <div className="mt-2.5 max-h-72 space-y-3.5 overflow-y-auto pr-0.5">
            {sections.map((section) => (
              <div key={section.category}>
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  {section.label}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {section.entries.map((entry) => (
                    <LoraRow
                      key={entry.loraId}
                      entry={entry}
                      selected={selection.find((s) => s.loraId === entry.loraId)}
                      onToggle={() => toggle(entry)}
                      onStrength={(value) => setStrength(entry, value)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
