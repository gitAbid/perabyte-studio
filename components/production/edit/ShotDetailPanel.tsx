"use client";

/**
 * Detail panel for the selected timeline item (spec 13 §8: every destructive change previews
 * before applying). Shot actions map ONE-TO-ONE onto the frozen C10 ops — retime via a duration
 * input, disable, duplicate, replaceTake via the available takes list; caption edits map onto
 * the wholesale `setCaptions` op with only the selected cue's text changed. Nothing here applies
 * directly: every action hands a `FirstCutOpInput` up to the shared confirm card, whose summary
 * is produced by the same `describeFirstCutOp` used by /first-cut so preview and op never drift.
 */

import { useEffect, useState } from "react";
import { Badge, Button, SelectField } from "@/components/ui";
import {
  formatDurationLabel, frameGridStepMs, snapToFrameGrid,
  type FirstCutOpInput, type FirstCutTakeOption, type FirstCutViewModel,
} from "@/lib/production/first-cut-view-model";

export interface ShotDetailPanelProps {
  view: FirstCutViewModel;
  shot: FirstCutViewModel["shots"][number] | null;
  caption: { index: number; text: string; startMs: number; endMs: number } | null;
  /** Replacement candidates for the selected shot's base revision, current take excluded. */
  takes: ReadonlyArray<FirstCutTakeOption>;
  /** Pinned source length (frames) for the selected shot; null when unknown. */
  sourceFrames: number | null;
  interactive: boolean;
  /** Hands an op up to the shared confirm/apply path (summary is derived there). */
  onPlan: (op: FirstCutOpInput) => void;
  /** Reverts the working cut to the last persisted manifest (the only honest way to un-skip). */
  onRestoreSaved: () => void;
  hasUnsavedChanges: boolean;
}

export function ShotDetailPanel({
  view, shot, caption, takes, sourceFrames, interactive, onPlan, onRestoreSaved, hasUnsavedChanges,
}: ShotDetailPanelProps) {
  const [trimSeconds, setTrimSeconds] = useState("1");
  const [trimError, setTrimError] = useState<string | null>(null);
  const [takeChoice, setTakeChoice] = useState("");
  const [captionText, setCaptionText] = useState("");
  const [captionError, setCaptionError] = useState<string | null>(null);

  // Keep form state honest when the selection (or the working manifest) changes underneath.
  useEffect(() => {
    setTrimError(null);
    setTakeChoice("");
    setCaptionError(null);
  }, [shot?.shotRevisionId, caption?.index]);

  useEffect(() => {
    setCaptionText(caption?.text ?? "");
  }, [caption?.index, caption?.text]);

  const plan = (op: FirstCutOpInput): void => {
    setTrimError(null);
    setCaptionError(null);
    onPlan(op);
  };

  const planRetime = (): void => {
    if (!shot) return;
    const seconds = Number(trimSeconds.replace(",", "."));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setTrimError("Type the new length in seconds — for example 1.5.");
      return;
    }
    const fps = view.fps;
    const maxFrames = sourceFrames && sourceFrames > 0 ? Math.max(0, sourceFrames - shot.startFrame) : 0;
    const stepMs = frameGridStepMs(fps);
    let durationMs = snapToFrameGrid(seconds * 1000, fps);
    if (maxFrames > 0) {
      const maxMs = Math.floor((maxFrames * 1000) / fps);
      if (durationMs > maxMs) durationMs = Math.max(stepMs, Math.floor(maxMs / stepMs) * stepMs);
    }
    if (durationMs === shot.durationMs) {
      setTrimError(`Scene ${shot.position} is already ${formatDurationLabel(shot.durationMs)} long — pick a different length.`);
      return;
    }
    plan({ kind: "retime", shotId: shot.shotRevisionId, durationMs });
  };

  const planDisable = (): void => {
    if (!shot || shot.disabled) return;
    if (shot.lastEnabled) {
      setTrimError(`Scene ${shot.position} is the only scene left in the cut — skipping it would leave nothing to play.`);
      return;
    }
    plan({ kind: "disable", shotId: shot.shotRevisionId });
  };

  const planReplaceTake = (): void => {
    if (!shot) return;
    const choice = takes.find((take) => take.id === takeChoice);
    if (!choice) {
      setTrimError("Choose which take to use instead.");
      return;
    }
    plan({ kind: "replaceTake", shotId: shot.shotRevisionId, takeId: choice.id });
  };

  const planCaptionText = (): void => {
    if (!caption) return;
    const line = captionText.trim().slice(0, 200);
    if (!line) {
      setCaptionError("Type the caption line, or remove the cue below.");
      return;
    }
    if (line === caption.text) {
      setCaptionError("That line is unchanged.");
      return;
    }
    const cues = view.captions.map((cue, index) => (index === caption.index ? { ...cue, text: line } : cue));
    plan({ kind: "setCaptions", cues });
  };

  const planRemoveCaption = (): void => {
    if (!caption) return;
    plan({ kind: "setCaptions", cues: view.captions.filter((_, index) => index !== caption.index) });
  };

  if (caption) {
    return (
      <section aria-label="Selected caption" data-testid="edit.detail.caption" className="flex flex-col gap-3">
        <h3 className="text-[13px] font-bold text-ink">
          Caption {caption.index + 1} of {view.captions.length}
        </h3>
        <label className="flex flex-col gap-2 text-[13px] font-semibold text-ink-soft">
          Caption text
          <textarea
            rows={2}
            maxLength={200}
            value={captionText}
            disabled={!interactive}
            onChange={(event) => setCaptionText(event.target.value)}
            className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 text-sm leading-relaxed text-ink focus:border-primary focus:outline-none disabled:opacity-55"
            data-testid="edit.detail.caption.text"
          />
        </label>
        <p className="text-[12px] text-muted">
          Cue range {formatDurationLabel(caption.startMs)} → {formatDurationLabel(caption.endMs)} — the bounds stay fixed, and captions are overlay metadata: they don&apos;t move the render inputs hash.
        </p>
        {captionError && <p role="alert" data-testid="edit.detail.caption.error" className="text-[12px] font-medium text-danger">{captionError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!interactive} onClick={() => planCaptionText()} data-testid="edit.detail.caption.save">
            Preview caption change
          </Button>
          <Button variant="ghost" size="sm" disabled={!interactive} onClick={() => planRemoveCaption()} data-testid="edit.detail.caption.remove">
            Remove this caption
          </Button>
        </div>
      </section>
    );
  }

  if (!shot) {
    return (
      <section aria-label="Details" data-testid="edit.detail.empty" className="flex flex-col gap-2">
        <h3 className="text-[13px] font-bold text-ink">Nothing selected</h3>
        <p className="text-[13px] text-muted">
          Select a scene block or its number chip — or a caption in the CAPTIONS lane — to see details and edit actions here.
        </p>
      </section>
    );
  }

  const maxFramesLabel = sourceFrames && sourceFrames > 0
    ? formatDurationLabel(Math.floor((Math.max(0, sourceFrames - shot.startFrame) * 1000) / view.fps))
    : null;

  return (
    <section aria-label={`Scene ${shot.position} details`} data-testid="edit.detail.shot" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[14px] font-bold text-ink">
            Scene {shot.position}
            {shot.isCopy ? " (repeat)" : ""}
          </h3>
          <p className="mt-0.5 text-[12px] text-muted">
            {formatDurationLabel(shot.durationMs)}
            {shot.startMs !== null && !shot.disabled ? ` · starts at ${formatDurationLabel(shot.startMs)}` : ""}
            {` · ${shot.transition === "crossfade" ? "crossfade out" : "hard cut out"}`}
          </p>
        </div>
        <Badge tone={shot.status === "selected" ? "success" : shot.status === "missing" ? "warning" : shot.status === "failed" ? "danger" : "neutral"}>
          {shot.statusLabel}
        </Badge>
      </header>

      {shot.disabled ? (
        <div className="flex flex-col gap-2 rounded-[8px] border border-border bg-surface p-3.5" data-testid="edit.detail.disabled-note">
          <p className="text-[13px] text-ink-soft">
            This scene is skipped — it stays saved on the cut with its trim and take, plays nothing and adds no time.
          </p>
          <p className="text-[12px] text-muted">
            Re-enabling one skipped scene needs a manifest enable op that isn&apos;t wired into this slice yet.
            {hasUnsavedChanges
              ? " Restoring the saved cut brings skipped scenes back and reverts unsaved preview edits."
              : " The saved cut already contains this skip."}
          </p>
          {hasUnsavedChanges && (
            <Button variant="secondary" size="sm" onClick={onRestoreSaved} data-testid="edit.detail.restore">
              Restore the saved cut
            </Button>
          )}
        </div>
      ) : (
        <>
          <form
            className="grid gap-3 rounded-[8px] border border-border bg-surface p-3.5 sm:grid-cols-[1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              planRetime();
            }}
            data-testid="edit.detail.retime.form"
          >
            <label className="flex flex-col gap-2 text-[13px] font-semibold text-ink-soft">
              New length (seconds)
              <input
                type="number"
                inputMode="decimal"
                min={frameGridStepMs(view.fps) / 1000}
                step={frameGridStepMs(view.fps) / 1000}
                value={trimSeconds}
                disabled={!interactive}
                onChange={(event) => setTrimSeconds(event.target.value)}
                className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none disabled:opacity-55"
                data-testid="edit.detail.retime.seconds"
              />
            </label>
            <Button type="submit" size="sm" disabled={!interactive} data-testid="edit.detail.retime.plan">
              Preview trim
            </Button>
            <p className="text-[12px] text-muted sm:col-span-2">
              Keeps the in-point and moves the out-point; lengths snap to the {view.fps} fps frame grid
              {maxFramesLabel ? ` and stay inside this scene's ${maxFramesLabel} of source footage` : ""}.
            </p>
          </form>

          {trimError && <p role="alert" data-testid="edit.detail.error" className="text-[12px] font-medium text-danger">{trimError}</p>}

          <div className="flex flex-wrap gap-2" data-testid="edit.detail.shot-actions">
            <Button variant="secondary" size="sm" disabled={!interactive || shot.lastEnabled} onClick={() => planDisable()} data-testid="edit.detail.disable">
              Skip scene
            </Button>
            <Button variant="secondary" size="sm" disabled={!interactive} onClick={() => plan({ kind: "duplicate", shotId: shot.shotRevisionId })} data-testid="edit.detail.duplicate">
              Repeat scene
            </Button>
          </div>

          <div className="flex flex-col gap-2 rounded-[8px] border border-border bg-surface p-3.5" data-testid="edit.detail.take.form">
            <SelectField
              label="Swap take"
              value={takeChoice}
              disabled={!interactive || takes.length === 0}
              onChange={(event) => setTakeChoice(event.target.value)}
              hint={takes.length === 0 ? "This scene has no other take yet — generate one from the storyboard." : undefined}
            >
              <option value="">Choose a take…</option>
              {takes.map((take) => (
                <option key={take.id} value={take.id}>{take.label}</option>
              ))}
            </SelectField>
            <div>
              <Button size="sm" disabled={!interactive || takes.length === 0} onClick={() => planReplaceTake()} data-testid="edit.detail.take.plan">
                Preview take swap
              </Button>
            </div>
          </div>
        </>
      )}

      <p className="text-[12px] text-muted" data-testid="edit.detail.meta">
        Current take {shot.takeId.slice(0, 18)}{shot.changedSinceBuild ? " · changed since the last build" : ""}.
      </p>
    </section>
  );
}
