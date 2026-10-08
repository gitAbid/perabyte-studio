"use client";

import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import type { LibraryItemKind, LibrarySortMode } from "@/lib/library/read-model";

export type LibraryKindOption = {
  value: LibraryItemKind | "all";
  label: string;
};

/**
 * Filter chips for one library section (spec 16 §5): kind chips (All /
 * Characters / Environments or All / Images / Videos), a favorites-only
 * toggle, and a sort control. Every control keeps its visible label — no
 * icon-only or hover-only filters (UX spec §9).
 */
export function LibraryFilters({
  kindOptions,
  kind,
  onKindChange,
  favoritesOnly,
  onToggleFavorites,
  favoritesOnlyLabel,
  sort,
  onSortChange,
  sectionName,
}: {
  kindOptions: LibraryKindOption[];
  kind: LibraryItemKind | "all";
  onKindChange(kind: LibraryItemKind | "all"): void;
  favoritesOnly: boolean;
  onToggleFavorites(): void;
  /** Human label for the favorites toggle, e.g. "Favorites (4)". */
  favoritesOnlyLabel: string;
  sort: LibrarySortMode;
  onSortChange(sort: LibrarySortMode): void;
  /** Section name for accessible labels, e.g. "Creative". */
  sectionName: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label={`Filter ${sectionName.toLowerCase()} items by type`}
        data-testid="library.filter.kind"
        className="inline-flex flex-wrap items-center gap-1.5"
      >
        {kindOptions.map((option) => {
          const active = option.value === kind;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              data-testid={`library.filter.${option.value}`}
              onClick={() => onKindChange(option.value)}
              className={`inline-flex items-center rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                active
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <Button
        variant="secondary"
        size="sm"
        icon="star"
        aria-pressed={favoritesOnly}
        data-testid="library.filter.favorites"
        onClick={onToggleFavorites}
      >
        {favoritesOnlyLabel}
      </Button>

      <label className="ml-auto flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted">
        Order
        <select
          value={sort}
          onChange={(event) => onSortChange(event.target.value as LibrarySortMode)}
          aria-label={`Sort ${sectionName.toLowerCase()} items`}
          data-testid="library.filter.sort"
          className="h-9 rounded-[5px] border border-border bg-raised px-2.5 text-[12px] font-medium normal-case tracking-normal text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </label>
    </div>
  );
}

/** Small count chip used next to group headings. Kept beside the filters file so headings share one style. */
export function LibraryCountChip({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
      <Icon name="grid" size={11} aria-hidden="true" />
      {count}
    </span>
  );
}
