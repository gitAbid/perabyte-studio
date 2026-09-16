"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { useSmartMask } from "@/lib/moderation-client";
import { displaySrc, isVideoSource } from "@/lib/renderer";

/* ------------------------------------------------------------------ */
/* Image frame with skeleton + recoverable error state                 */
/* ------------------------------------------------------------------ */

/** Automatic retries before the user is asked to intervene. */
const AUTO_RETRIES = 3;

/* ------------------------------------------------------------------ */
/* Uncensored (18+) masking                                            */
/* ------------------------------------------------------------------ */

/**
 * Mask decisions come from `useSmartMask` (lib/moderation-client.ts): the
 * caller's static flag (rendered with the safety checker off) rules until
 * a confident vision verdict for this exact media arrives, then the
 * verdict wins in both directions. Revealing is per frame instance.
 */

/** Classes that blur a media element past recognition (scale hides the blur's soft edges). */
const BLUR_CLASSES = "scale-105 blur-2xl";

/**
 * Full-cover veil over masked media: an 18+ chip and a Show control. The
 * veil also blocks every interaction with the media beneath it. MediaFrame
 * sits inside <button> cards and <Link>s, so the reveal control is a
 * span-with-role (like ImageFrame's Retry) — a nested native button would be
 * invalid HTML and break hydration, and the click must not select the outer
 * card or follow the outer link.
 */
function SensitiveVeil({
  onReveal,
  detailed,
}: {
  onReveal: () => void;
  /** Show the "Sensitive content" caption — large stages only. */
  detailed?: boolean;
}) {
  function reveal(event: MouseEvent | KeyboardEvent) {
    // stopPropagation alone is not enough: it suppresses ancestor React
    // handlers but the native event still lands on an ancestor <Link>/<a>,
    // whose default action then navigates. preventDefault keeps the click on
    // the veil.
    event.preventDefault();
    event.stopPropagation();
    onReveal();
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/25 text-center">
      <span className="rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-white">
        18+
      </span>
      {detailed && (
        <p className="text-[12px] font-semibold text-white drop-shadow">
          Sensitive content
        </p>
      )}
      <span
        role="button"
        tabIndex={0}
        aria-label="Show sensitive content"
        onClick={reveal}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") reveal(event);
        }}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink shadow-card transition-colors hover:bg-surface-2"
      >
        <Icon name="eye" size={13} />
        Show
      </span>
    </div>
  );
}

/**
 * Image frame with skeleton + recoverable error state. Sources that point at
 * video bytes (cached provider mp4s) render as a compact muted looping
 * <video> instead — an <img> cannot decode mp4 and would surface as a
 * broken image with pointless retries.
 */
export function MediaFrame({
  src,
  alt,
  className = "",
  ratio = "16/9",
  rounded = "rounded-[16px]",
  sizes,
  priority,
  fit,
  sensitive,
  detailed,
}: {
  src: string | null;
  alt: string;
  className?: string;
  ratio?: string;
  rounded?: string;
  sizes?: string;
  priority?: boolean;
  /** Size to the container (contain) instead of a fixed aspect-ratio box. */
  fit?: boolean;
  /** Source is 18+/uncensored — blur while the mask setting is on. */
  sensitive?: boolean;
  /** Caption under the 18+ chip (large stages). */
  detailed?: boolean;
}) {
  const video = isVideoSource(src);

  if (video) {
    return <VideoFrame src={src} alt={alt} fit={fit} ratio={ratio} rounded={rounded} className={className} sensitive={sensitive} detailed={detailed} />;
  }

  return <ImageFrame
    src={src}
    alt={alt}
    className={className}
    ratio={ratio}
    rounded={rounded}
    sizes={sizes}
    priority={priority}
    fit={fit}
    sensitive={sensitive}
    detailed={detailed}
  />;
}

/** Overlay shown when a <video> source fails to load or decode. */
function VideoUnavailable({ hint }: { hint?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center">
      <Icon name="alert" size={20} className="text-warning" />
      <p className="text-[12px] font-medium text-ink-soft">
        {hint ?? "This video could not be loaded."}
      </p>
    </div>
  );
}

/** Compact looping video frame (thumbnails, history) with a load-error state. */
function VideoFrame({
  src,
  alt,
  fit,
  ratio,
  rounded,
  className,
  sensitive,
  detailed,
}: {
  src: string | null;
  alt: string;
  fit?: boolean;
  ratio: string;
  rounded: string;
  className: string;
  sensitive?: boolean;
  detailed?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { masked, reveal } = useSmartMask(sensitive, src);

  useEffect(() => setFailed(false), [src]);

  return (
    <div
      className={`relative overflow-hidden bg-black ${
        fit ? "flex h-full w-full items-center justify-center" : "bg-surface-2"
      } ${rounded} ${className}`}
      style={fit ? undefined : { aspectRatio: ratio }}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={src ?? undefined}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={alt}
        onError={() => setFailed(true)}
        className={`size-full object-cover ${masked ? BLUR_CLASSES : ""}`}
      />
      {failed && <VideoUnavailable />}
      {masked && <SensitiveVeil onReveal={reveal} detailed={detailed} />}
    </div>
  );
}

function ImageFrame({
  src,
  alt,
  className = "",
  ratio = "16/9",
  rounded = "rounded-[16px]",
  sizes,
  priority,
  fit,
  sensitive,
  detailed,
}: {
  src: string | null;
  alt: string;
  className?: string;
  ratio?: string;
  rounded?: string;
  sizes?: string;
  priority?: boolean;
  fit?: boolean;
  sensitive?: boolean;
  detailed?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [autoTries, setAutoTries] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const { masked, reveal } = useSmartMask(sensitive, src);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src, attempt]);

  // The render provider rate-limits hard (HTTP 429), which shows up here as a
  // failed image. Those clear within seconds, so retry automatically a few
  // times with backoff before handing control to the user.
  useEffect(() => {
    if (!failed || autoTries >= AUTO_RETRIES) return;
    const timer = setTimeout(
      () => {
        setAutoTries((n) => n + 1);
        setAttempt((n) => n + 1);
        setFailed(false);
      },
      2000 * (autoTries + 1),
    );
    return () => clearTimeout(timer);
  }, [failed, autoTries]);

  const retry = useCallback(() => {
    setAutoTries(0);
    setFailed(false);
    setAttempt((a) => a + 1);
  }, []);

  const url = src ? withRetryParam(displaySrc(src) as string, attempt) : null;
  const autoRetrying = failed && autoTries < AUTO_RETRIES;

  return (
    <div
      className={`relative overflow-hidden ${
        fit
          ? "flex h-full w-full items-center justify-center"
          : "bg-surface-2"
      } ${rounded} ${className}`}
      style={fit ? undefined : { aspectRatio: ratio }}
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
          className={
            fit
              ? `max-h-full max-w-full rounded-[14px] object-contain transition-opacity duration-500 ${
                  loaded ? "opacity-100" : "opacity-0"
                } ${masked ? BLUR_CLASSES : ""}`
              : `size-full object-cover transition-opacity duration-500 ${
                  loaded ? "opacity-100" : "opacity-0"
                } ${masked ? BLUR_CLASSES : ""}`
          }
        />
      )}

      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center">
          <Icon
            name={autoRetrying ? "clock" : "alert"}
            size={20}
            className={autoRetrying ? "text-muted" : "text-warning"}
          />
          <p className="text-[12px] font-medium text-ink-soft">
            {autoRetrying
              ? "The render provider is busy — retrying…"
              : "This render could not be loaded."}
          </p>
          {!autoRetrying && (
            // MediaFrame is embedded inside selectable <button> cards
            // (thumbnails, variant pickers), so the retry control must not be
            // a native <button> — nested buttons are invalid HTML and break
            // hydration. A click here must also not select the outer card.
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                // preventDefault too: an ancestor <Link>'s native default
                // action would otherwise navigate on click.
                event.preventDefault();
                event.stopPropagation();
                retry();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  retry();
                }
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-strong bg-raised px-2.5 py-1 text-[12px] font-semibold text-ink hover:border-muted"
            >
              <Icon name="refresh" size={13} />
              Retry
            </span>
          )}
        </div>
      )}

      {masked && <SensitiveVeil onReveal={reveal} detailed={detailed} />}
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
 *
 * When `videoUrl` is provided (a real provider mp4), a native <video> player
 * takes over instead — the simulated stage remains for legacy/demo assets.
 */
export function VideoStage({
  posterUrl,
  videoUrl,
  title,
  durationSeconds = 5,
  className = "",
  fit,
  fitStyle,
  ratio = "16/9",
  sensitive,
}: {
  posterUrl: string | null;
  /** Real mp4 URL — when set, a native player replaces the simulated stage. */
  videoUrl?: string | null;
  title: string;
  durationSeconds?: number;
  className?: string;
  /** Shrink to the container instead of claiming a fixed aspect-ratio box. */
  fit?: boolean;
  /** Exact sizing for fit mode (e.g. the render's aspect ratio), applied when
   * `fit` is set so portrait renders are not cropped into a 16:9 stage. */
  fitStyle?: CSSProperties;
  /** The render's native aspect ratio for the stage box when it is not sized
   * by a fit container — defaults to the legacy 16:9 stage. */
  ratio?: string;
  /** Source is 18+/uncensored — blur while the mask setting is on. */
  sensitive?: boolean;
}) {
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const { masked, reveal } = useSmartMask(sensitive, videoUrl ?? posterUrl ?? null);

  const duration = Math.max(1, Math.round(durationSeconds * 15)) / 10;

  useEffect(() => setVideoFailed(false), [videoUrl]);

  useEffect(() => {
    if (!playing || videoUrl) return;
    const id = window.setInterval(() => {
      setElapsed((prev) => (prev + 0.1 >= duration ? 0 : prev + 0.1));
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, duration, videoUrl]);

  const toggleFullscreen = useCallback(() => {
    const node = shellRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  }, []);

  if (videoUrl) {
    return (
      <div
        ref={shellRef}
        className={`relative overflow-hidden rounded-[20px] bg-black ${className}`}
        style={
          fit
            ? (fitStyle ?? {
                aspectRatio: ratio,
                height: "100%",
                width: "auto",
                maxWidth: "100%",
                maxHeight: "100%",
              })
            : { aspectRatio: ratio }
        }
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={videoUrl}
          poster={posterUrl ? (displaySrc(posterUrl) ?? undefined) : undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={title}
          onError={() => setVideoFailed(true)}
          className={`size-full bg-black object-contain ${masked ? BLUR_CLASSES : ""}`}
        />
        {videoFailed && <VideoUnavailable hint="This video could not be loaded — regenerate it." />}
        {masked && <SensitiveVeil onReveal={reveal} detailed />}
      </div>
    );
  }

  const progress = Math.min(100, (elapsed / duration) * 100);

  return (
    <div
      ref={shellRef}
      className={`group relative overflow-hidden rounded-[20px] bg-black ${className}`}
      style={
        fit
          ? (fitStyle ?? {
              aspectRatio: ratio,
              height: "100%",
              width: "auto",
              maxWidth: "100%",
              maxHeight: "100%",
            })
          : { aspectRatio: ratio }
      }
    >
      {posterUrl ? (
        <img
          src={displaySrc(posterUrl) as string}
          alt={title}
          className={`size-full object-cover ${playing && !masked ? "kenburns" : ""} ${masked ? BLUR_CLASSES : ""}`}
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
            className="absolute inset-y-0 left-0 rounded-full bg-raised"
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

      <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur">
        Preview render · {duration}s
      </span>

      {masked && <SensitiveVeil onReveal={reveal} detailed />}
    </div>
  );
}

function formatClock(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}:${rest.toString().padStart(2, "0")}`;
}