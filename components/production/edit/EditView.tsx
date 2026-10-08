"use client";

/**
 * Advanced edit view body (spec 13 M4 increment, `/production/[projectId]/edit`).
 *
 * A track-style timeline (VIDEO / VOICE / MUSIC / SFX / CAPTIONS lanes) rendered directly from
 * the working `RenderManifest` through the shared first-cut view model — no feature-local
 * timeline model: after every applied op the server returns the fresh manifest and EVERYTHING
 * (lanes, chips, detail panel, NL context, playhead bounds) is re-derived from it, so timeline
 * state stays fully reconstructable. All edits run through the frozen C10 manifest ops behind
 * the page's server action, each one previewed in the confirm card before applying. Basic
 * playback is a playhead cycling by accumulated duration; real playback belongs to /first-cut.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import {
  buildFirstCutViewModel, describeFirstCutOp, framesToMs,
  type FirstCutApplyChangeCommand, type FirstCutApplyResult, type FirstCutManifest, type FirstCutOpInput,
} from "@/lib/production/first-cut-view-model";
import { buildEditIntentContext, editIntentToOp, isManifestOpIntent, type EditIntent, type ManifestOpIntent } from "@/lib/production/edit-intents";

const editIntentToOpStrict = (intent: ManifestOpIntent): FirstCutOpInput => editIntentToOp(intent)!;
import type { EditViewData } from "./edit-view-data";
import { buildTimelineModel, formatTimecode } from "./timeline-model";
import { TimelineTracks } from "./TimelineTracks";
import { ShotDetailPanel } from "./ShotDetailPanel";
import { CommandBox } from "./CommandBox";

export interface EditViewProps {
  data: EditViewData;
  /** Server action: applies ONE confirmed op through the pure C10 manifest-ops functions. */
  onApplyOp: (command: FirstCutApplyChangeCommand) => Promise<FirstCutApplyResult>;
}

const PLAY_STEP_MS = 100;

export function EditView({ data, onApplyOp }: EditViewProps) {
  const builtManifest = data.builtManifest;
  const [workingManifest, setWorkingManifest] = useState<FirstCutManifest>(builtManifest);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedCaptionIndex, setSelectedCaptionIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<{ op: FirstCutOpInput; summary: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);

  // Server-derived view: recomputed from the working manifest on every change.
  const view = useMemo(
    () =>
      buildFirstCutViewModel({
        workingManifest,
        builtManifest,
        crossfadeFrames: data.crossfadeFrames,
        missingAssetIds: data.missingAssetIds,
        failedShotRevisionIds: [],
        plannedShotRevisionIds: data.plannedShotRevisionIds,
        shotLabels: data.shotLabels,
      }),
    [workingManifest, builtManifest, data.crossfadeFrames, data.missingAssetIds, data.plannedShotRevisionIds, data.shotLabels],
  );

  const model = useMemo(() => buildTimelineModel(workingManifest, view), [workingManifest, view]);

  // The NL router context is rebuilt from the SAME derived view, so commands always resolve
  // against the current working cut.
  const intentContext = useMemo(
    () =>
      buildEditIntentContext({
        fps: view.fps,
        shotRows: view.shots.map((shot) => ({
          shotRevisionId: shot.shotRevisionId,
          label: data.shotLabels[shot.baseShotRevisionId] ?? null,
          durationMs: shot.durationMs,
          sourceDurationMs: (() => {
            const sourceFrames = data.sourceFramesByShot[shot.shotRevisionId];
            return sourceFrames && sourceFrames > 0 ? framesToMs(sourceFrames, view.fps) : null;
          })(),
          disabled: shot.disabled,
          soleEnabled: shot.lastEnabled && !shot.disabled,
          currentTakeId: shot.takeId,
          takes: data.takesByBaseShot[shot.baseShotRevisionId] ?? [],
        })),
        characterNames: data.characterNames,
      }),
    [view, data.shotLabels, data.sourceFramesByShot, data.takesByBaseShot, data.characterNames],
  );

  const totalMs = view.workingRuntimeMs;

  // Basic playback: the playhead cycles by accumulated duration; /first-cut owns real playback.
  useEffect(() => {
    if (!playing || totalMs <= 0) return;
    const timer = setInterval(() => {
      setPlayheadMs((previous) => Math.min(totalMs, previous + PLAY_STEP_MS));
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, totalMs]);

  useEffect(() => {
    if (playing && totalMs > 0 && playheadMs >= totalMs) setPlaying(false);
  }, [playing, playheadMs, totalMs]);

  useEffect(() => {
    if (playheadMs > totalMs) setPlayheadMs(totalMs);
  }, [playheadMs, totalMs]);

  const togglePlay = useCallback(() => {
    setPlaying((previous) => {
      if (!previous && playheadMs >= totalMs) setPlayheadMs(0);
      return !previous;
    });
  }, [playheadMs, totalMs]);

  const restart = useCallback(() => {
    setPlayheadMs(0);
    setPlaying(true);
  }, []);

  const activeShotId = useMemo(() => {
    if (playheadMs <= 0) return null;
    const active = view.shots.find(
      (shot) => !shot.disabled && shot.startMs !== null && playheadMs >= shot.startMs && playheadMs < shot.startMs + shot.durationMs,
    );
    return active?.shotRevisionId ?? null;
  }, [playheadMs, view.shots]);

  const planOp = useCallback(
    (op: FirstCutOpInput) => {
      setApplyError(null);
      setNotice(null);
      setPending({ op, summary: describeFirstCutOp(op, view, data.takesByBaseShot) });
    },
    [view, data.takesByBaseShot],
  );

  const planIntent = useCallback(
    (intent: EditIntent) => {
      if (!isManifestOpIntent(intent)) return;
      setApplyError(null);
      setNotice(null);
      setPending({ op: editIntentToOpStrict(intent), summary: intent.summary });
    },
    [],
  );

  const applyPending = useCallback(async (): Promise<void> => {
    if (!pending || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await onApplyOp({ projectId: data.projectId, manifest: workingManifest, op: pending.op });
      if (result.ok) {
        // The next manifest comes from the server (pure C10 op) — the timeline re-derives from it.
        setWorkingManifest(result.manifest);
        setNotice(`Applied — ${pending.summary} The timeline above is the re-derived working cut; the last build plays unchanged until you rebuild in First Cut.`);
        setPending(null);
      } else {
        setApplyError(result.error);
      }
    } catch {
      setApplyError("The change could not be applied: the studio server could not be reached. Your working cut is unchanged.");
    } finally {
      setApplying(false);
    }
  }, [pending, applying, onApplyOp, data.projectId, workingManifest]);

  const restoreSaved = useCallback(() => {
    setWorkingManifest(builtManifest);
    setPending(null);
    setApplyError(null);
    setNotice("Restored the saved cut — the timeline is re-derived from the last persisted manifest.");
  }, [builtManifest]);

  const selectShot = useCallback((shotRevisionId: string) => {
    setSelectedShotId((previous) => (previous === shotRevisionId ? null : shotRevisionId));
    setSelectedCaptionIndex(null);
  }, []);

  const selectCaption = useCallback((index: number) => {
    setSelectedCaptionIndex((previous) => (previous === index ? null : index));
    setSelectedShotId(null);
  }, []);

  const selectedShot = view.shots.find((shot) => shot.shotRevisionId === selectedShotId) ?? null;
  const selectedCaption = selectedCaptionIndex !== null ? model.captions.find((caption) => caption.index === selectedCaptionIndex) ?? null : null;
  const captionDetail = selectedCaption
    ? {
        index: selectedCaption.index,
        text: selectedCaption.text,
        startMs: selectedCaption.startMs,
        endMs: selectedCaption.startMs + selectedCaption.durationMs,
      }
    : null;
  const selectedTakes = selectedShot
    ? (data.takesByBaseShot[selectedShot.baseShotRevisionId] ?? []).filter((take) => take.id !== selectedShot.takeId)
    : [];
  const selectedOrdinal = selectedShot ? selectedShot.position : null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6" data-testid="edit.view">
      <header className="flex flex-col gap-1" data-testid="edit.header">
        <nav className="flex flex-wrap items-center gap-1 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
          <Link href={`/production/${data.projectId}`} className="hover:underline" data-testid="edit.header.project-link">
            Studio / Production / {data.projectName}
          </Link>
          <span aria-hidden="true">/</span>
          <span>Advanced edit</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Advanced edit</h1>
            <p className="mt-1 text-[12px] text-muted">
              A track view of the working manifest — every action is a manifest operation, previewed before it applies.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/first-cut?projectId=${encodeURIComponent(data.projectId)}`}
              data-testid="edit.header.first-cut"
              className="inline-flex h-9 items-center rounded-[7px] border border-border-strong bg-raised px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted"
            >
              First cut &amp; playback
            </Link>
            <Link
              href={`/production/${data.projectId}/export`}
              data-testid="edit.header.export"
              className="inline-flex h-9 items-center rounded-[7px] border border-border-strong bg-raised px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted"
            >
              Export &amp; QC
            </Link>
          </div>
        </div>
      </header>

      {!data.editsAvailable && (
        <p role="status" data-testid="edit.readonly" className="rounded-[8px] border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[13px] text-ink">
          {data.editsUnavailableReason ?? "Edits are unavailable for this cut."} The timeline below stays readable.
        </p>
      )}

      <CommandBox
        projectId={data.projectId}
        context={intentContext}
        selectedOrdinal={selectedOrdinal}
        interactive={data.editsAvailable}
        onPlannedIntent={planIntent}
      />

      {pending && (
        <div role="region" aria-label="Planned change" data-testid="edit.confirm" className="rounded-[10px] border border-primary/40 bg-primary-soft/50 p-4">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-primary">Planned change</p>
          <p className="mt-1 text-[14px] font-medium text-ink" data-testid="edit.confirm.summary">{pending.summary}</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            This edits the working cut in preview — nothing renders until you rebuild from First Cut, and every other scene is reused.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={applying} disabled={applying} onClick={() => { void applyPending(); }} data-testid="edit.confirm.apply">
              Apply change
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={applying} onClick={() => setPending(null)} data-testid="edit.confirm.discard">
              Discard
            </Button>
          </div>
        </div>
      )}

      {applyError && (
        <p role="alert" data-testid="edit.error" className="rounded-[8px] border border-danger/40 bg-danger-soft/60 px-3.5 py-2.5 text-[13px] text-danger">
          {applyError}
        </p>
      )}
      {notice && !applyError && (
        <p role="status" data-testid="edit.notice" className="rounded-[8px] border border-success/30 bg-success-soft px-3.5 py-2.5 text-[13px] text-ink">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted" data-testid="edit.status-line">
        <p data-testid="edit.status-line.delta">{view.delta.summary}</p>
        <p data-testid="edit.status-line.build">
          {data.exportRecord
            ? `Last build: ${data.exportRecord.status.replace(/_/g, " ")} · working cut ${view.matchesBuilt ? "matches" : "differs from"} the built manifest (${formatTimecode(totalMs)})`
            : "No build queued yet for this manifest."}
        </p>
      </div>

      <TimelineTracks
        view={view}
        model={model}
        shotLabels={data.shotLabels}
        playheadMs={playheadMs}
        playing={playing}
        activeShotId={activeShotId}
        onTogglePlay={togglePlay}
        onRestart={restart}
        selectedShotId={selectedShotId}
        onSelectShot={selectShot}
        selectedCaptionIndex={selectedCaptionIndex}
        onSelectCaption={selectCaption}
      />

      <section className="rounded-[12px] border border-border bg-raised p-5 shadow-card" aria-label="Selection details" data-testid="edit.detail">
        <ShotDetailPanel
          view={view}
          shot={selectedShot}
          caption={captionDetail}
          takes={selectedTakes}
          sourceFrames={selectedShot ? data.sourceFramesByShot[selectedShot.shotRevisionId] ?? null : null}
          interactive={data.editsAvailable && !applying}
          onPlan={planOp}
          onRestoreSaved={restoreSaved}
          hasUnsavedChanges={!view.matchesBuilt}
        />
        {selectedShot && (
          <p className="mt-3 border-t border-border pt-3 text-[12px] text-muted">
            Need a different angle for this scene? Generate another take from the{" "}
            <Link href={`/production/${data.projectId}/storyboard`} className="font-semibold text-primary hover:underline">
              storyboard
            </Link>{" "}
            — it appears in the swap-take list above.
          </p>
        )}
      </section>

      {view.outsideCut.length > 0 && (
        <p className="rounded-[10px] border border-dashed border-border-strong bg-surface px-4 py-3 text-[13px] text-muted" data-testid="edit.outside-cut">
          {view.outsideCut.length} planned scene{view.outsideCut.length === 1 ? " is" : "s are"} not in this cut yet — the storyboard moved on since the last build.{" "}
          <Link href={`/production/${data.projectId}/storyboard`} className="font-semibold text-primary hover:underline">
            Open the storyboard
          </Link>{" "}
          to bring them in.
        </p>
      )}
    </main>
  );
}
