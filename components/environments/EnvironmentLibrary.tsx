"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { MenuItem } from "@/components/library/MenuItem";
import {
  CARD_CHECK,
  CARD_FALLBACK,
  CARD_MEDIA,
  CARD_MENU_BTN,
  CARD_INFO,
  CARD_INFO_META,
  CARD_INFO_REVEAL,
  CARD_SELECTED,
  CARD_SHELL,
  CARD_STAR,
  CARD_STAR_GHOST,
  CARD_STAR_ON,
  CARD_TITLE,
} from "@/components/library/card-styles";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LinkButton,
  formatDate,
  useToast,
} from "@/components/ui";
import {
  environmentApprovalState,
  removeEnvironments,
  toggleEnvironmentFavorite,
  useEnvironments,
  type EnvironmentCanonEntry,
} from "@/components/environments/environment-store";
import type { SortMode } from "@/lib/library-selectors";

/**
 * The environment library (spec 07): server-of-truth is the local canon store;
 * this page owns search, favourites, manage mode and the teaching empty
 * state. Cards open the detail page at /environments/[id]; creation with
 * plate generation lives at /environments/new. Legacy Places rows were
 * imported once by the store and carry a small "Imported" chip.
 */

const CAPTION =
  "Reusable places with a canonical plate, structured lighting and derived views — the anchor every scene returns to.";

function metaLine(entry: EnvironmentCanonEntry): string {
  return [entry.zone, entry.lighting, entry.timeOfDay]
    .filter(Boolean)
    .join(" · ");
}

export function EnvironmentLibrary() {
  const toast = useToast();
  const { environments, ready } = useEnvironments();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [favouritesOnly, setFavouritesOnly] = useState(false);

  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<EnvironmentCanonEntry[] | null>(null);

  const favouriteCount = environments.filter((entry) => entry.favorite).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return environments
      .filter((entry) => !favouritesOnly || entry.favorite)
      .filter((entry) =>
        q
          ? [
              entry.name,
              entry.description,
              entry.zone,
              entry.lighting,
              entry.timeOfDay,
              entry.weather,
              entry.palette,
            ].some((text) => text?.toLowerCase().includes(q))
          : true,
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "oldest"
            ? a.updatedAt - b.updatedAt
            : b.updatedAt - a.updatedAt,
      );
  }, [environments, query, favouritesOnly, sort]);

  function exitManage() {
    setManage(false);
    setSelected(new Set());
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmDelete() {
    if (!deleteTargets?.length) return;
    const ids = deleteTargets.map((entry) => entry.id);
    removeEnvironments(ids);
    toast.push(`${ids.length} environment${ids.length === 1 ? "" : "s"} deleted.`, "success");
    setDeleteTargets(null);
    setSelected(new Set());
  }

  const deleteBody = deleteTargets
    ? `This deletes ${deleteTargets.length === 1 ? `“${deleteTargets[0].name}”` : `${deleteTargets.length} environments`} from the canon library. Scenes that already rendered keep their frames.`
    : "";

  return (
    <LibraryShell
      title="Environments"
      caption={ready ? CAPTION : " "}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search names, zones, lighting, palettes"
      sort={sort}
      onSortChange={setSort}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => setFavouritesOnly((v) => !v)}
      cta={
        !ready || environments.length > 0 ? (
          <LinkButton href="/environments/new" icon="plus" data-testid="environments.library.new">
            New environment
          </LinkButton>
        ) : null
      }
      manage={manage}
      onToggleManage={() => (manage ? exitManage() : setManage(true))}
      loading={!ready}
      empty={
        ready && environments.length === 0 ? (
          <div data-testid="environments.library.empty">
            <EmptyState
              icon="home"
              title="No environments yet"
              body="Create an environment so every scene can return to the same place — one canonical plate, structured lighting, and optional wide, entrance, day and night views."
              action={
                <LinkButton href="/environments/new" icon="plus">
                  Create your first environment
                </LinkButton>
              }
            />
          </div>
        ) : ready && visible.length === 0 ? (
          <div data-testid="environments.library.no-matches">
            <EmptyState
              icon="search"
              title="No matches"
              body="Try a different word, or clear the filters to see every environment."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setFavouritesOnly(false);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : null
      }
      manageBar={
        <>
          <span className="text-[12.5px] font-semibold text-ink-soft">
            {selected.size} selected
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon="check"
            disabled={visible.length === 0}
            onClick={() =>
              setSelected(
                visible.every((entry) => selected.has(entry.id))
                  ? new Set()
                  : new Set(visible.map((entry) => entry.id)),
              )
            }
          >
            {visible.length > 0 && visible.every((entry) => selected.has(entry.id))
              ? "Deselect all"
              : "Select all"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="star"
            disabled={selected.size === 0}
            onClick={() => {
              selected.forEach((id) => {
                const entry = environments.find((candidate) => candidate.id === id);
                if (entry && !entry.favorite) toggleEnvironmentFavorite(id);
              });
              toast.push("Added to favourites.", "success");
            }}
          >
            Favourite
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={selected.size === 0}
            onClick={() => setDeleteTargets(environments.filter((entry) => selected.has(entry.id)))}
          >
            Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={exitManage}>
            Done
          </Button>
        </>
      }
    >
      {ready && visible.length > 0 && (
        <div
          data-testid="environments.library.grid"
          className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
        >
          {!manage && (
            <Link
              href="/environments/new"
              aria-label="New environment"
              data-testid="environments.library.new-tile"
              className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border bg-surface text-muted transition-colors hover:border-primary hover:bg-primary-soft/40 hover:text-primary"
            >
              <Icon name="plus" size={22} />
              <span className="text-[13px] font-semibold">New environment</span>
            </Link>
          )}
          {visible.map((entry, index) => {
            const isSelected = selected.has(entry.id);
            const approved = environmentApprovalState(entry) === "approved";
            return (
              <div
                key={entry.id}
                data-testid={`environments.library.card.${index}`}
                className={`${CARD_SHELL} ${manage && isSelected ? CARD_SELECTED : "border-border"}`}
              >
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${entry.name}`}
                    onClick={() => toggleSelected(entry.id)}
                    className="block w-full"
                  >
                    <EnvironmentPlate entry={entry} />
                  </button>
                ) : (
                  <Link
                    href={`/environments/${entry.id}`}
                    aria-label={`Open ${entry.name} details`}
                    className="block"
                  >
                    <EnvironmentPlate entry={entry} />
                  </Link>
                )}

                {/* Info scrim — always-on title, hover reveals the description */}
                <div className={CARD_INFO}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={CARD_TITLE}>{entry.name}</span>
                    {approved && (
                      <span className="shrink-0">
                        <Badge tone="success">Canon</Badge>
                      </span>
                    )}
                  </div>
                  <div className={CARD_INFO_META}>
                    <span className="min-w-0 truncate">{metaLine(entry) || "\u00a0"}</span>
                    <span className="shrink-0">{formatDate(entry.updatedAt)}</span>
                  </div>
                  <div className={CARD_INFO_REVEAL}>
                    <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-soft">
                      {entry.description || "No description yet."}
                    </p>
                  </div>
                </div>

                {/* Overlay controls */}
                {manage ? (
                  <span role="checkbox" aria-checked={isSelected} className={CARD_CHECK}>
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={entry.favorite ? "Remove favourite" : "Add favourite"}
                    onClick={() => toggleEnvironmentFavorite(entry.id)}
                    className={`${CARD_STAR} ${entry.favorite ? CARD_STAR_ON : CARD_STAR_GHOST}`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}
                {!manage && (
                  <button
                    type="button"
                    aria-label={`Actions for ${entry.name}`}
                    aria-expanded={menuId === entry.id}
                    onClick={() => setMenuId((id) => (id === entry.id ? null : entry.id))}
                    className={CARD_MENU_BTN}
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
                {menuId === entry.id && !manage && (
                  <>
                    <button
                      type="button"
                      aria-label="Close menu"
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setMenuId(null)}
                    />
                    <div
                      role="menu"
                      className="absolute right-2.5 top-11 z-20 w-52 rounded-[14px] border border-border bg-raised p-1.5 shadow-lift"
                    >
                      <MenuItem
                        icon="home"
                        label="Open details"
                        href={`/environments/${entry.id}`}
                        onDone={() => setMenuId(null)}
                      />
                      <MenuItem
                        icon="star"
                        label={entry.favorite ? "Remove favourite" : "Add favourite"}
                        onSelect={() => {
                          toggleEnvironmentFavorite(entry.id);
                          setMenuId(null);
                        }}
                      />
                      <div className="my-1 h-px bg-border" />
                      <MenuItem
                        icon="trash"
                        label="Delete"
                        tone="danger"
                        onSelect={() => {
                          setDeleteTargets([entry]);
                          setMenuId(null);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTargets)}
        title={
          deleteTargets && deleteTargets.length > 1
            ? `Delete ${deleteTargets.length} environments?`
            : `Delete “${deleteTargets?.[0]?.name ?? ""}”?`
        }
        body={deleteBody}
        onCancel={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
      />
    </LibraryShell>
  );
}

/** Canonical plate with a teaching placeholder tile when none is set yet. */
function EnvironmentPlate({ entry }: { entry: EnvironmentCanonEntry }) {
  if (entry.plateUrl) {
    return (
      <MediaFrame
        src={entry.plateUrl}
        alt={`${entry.name} canonical plate`}
        ratio="16/10"
        rounded="rounded-t-[15px]"
        className={CARD_MEDIA}
      />
    );
  }
  return (
    <div className={`${CARD_FALLBACK} aspect-[16/10] rounded-[15px]`}>
      <Badge>No plate yet</Badge>
    </div>
  );
}
