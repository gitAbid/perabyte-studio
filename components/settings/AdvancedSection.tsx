"use client";

import { useEffect, useState } from "react";
import { SectionShell } from "@/components/settings/shared";
import type { ProviderSettingsUpdate } from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

const MIN_MINUTES = 0.5;
const MAX_MINUTES = 60;

/**
 * One numeric minutes field that commits on blur/Enter. Local state holds the
 * draft; server truth (prop changes) resyncs the field only when the draft
 * isn't mid-edit.
 */
function TimeoutField({
  label,
  hint,
  valueSeconds,
  onCommit,
}: {
  label: string;
  hint: string;
  valueSeconds: number;
  onCommit: (seconds: number) => void;
}) {
  const [minutes, setMinutes] = useState(String(valueSeconds / 60));
  const [committed, setCommitted] = useState(valueSeconds);

  useEffect(() => {
    if (valueSeconds !== committed) {
      setCommitted(valueSeconds);
      setMinutes(String(valueSeconds / 60));
    }
  }, [valueSeconds, committed]);

  function commit() {
    const parsed = Number.parseFloat(minutes.replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setMinutes(String(committed / 60));
      return;
    }
    const clamped = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed));
    const seconds = Math.round(clamped * 60);
    if (seconds === committed) {
      setMinutes(String(committed / 60));
      return;
    }
    setCommitted(seconds);
    setMinutes(String(clamped));
    onCommit(seconds);
  }

  return (
    <label className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-ink-soft">
          {label}
        </span>
        <span className="block text-[11px] leading-snug text-muted">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          value={minutes}
          aria-label={label}
          onChange={(event) => setMinutes(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="h-8 w-16 rounded-[9px] border border-border-strong bg-raised px-2.5 text-right text-[12.5px] tabular-nums text-ink focus:border-primary focus:outline-none"
        />
        <span className="text-[11.5px] text-muted">min</span>
      </span>
    </label>
  );
}

export function AdvancedSection({
  renderTimeouts,
  onUpdate,
}: {
  renderTimeouts: { image: number; video: number };
  onUpdate: OnUpdate;
}) {
  return (
    <SectionShell icon="clock" title="Advanced" description="Render timeouts">
      <div className="space-y-4 rounded-[14px] border border-border bg-surface p-4">
        <TimeoutField
          label="Image renders"
          hint="How long an image may take before it stops as retryable."
          valueSeconds={renderTimeouts.image}
          onCommit={(seconds) =>
            onUpdate({ renderTimeouts: { image: seconds } }).catch(
              () => undefined,
            )
          }
        />
        <TimeoutField
          label="Video renders"
          hint="Raise this for long clips — a timed-out job is retried, not lost."
          valueSeconds={renderTimeouts.video}
          onCommit={(seconds) =>
            onUpdate({ renderTimeouts: { video: seconds } }).catch(
              () => undefined,
            )
          }
        />
        <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
          Defaults: 5 minutes for images, 10 for videos. Applies to every
          provider; the platform hosting the studio can still cap it lower.
        </p>
      </div>
    </SectionShell>
  );
}
