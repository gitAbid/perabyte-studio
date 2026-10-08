"use client";

/**
 * Variant comparison primitives for the generation flow (spec 03 §4; contracts C12).
 *
 * Feature-agnostic: lanes pass candidates in and receive ids back. Selection is
 * fully controlled (`selectedId` + `onSelect`), so a lane's server state stays
 * the only source of truth — this component never mutates anything itself and
 * performs no fetching.
 *
 * VariantGrid renders the universal generation card: preview on top, human
 * label plus optional highlight badge, then [Use This] plus compare/refine
 * affordances. Lanes can add feature actions (Favorite, Delete draft…) via
 * `cardActions`. CompareModal is a plain dialog (Esc closes, focus is trapped
 * and restored) with a side-by-side or drag-slider comparison of two
 * candidates.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, EmptyState } from "@/components/ui";
import { MediaPreview, type MediaPreviewState } from "./media";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger";

/** One candidate in the grid. `id` is the only thing handed back to the lane. */
export type VariantCandidate = {
  id: string;
  /** Human label, e.g. "Variant 2". Never a model or provider id. */
  label: string;
  /** Card preview: loading / empty / error / ready — see MediaPreviewState. */
  preview: MediaPreviewState;
  /** Short highlight, e.g. "Recommended". */
  badge?: string;
  badgeTone?: BadgeTone;
  /** Optional one-line human caption under the label. */
  caption?: string;
  disabled?: boolean;
};

export type VariantGridProps = {
  candidates: VariantCandidate[];
  /** Controlled selection; null when nothing is chosen yet. */
  selectedId: string | null;
  onSelect?: (candidateId: string) => void;
  /** Per-card compare affordance; omit to hide it (lane owns the modal). */
  onCompare?: (candidateId: string) => void;
  /** Per-card refine affordance ("Change Something"); omit to hide it. */
  onRefine?: (candidateId: string) => void;
  /** Max columns on desktop; tablet/mobile always step down. Default 3. */
  columns?: 2 | 3 | 4;
  /** Aspect ratio applied to every card preview, e.g. "16 / 9". Default "1 / 1". */
  ratio?: string;
  loading?: boolean;
  error?: { message: string; onRetry?: () => void } | null;
  /** Empty copy must teach the next action (spec 03 §5). */
  emptyState?: { title?: string; body: string; action?: ReactNode };
  /** Extra lane actions rendered after refine, e.g. Favorite / Delete draft. */
  cardActions?: (candidate: VariantCandidate) => ReactNode;
  ariaLabel?: string;
  className?: string;
  /** Root test id, e.g. "variant-grid" → "variant-grid.card.select-0". */
  testId: string;
};

const COLUMN_CLASSES: Record<NonNullable<VariantGridProps["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function VariantGrid({
  candidates,
  selectedId,
  onSelect,
  onCompare,
  onRefine,
  columns = 3,
  ratio = "1 / 1",
  loading = false,
  error = null,
  emptyState,
  cardActions,
  ariaLabel = "Generated variants",
  className = "",
  testId,
}: VariantGridProps) {
  const gridClass = `grid grid-cols-1 gap-4 ${COLUMN_CLASSES[columns]}`;

  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading variants"
        data-testid={`${testId}.loading`}
        className={`${gridClass} ${className}`}
      >
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="overflow-hidden rounded-[12px] border border-border bg-raised shadow-card"
          >
            <div className="skeleton w-full" style={{ aspectRatio: ratio }} />
            <div className="space-y-2 p-4">
              <div className="skeleton h-3.5 w-24 rounded" />
              <div className="skeleton h-3 w-16 rounded" />
              <div className="skeleton h-9 w-full rounded-[7px]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" data-testid={`${testId}.error`} className={className}>
        <EmptyState
          icon="alert"
          title="Variants could not load"
          body={error.message}
          action={
            error.onRetry ? (
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                onClick={error.onRetry}
                data-testid={`${testId}.retry`}
              >
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div data-testid={`${testId}.empty`} className={className}>
        <EmptyState
          icon="sparkle"
          title={emptyState?.title ?? "No variants yet"}
          body={emptyState?.body ?? "Start a generation and the candidates will appear here."}
          action={emptyState?.action}
        />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={`${testId}.grid`}
      className={`${gridClass} ${className}`}
    >
      {candidates.map((candidate, index) => (
        <VariantCard
          key={candidate.id}
          candidate={candidate}
          index={index}
          selected={candidate.id === selectedId}
          ratio={ratio}
          onSelect={onSelect}
          onCompare={onCompare}
          onRefine={onRefine}
          cardActions={cardActions}
          testId={testId}
        />
      ))}
    </div>
  );
}

function VariantCard({
  candidate,
  index,
  selected,
  ratio,
  onSelect,
  onCompare,
  onRefine,
  cardActions,
  testId,
}: {
  candidate: VariantCandidate;
  index: number;
  selected: boolean;
  ratio: string;
  onSelect?: (candidateId: string) => void;
  onCompare?: (candidateId: string) => void;
  onRefine?: (candidateId: string) => void;
  cardActions?: (candidate: VariantCandidate) => ReactNode;
  testId: string;
}) {
  return (
    <article
      data-testid={`${testId}.card.${index}`}
      className={`overflow-hidden rounded-[12px] border bg-raised shadow-card transition-colors ${
        selected ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted"
      } ${candidate.disabled ? "opacity-60" : ""}`}
    >
      <MediaPreview state={candidate.preview} ratio={ratio} fit="cover" rounded="none" />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-ink">{candidate.label}</h3>
          {candidate.badge && (
            <Badge tone={candidate.badgeTone ?? "primary"}>{candidate.badge}</Badge>
          )}
        </div>
        {candidate.caption && (
          <p className="text-[12.5px] leading-snug text-muted">{candidate.caption}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {onSelect && (
            <Button
              size="sm"
              variant={selected ? "secondary" : "primary"}
              icon={selected ? "check" : undefined}
              aria-pressed={selected}
              disabled={candidate.disabled}
              onClick={() => onSelect(candidate.id)}
              data-testid={`${testId}.card.select-${index}`}
            >
              {selected ? "Selected" : "Use This"}
            </Button>
          )}
          {onCompare && (
            <Button
              size="sm"
              variant="ghost"
              icon="layers"
              aria-label={`Compare ${candidate.label}`}
              disabled={candidate.disabled}
              onClick={() => onCompare(candidate.id)}
              data-testid={`${testId}.card.compare-${index}`}
            >
              Compare
            </Button>
          )}
          {onRefine && (
            <Button
              size="sm"
              variant="ghost"
              icon="pen"
              aria-label={`Refine ${candidate.label}`}
              disabled={candidate.disabled}
              onClick={() => onRefine(candidate.id)}
              data-testid={`${testId}.card.refine-${index}`}
            >
              Refine
            </Button>
          )}
          {cardActions?.(candidate)}
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* CompareModal                                                        */
/* ------------------------------------------------------------------ */

/** One side of a comparison; the same states as any card preview. */
export type CompareSide = {
  label: string;
  preview: MediaPreviewState;
};

export type CompareModalProps = {
  open: boolean;
  left: CompareSide | null;
  right: CompareSide | null;
  /** "side-by-side" (default) or "slider" (drag to reveal). */
  mode?: "side-by-side" | "slider";
  title?: string;
  /** Shared frame ratio for both sides, e.g. "16 / 9". Default "1 / 1". */
  ratio?: string;
  onClose: () => void;
  /** Root test id, e.g. "character.compare" → "character.compare.close". */
  testId: string;
};

/**
 * Two-candidate comparison with dialog semantics: aria-modal dialog, Esc to
 * close, Tab trapped inside, focus moved in on open and restored to the
 * invoker on close. Slider mode is a native range input, so it is fully
 * keyboard operable.
 */
export function CompareModal({
  open,
  left,
  right,
  mode = "side-by-side",
  title = "Compare variants",
  ratio = "1 / 1",
  onClose,
  testId,
}: CompareModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [sliderPercent, setSliderPercent] = useState(50);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    setSliderPercent(50);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open || !left || !right) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !(active instanceof Node && dialog.contains(active)))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className="flex max-h-[92vh] w-full max-w-3xl animate-fade-up flex-col gap-4 overflow-y-auto rounded-[14px] border border-border bg-raised p-5 shadow-lift"
      >
        <header className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-base font-bold text-ink">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            aria-label="Close comparison"
            onClick={onClose}
            data-testid={`${testId}.close`}
          >
            Close
          </Button>
        </header>

        {mode === "slider" ? (
          <div>
            <div
              className="relative overflow-hidden rounded-[10px] border border-border bg-surface-2"
              style={{ aspectRatio: ratio }}
            >
              <div className="absolute inset-0">
                <MediaPreview
                  state={left.preview}
                  ratio="auto"
                  fit="contain"
                  rounded="none"
                  className="size-full"
                  testId={`${testId}.left`}
                />
              </div>
              <div
                className="absolute inset-0"
                style={{ clipPath: `inset(0 0 0 ${sliderPercent}%)` }}
              >
                <MediaPreview
                  state={right.preview}
                  ratio="auto"
                  fit="contain"
                  rounded="none"
                  className="size-full"
                  testId={`${testId}.right`}
                />
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0"
                style={{ left: `${sliderPercent}%` }}
              >
                <div className="h-full w-0.5 -translate-x-1/2 bg-raised shadow-lift" />
              </div>
              <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-raised/90 px-2.5 py-1 text-[11px] font-bold text-ink shadow-card">
                {left.label}
              </span>
              <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-raised/90 px-2.5 py-1 text-[11px] font-bold text-ink shadow-card">
                {right.label}
              </span>
            </div>
            <label className="mt-3 flex items-center gap-3 text-[12px] font-semibold text-ink-soft">
              <span className="sr-only">Comparison position</span>
              <span aria-hidden="true">{left.label}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={sliderPercent}
                onChange={(event) => setSliderPercent(Number(event.target.value))}
                aria-label="Comparison position"
                aria-valuetext={`${sliderPercent}% ${right.label}`}
                data-testid={`${testId}.slider`}
                className="h-1.5 w-full flex-1 cursor-pointer accent-[var(--color-primary)]"
              />
              <span aria-hidden="true">{right.label}</span>
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              { side: left, key: "left" as const },
              { side: right, key: "right" as const },
            ].map(({ side, key }) => (
              <figure key={key} className="flex flex-col gap-2">
                <MediaPreview
                  state={side.preview}
                  ratio={ratio}
                  fit="contain"
                  rounded="md"
                  testId={`${testId}.${key}`}
                />
                <figcaption className="text-center text-[13px] font-semibold text-ink-soft">
                  {side.label}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
