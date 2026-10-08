"use client";

import { LibraryCard } from "@/components/library/LibraryCard";
import type { LibraryFavorites, LibraryItem } from "@/lib/library/read-model";

/**
 * Responsive card grid for one library group (UX spec §9: one column on
 * phones, more as space allows). Presentational only — the explorer owns
 * state and passes resolved favorites down.
 */
export function LibraryGrid({
  items,
  favorites,
  onToggleFavorite,
  testId,
}: {
  items: LibraryItem[];
  favorites: LibraryFavorites;
  onToggleFavorite(id: string): void;
  /** Stable test id for this grid, e.g. "library.grid.characters". */
  testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      data-testid={testId}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
    >
      {items.map((item) => (
        <li key={item.id}>
          <LibraryCard
            item={item}
            favorite={typeof favorites[item.id] === "boolean" ? favorites[item.id] : item.favorite}
            onToggleFavorite={onToggleFavorite}
          />
        </li>
      ))}
    </ul>
  );
}

/** Named loading state for the grid (spec 03 §3 — never an anonymous spinner). */
export function LibraryGridSkeleton({ testId = "library.loading", tiles = 4 }: { testId?: string; tiles?: number }) {
  return (
    <div
      data-testid={testId}
      aria-busy="true"
      role="status"
      aria-label="Loading the library"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
    >
      {Array.from({ length: tiles }).map((_, index) => (
        <div key={index} className="skeleton aspect-[3/4] rounded-[8px]" aria-hidden="true" />
      ))}
    </div>
  );
}
