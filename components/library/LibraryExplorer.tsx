"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { LibraryGrid } from "@/components/library/LibraryGrid";
import { LibraryFilters, type LibraryKindOption } from "@/components/library/LibraryFilters";
import { SearchBox } from "@/components/library/SearchBox";
import { LinkButton } from "@/components/ui";
import {
  flattenLibraryItems,
  readLibraryFavorites,
  resolveFavorite,
  selectLibraryItems,
  writeLibraryFavorites,
  type LibraryFavorites,
  type LibraryItemKind,
  type LibraryModel,
  type LibrarySection,
  type LibrarySortMode,
} from "@/lib/library/read-model";

/**
 * /library screen (spec 16 §6 primary screen format): Creative and Media
 * sections as top-level tabs, filter chips and search over the loaded set,
 * and one grid per group. Server data arrives preloaded via the read model —
 * this component only overlays browser-local favorites (documented Alpha
 * seam in lib/library/read-model.ts) and filters client-side.
 */

type GroupDef = {
  kind: LibraryItemKind;
  heading: string;
  blurb: string;
  icon: IconName;
  empty: { title: string; body: string; ctaHref: string; ctaLabel: string };
};

const SECTION_GROUPS: Record<LibrarySection, GroupDef[]> = {
  creative: [
    {
      kind: "character",
      heading: "Characters",
      blurb: "Faces and outfits your scenes share.",
      icon: "character",
      empty: {
        title: "No characters yet",
        body: "Create a character so PeraByte can keep their look consistent across every scene.",
        ctaHref: "/character",
        ctaLabel: "Create a character",
      },
    },
    {
      kind: "environment",
      heading: "Environments",
      blurb: "Places your scenes return to.",
      icon: "home",
      empty: {
        title: "No environments yet",
        body: "Add a place so every scene can come back to the same location.",
        ctaHref: "/locations",
        ctaLabel: "Add an environment",
      },
    },
  ],
  media: [
    {
      kind: "image",
      heading: "Images",
      blurb: "Still renders you have made.",
      icon: "image",
      empty: {
        title: "No images yet",
        body: "Generate your first image and it will be saved here automatically.",
        ctaHref: "/generate/image",
        ctaLabel: "Create an image",
      },
    },
    {
      kind: "video",
      heading: "Videos",
      blurb: "Motion renders you have made.",
      icon: "video",
      empty: {
        title: "No videos yet",
        body: "Generate your first video and it will be saved here automatically.",
        ctaHref: "/generate/video",
        ctaLabel: "Create a video",
      },
    },
  ],
};

const KIND_OPTIONS: Record<LibrarySection, LibraryKindOption[]> = {
  creative: [
    { value: "all", label: "All" },
    { value: "character", label: "Characters" },
    { value: "environment", label: "Environments" },
  ],
  media: [
    { value: "all", label: "All" },
    { value: "image", label: "Images" },
    { value: "video", label: "Videos" },
  ],
};

const SECTION_META: Record<LibrarySection, { label: string; icon: IconName; description: string }> = {
  creative: {
    label: "Creative",
    icon: "character",
    description: "Characters and environments — the reusable canon PeraByte keeps consistent.",
  },
  media: {
    label: "Media",
    icon: "image",
    description: "Every image and video you have generated, ready to reuse.",
  },
};

/** Group kind → the read-model array it renders. */
const KIND_TO_MODEL_KEY: Record<LibraryItemKind, "characters" | "environments" | "images" | "videos"> = {
  character: "characters",
  environment: "environments",
  image: "images",
  video: "videos",
};

export function LibraryExplorer({ model }: { model: LibraryModel }) {
  const [section, setSection] = useState<LibrarySection>("creative");
  const [kind, setKind] = useState<LibraryItemKind | "all">("all");
  const [text, setText] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sort, setSort] = useState<LibrarySortMode>("newest");
  const [favorites, setFavorites] = useState<LibraryFavorites>({});
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);

  // Adopt the browser-local favorites overlay after mount so the server
  // render and the first client render agree (no hydration mismatch); stars
  // reconcile a moment after first paint.
  useEffect(() => {
    setFavorites(readLibraryFavorites(window.localStorage));
    setFavoritesLoaded(true);
  }, []);

  // Persist overlay changes; the per-library stores stay untouched (post-Alpha seam).
  useEffect(() => {
    if (!favoritesLoaded) return;
    writeLibraryFavorites(window.localStorage, favorites);
  }, [favorites, favoritesLoaded]);

  const allItems = useMemo(() => flattenLibraryItems(model), [model]);
  const itemById = useMemo(() => new Map(allItems.map((item) => [item.id, item])), [allItems]);

  const groups = SECTION_GROUPS[section];
  const baseQuery = { text, favoritesOnly, sort, favorites };

  const groupViews = useMemo(
    () =>
      groups.map((group) => {
        const items = model[KIND_TO_MODEL_KEY[group.kind]];
        const visible = selectLibraryItems(items, { ...baseQuery, kind: "all" });
        return { group, items, visible };
      }),
    // Every field of baseQuery is a primitive and listed below; model/groups
    // drive identity otherwise.
    [groups, model, text, favoritesOnly, sort, favorites],
  );

  const sectionItems = useMemo(
    () =>
      section === "creative" ? [...model.characters, ...model.environments] : [...model.images, ...model.videos],
    [section, model],
  );

  const sectionTotals = useMemo(
    () => ({
      total: sectionItems.length,
      visible: groupViews.reduce((sum, group) => sum + group.visible.length, 0),
    }),
    [sectionItems, groupViews],
  );

  const favoriteCount = useMemo(
    () => sectionItems.filter((item) => resolveFavorite(item, favorites)).length,
    [sectionItems, favorites],
  );

  function switchSection(next: LibrarySection) {
    setSection(next);
    const validKinds = KIND_OPTIONS[next].map((option) => option.value);
    if (!validKinds.includes(kind)) setKind("all");
  }

  function toggleFavorite(id: string) {
    const item = itemById.get(id);
    if (!item) return;
    const current = resolveFavorite(item, favorites);
    setFavorites((prev) => ({ ...prev, [id]: !current }));
  }

  function clearFilters() {
    setText("");
    setKind("all");
    setFavoritesOnly(false);
  }

  const filtersActive = text.trim() !== "" || kind !== "all" || favoritesOnly;
  const nothingVisible = sectionTotals.visible === 0 && sectionTotals.total > 0;

  return (
    <div
      data-testid="library.root"
      className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-14 pt-6 sm:px-6 lg:px-10 lg:pt-9"
    >
      <header className="max-w-3xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
          Everything you have made
        </p>
        <h1 className="editorial-display mt-2 text-[30px] leading-tight text-ink sm:text-[38px]">
          Library
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          One place to find your characters, environments, images, and videos.
          Open any item to work with it where it lives.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-start">
        <div
          role="tablist"
          aria-label="Library sections"
          data-testid="library.tabs"
          className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-border bg-surface p-1"
        >
          {(Object.keys(SECTION_GROUPS) as LibrarySection[]).map((id) => {
            const meta = SECTION_META[id];
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="library-panel"
                id={`library-tab-${id}`}
                data-testid={`library.tab.${id}`}
                onClick={() => switchSection(id)}
                className={`inline-flex items-center gap-1.5 rounded-[9px] px-3.5 py-2 text-[13px] font-semibold transition-all ${
                  active ? "bg-primary-strong text-white shadow-sm" : "text-ink-soft hover:bg-raised"
                }`}
              >
                <Icon name={meta.icon} size={15} aria-hidden="true" />
                {meta.label}
              </button>
            );
          })}
        </div>
        <SearchBox value={text} onChange={setText} placeholder="Search titles, notes, and tags…" />
      </div>

      <div
        id="library-panel"
        role="tabpanel"
        aria-labelledby={`library-tab-${section}`}
        data-testid={`library.section.${section}`}
        className="mt-5 flex flex-col gap-5"
      >
        <p className="text-[12.5px] leading-relaxed text-muted">
          {SECTION_META[section].description}
        </p>

        <LibraryFilters
          kindOptions={KIND_OPTIONS[section]}
          kind={kind}
          onKindChange={setKind}
          favoritesOnly={favoritesOnly}
          onToggleFavorites={() => setFavoritesOnly((value) => !value)}
          favoritesOnlyLabel={
            favoritesOnly ? "Showing favorites" : `Favorites${favoriteCount > 0 ? ` (${favoriteCount})` : ""}`
          }
          sort={sort}
          onSortChange={setSort}
          sectionName={SECTION_META[section].label}
        />

        <p role="status" data-testid="library.results-count" className="text-[12px] text-muted">
          Showing {sectionTotals.visible} of {sectionTotals.total}{" "}
          {section === "creative" ? "creative items" : "media items"}
        </p>

        {nothingVisible ? (
          <EmptyState
            icon="search"
            title="No matches"
            body="Try a different word, or clear the filters to see everything in this section."
            action={
              filtersActive && (
                <button
                  type="button"
                  data-testid="library.clear-filters"
                  onClick={clearFilters}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-border-strong bg-raised px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                >
                  <Icon name="close" size={14} aria-hidden="true" />
                  Clear filters
                </button>
              )
            }
            testId="library.empty.no-matches"
          />
        ) : (
          groupViews
            .filter(({ group }) => kind === "all" || kind === group.kind)
            .map(({ group, items, visible }) => (
              <section
                key={group.kind}
                aria-labelledby={`library-heading-${group.kind}`}
                data-testid={`library.group.${group.kind}`}
                className="flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon name={group.icon} size={16} aria-hidden="true" className="text-muted" />
                    <h2
                      id={`library-heading-${group.kind}`}
                      className="text-[15px] font-bold tracking-[-0.01em] text-ink"
                    >
                      {group.heading}
                    </h2>
                    <span className="text-[12px] text-muted">
                      {visible.length} of {items.length}
                    </span>
                  </div>
                  <p className="text-[12px] text-muted">{group.blurb}</p>
                </div>

                {items.length === 0 ? (
                  <EmptyState
                    icon={group.icon}
                    title={group.empty.title}
                    body={group.empty.body}
                    action={
                      <LinkButton href={group.empty.ctaHref} icon="plus">
                        {group.empty.ctaLabel}
                      </LinkButton>
                    }
                    testId={`library.empty.${group.kind}`}
                  />
                ) : visible.length === 0 ? (
                  <EmptyState
                    icon="search"
                    title={`No ${group.heading.toLowerCase()} match your filters`}
                    body="Adjust the search or filters above to see more of what you have."
                    action={
                      filtersActive && (
                        <button
                          type="button"
                          data-testid={`library.clear-filters.${group.kind}`}
                          onClick={clearFilters}
                          className="inline-flex h-9 items-center gap-1.5 rounded-[7px] border border-border-strong bg-raised px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                        >
                          <Icon name="close" size={14} aria-hidden="true" />
                          Clear filters
                        </button>
                      )
                    }
                    testId={`library.empty.${group.kind}.filtered`}
                  />
                ) : (
                  <LibraryGrid
                    items={visible}
                    favorites={favorites}
                    onToggleFavorite={toggleFavorite}
                    testId={`library.grid.${group.kind}`}
                  />
                )}
              </section>
            ))
        )}
      </div>
    </div>
  );
}
