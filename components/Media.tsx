"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/* ------------------------------------------------------------------ */
/* Image frame with skeleton + recoverable error state                 */
/* ------------------------------------------------------------------ */

export function MediaFrame({
  src,
  alt,
  className = "",
  ratio = "16/9",
  rounded = "rounded-[16px]",
  sizes,
  priority,
}: {
  src: string | null;
  alt: string;
  className?: string;
  ratio?: string;
  rounded?: string;
  sizes?: string;
  priority?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src, attempt]);

  const url = src ? withRetryParam(src, attempt) : null;

  return (
    <div
      className={`relative overflow-hidden bg-surface-2 ${rounded} ${className}`}
      style={{ aspectRatio: ratio }}
    >
      {!loaded && !failed && <div className="skeleton absolute inset-0" />}

      {url && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          sizes={sizes}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`size-full object-cover transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}

      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center">
          <Icon name="alert" size={20} className="text-warning" />
          <p className="text-[12px] font-medium text-ink-soft">
            This render could not be loaded.
          </p>
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="inline-flex items-center gap-1 rounded-lg border border-border-strong bg-white px-2.5 py-1 text-[12px] font-semibold text-ink hover:border-muted"
          >
            <Icon name="refresh" size={13} />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function withRetryParam(url: string, attempt: number) {
  if (attempt === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}retry=${attempt}`;
}

/* ------------------------------------------------------------------ */
/* Video stage                                                         */
/* ------------------------------------------------------------------ */

/**
 * Video playback is simulated in this build: the provider we render through
 * returns still frames, so we present the rendered keyframe as an animated
 * preview with real transport controls. The bar is labelled in the UI so
 * nobody mistakes it for an exported MP4.
 */
export function VideoStage({
  posterUrl,
  title,
  durationSeconds = 5,
  className = "",
}: {
  posterUrl: string | null;
  title: string;
  durationSeconds?: number;
  className?: string;
}) {
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);

  const duration = Math.max(1, Math.round(durationSeconds * 15)) / 10;

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setElapsed((prev) => (prev + 0.1 >= duration ? 0 : prev + 0.1));
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, duration]);

  const toggleFullscreen = useCallback(() => {
    const node = shellRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  }, []);

  const progress = Math.min(100, (elapsed / duration) * 100);

  return (
    <div
      ref={shellRef}
      className={`group relative overflow-hidden rounded-[20px] bg-ink ${className}`}
      style={{ aspectRatio: "16/9" }}
    >
      {posterUrl ? (
        <img
          src={posterUrl}
          alt={title}
          className={`size-full object-cover ${playing ? "kenburns" : ""}`}
        />
      ) : (
        <div className="skeleton absolute inset-0 opacity-40" />
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 via-ink/25 to-transparent px-4 pb-3.5 pt-10">
        <div
          className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/30"
          role="slider"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(elapsed)}
          tabIndex={0}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setElapsed(
              Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration)),
            );
          }}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-white"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-3 flex items-center gap-3 text-white">
          <button
            type="button"
            aria-label={playing ? "Pause preview" : "Play preview"}
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex size-8 items-center justify-center rounded-full bg-white/15 backdrop-blur hover:bg-white/25"
          >
            <Icon name={playing ? "pause" : "play"} size={15} />
          </button>
          <span className="text-[12px] tabular-nums text-white/90">
            {formatClock(elapsed)} / {formatClock(duration)}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => setMuted((m) => !m)}
              className="opacity-90 hover:opacity-100"
            >
              <Icon name="volume" size={16} />
            </button>
            <button
              type="button"
              aria-label="Toggle fullscreen"
              onClick={toggleFullscreen}
              className="opacity-90 hover:opacity-100"
            >
              <Icon name="fullscreen" size={16} />
            </button>
          </span>
        </div>
      </div>

      <span className="absolute left-3 top-3 rounded-full bg-ink/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur">
        Preview render · {duration}s
      </span>
    </div>
  );
}

function formatClock(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}:${rest.toString().padStart(2, "0")}`;
}