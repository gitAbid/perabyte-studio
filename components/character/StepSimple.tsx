"use client";

import { Button, SelectField, TextAreaField } from "@/components/ui";
import { CHARACTER_STYLES, type CharacterSpec } from "@/lib/character";
import { PROMPT_EXAMPLES } from "@/components/character/CharacterSteps";
import type { ModelOption } from "@/components/character/CharacterStudio";

const EXAMPLE_LABELS = ["Artist", "Warrior", "Barista"];

/**
 * Simple mode: describe the character in one prompt and render — no wizard.
 * The prompt IS the identity (`spec.freeform`), so nothing here invents
 * default attributes the user never asked for. Fine-tuning lives one toggle
 * away in Detailed mode.
 */
export function StepSimple({
  spec,
  patch,
  promptError,
  onSwitchToDetailed,
  models,
  modelId,
  onModelChange,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  promptError?: string;
  onSwitchToDetailed: () => void;
  /** Image model catalog for the picker; the row hides while empty. */
  models?: ModelOption[];
  modelId?: string | null;
  onModelChange?: (modelId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[16px] font-extrabold tracking-[-0.02em] text-ink">
          Describe your character
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          One prompt is all it takes — the sheet on the right renders every
          view of them.
        </p>
      </div>

      <TextAreaField
        label="Character Prompt"
        value={spec.prompt}
        maxLength={400}
        rows={6}
        error={promptError}
        placeholder="e.g. A young artist with ink-stained fingers, messy hair and a paint-splattered apron, warm smile."
        onChange={(value) => patch({ prompt: value })}
      />

      <div className="rounded-[14px] border border-border bg-surface p-3.5">
        <p className="text-[12.5px] font-semibold text-ink-soft">
          Need an idea? Start from one of these.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {PROMPT_EXAMPLES.map((example, index) => (
            <button
              key={example}
              type="button"
              aria-pressed={spec.prompt === example}
              title={example}
              onClick={() => patch({ prompt: spec.prompt === example ? "" : example })}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                spec.prompt === example
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              {EXAMPLE_LABELS[index]}
            </button>
          ))}
        </div>
      </div>

      <SelectField
        label="Art Style"
        value={spec.style}
        onChange={(e) => patch({ style: e.target.value })}
      >
        {CHARACTER_STYLES.map((style) => (
          <option key={style} value={style}>
            {style}
          </option>
        ))}
      </SelectField>

      {models && models.length > 0 && onModelChange && (
        <SelectField label="Model" value={modelId ?? models[0].id} onChange={(e) => onModelChange(e.target.value)}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
              {model.hint ? ` — ${model.hint}` : ""} · {model.providerLabel}
            </option>
          ))}
        </SelectField>
      )}

      <div className="flex items-center justify-between gap-3 rounded-[14px] border border-border bg-surface p-3.5">
        <p className="text-[12px] leading-snug text-muted">
          <span className="font-bold text-ink-soft">Want more control? </span>
          Age, ethnicity, hair, outfit, NSFW level and render options live in
          Detailed mode.
        </p>
        <Button variant="secondary" size="sm" icon="sliders" onClick={onSwitchToDetailed}>
          Detailed
        </Button>
      </div>
    </div>
  );
}
