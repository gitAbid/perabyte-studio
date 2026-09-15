"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { isVideoScene, type PlayableScene } from "@/lib/renderer";

/**
 * Plays a story's scenes back-to-back like one uninterrupted video: real
 * mp4s run to their natural end and auto-advance, image scenes dwell for
 * `sceneSeconds` with the same kenburns motion as the simulated preview.
 * Hard cuts between scenes; the reel stops on a Replay card after the last
 * scene. Rendered as a fullscreen overlay so nothing scrolls or competes
 * with the grid while the story plays.
 */
export function StoryPlayer({
  scenes,
  sceneSeconds = 5,
  onClose,
}: {
  scenes: (PlayableScene & { label?: string })[];
  /** Dwell time for image scenes, in seconds (video scenes play their own length). */
  sceneSeconds?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [finished, setFinished] = useState(false);
  // 0..1 progress through the CURRENT scene (video timeupdate or image dwell).
  const [progress, setProgress] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const scene = scenes[index];
  const currentIsVideo = scene ? isVideoScene(scene) : false;

  const goTo = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(next, scenes.length - 1)));
    setProgress(0);
    setFinished(false);
  }, [scenes.length]);

  const advance = useCallback(() => {
    if (index < scenes.length - 1) {
      goTo(index + 1);
    } else {
      // End of the reel: hold the last frame with a Replay card.
      setFinished(true);
      setPlaying(false);
    }
  }, [goTo, index, scenes.length]);

  const replay = useCallback(() => {
    goTo(0);
    setPlaying(true);
  }, [goTo]);

  // Sync the play state to the current video element (images are driven by
  // the dwell timer below). A fresh source can reject the first play() while
  // it is still settling (AbortError mid-load), so retry briefly on a timer
  // before conceding to the paused state. The element carries no autoPlay —
  // this effect is the single source of playback so the two never race.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!playing) {
      video.pause();
      return;
    }
    let cancelled = false;
    let timer = 0;
    const attempt = (n: number) => {
      if (cancelled) return;
      video.muted = muted;
      video.play().catch(() => {
        if (cancelled) return;
        if (n >= 5) {
          setPlaying(false);
          return;
        }
        timer = window.setTimeout(() => attempt(n + 1), 200 * (n + 1));
      });
    };
    attempt(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playing, index, muted]);

  // Image scenes: advance after the dwell time. Videos advance via onEnded.
  // Wall-clock based so the dwell always completes (a stepped counter caps
  // just below 1 and would never trigger the advance). advance() flips the
  // scene or sets finished, either of which tears this effect down.
  useEffect(() => {
    if (!playing || finished || currentIsVideo) return;
    const started = performance.now();
    const durationMs = Math.max(1, sceneSeconds) * 1000;
    const id = window.setInterval(() => {
      const ratio = (performance.now() - started) / durationMs;
      if (ratio >= 1) {
        setProgress(1);
        advance();
      } else {
        setProgress(ratio);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, finished, currentIsVideo, sceneSeconds, advance]);

  // Keyboard transport: Esc closes, Space toggles, arrows change scene.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === " ") {
        event.preventDefault();
        if (finished) replay();
        else setPlaying((p) => !p);
      } else if (event.key === "ArrowRight") goTo(index + 1);
      else if (event.key === "ArrowLeft") goTo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finished, goTo, index, onClose, replay]);

  // Lock page scroll behind the overlay.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Take over the page's media: pause anything playing outside the reel.
  // Prevents competing audio, and some embedded players only sustain one
  // decoder at a time — a dormant grid preview can stall playback here.
  useEffect(() => {
    const dialog = shellRef.current;
    if (!dialog) return;
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => {
      if (!dialog.contains(media) && !media.paused) media.pause();
    });
  }, [index]);

  const toggleFullscreen = useCallback(() => {
    if (!shellRef.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current.requestFullscreen?.();
  }, []);

  if (!scene) return null;

  const progressPct = Math.min(100, progress * 100);

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label="Story playback"
      className="fixed inset-0 z-50 bg-ink"
    >
      {/* Stage — hard cuts between scenes for the uninterrupted-video feel. */}
      <div className="absolute inset-0 flex items-center justify-center">
        {currentIsVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            key={scene.url}
            ref={videoRef}
            src={scene.url}
            muted={muted}
            playsInline
            preload="auto"
            aria-label={scene.label ?? `Scene ${index + 1}`}
            onEnded={advance}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              if (video.duration > 0) setProgress(video.currentTime / video.duration);
            }}
            onError={advance}
            className="max-h-full max-w-full"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={scene.url}
            src={scene.url}
            alt={scene.label ?? `Scene ${index + 1}`}
            className={`max-h-full max-w-full object-contain ${playing && !finished ? "kenburns" : ""}`}
          />
        )}

        {finished && (
          <button
            type="button"
            onClick={replay}
            aria-label="Replay story"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/60 text-white transition-colors hover:bg-ink/45"
          >
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-white/15 backdrop-blur">
              <Icon name="refresh" size={22} />
            </span>
            <span className="text-[13px] font-bold">Replay story</span>
          </button>
        )}
      </div>

      {/* Top chrome: position, current scene's prompt, close. */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-ink/70 to-transparent p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">
            Scene {index + 1} / {scenes.length}
          </p>
          {scene.label && (
            <p className="mt-0.5 truncate text-[12.5px] text-white/90">{scene.label}</p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close story playback"
          onClick={onClose}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/25"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {/* Bottom chrome: per-scene progress segments + transport. */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 via-ink/25 to-transparent px-4 pb-4 pt-12">
        <div className="flex gap-1" role="progressbar" aria-label="Story progress" aria-valuemin={0} aria-valuemax={scenes.length} aria-valuenow={index + 1}>
          {scenes.map((entry, i) => (
            <span key={`${entry.url}-${i}`} className="h-1 flex-1 overflow-hidden rounded-full bg-white/25">
              <span
                className="block h-full rounded-full bg-white transition-[width] duration-200 ease-linear"
                style={{ width: `${i < index ? 100 : i === index ? progressPct : 0}%` }}
              />
            </span>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3 text-white">
          <button
            type="button"
            aria-label={playing ? "Pause story" : "Play story"}
            onClick={() => {
              if (finished) replay();
              else setPlaying((p) => !p);
            }}
            className="inline-flex size-10 items-center justify-center rounded-full bg-white/15 backdrop-blur transition-colors hover:bg-white/25"
          >
            <Icon name={playing && !finished ? "pause" : "play"} size={17} />
          </button>
          <button
            type="button"
            aria-label="Previous scene"
            onClick={() => goTo(index - 1)}
            disabled={index === 0}
            className="opacity-90 transition-opacity hover:opacity-100 disabled:opacity-30"
          >
            <Icon name="arrow-left" size={18} />
          </button>
          <button
            type="button"
            aria-label="Next scene"
            onClick={() => goTo(index + 1)}
            disabled={index >= scenes.length - 1}
            className="opacity-90 transition-opacity hover:opacity-100 disabled:opacity-30"
          >
            <Icon name="arrow-right" size={18} />
          </button>
          <span className="text-[12px] tabular-nums text-white/90">
            {Math.round(progressPct)}%
          </span>
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => setMuted((m) => !m)}
              className="opacity-90 transition-opacity hover:opacity-100"
            >
              <Icon name="volume" size={16} />
            </button>
            <button
              type="button"
              aria-label="Toggle fullscreen"
              onClick={toggleFullscreen}
              className="opacity-90 transition-opacity hover:opacity-100"
            >
              <Icon name="fullscreen" size={16} />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
