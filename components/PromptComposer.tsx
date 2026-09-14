"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Button } from "./ui";
import {
  ASPECTS,
  DURATIONS,
  IMAGE_STYLES,
  PROMPT_MAX,
  RESOLUTIONS,
  VIDEO_STYLES,
  VARIANT_COUNTS,
  type AspectKey,
  type DurationKey,
  type ResolutionKey,
} from "@/lib/constants";
import type { GenerationSettings } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Badge dropdown                                                      */
/* ------------------------------------------------------------------ */

interface Option {
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
 * studio stays on one screen, without a separate settings column.
 */
function PillSelect({
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
  options: Option[];
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

/* ------------------------------------------------------------------ */
/* Advanced ("more options")                                           */
/* ------------------------------------------------------------------ */

function AdvancedPanel({
  settings,
  onChange,
  onCopyPrompt,
}: {
  settings: GenerationSettings;
  onChange: (patch: Partial<GenerationSettings>) => void;
  onCopyPrompt: () => void;
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

  return (
    // `contents` keeps both children as flex items of the badge row, while the
    // ref still covers them for the outside-click handler.
    <div ref={shellRef} className="contents">
      <button
        type="button"
        aria-label="More options"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex size-8 items-center justify-center rounded-full border transition-colors ${
          open
            ? "border-primary bg-primary-soft text-primary"
            : PILL_IDLE
        }`}
      >
        <Icon name="sliders" size={14} />
      </button>

      {open && (
        // Mobile: a full-width block that expands inline under the badges (no
        // viewport overflow). sm and up: a popover anchored above the badges.
        <div className="order-last w-full rounded-[14px] border border-border bg-white p-3.5 shadow-card sm:absolute sm:bottom-full sm:right-0 sm:z-30 sm:mb-2 sm:w-72 sm:shadow-lift">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
            More options
          </p>

          <div className="mt-3 space-y-3.5">
            <div>
              <p className="text-[12px] font-semibold text-ink-soft">Variations</p>
              <div className="mt-1.5 flex gap-1.5">
                {VARIANT_COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={settings.count === n}
                    onClick={() => onChange({ count: n })}
                    className={`h-7 flex-1 rounded-[9px] border text-[12px] font-semibold transition-colors ${
                      settings.count === n
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-white text-ink-soft hover:border-border-strong"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-semibold text-ink-soft">
                Lock seed
              </span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="random"
                value={settings.seed}
                aria-label="Seed"
                onChange={(e) =>
                  onChange({ seed: e.target.value.replace(/[^\d]/g, "") })
                }
                className="h-8 w-28 rounded-[9px] border border-border-strong bg-white px-2.5 text-[12.5px] tabular-nums text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              />
            </label>

            <div>
              <p className="text-[12px] font-semibold text-ink-soft">
                Negative prompt
              </p>
              <textarea
                rows={2}
                maxLength={240}
                value={settings.negativePrompt}
                aria-label="Negative prompt"
                placeholder="blurry, watermark, low detail"
                onChange={(e) => onChange({ negativePrompt: e.target.value })}
                className="mt-1.5 w-full resize-none rounded-[9px] border border-border-strong bg-white px-2.5 py-2 text-[12.5px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={onCopyPrompt}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary hover:underline"
            >
              <Icon name="copy" size={13} />
              Copy prompt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

export function PromptComposer({
  kind,
  prompt,
  onPromptChange,
  promptError,
  settings,
  onSettingsChange,
  busy,
  onGenerate,
  onCancel,
  onCopyPrompt,
  title = "Prompt composer",
  headerBadge,
}: {
  kind: "image" | "video";
  prompt: string;
  onPromptChange: (value: string) => void;
  promptError?: string;
  settings: GenerationSettings;
  onSettingsChange: (patch: Partial<GenerationSettings>) => void;
  busy: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  onCopyPrompt: () => void;
  title?: string;
  headerBadge?: ReactNode;
}) {
  const styles = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;

  return (
    // The composer is the panel itself and stretches with its column, so the
    // prompt area absorbs the available height instead of leaving dead space.
    // The card keeps a static border — only the prompt surface reacts to focus.
    <div className="flex h-full min-h-0 flex-col rounded-[20px] border border-border bg-white p-4 shadow-card sm:p-5">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-ink">{title}</p>
          <p className="mt-0.5 hidden text-[11.5px] text-muted sm:block">
            Settings stay attached to the prompt.
          </p>
        </div>
        {headerBadge}
      </div>

      <label htmlFor="prompt-input" className="sr-only">
        {kind === "video" ? "Describe your video" : "Describe your image"}
      </label>
      {/* Tinted prompt surface so the input reads differently from the card. */}
      <div
        className={`mt-3 min-h-0 flex-1 rounded-[12px] border bg-surface px-3.5 py-3 transition-colors ${
          promptError
            ? "border-danger"
            : "border-border focus-within:border-primary"
        }`}
      >
        <textarea
          id="prompt-input"
          rows={3}
          value={prompt}
          maxLength={PROMPT_MAX}
          aria-invalid={promptError ? true : undefined}
          placeholder={
            kind === "video"
              ? "A cinematic shot of a car driving through a mountain road at sunset."
              : "A serene mountain landscape with a lake, sunrise, and pine trees."
          }
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!busy) onGenerate();
            }
          }}
          className="size-full min-h-[104px] resize-none bg-transparent text-[14px] leading-relaxed text-ink placeholder:text-muted focus:outline-none focus-visible:outline-none sm:text-[14.5px]"
        />
      </div>

      {/* Settings badges live inline in the prompt box. */}
      <div className="relative mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <PillSelect
          icon="grid"
          label="Aspect ratio"
          value={settings.aspect}
          options={Object.entries(ASPECTS).map(([value, meta]) => ({
            value,
            label: meta.label,
            hint: meta.hint,
          }))}
          onChange={(value) =>
            onSettingsChange({ aspect: value as AspectKey })
          }
        />
        <PillSelect
          icon="sparkle"
          label="Resolution"
          value={settings.resolution}
          options={Object.entries(RESOLUTIONS).map(([value, meta]) => ({
            value,
            label: value,
            hint: meta.label.split("·")[1]?.trim(),
          }))}
          onChange={(value) =>
            onSettingsChange({ resolution: value as ResolutionKey })
          }
        />
        <PillSelect
          icon="image"
          label="Style"
          value={settings.style}
          options={Object.keys(styles).map((name) => ({ value: name, label: name }))}
          onChange={(value) => onSettingsChange({ style: value })}
        />
        {kind === "video" && (
          <PillSelect
            icon="clock"
            label="Duration"
            value={settings.duration}
            options={DURATIONS.map((value) => ({ value, label: value }))}
            onChange={(value) =>
              onSettingsChange({ duration: value as DurationKey })
            }
          />
        )}

        {/* Prompt enhancement is a first-class toggle, not buried in options. */}
        <button
          type="button"
          role="switch"
          aria-checked={settings.enhance}
          aria-label="Prompt enhancement"
          title="Prompt enhancement — expand short prompts with extra detail"
          onClick={() => onSettingsChange({ enhance: !settings.enhance })}
          className={`${PILL_BASE} ${
            settings.enhance
              ? "border-primary bg-primary-soft text-primary"
              : PILL_IDLE
          }`}
        >
          <Icon name="layers" size={13} />
          <span className="whitespace-nowrap">Enhance</span>
          {settings.enhance && <Icon name="check" size={12} />}
        </button>

        <AdvancedPanel
          settings={settings}
          onChange={onSettingsChange}
          onCopyPrompt={onCopyPrompt}
        />
      </div>

      <div className="mt-2.5 flex shrink-0 items-center gap-2">
        <span
          className={`text-[11.5px] tabular-nums text-muted ${
            prompt.length > PROMPT_MAX - 60 ? "text-warning" : ""
          }`}
        >
          {prompt.length}/{PROMPT_MAX}
        </span>
        <span className="hidden text-[11.5px] text-muted lg:block">
          · ⌘ + Enter to generate
        </span>

        {busy ? (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            icon="sparkle"
            onClick={onGenerate}
            className="ml-auto shrink-0"
          >
            Generate
          </Button>
        )}
      </div>

      {promptError && (
        <p
          role="alert"
          className="mt-2 flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-danger"
        >
          <Icon name="alert" size={13} />
          {promptError}
        </p>
      )}
    </div>
  );
}
