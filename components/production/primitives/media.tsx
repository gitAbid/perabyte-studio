"use client";

/**
 * Shared media primitives for the generation flow (spec 03 §4, §9; contracts C12).
 *
 * Feature-agnostic on purpose: no feature imports, no fetching, no mock data.
 * A feature lane owns the source of truth and passes fully described states in;
 * these components only render it.
 *
 * MediaPreview renders every state the generation flow produces — loading
 * (skeleton), empty (teaching copy), error (with retry), ready (image or video)
 * — inside an aspect-ratio-locked frame so grids never jump while media loads.
 * Alt text is a required field on MediaSource, so a lane cannot render an
 * unnamed image.
 *
 * The retry affordance is a span with role="button" (mirroring the
 * SensitiveVeil pattern in components/Media.tsx): these frames are routinely
 * nested inside card <button>s and <Link>s in feature lanes, and a nested
 * native <button> would be invalid HTML and break hydration.
 */

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";

/** One piece of generated media. `alt` is required — never render unnamed media. */
export type MediaSource = {
  kind: "image" | "video";
  src: string;
  /** Human description of what this shows; used as img alt / video aria-label. */
  alt: string;
  /** Optional poster frame for videos. */
  poster?: string;
};

/** Everything MediaPreview can show. Lanes map their fetch/job state onto this. */
export type MediaPreviewState =
  | { phase: "loading" }
  | { phase: "empty"; title?: string; body?: string }
  | { phase: "error"; message?: string; onRetry?: () => void }
  | { phase: "ready"; media: MediaSource };

export type MediaPreviewProps = {
  state: MediaPreviewState;
  /** CSS aspect-ratio value locking the frame, e.g. "16 / 9". Default "1 / 1". */
  ratio?: string;
  /** How the media fills the frame. Default "cover". */
  fit?: "cover" | "contain";
  /** Frame corner rounding; "none" when the parent already clips. Default "md". */
  rounded?: "none" | "sm" | "md" | "lg";
  className?: string;
  /** Root test id; derived ids get dot suffixes (.loading/.empty/.retry/.image/.video). */
  testId?: string;
};

const ROUNDING: Record<NonNullable<MediaPreviewProps["rounded"]>, string> = {
  none: "",
  sm: "rounded-[8px]",
  md: "rounded-[10px]",
  lg: "rounded-[12px]",
};

const DEFAULT_EMPTY = {
  title: "Nothing here yet",
  body: "Generated media will appear here once it is ready.",
};

export function MediaPreview({
  state,
  ratio = "1 / 1",
  fit = "cover",
  rounded = "md",
  className = "",
  testId,
}: MediaPreviewProps) {
  return (
    <div
      data-testid={testId}
      className={`relative overflow-hidden bg-surface-2 ${ROUNDING[rounded]} ${className}`}
      style={{ aspectRatio: ratio }}
    >
      {/* Skeleton sits under everything: pixels cover it as they arrive, so a
          cached image never needs JS to reveal itself. */}
      <div className="skeleton absolute inset-0" aria-hidden="true" />
      <StateBody state={state} fit={fit} testId={testId} />
    </div>
  );
}

function StateBody({
  state,
  fit,
  testId,
}: {
  state: MediaPreviewState;
  fit: "cover" | "contain";
  testId?: string;
}) {
  if (state.phase === "loading") {
    return (
      <span
        role="status"
        data-testid={testId ? `${testId}.loading` : undefined}
        className="sr-only"
      >
        Loading preview
      </span>
    );
  }
  if (state.phase === "empty") {
    return (
      <div
        role="status"
        data-testid={testId ? `${testId}.empty` : undefined}
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface-2 px-4 text-center"
      >
        <Icon name="image" size={20} className="text-muted" />
        <p className="text-[13px] font-semibold text-ink-soft">
          {state.title ?? DEFAULT_EMPTY.title}
        </p>
        <p className="text-[12px] leading-snug text-muted">
          {state.body ?? DEFAULT_EMPTY.body}
        </p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div
        role="alert"
        data-testid={testId ? `${testId}.error` : undefined}
        className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-danger-soft px-4 text-center"
      >
        <Icon name="alert" size={18} className="text-danger" />
        <p className="text-[12.5px] font-semibold text-ink">
          {state.message ?? "This preview could not be loaded."}
        </p>
        {state.onRetry && (
          <RetryAffordance
            label="Try again"
            onRetry={state.onRetry}
            testId={testId ? `${testId}.retry` : undefined}
          />
        )}
      </div>
    );
  }
  return <LoadedMedia key={state.media.src} media={state.media} fit={fit} testId={testId} />;
}

function LoadedMedia({
  media,
  fit,
  testId,
}: {
  media: MediaSource;
  fit: "cover" | "contain";
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const objectClass = fit === "contain" ? "object-contain" : "object-cover";

  if (failed) {
    return (
      <div
        role="alert"
        className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-danger-soft px-4 text-center"
      >
        <Icon name="alert" size={18} className="text-danger" />
        <p className="text-[12.5px] font-semibold text-ink">
          This preview could not be loaded.
        </p>
        <RetryAffordance
          label="Try again"
          onRetry={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
          testId={testId ? `${testId}.retry` : undefined}
        />
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      // Keyed remount makes a retry re-request the source from scratch.
      <video
        key={attempt}
        src={media.src}
        poster={media.poster}
        controls
        playsInline
        preload="metadata"
        aria-label={media.alt}
        onError={() => setFailed(true)}
        data-testid={testId ? `${testId}.video` : undefined}
        className={`relative size-full ${objectClass}`}
      />
    );
  }

  return (
    <img
      key={attempt}
      src={media.src}
      alt={media.alt}
      loading="lazy"
      onError={() => setFailed(true)}
      data-testid={testId ? `${testId}.image` : undefined}
      className={`relative size-full ${objectClass}`}
    />
  );
}

/**
 * Retry control rendered as a span with role="button": MediaPreview frames are
 * nested inside card buttons/links in feature lanes, and a nested native
 * <button> would be invalid HTML (same reasoning as components/Media.tsx).
 * Still fully keyboard operable.
 */
function RetryAffordance({
  label,
  onRetry,
  testId,
}: {
  label: string;
  onRetry: () => void;
  testId?: string;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid={testId}
      onClick={onRetry}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onRetry();
        }
      }}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-border-strong bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink shadow-card transition-colors hover:bg-surface-2"
    >
      <Icon name="refresh" size={13} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* VersionStrip                                                        */
/* ------------------------------------------------------------------ */

/** One immutable version in the history strip. */
export type VersionThumb = {
  id: string;
  /** Short human label, e.g. "v3" or "Today, 14:02". */
  label: string;
  /** Optional secondary line, e.g. what changed. */
  caption?: string;
  /** Thumbnail state; each thumb shows its own loading/error/empty frame. */
  state: MediaPreviewState;
};

export type VersionStripProps = {
  versions: VersionThumb[];
  /** Currently selected version id (controlled). */
  selectedId: string | null;
  /** Omit for a read-only strip (no selection affordance). */
  onSelect?: (versionId: string) => void;
  loading?: boolean;
  error?: { message: string; onRetry?: () => void } | null;
  emptyState?: { title?: string; body: string };
  heading?: string;
  className?: string;
  /** Root test id, e.g. "character.version" → "character.version.select-0". */
  testId: string;
};

/**
 * Horizontal strip of version thumbnails with a controlled selected state and
 * an immutable-history feel: the strip only ever shows what the lane passes,
 * offers no delete/overwrite affordance, and states in its caption that
 * earlier versions stay put.
 */
export function VersionStrip({
  versions,
  selectedId,
  onSelect,
  loading = false,
  error = null,
  emptyState,
  heading = "Version history",
  className = "",
  testId,
}: VersionStripProps) {
  return (
    <section
      aria-label={heading}
      data-testid={testId}
      className={`flex flex-col gap-2.5 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="history" size={15} className="text-muted" />
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
          {heading}
        </h3>
        <span className="text-[12px] text-muted">
          Earlier versions stay here — nothing is overwritten.
        </span>
      </div>

      {loading ? (
        <div
          role="status"
          data-testid={`${testId}.loading`}
          aria-label="Loading versions"
          className="flex gap-3 overflow-hidden"
        >
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              aria-hidden="true"
              className="flex w-24 shrink-0 flex-col gap-1.5 rounded-[10px] border border-border bg-raised p-1.5"
            >
              <div className="skeleton aspect-square w-full rounded-[8px]" />
              <div className="skeleton h-3 w-10 rounded" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div
          role="alert"
          data-testid={`${testId}.error`}
          className="flex flex-wrap items-center gap-3 rounded-[10px] border border-danger/30 bg-danger-soft px-3.5 py-3"
        >
          <Icon name="alert" size={16} className="text-danger" />
          <p className="flex-1 text-[13px] text-ink">{error.message}</p>
          {error.onRetry && (
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              onClick={error.onRetry}
              data-testid={`${testId}.retry`}
            >
              Try again
            </Button>
          )}
        </div>
      ) : versions.length === 0 ? (
        <div
          data-testid={`${testId}.empty`}
          className="flex flex-col items-center gap-1 rounded-[10px] border border-dashed border-border-strong bg-surface px-6 py-7 text-center"
        >
          <p className="text-[13px] font-bold text-ink">
            {emptyState?.title ?? "No versions yet"}
          </p>
          <p className="max-w-sm text-[12.5px] text-muted">
            {emptyState?.body ?? "Generated versions will line up here."}
          </p>
        </div>
      ) : (
        <ul className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
          {versions.map((version, index) => {
            const selected = version.id === selectedId;
            const frameClass = `flex w-24 shrink-0 flex-col gap-1.5 rounded-[10px] border p-1.5 text-left ${
              selected
                ? "border-primary bg-primary-soft"
                : `border-border bg-raised ${onSelect ? "transition-colors hover:border-muted" : ""}`
            }`;
            return (
              <li key={version.id}>
                {onSelect ? (
                  <button
                    type="button"
                    aria-label={version.label}
                    aria-pressed={selected}
                    onClick={() => onSelect(version.id)}
                    data-testid={`${testId}.select-${index}`}
                    className={frameClass}
                  >
                    <ThumbBody version={version} selected={selected} />
                  </button>
                ) : (
                  <div
                    aria-label={version.label}
                    aria-current={selected ? "true" : undefined}
                    data-testid={`${testId}.select-${index}`}
                    className={frameClass}
                  >
                    <ThumbBody version={version} selected={selected} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Thumbnail + label + optional caption shared by the selectable and read-only thumbs. */
function ThumbBody({ version, selected }: { version: VersionThumb; selected: boolean }) {
  return (
    <>
      <MediaPreview
        state={version.state}
        ratio="1 / 1"
        fit="cover"
        rounded="sm"
        className="w-full"
      />
      <span className="flex items-center gap-1 px-0.5 text-[12px] font-semibold text-ink">
        {selected && <Icon name="check" size={13} className="text-primary" />}
        {version.label}
      </span>
      {version.caption && (
        <span className="px-0.5 text-[11px] leading-tight text-muted">
          {version.caption}
        </span>
      )}
    </>
  );
}
