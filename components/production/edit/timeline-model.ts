/**
 * Pure lane projection for the advanced edit timeline (spec 13 §6/§10.5).
 *
 * Everything is computed from the working `RenderManifest` through the shared first-cut view
 * model — there is NO feature-local timeline model: the lanes are a percent-positioned
 * projection of manifest shots, audioCues and captionCues, rebuilt after every applied op so
 * timeline state stays fully reconstructable from the manifest.
 */
import { framesToMs, type FirstCutManifest, type FirstCutShotView, type FirstCutViewModel } from "@/lib/production/first-cut-view-model";

export interface TimelineVideoBlock {
  shot: FirstCutShotView;
  startPercent: number;
  widthPercent: number;
}

export interface TimelineCueBlock {
  id: string;
  label: string;
  startMs: number;
  durationMs: number;
  startPercent: number;
  widthPercent: number;
}

export interface TimelineCaptionBlock {
  index: number;
  text: string;
  startMs: number;
  durationMs: number;
  startPercent: number;
  widthPercent: number;
}

export interface TimelineModel {
  totalMs: number;
  video: TimelineVideoBlock[];
  voice: TimelineCueBlock[];
  music: TimelineCueBlock[];
  sfx: TimelineCueBlock[];
  captions: TimelineCaptionBlock[];
}

const percent = (ms: number, totalMs: number): number => (totalMs > 0 ? Math.min(100, Math.max(0, (ms / totalMs) * 100)) : 0);

/** Audio cue samples sit on the manifest's fixed 48 kHz timeline; ms = samples / (sampleRate / 1000). */
const samplesToMs = (samples: number, sampleRate: number): number => Math.round((samples * 1000) / (sampleRate > 0 ? sampleRate : 48_000));

/** "0:04.2" — playhead timecode with a tenth-of-a-second digit (plain text alternative below the lanes). */
export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = (clamped % 60_000) / 1000;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function buildTimelineModel(manifest: FirstCutManifest, view: FirstCutViewModel): TimelineModel {
  const fps = manifest?.profile?.fps ?? view.fps;
  const sampleRate = manifest?.profile?.sampleRate ?? 48_000;
  const totalMs = view.workingRuntimeMs;

  const video: TimelineVideoBlock[] = [];
  for (const shot of view.shots) {
    if (shot.disabled || shot.startMs === null) continue;
    video.push({
      shot,
      startPercent: percent(shot.startMs, totalMs),
      widthPercent: percent(shot.durationMs, totalMs),
    });
  }

  const cueBucket = (roles: ReadonlyArray<string>): TimelineCueBlock[] =>
    (manifest?.audioCues ?? [])
      .filter((cue) => roles.includes(cue.role))
      .map((cue) => {
        const startMs = samplesToMs(cue.timelineStartSample, sampleRate);
        const durationMs = Math.max(0, samplesToMs(cue.sourceEndSample - cue.sourceStartSample, sampleRate));
        return {
          id: cue.id,
          label: cue.sourceText?.trim() ? cue.sourceText.trim().slice(0, 80) : `${cue.role} cue`,
          startMs,
          durationMs,
          startPercent: percent(startMs, totalMs),
          widthPercent: percent(durationMs, totalMs),
        };
      });

  const captions: TimelineCaptionBlock[] = (manifest?.captionCues ?? []).map((cue, index) => {
    const startMs = framesToMs(cue.startFrame, fps);
    const durationMs = Math.max(0, framesToMs(cue.endFrame - cue.startFrame, fps));
    return {
      index,
      text: cue.text,
      startMs,
      durationMs,
      startPercent: percent(startMs, totalMs),
      widthPercent: percent(durationMs, totalMs),
    };
  });

  return {
    totalMs,
    video,
    voice: cueBucket(["narration", "dialogue"]),
    music: cueBucket(["music"]),
    sfx: cueBucket(["sfx"]),
    captions,
  };
}
