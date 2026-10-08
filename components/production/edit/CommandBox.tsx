"use client";

/**
 * NL command box at the top of the advanced edit view (spec 13 §5/§8, FR-31.1).
 *
 * Parses the instruction with the deterministic edit-intents router — no AI calls. Manifest-op
 * intents (retime / disable / duplicate / replaceTake) flow into the SAME confirm/apply path as
 * clicks: the box hands the intent up and the shared confirm card shows the preview. Direction
 * intents (retake, delivery) and scene swaps are parsed but belong to other flows, so they render
 * as deep-link buttons with the prefilled note as a query param; unsupported commands show an
 * actionable hint inline (never a dead end, never a guess).
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { Icon } from "@/components/Icon";
import {
  isManifestOpIntent, parseEditIntent,
  type EditIntent, type EditIntentContext,
} from "@/lib/production/edit-intents";

export interface CommandBoxProps {
  projectId: string;
  context: EditIntentContext;
  /** 1-based ordinal of the currently selected shot; anchors "this scene" directions in deep links. */
  selectedOrdinal: number | null;
  interactive: boolean;
  /** Hands a manifest-op intent to the shared confirm/apply path. */
  onPlannedIntent: (intent: EditIntent) => void;
}

export function CommandBox({ projectId, context, selectedOrdinal, interactive, onPlannedIntent }: CommandBoxProps) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<EditIntent | null>(null);

  const submit = (): void => {
    const intent = parseEditIntent(value, context);
    setResult(intent);
    if (isManifestOpIntent(intent)) {
      onPlannedIntent(intent);
      setValue("");
    }
  };

  const retakeHref = (intent: Extract<EditIntent, { kind: "retake_direction" }>): string => {
    const params = new URLSearchParams();
    params.set("retakeNote", intent.note);
    const scene = intent.sceneOrdinal ?? selectedOrdinal;
    if (scene !== null) params.set("scene", String(scene));
    return `/production/${projectId}/storyboard?${params.toString()}`;
  };

  const swapHref = (intent: Extract<EditIntent, { kind: "swap" }>): string =>
    `/production/${projectId}/storyboard?reorderScenes=${encodeURIComponent(`${intent.firstOrdinal}-${intent.secondOrdinal}`)}`;

  const audioHref = (intent: Extract<EditIntent, { kind: "delivery_direction" }>): string => {
    const params = new URLSearchParams();
    params.set("deliveryNote", intent.note);
    if (intent.characterName) params.set("character", intent.characterName);
    return `/production/${projectId}/audio?${params.toString()}`;
  };

  return (
    <section className="rounded-[12px] border border-border bg-raised p-5 shadow-card" data-testid="edit.command" aria-label="Ask for a timeline change">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (interactive && value.trim()) submit();
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="edit-command-input" className="text-[13px] font-semibold text-ink-soft">
            Ask for a change
          </label>
          <span className="text-[12px] tabular-nums text-muted">{value.length} / 300</span>
        </div>
        <textarea
          id="edit-command-input"
          rows={2}
          maxLength={300}
          value={value}
          disabled={!interactive}
          placeholder="For example: “trim 2 seconds off scene 5”, “swap scenes 3 and 4”, “make scene 2 more dramatic”, “Luna sounds scared here”"
          aria-describedby="edit-command-hint"
          onChange={(event) => setValue(event.target.value)}
          className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 text-sm leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="edit.command.input"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="edit-command-hint" className="text-[12px] text-muted">
            Deterministic plain-word parsing — no AI. Trim, skip, repeat and take swaps apply here; scene order, retakes and delivery belong to their panels.
          </p>
          <Button type="submit" size="sm" disabled={!interactive || !value.trim()} data-testid="edit.command.apply">
            Read this change
          </Button>
        </div>
      </form>

      {!interactive && (
        <p role="status" data-testid="edit.command.disabled" className="mt-2 text-[13px] text-muted">
          Timeline edits are unavailable for this cut, so the command box is read-only.
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-2">
          {isManifestOpIntent(result) && (
            <p role="status" data-testid="edit.command.accepted" className="rounded-[8px] border border-success/30 bg-success-soft px-3.5 py-2.5 text-[13px] text-ink">
              Understood — confirm it in the planned-change card: {result.summary}
            </p>
          )}

          {result.kind === "swap" && (
            <div role="region" aria-label="Scene order hand-off" data-testid="edit.command.swap" className="rounded-[8px] border border-primary/40 bg-primary-soft/50 px-3.5 py-3">
              <p className="text-[13px] font-medium text-ink">{result.summary}</p>
              <p className="mt-1 text-[12px] text-ink-soft">
                Scene order is a storyboard plan revision, not a timeline op — the scenes and their rendered media are reused.
              </p>
              <Link
                href={swapHref(result)}
                data-testid="edit.command.swap.link"
                className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline"
              >
                Open the storyboard to reorder
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          )}

          {result.kind === "retake_direction" && (
            <div role="region" aria-label="Retake direction hand-off" data-testid="edit.command.retake" className="rounded-[8px] border border-primary/40 bg-primary-soft/50 px-3.5 py-3">
              <p className="text-[13px] font-medium text-ink">{result.summary}</p>
              <p className="mt-1 text-[12px] text-ink-soft">
                Retakes are generated per scene from the storyboard — the direction note travels with you, prefilled.
              </p>
              <Link
                href={retakeHref(result)}
                data-testid="edit.command.retake.link"
                className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline"
              >
                Open the storyboard with this direction
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          )}

          {result.kind === "delivery_direction" && (
            <div role="region" aria-label="Delivery direction hand-off" data-testid="edit.command.delivery" className="rounded-[8px] border border-primary/40 bg-primary-soft/50 px-3.5 py-3">
              <p className="text-[13px] font-medium text-ink">{result.summary}</p>
              <p className="mt-1 text-[12px] text-ink-soft">
                Speech delivery is set per line in the audio workspace — the note travels with you, prefilled.
              </p>
              <Link
                href={audioHref(result)}
                data-testid="edit.command.delivery.link"
                className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline"
              >
                Open the audio workspace
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          )}

          {result.kind === "unsupported" && (
            <div>
              <p role="status" data-testid="edit.command.unsupported" className="flex items-start gap-1.5 text-[13px] text-ink-soft">
                <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warning" />
                {result.hint}
              </p>
              {result.panel && (
                <Link
                  href={`/production/${projectId}/${result.panel === "audio" ? "audio" : "storyboard"}`}
                  data-testid="edit.command.unsupported.link"
                  className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline"
                >
                  Open the {result.panel === "audio" ? "audio workspace" : "storyboard"}
                  <Icon name="arrow-right" size={14} />
                </Link>
              )}
            </div>
          )}

          <div>
            <Button variant="ghost" size="sm" onClick={() => setResult(null)} data-testid="edit.command.dismiss">
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
