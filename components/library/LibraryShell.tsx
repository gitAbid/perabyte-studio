"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import type { SortMode } from "@/lib/library-selectors";

/**
 * Shared chrome for the three studio libraries (characters / images /
 * stories): header + controls + filters slot + manage bar + loading/empty
 * states. Deliberately dumb — pages own state, grids, and dialogs, and pass
 * their grid as children.
 */
export function LibraryShell({
  title,
  caption,
  query,
  onQueryChange,
  searchPlaceholder = "Search",
  sort,
  onSortChange,
  favouritesOnly,
  onToggleFavourites,
  filters,
  cta,
  manage,
  onToggleManage,
  manageBar,
  loading,
  loadingTiles = 6,
  empty,
  children,
}: {
  title: string;
  caption: string;
  query: string;
  onQueryChange(value: string): void;
  searchPlaceholder?: string;
  sort: SortMode;
  onSortChange(value: SortMode): void;
  favouritesOnly: boolean;
  onToggleFavourites(): void;
  filters?: ReactNode;
  cta: ReactNode;
  manage: boolean;
  onToggleManage(): void;
  manageBar?: ReactNode;
  loading: boolean;
  loadingTiles?: number;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1680px] px-4 pb-12 pt-6 sm:px-6 lg:px-10 lg:pt-9">
      <header className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Collection / Studio archive</p>
          <h1 className="mt-2 text-[34px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[44px]">{title}</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">{caption}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{cta}</div>
      </header>

      <div className="mt-5 flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-[420px]">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={`Search ${title.toLowerCase()}`}
            className="h-11 w-full rounded-[5px] border border-border bg-raised pl-10 pr-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
          />
        </div>

        <label className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted">
          Order
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortMode)}
            aria-label={`Sort ${title.toLowerCase()}`}
            className="h-10 rounded-[5px] border border-border bg-raised px-3 text-[12px] font-medium normal-case tracking-normal text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
          <Button
            variant="secondary"
            size="sm"
            icon="star"
            aria-pressed={favouritesOnly}
            onClick={onToggleFavourites}
          >
            {favouritesOnly ? "Showing favourites" : "Favourites"}
          </Button>
          <Button
            variant={manage ? "primary" : "secondary"}
            size="sm"
            icon="grid"
            aria-pressed={manage}
            onClick={onToggleManage}
          >
            {manage ? "Done managing" : "Manage"}
          </Button>
        </div>
      </div>

      {filters && <div className="mt-3 flex flex-wrap items-center gap-1.5">{filters}</div>}

      {manage && manageBar && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-primary/20 bg-primary-soft/35 px-3.5 py-3">
          {manageBar}
        </div>
      )}

      {loading ? (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: loadingTiles }).map((_, i) => (
            <div key={i} className="skeleton aspect-[4/5] rounded-[16px]" />
          ))}
        </div>
      ) : (
        <>
          {empty && <div className="mt-6">{empty}</div>}
          {children}
        </>
      )}
    </div>
  );
}
