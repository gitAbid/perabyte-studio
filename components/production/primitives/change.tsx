"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/Icon";

/* ------------------------------------------------------------------ */
/* NaturalLanguageChangeBox — UX spec §7                               */
/* ------------------------------------------------------------------ */
/* The one consistent "ask for a change in your own words" box. Shows  */
/* a live character count and disables itself while a change is being  */
/* applied. Showing WHAT will change before an expensive or destructive*/
/* action is the caller's job (render the plan next to this box).      */

export interface NaturalLanguageChangeBoxProps {
  /** Field label. Defaults to "Ask for a change". */
  label?: string;
  placeholder?: string;
  /** Confirm button label. Defaults to "Apply change". */
  submitLabel?: string;
  /** Character limit for the instruction (drives the live counter). */
  maxChars?: number;
  /** While true the box and its submit button are disabled. */
  busy?: boolean;
  /** Plain-language failure message rendered with role="alert". */
  error?: string;
  /** Called with the trimmed instruction when the creator submits. */
  onSubmit: (instruction: string) => void;
  /** Stable test id base (feature.entity); input becomes `${testIdBase}.input`, button `${testIdBase}.submit`. */
  testIdBase?: string;
  className?: string;
}

export function NaturalLanguageChangeBox({
  label = "Ask for a change",
  placeholder = "Describe what to change — for example, “make the ending calmer”…",
  submitLabel = "Apply change",
  maxChars = 500,
  busy = false,
  error,
  onSubmit,
  testIdBase = "change.request",
  className = "",
}: NaturalLanguageChangeBoxProps) {
  const [value, setValue] = useState("");
  const textareaId = useId();
  const canSubmit = !busy && value.trim().length > 0;

  return (
    <form
      data-testid={testIdBase}
      aria-busy={busy || undefined}
      className={`flex w-full flex-col gap-2 ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        const instruction = value.trim();
        if (!busy && instruction) onSubmit(instruction);
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={textareaId}
          className="text-[13px] font-semibold text-ink-soft"
        >
          {label}
        </label>
        <span
          data-testid={`${testIdBase}.counter`}
          className="text-[12px] tabular-nums text-muted"
        >
          {value.length} / {maxChars}
        </span>
      </div>

      <textarea
        id={textareaId}
        data-testid={`${testIdBase}.input`}
        value={value}
        rows={3}
        maxLength={maxChars}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${textareaId}-error` : undefined}
        onChange={(event) => setValue(event.target.value)}
        className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 text-sm leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
      />

      {error && (
        <p
          id={`${textareaId}-error`}
          role="alert"
          className="flex items-center gap-1.5 text-[12px] font-medium text-danger"
        >
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          loading={busy}
          disabled={!canSubmit}
          data-testid={`${testIdBase}.submit`}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
