"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface PillOption {
  value: string;
  label: string;
  hint?: string;
  /** Second row under the label (e.g. a model's use case). */
  description?: string;
  /** Tiny uppercase chips after the label (Sensored, Free, LoRA…). */
  badges?: string[];
  /** When any option carries one, the dropdown renders grouped sections
   * ordered by first appearance (e.g. Sensored / Uncensored models). */
  group?: string;
}

const PILL_BASE =
  "inline-flex h-9 items-center gap-1.5 rounded-[8px] border px-3 text-[12.5px] font-semibold transition-colors";
const PILL_IDLE =
  "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink";

/**
 * Compact dropdown used in the writer, review step, and conversion dialog.
 * The composer opts into the taller labeled-field presentation.
 */
export function PillSelect({
  icon,
  label,
  value,
  options,
  onChange,
  align = "left",
  placement = "up",
  presentation = "chip",
  disabled = false,
  disabledHint,
  tail,
}: {
  icon: IconName;
  label: string;
  value: string;
  options: PillOption[];
  onChange: (value: string) => void;
  align?: "left" | "right";
  /** Field treatment for labeled controls inside the generator settings grid. */
  presentation?: "chip" | "field";
  /** Panel opens up (default — composer pills live near the viewport bottom)
   * or down (pills in page headers near the top would clip above the window). */
  placement?: "up" | "down";
  /** Non-interactive pill for options the active model can't honour. */
  disabled?: boolean;
  disabledHint?: string;
  /** Collapsed "everything else" section (provider-grouped). */
  tail?: { label: string; options: PillOption[] };
}) {
  const [open, setOpen] = useState(false);
  const [tailOpen, setTailOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setTailOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!shellRef.current?.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A selected tail option isn't in `options` — without this lookup the pill
  // shows the raw value (e.g. "sogni:ltx23-…") instead of the model's label.
  const current =
    options.find((o) => o.value === value) ??
    tail?.options.find((o) => o.value === value);

  const renderOption = (option: PillOption) => {
    const active = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={active}
        onClick={() => {
          onChange(option.value);
          close();
        }}
        className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
          active
            ? "bg-primary-soft font-semibold text-primary"
            : "text-ink-soft hover:bg-surface-2"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{option.label}</span>
            {option.hint && (
              <span className="shrink-0 text-[11px] font-normal text-muted">
                {option.hint}
              </span>
            )}
            {option.badges?.map((badge) => (
              <span
                key={badge}
                className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-muted"
              >
                {badge}
              </span>
            ))}
          </span>
          {option.description && (
            <span className="mt-0.5 block truncate text-[11px] font-normal leading-tight text-muted">
              {option.description}
            </span>
          )}
        </span>
        {active && <Icon name="check" size={14} />}
      </button>
    );
  };

  /** Flat list when no groups are set; grouped sections (first-appearance
   * order, hairline separators) when any option carries a group label. */
  const renderSections = (list: PillOption[]) => {
    if (!list.some((option) => option.group)) {
      return list.map(renderOption);
    }
    const sections: { name: string; options: PillOption[] }[] = [];
    for (const option of list) {
      const name = option.group ?? "";
      let section = sections.find((candidate) => candidate.name === name);
      if (!section) {
        section = { name, options: [] };
        sections.push(section);
      }
      section.options.push(option);
    }
    return sections.map((section, index) => (
      <div
        key={section.name || "__all"}
        className={index > 0 ? "mt-1 border-t border-border pt-1" : undefined}
      >
        {section.name && (
          <p className="px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide text-muted">
            {section.name}
          </p>
        )}
        {section.options.map(renderOption)}
      </div>
    ));
  };

  return (
    <div ref={shellRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        aria-disabled={disabled || undefined}
        title={disabled ? (disabledHint ?? `${label} is not available for this model`) : undefined}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        className={`${presentation === "field"
          ? "flex h-12 w-full min-w-0 items-center gap-2 rounded-[8px] border px-2.5 text-left transition-colors"
          : PILL_BASE
        } ${
          disabled
            ? "cursor-not-allowed border-border bg-surface text-muted"
            : open
              ? "border-primary bg-primary-soft text-primary"
              : PILL_IDLE
        }`}
      >
        {presentation === "field" ? (
          <>
            <Icon name={icon} size={15} className="shrink-0" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[10px] font-bold uppercase tracking-[0.1em] text-muted">{label}</span>
              <span className="mt-0.5 block truncate text-[12.5px] font-semibold text-ink-soft">{current?.label ?? value}</span>
            </span>
            <Icon name="chevron-down" size={13} className="shrink-0 opacity-70" />
          </>
        ) : (
          <>
            <Icon name={icon} size={13} />
            <span className="whitespace-nowrap">{current?.label ?? value}</span>
            <Icon name="chevron-down" size={12} className="opacity-70" />
          </>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={label}
          className={`thin-scrollbar absolute z-30 max-h-80 w-72 overflow-y-auto rounded-[14px] border border-border bg-raised p-1.5 shadow-lift ${
            placement === "down" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          <p className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
            {label}
          </p>
          {renderSections(options)}
          {tail && tail.options.length > 0 && (
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => setTailOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface-2"
              >
                <Icon
                  name="chevron-down"
                  size={12}
                  className={`opacity-70 transition-transform ${tailOpen ? "" : "-rotate-90"}`}
                />
                {tail.label}
              </button>
              {tailOpen && renderSections(tail.options)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
