import Link from "next/link";
import { Icon } from "@/components/Icon";

/* ------------------------------------------------------------------ */
/* WorkspaceContextChip — CONTRACTS-FROZEN C2 / UX spec §2             */
/* ------------------------------------------------------------------ */
/* Compact reminder of which workspace is active and how it is rated.  */
/* Purely prop-driven: no fetching, no store access. Renders as a link */
/* when `href` is given, a button when only `onClick` is given, and a  */
/* plain chip otherwise.                                               */

export type WorkspaceRating = "General" | "Mature" | "Adult";

const RATING_TONES: Record<WorkspaceRating, string> = {
  General: "bg-success-soft text-success",
  Mature: "bg-warning-soft text-warning",
  Adult: "bg-danger-soft text-danger",
};

const RATING_NOTES: Record<WorkspaceRating, string> = {
  General: "Safe for general audiences",
  Mature: "May include mature themes",
  Adult: "Intended for adults only",
};

export interface WorkspaceContextChipProps {
  /** Active workspace name (short — the chip truncates long names). */
  name: string;
  /** Workspace content rating (CONTRACTS-FROZEN C2 vocabulary). */
  rating: WorkspaceRating;
  /** When set, the whole chip is a link (e.g. to the workspace page). */
  href?: string;
  /** When set (without href), the whole chip is a button. */
  onClick?: () => void;
  /** Stable test id for this stateful surface (feature.entity.action). */
  testId?: string;
  className?: string;
}

export function WorkspaceContextChip({
  name,
  rating,
  href,
  onClick,
  testId = "workspace.context",
  className = "",
}: WorkspaceContextChipProps) {
  const content = (
    <>
      <Icon name="layers" size={14} className="shrink-0 text-muted" />
      <span className="sr-only">Workspace: </span>
      <span className="max-w-[180px] truncate font-semibold text-ink">
        {name}
      </span>
      <span
        title={RATING_NOTES[rating]}
        className={`shrink-0 rounded-[4px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] ${RATING_TONES[rating]}`}
      >
        {rating}
      </span>
    </>
  );

  const shell = `inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-raised px-3 py-1.5 text-[12px] transition-colors ${className}`;

  if (href) {
    return (
      <Link
        href={href}
        data-testid={testId}
        className={`${shell} hover:border-muted focus-visible:outline-primary`}
      >
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className={`${shell} cursor-pointer hover:border-muted`}
      >
        {content}
      </button>
    );
  }

  return (
    <span data-testid={testId} className={shell}>
      {content}
    </span>
  );
}
