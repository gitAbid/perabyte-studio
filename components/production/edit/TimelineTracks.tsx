"use client";

/**
 * Track-style timeline lanes over the working manifest (spec 13 §6 Advanced view).
 *
 * VIDEO (one block per enabled shot), VOICE / MUSIC / SFX (manifest audioCues positioned by
 * timeline time), CAPTIONS (caption cue ranges), plus a playhead that cycles by accumulated
 * duration — playback itself stays with /first-cut. Every block carries its full timing as an
 * accessible name, and text cue lists below the lanes are the text alternative for all cue
 * timing (UX spec audio section). Blocks select; all edits happen through the detail panel's
 * confirm/apply path over the frozen C10 ops.
 */

import { Icon } from "@/components/Icon";
import { formatDurationLabel, type FirstCutViewModel } from "@/lib/production/first-cut-view-model";
import { formatTimecode, type TimelineModel } from "./timeline-model";

export interface TimelineTracksProps {
  view: FirstCutViewModel;
  model: TimelineModel;
  /** Human labels by base shot revision id (visual intent) for block titles. */
  shotLabels: Readonly<Record<string, string>>;
  playheadMs: number;
  playing: boolean;
  activeShotId: string | null;
  onTogglePlay: () => void;
  onRestart: () => void;
  selectedShotId: string | null;
  onSelectShot: (shotRevisionId: string) => void;
  selectedCaptionIndex: number | null;
  onSelectCaption: (index: number) => void;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

export function TimelineTracks({
  view, model, shotLabels, playheadMs, playing, activeShotId,
  onTogglePlay, onRestart, selectedShotId, onSelectShot, selectedCaptionIndex, onSelectCaption,
}: TimelineTracksProps) {
  const playheadPercent = model.totalMs > 0 ? Math.min(100, (playheadMs / model.totalMs) * 100) : 0;
  const hasCues = model.voice.length + model.music.length + model.sfx.length > 0;
  const labelFor = (shot: FirstCutViewModel["shots"][number]): string => shotLabels[shot.baseShotRevisionId] ?? (shot.isCopy ? "Repeat" : `Scene ${shot.position}`);

  return (
    <section className="flex flex-col gap-3" aria-label="Timeline" data-testid="edit.timeline">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-bold text-ink">Timeline</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? "Pause timeline scrub" : "Play timeline scrub"}
            data-testid="edit.timeline.play"
            className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] font-semibold text-ink transition-colors hover:border-muted"
          >
            <Icon name={playing ? "pause" : "play"} size={15} />
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            onClick={onRestart}
            aria-label="Restart timeline scrub from the beginning"
            data-testid="edit.timeline.restart"
            className="inline-flex h-9 items-center rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] font-semibold text-ink transition-colors hover:border-muted"
          >
            Restart
          </button>
          <p className="text-[12px] tabular-nums text-muted" data-testid="edit.timeline.playhead-readout" role="status">
            {formatTimecode(playheadMs)} / {formatTimecode(model.totalMs)} · runtime {view.runtimeLabel}
          </p>
        </div>
      </div>

      {/* Ordinal chips: every manifest shot in order, including skipped ones (zero timeline time). */}
      <ol className="flex flex-wrap gap-1.5" aria-label="Scenes in manifest order" data-testid="edit.timeline.chips">
        {view.shots.map((shot) => (
          <li key={shot.shotRevisionId}>
            <button
              type="button"
              data-testid="edit.timeline.chip"
              data-position={shot.position}
              data-status={shot.status}
              aria-pressed={selectedShotId === shot.shotRevisionId}
              aria-label={`Scene ${shot.position}${shot.isCopy ? " (repeat)" : ""}${shot.disabled ? ", skipped" : ""}, ${formatDurationLabel(shot.durationMs)}`}
              onClick={() => onSelectShot(shot.shotRevisionId)}
              title={shot.disabled ? `Scene ${shot.position} — skipped` : `Scene ${shot.position} — ${formatDurationLabel(shot.durationMs)}`}
              className={`inline-flex h-8 min-w-9 items-center justify-center rounded-[6px] border px-2 text-[12px] font-bold tabular-nums transition-colors ${
                selectedShotId === shot.shotRevisionId
                  ? "border-primary bg-primary-strong text-white"
                  : shot.disabled
                    ? "border-dashed border-border-strong bg-surface text-muted line-through"
                    : shot.status === "missing"
                      ? "border-warning/50 bg-warning-soft text-ink"
                      : "border-border bg-raised text-ink hover:border-muted"
              }`}
            >
              {pad2(shot.position)}
            </button>
          </li>
        ))}
      </ol>

      {/* Lanes. The playhead overlay spans the track column (which starts at the 5rem label gutter). */}
      <div className="relative flex flex-col overflow-hidden rounded-[10px] border border-border bg-surface">
        <Lane label="Video" laneLabel="VIDEO">
          {model.video.map((block) => {
            const selected = selectedShotId === block.shot.shotRevisionId;
            const active = activeShotId === block.shot.shotRevisionId;
            return (
              <button
                key={block.shot.shotRevisionId}
                type="button"
                data-testid="edit.timeline.shot"
                data-position={block.shot.position}
                data-active={active || undefined}
                aria-pressed={selected}
                aria-label={`Scene ${block.shot.position}${block.shot.isCopy ? " (repeat)" : ""}: ${labelFor(block.shot)}, ${formatDurationLabel(block.shot.durationMs)}, starts at ${formatDurationLabel(block.shot.startMs ?? 0)}`}
                onClick={() => onSelectShot(block.shot.shotRevisionId)}
                style={{ left: `${block.startPercent}%`, width: `${Math.max(block.widthPercent, 2)}%` }}
                className={`absolute inset-y-1.5 flex min-w-0 flex-col justify-center overflow-hidden rounded-[6px] border px-1.5 text-left transition-colors ${
                  selected
                    ? "z-[1] border-primary bg-primary-strong text-white ring-2 ring-primary ring-offset-1 ring-offset-surface"
                    : active
                      ? "border-primary bg-primary-soft text-ink"
                      : block.shot.status === "missing"
                        ? "border-warning/50 bg-warning-soft text-ink"
                        : "border-primary/40 bg-primary-soft/60 text-ink hover:bg-primary-soft"
                }`}
              >
                <span className="text-[10px] font-bold tabular-nums opacity-80">{pad2(block.shot.position)}</span>
                <span className="truncate text-[11px] leading-tight">{labelFor(block.shot)}</span>
              </button>
            );
          })}
          {model.video.length === 0 && <LaneEmpty text="No playing shots — every scene is skipped." />}
        </Lane>
        <Lane label="Voice" laneLabel="VOICE">
          {model.voice.map((cue) => (
            <CueBlock key={cue.id} cue={cue} tone="bg-success-soft border-success/40 text-ink" />
          ))}
          {model.voice.length === 0 && <LaneEmpty text="No narration or dialogue cues." />}
        </Lane>
        <Lane label="Music" laneLabel="MUSIC">
          {model.music.map((cue) => (
            <CueBlock key={cue.id} cue={cue} tone="bg-warning-soft border-warning/40 text-ink" />
          ))}
          {model.music.length === 0 && <LaneEmpty text="No music cues." />}
        </Lane>
        <Lane label="SFX" laneLabel="SFX">
          {model.sfx.map((cue) => (
            <CueBlock key={cue.id} cue={cue} tone="bg-danger-soft border-danger/40 text-ink" />
          ))}
          {model.sfx.length === 0 && <LaneEmpty text="No SFX cues." />}
        </Lane>
        <Lane label="Captions" laneLabel="CAPTIONS">
          {model.captions.map((caption) => (
            <button
              key={caption.index}
              type="button"
              data-testid="edit.timeline.caption"
              data-caption={caption.index}
              aria-pressed={selectedCaptionIndex === caption.index}
              aria-label={`Caption ${caption.index + 1}: “${caption.text}”, ${formatDurationLabel(caption.startMs)} to ${formatDurationLabel(caption.startMs + caption.durationMs)}`}
              onClick={() => onSelectCaption(caption.index)}
              style={{ left: `${caption.startPercent}%`, width: `${Math.max(caption.widthPercent, 2)}%` }}
              className={`absolute inset-y-1.5 overflow-hidden rounded-[6px] border px-1.5 text-left text-[11px] leading-tight ${
                selectedCaptionIndex === caption.index
                  ? "z-[1] border-primary bg-primary-strong text-white ring-2 ring-primary ring-offset-1 ring-offset-surface"
                  : "border-border-strong bg-raised text-ink-soft hover:border-muted"
              }`}
            >
              <span className="line-clamp-2">{caption.text}</span>
            </button>
          ))}
          {model.captions.length === 0 && <LaneEmpty text="No captions on this cut." />}
        </Lane>
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-20 right-0 z-[2]">
          <div className="absolute inset-y-0 w-px bg-accent" style={{ left: `${playheadPercent}%` }} />
          <div className="absolute top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" style={{ left: `${playheadPercent}%` }} />
        </div>
      </div>

      {/* Text alternatives for all cue timing (UX spec: no drag-only, always a text path). */}
      <div className="grid gap-2 text-[12px] text-muted sm:grid-cols-2" data-testid="edit.timeline.cue-lists">
        <ul className="flex flex-col gap-1" aria-label="Audio cue timings" data-testid="edit.timeline.cues-list">
          {hasCues ? (
            [...model.voice, ...model.music, ...model.sfx]
              .sort((left, right) => left.startMs - right.startMs)
              .map((cue) => (
                <li key={cue.id}>
                  {formatDurationLabel(cue.startMs)} → {formatDurationLabel(cue.startMs + cue.durationMs)} · {cue.label}
                </li>
              ))
          ) : (
            <li>No audio cues on this cut — narration, music and SFX are managed in the audio workspace.</li>
          )}
        </ul>
        <ul className="flex flex-col gap-1" aria-label="Caption timings" data-testid="edit.timeline.captions-list">
          {model.captions.length > 0 ? (
            model.captions.map((caption) => (
              <li key={caption.index}>
                {formatDurationLabel(caption.startMs)} → {formatDurationLabel(caption.startMs + caption.durationMs)} · “{caption.text}”
              </li>
            ))
          ) : (
            <li>No captions on this cut.</li>
          )}
        </ul>
      </div>
    </section>
  );
}

function Lane({ label, laneLabel, children }: { label: string; laneLabel: string; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch border-b border-border last:border-b-0" data-testid="edit.timeline.lane" data-lane={laneLabel}>
      <div className="w-20 shrink-0 border-r border-border bg-surface-2/60 px-2 py-2">
        <span className="block text-[9px] font-bold uppercase tracking-[0.14em] text-muted">{laneLabel}</span>
        <span className="sr-only">{label} track</span>
      </div>
      <div className="relative h-14 min-w-0 flex-1" role="group" aria-label={`${laneLabel} lane`}>
        {children}
      </div>
    </div>
  );
}

function CueBlock({ cue, tone }: { cue: TimelineModel["voice"][number]; tone: string }) {
  return (
    <span
      role="img"
      aria-label={`${cue.label}, ${formatDurationLabel(cue.startMs)} to ${formatDurationLabel(cue.startMs + cue.durationMs)}`}
      data-testid="edit.timeline.cue"
      style={{ left: `${cue.startPercent}%`, width: `${Math.max(cue.widthPercent, 1.5)}%` }}
      className={`absolute inset-y-1.5 overflow-hidden rounded-[6px] border px-1.5 text-[10px] leading-tight ${tone}`}
    >
      <span className="line-clamp-2">{cue.label}</span>
    </span>
  );
}

function LaneEmpty({ text }: { text: string }) {
  return (
    <span className="absolute inset-y-1.5 left-2 flex items-center text-[11px] text-muted">
      {text}
    </span>
  );
}
