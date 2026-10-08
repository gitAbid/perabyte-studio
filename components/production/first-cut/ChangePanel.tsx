"use client";

/**
 * First Cut "Ask for a change" panel (spec 13 Alpha slice).
 *
 * Wraps the shared NaturalLanguageChangeBox primitive (UX spec §7) plus one structured form
 * per frozen C10 manifest op (retime / disable / duplicate / replaceTake / setCaptions).
 * Every path — typed or spoken — produces the SAME thing: a human-readable plan preview that
 * must be confirmed before the op is applied through the pure manifest-ops functions on the
 * server. Free text that does not map onto one of the five ops is answered honestly; the UI
 * never pretends to understand anything broader (spec 13 §8).
 */

import { useMemo, useState } from "react";
import { Badge, Button, SelectField } from "@/components/ui";
import { NaturalLanguageChangeBox } from "@/components/production/primitives/change";
import {
  describeFirstCutOp, formatDurationLabel, frameGridStepMs, parseFirstCutInstruction, snapToFrameGrid,
  type FirstCutApplyResult, type FirstCutOpInput, type FirstCutTakeOption, type FirstCutViewModel,
} from "@/lib/production/first-cut-view-model";

export interface ChangePanelProps {
  view: FirstCutViewModel;
  takesByBaseShot: Readonly<Record<string, ReadonlyArray<FirstCutTakeOption>>>;
  /** Pinned source length (frames) per manifest shot id — bounds the trim form honestly. */
  sourceFramesByShot: Readonly<Record<string, number>>;
  editsAvailable: boolean;
  editsUnavailableReason: string | null;
  onApply: (op: FirstCutOpInput) => Promise<FirstCutApplyResult>;
}

type FormKind = "retime" | "disable" | "duplicate" | "replaceTake" | "captions";

const FORM_BUTTONS: Array<{ kind: FormKind; label: string; testId: string }> = [
  { kind: "retime", label: "Trim a shot", testId: "first-cut.ops.trim" },
  { kind: "disable", label: "Skip a shot", testId: "first-cut.ops.skip" },
  { kind: "duplicate", label: "Repeat a shot", testId: "first-cut.ops.repeat" },
  { kind: "replaceTake", label: "Swap a take", testId: "first-cut.ops.swap-take" },
  { kind: "captions", label: "Edit captions", testId: "first-cut.ops.captions" },
];

export function ChangePanel({ view, takesByBaseShot, sourceFramesByShot, editsAvailable, editsUnavailableReason, onApply }: ChangePanelProps) {
  const [openForm, setOpenForm] = useState<FormKind | null>(null);
  const [plan, setPlan] = useState<{ op: FirstCutOpInput; planText: string } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Structured form fields (kept as strings; validated at plan time).
  const [trimShot, setTrimShot] = useState("");
  const [trimSeconds, setTrimSeconds] = useState("1");
  const [skipShot, setSkipShot] = useState("");
  const [repeatShot, setRepeatShot] = useState("");
  const [swapShot, setSwapShot] = useState("");
  const [swapTake, setSwapTake] = useState("");
  const [captionText, setCaptionText] = useState("");

  const shotOptions = useMemo(
    () =>
      view.shots.map((shot) => ({
        value: shot.shotRevisionId,
        label: `Shot ${shot.position}${shot.isCopy ? " (repeat)" : ""} — ${formatDurationLabel(shot.durationMs)}${shot.disabled ? " — skipped" : ""}`,
      })),
    [view.shots],
  );

  const skippableShotOptions = useMemo(() => shotOptions.filter((_, index) => !view.shots[index]?.lastEnabled), [shotOptions, view.shots]);

  const takeOptionsFor = (shotId: string): Array<{ value: string; label: string }> => {
    const shot = view.shots.find((entry) => entry.shotRevisionId === shotId);
    if (!shot) return [];
    const options = takesByBaseShot[shot.baseShotRevisionId] ?? [];
    return options
      .filter((take) => take.id !== shot.takeId)
      .map((take) => ({ value: take.id, label: take.label }));
  };

  const draftPlan = (op: FirstCutOpInput): void => {
    setParseError(null);
    setApplyError(null);
    setNotice(null);
    setPlan({ op, planText: describeFirstCutOp(op, view, takesByBaseShot) });
  };

  const handleInstruction = (instruction: string): void => {
    const parsed = parseFirstCutInstruction(instruction, view, takesByBaseShot);
    setApplyError(null);
    setNotice(null);
    if (!parsed.ok) {
      setPlan(null);
      setParseError(parsed.reason);
      return;
    }
    setParseError(null);
    setPlan({ op: parsed.op, planText: parsed.planText });
  };

  const applyPlan = async (): Promise<void> => {
    if (!plan || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await onApply(plan.op);
      if (result.ok) {
        setNotice(`Applied — ${plan.planText} The strip below is the working cut; the player still shows the last build until you rebuild.`);
        setPlan(null);
        setOpenForm(null);
      } else {
        setApplyError(result.error);
      }
    } catch {
      setApplyError("The change could not be applied: the studio server could not be reached. Your working cut is unchanged.");
    } finally {
      setApplying(false);
    }
  };

  const planRetime = (): void => {
    const shot = view.shots.find((entry) => entry.shotRevisionId === trimShot);
    if (!shot) {
      setParseError("Choose which shot to trim first.");
      return;
    }
    const seconds = Number(trimSeconds.replace(",", "."));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setParseError("Type the new length in seconds — for example 1.5.");
      return;
    }
    const fps = view.fps;
    const sourceFrames = sourceFramesByShot[shot.shotRevisionId] ?? 0;
    const maxFrames = sourceFrames > 0 ? Math.max(0, sourceFrames - shot.startFrame) : 0;
    const stepMs = frameGridStepMs(fps);
    let durationMs = snapToFrameGrid(seconds * 1000, fps);
    if (maxFrames > 0) {
      const maxMs = Math.floor((maxFrames * 1000) / fps);
      if (durationMs > maxMs) durationMs = Math.max(stepMs, Math.floor(maxMs / stepMs) * stepMs);
    }
    if (durationMs === shot.durationMs) {
      setParseError(`Shot ${shot.position} is already ${formatDurationLabel(shot.durationMs)} long — pick a different length.`);
      return;
    }
    setParseError(null);
    draftPlan({ kind: "retime", shotId: shot.shotRevisionId, durationMs });
  };

  const planDisable = (): void => {
    const shot = view.shots.find((entry) => entry.shotRevisionId === skipShot);
    if (!shot) {
      setParseError("Choose which shot to skip first.");
      return;
    }
    if (shot.lastEnabled) {
      setParseError(`Shot ${shot.position} is the only shot left in the cut — skipping it would leave nothing to play.`);
      return;
    }
    setParseError(null);
    draftPlan({ kind: "disable", shotId: shot.shotRevisionId });
  };

  const planDuplicate = (): void => {
    const shot = view.shots.find((entry) => entry.shotRevisionId === repeatShot);
    if (!shot) {
      setParseError("Choose which shot to repeat first.");
      return;
    }
    setParseError(null);
    draftPlan({ kind: "duplicate", shotId: shot.shotRevisionId });
  };

  const planReplaceTake = (): void => {
    const shot = view.shots.find((entry) => entry.shotRevisionId === swapShot);
    if (!shot) {
      setParseError("Choose which shot to swap first.");
      return;
    }
    const options = takeOptionsFor(shot.shotRevisionId);
    if (options.length === 0) {
      setParseError(`Shot ${shot.position} has no other take to swap to — generate another take in the storyboard first.`);
      return;
    }
    if (!swapTake || !options.some((option) => option.value === swapTake)) {
      setParseError("Choose which take to use instead.");
      return;
    }
    setParseError(null);
    draftPlan({ kind: "replaceTake", shotId: shot.shotRevisionId, takeId: swapTake });
  };

  const planCaptions = (cues: Array<{ text: string; startFrame: number; endFrame: number }>): void => {
    if (cues.length > 0 && view.workingTotalFrames <= 0) {
      setParseError("The cut has no playable length to caption yet — build it first.");
      return;
    }
    setParseError(null);
    draftPlan({ kind: "setCaptions", cues });
  };

  return (
    <section className="rounded-[12px] border border-border bg-raised p-5 shadow-card" data-testid="first-cut.change-panel" aria-label="Ask for a change">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-ink">Ask for a change</h2>
        {view.delta.changedCount > 0 && (
          <Badge tone="primary" >
            <span data-testid="first-cut.change.delta">{view.delta.summary}</span>
          </Badge>
        )}
      </div>

      {!editsAvailable && (
        <p role="status" data-testid="first-cut.change.unavailable" className="mt-2 text-[13px] text-muted">
          {editsUnavailableReason ?? "Changes are unavailable for this cut."}
        </p>
      )}

      {editsAvailable && (
        <>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Structured edits">
            {FORM_BUTTONS.map((button) => (
              <Button
                key={button.kind}
                type="button"
                variant={openForm === button.kind ? "primary" : "secondary"}
                size="sm"
                aria-pressed={openForm === button.kind}
                disabled={applying}
                onClick={() => {
                  setOpenForm((current) => (current === button.kind ? null : button.kind));
                  setParseError(null);
                }}
                data-testid={button.testId}
              >
                {button.label}
              </Button>
            ))}
          </div>

          {openForm === "retime" && (
            <form
              className="mt-3 grid gap-3 rounded-[10px] border border-border bg-surface p-4 sm:grid-cols-[1fr_180px]"
              onSubmit={(event) => {
                event.preventDefault();
                planRetime();
              }}
              data-testid="first-cut.trim.form"
            >
              <SelectField label="Shot" value={trimShot} onChange={(event) => setTrimShot(event.target.value)}>
                <option value="">Choose a shot…</option>
                {shotOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <label className="flex flex-col gap-2 text-[13px] font-semibold text-ink-soft">
                New length (seconds)
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.125}
                  step={0.125}
                  value={trimSeconds}
                  onChange={(event) => setTrimSeconds(event.target.value)}
                  className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                  data-testid="first-cut.trim.seconds"
                />
              </label>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" disabled={applying} data-testid="first-cut.trim.plan">
                  Plan this trim
                </Button>
                <p className="mt-1 text-[12px] text-muted">
                  Lengths snap to the {view.fps} fps frame grid and stay inside the shot&apos;s source footage.
                </p>
              </div>
            </form>
          )}

          {openForm === "disable" && (
            <form
              className="mt-3 rounded-[10px] border border-border bg-surface p-4"
              onSubmit={(event) => {
                event.preventDefault();
                planDisable();
              }}
              data-testid="first-cut.skip.form"
            >
              <SelectField label="Shot to skip" value={skipShot} onChange={(event) => setSkipShot(event.target.value)}>
                <option value="">Choose a shot…</option>
                {skippableShotOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <div className="mt-3">
                <Button type="submit" size="sm" disabled={applying} data-testid="first-cut.skip.plan">
                  Plan this skip
                </Button>
                <p className="mt-1 text-[12px] text-muted">Skipping keeps the shot saved on the cut but plays nothing. The only playing shot cannot be skipped.</p>
              </div>
            </form>
          )}

          {openForm === "duplicate" && (
            <form
              className="mt-3 rounded-[10px] border border-border bg-surface p-4"
              onSubmit={(event) => {
                event.preventDefault();
                planDuplicate();
              }}
              data-testid="first-cut.repeat.form"
            >
              <SelectField label="Shot to repeat" value={repeatShot} onChange={(event) => setRepeatShot(event.target.value)}>
                <option value="">Choose a shot…</option>
                {shotOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <div className="mt-3">
                <Button type="submit" size="sm" disabled={applying} data-testid="first-cut.repeat.plan">
                  Plan this repeat
                </Button>
              </div>
            </form>
          )}

          {openForm === "replaceTake" && (
            <form
              className="mt-3 grid gap-3 rounded-[10px] border border-border bg-surface p-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                planReplaceTake();
              }}
              data-testid="first-cut.swap.form"
            >
              <SelectField
                label="Shot"
                value={swapShot}
                onChange={(event) => {
                  setSwapShot(event.target.value);
                  setSwapTake("");
                }}
              >
                <option value="">Choose a shot…</option>
                {shotOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <SelectField label="Use take" value={swapTake} onChange={(event) => setSwapTake(event.target.value)}>
                <option value="">Choose a take…</option>
                {takeOptionsFor(swapShot).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </SelectField>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" disabled={applying} data-testid="first-cut.swap.plan">
                  Plan this swap
                </Button>
                {swapShot && takeOptionsFor(swapShot).length === 0 && (
                  <p className="mt-1 text-[12px] text-muted">This shot has no other take yet — generate one in the storyboard first.</p>
                )}
              </div>
            </form>
          )}

          {openForm === "captions" && (
            <form
              className="mt-3 rounded-[10px] border border-border bg-surface p-4"
              onSubmit={(event) => {
                event.preventDefault();
                const line = captionText.trim();
                if (!line) {
                  setParseError("Type the caption line first, or use “Remove all captions”.");
                  return;
                }
                planCaptions([{ text: line.slice(0, 200), startFrame: 0, endFrame: view.workingTotalFrames }]);
              }}
              data-testid="first-cut.captions.form"
            >
              <label className="flex flex-col gap-2 text-[13px] font-semibold text-ink-soft" htmlFor="first-cut-caption-text">
                One caption line, shown from the start to the end of the cut
                <textarea
                  id="first-cut-caption-text"
                  rows={2}
                  maxLength={200}
                  value={captionText}
                  onChange={(event) => setCaptionText(event.target.value)}
                  className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 text-sm leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                  placeholder="For example: The forest clears as dawn breaks…"
                  data-testid="first-cut.captions.text"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={applying} data-testid="first-cut.captions.plan">
                  Plan this caption
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={applying || view.captions.length === 0}
                  onClick={() => planCaptions([])}
                  data-testid="first-cut.captions.remove"
                >
                  Remove all captions
                </Button>
              </div>
            </form>
          )}

          <div className="mt-4 border-t border-border pt-4">
            <NaturalLanguageChangeBox
              testIdBase="first-cut.change"
              label="…or describe it in your own words"
              submitLabel="Plan this change"
              placeholder="For example: “trim shot 2 to 1 second”, “skip shot 3”, “repeat shot 1”, “use take 2 for shot 4”, “captions: The forest clears…”"
              busy={applying}
              error={parseError ?? undefined}
              onSubmit={handleInstruction}
            />
            <p className="mt-2 text-[12px] text-muted">
              I understand exactly five edits — the five buttons above. Anything else, I&apos;ll say so instead of guessing.
            </p>
          </div>
        </>
      )}

      {plan && (
        <div role="region" aria-label="Planned change" data-testid="first-cut.change.plan" className="mt-4 rounded-[10px] border border-primary/40 bg-primary-soft/50 p-4">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">Planned change</p>
          <p className="mt-1 text-[14px] font-medium text-ink">{plan.planText}</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            This edits the working cut in preview — nothing renders until you rebuild, and every other scene is reused.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={applying} disabled={applying} onClick={() => { void applyPlan(); }} data-testid="first-cut.change.apply">
              Apply change
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={applying} onClick={() => setPlan(null)} data-testid="first-cut.change.discard">
              Discard
            </Button>
          </div>
        </div>
      )}

      {applyError && (
        <p role="alert" data-testid="first-cut.change.error" className="mt-3 rounded-[8px] border border-danger/40 bg-danger-soft/60 px-3.5 py-2.5 text-[13px] text-danger">
          {applyError}
        </p>
      )}
      {notice && !applyError && (
        <p role="status" data-testid="first-cut.change.notice" className="mt-3 rounded-[8px] border border-success/30 bg-success-soft px-3.5 py-2.5 text-[13px] text-ink">
          {notice}
        </p>
      )}
    </section>
  );
}
