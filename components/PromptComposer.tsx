"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Button, Toggle } from "./ui";
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
        className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${
          open
            ? "border-primary bg-primary-soft text-primary"
            : "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink"
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
          className={`absolute bottom-[calc(100%+8px)] z-30 max-h-64 w-56 overflow-y-auto rounded-[14px] border border-border bg-white p-1.5 shadow-lift ${
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
/* Advanced popover                                                    */
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
    <div ref={shellRef} className="relative">
      <button
        type="button"
        aria-label="Advanced settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex size-8 items-center justify-center rounded-full border transition-colors ${
          open
            ? "border-primary bg-primary-soft text-primary"
            : "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink"
        }`}
      >
        <Icon name="sliders" size={14} />
      </button>

      {open && (
        <div className="absolute bottom-10 right-0 z-30 w-72 rounded-[14px] border border-border bg-white p-3.5 shadow-lift">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
            Advanced
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
                className="h-8 w-28 rounded-[9px] border border-border-strong px-2.5 text-[12.5px] tabular-nums text-ink placeholder:text-muted focus:border-primary focus:outline-none"
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
                className="mt-1.5 w-full resize-none rounded-[9px] border border-border-strong px-2.5 py-2 text-[12.5px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              />
            </div>

            <Toggle
              label="Prompt enhancement"
              description="Expand short prompts with extra detail."
              checked={settings.enhance}
              onChange={(v) => onChange({ enhance: v })}
            />

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
  large = false,
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
  large?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const styles = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;

  // Grow with the content, then scroll internally so the composer never pushes
  // the preview off screen.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [prompt]);

  return (
    <div
      className={`shrink-0 rounded-[20px] border bg-white p-3 shadow-card transition-colors ${
        promptError ? "border-danger" : "border-border-strong focus-within:border-primary"
      }`}
    >
      <label htmlFor="prompt-input" className="sr-only">
        {kind === "video" ? "Describe your video" : "Describe your image"}
      </label>
      <textarea
        id="prompt-input"
        ref={textareaRef}
        rows={1}
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
        className={`block w-full resize-none bg-transparent px-2 pt-1.5 text-[14px] leading-relaxed text-ink placeholder:text-muted focus:outline-none sm:text-[14.5px] ${
          large ? "min-h-[108px] max-h-[190px] lg:min-h-[170px]" : "max-h-[120px]"
        }`}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
          <AdvancedPanel
            settings={settings}
            onChange={onSettingsChange}
            onCopyPrompt={onCopyPrompt}
          />
        </div>

        <span
          className={`hidden text-[11.5px] tabular-nums text-muted sm:block ${
            prompt.length > PROMPT_MAX - 60 ? "text-warning" : ""
          }`}
        >
          {prompt.length}/{PROMPT_MAX}
        </span>

        {busy ? (
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            icon="sparkle"
            onClick={onGenerate}
            className="shrink-0"
          >
            Generate
          </Button>
        )}
      </div>

      {promptError && (
        <p
          role="alert"
          className="mt-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-danger"
        >
          <Icon name="alert" size={13} />
          {promptError}
        </p>
      )}
    </div>
  );
}
