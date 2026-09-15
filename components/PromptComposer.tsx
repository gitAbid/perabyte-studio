"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Button } from "./ui";
import { PillSelect } from "./PillSelect";
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
import type { ModelOption } from "@/lib/model-catalog";
import type { GenerationSettings } from "@/lib/types";

const PILL_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors";
const PILL_IDLE =
  "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink";

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
  onEnhancePrompt,
  enhancing = false,
  models,
  modelId,
  onModelChange,
  stylesSupported,
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
  /** Rewrites the prompt in place, aware of the current settings (async). */
  onEnhancePrompt: () => void;
  /** True while the enhancement request is in flight. */
  enhancing?: boolean;
  /** Model catalog for the picker; the pill is hidden while empty. */
  models?: ModelOption[];
  modelId?: string | null;
  onModelChange?: (modelId: string) => void;
  /** False when the active model can't honour style presets. */
  stylesSupported?: boolean;
  title?: string;
  headerBadge?: ReactNode;
}) {
  const styles = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;

  return (
    // The composer is the panel itself and stretches with its column, so the
    // prompt area absorbs the available height instead of leaving dead space.
    // The card keeps a static border; focusing the prompt only shifts its
    // surface tone slightly — no selection ring.
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
      {/* Tinted prompt surface; focus eases the tint instead of drawing a ring. */}
      <div
        className={`mt-3 flex min-h-0 flex-1 flex-col rounded-[12px] border px-3.5 pb-2 pt-3 transition-colors ${
          promptError ? "border-danger bg-surface" : "border-border bg-surface focus-within:bg-white"
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
          className="min-h-[104px] w-full flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink placeholder:text-muted focus:outline-none focus-visible:outline-none sm:text-[14.5px]"
        />
        <div className="flex shrink-0 items-center justify-end pt-1">
          <button
            type="button"
            onClick={onEnhancePrompt}
            disabled={busy || enhancing || !prompt.trim()}
            title="Expand the prompt with richer, style-aware detail"
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted"
          >
            <Icon
              name="sparkle"
              size={13}
              className={enhancing ? "animate-pulse" : undefined}
            />
            {enhancing ? "Enhancing…" : "Enhance prompt"}
          </button>
        </div>
      </div>

      {/* Settings badges live inline in the prompt box. Model leads so the
          active engine is always the first thing you see. */}
      <div className="relative mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        {models && models.length > 0 && onModelChange && (
          <PillSelect
            icon="chip"
            label="Model"
            value={modelId ?? models[0].id}
            options={models.map((entry) => ({
              value: entry.id,
              label: entry.label,
              hint: entry.hint
                ? `${entry.hint} · ${entry.providerLabel}`
                : entry.providerLabel,
              // Capability groups: models that can run safety-off vs models
              // that always stay behind a checker.
              group: entry.uncensored === false ? "Sensored" : "Uncensored",
            }))}
            onChange={onModelChange}
          />
          )}
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
          // Styleless models show a neutral value instead of a stale preset.
          value={stylesSupported === false ? "none" : settings.style}
          options={
            stylesSupported === false
              ? [{ value: "none", label: "None" }]
              : Object.keys(styles).map((name) => ({ value: name, label: name }))
          }
          onChange={(value) => onSettingsChange({ style: value })}
          disabled={stylesSupported === false}
          disabledHint="This model doesn't support style presets"
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
        <PillSelect
          icon="layers"
          label="Variations"
          value={String(settings.count)}
          options={VARIANT_COUNTS.map((n) => ({
            value: String(n),
            label: `${n} variation${n > 1 ? "s" : ""}`,
          }))}
          onChange={(value) => onSettingsChange({ count: Number(value) })}
        />

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
