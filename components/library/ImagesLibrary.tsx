"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { MenuItem } from "@/components/library/MenuItem";
import { TagEditorDialog } from "@/components/library/TagEditorDialog";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LinkButton,
  Segmented,
  useToast,
} from "@/components/ui";
import { isSensitiveAsset } from "@/lib/domain/models";
import { downloadMedia } from "@/lib/generation";
import {
  assetTags,
  collectAssetTags,
  selectMedia,
  type MediaFilter,
  type MediaLibraryState,
  type SortMode,
} from "@/lib/library-selectors";
import { removeAssets, toggleFavorite, updateAsset, useAssets } from "@/lib/store";
import type { Asset } from "@/lib/types";

/** Generation aspect keys → CSS ratios (fallback squares the tile). */
function aspectRatio(aspect: string | undefined): string {
  switch (aspect) {
    case "16:9":
      return "16/9";
    case "9:16":
      return "9/16";
    case "4:5":
      return "4/5";
    case "3:2":
      return "3/2";
    default:
      return "1/1";
  }
}

/**
 * The images & videos library: masonry grid over the server-backed asset
 * store (stories excluded — they live in /stories), with kind chips, search,
 * favourites, tags, and manage mode. Zero backend — it slices useAssets().
 */
export function ImagesLibrary() {
  const toast = useToast();
  const { assets, ready } = useAssets();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [kind, setKind] = useState<MediaFilter>("all");
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [tagTargets, setTagTargets] = useState<Asset[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const media = useMemo(
    () => assets.filter((a) => a.kind === "image" || a.kind === "video"),
    [assets],
  );
  const allTags = useMemo(() => collectAssetTags(media), [media]);
  const state: MediaLibraryState & { kind: MediaFilter } = {
    query,
    favouritesOnly,
    sort,
    activeTags,
    kind,
  };
  const visible = useMemo(() => selectMedia(media, state), [media, state]);

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

  function saveTags(targets: Asset[], tags: string[]) {
    targets.forEach((asset) =>
      updateAsset(asset.id, {
        meta: { ...asset.meta, ...(tags.length ? { tags } : { tags: [] }) },
      }),
    );
    toast.push(
      targets.length === 1 ? "Tags updated." : `Tags applied to ${targets.length} items.`,
      "success",
    );
    setTagTargets(null);
  }

  const favouriteCount = media.filter((a) => a.favorite).length;

  return (
    <LibraryShell
      title="Images & videos"
      caption={`${media.length} item${media.length === 1 ? "" : "s"} · ${favouriteCount} favorite${favouriteCount === 1 ? "" : "s"}`}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search titles and prompts"
      sort={sort}
      onSortChange={setSort}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => setFavouritesOnly((v) => !v)}
      cta={
        <LinkButton href="/generate/image" icon="plus">
          New image
        </LinkButton>
      }
      manage={manage}
      onToggleManage={() => (manage ? exitManage() : setManage(true))}
      loading={!ready}
      loadingTiles={8}
      empty={
        ready && media.length === 0 ? (
          <EmptyState
            icon="image"
            title="Nothing here yet"
            body="Generate your first image or video and it will appear here, saved automatically."
            action={
              <LinkButton href="/generate/image" icon="sparkle">
                Create something
              </LinkButton>
            }
          />
        ) : ready && visible.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            body="Try a different word, or clear the filters to see everything."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setActiveTags([]);
                  setFavouritesOnly(false);
                  setKind("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : null
      }
      filters={
        <>
          <Segmented
            ariaLabel="Filter by type"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "All" },
              { value: "image", label: "Images" },
              { value: "video", label: "Videos" },
            ]}
          />
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={activeTags.includes(tag)}
              onClick={() =>
                setActiveTags((prev) =>
                  prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                )
              }
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                activeTags.includes(tag)
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              {tag}
            </button>
          ))}
        </>
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
                visible.every((a) => selected.has(a.id))
                  ? new Set()
                  : new Set(visible.map((a) => a.id)),
              )
            }
          >
            {visible.length > 0 && visible.every((a) => selected.has(a.id))
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
                const asset = media.find((a) => a.id === id);
                if (asset && !asset.favorite) toggleFavorite(id);
              });
              toast.push("Added to favourites.", "success");
            }}
          >
            Favourite
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="chip"
            disabled={selected.size === 0}
            onClick={() => setTagTargets(media.filter((a) => selected.has(a.id)))}
          >
            Add tag
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={selected.size === 0}
            onClick={() => setConfirmBulk(true)}
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
        <div className="mt-6 columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
          {visible.map((asset) => {
            const isSelected = selected.has(asset.id);
            const tags = assetTags(asset);
            const isVideo = asset.kind === "video";
            return (
              <div
                key={asset.id}
                className={`group relative mb-3 break-inside-avoid rounded-[16px] border bg-raised p-2 shadow-card transition-shadow hover:shadow-lift ${
                  manage && isSelected ? "border-primary" : "border-border"
                }`}
              >
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${asset.title}`}
                    onClick={() => toggleSelected(asset.id)}
                    className="block w-full"
                  >
                    <MediaFrame
                      src={asset.posterUrl ?? asset.url}
                      alt={asset.title}
                      ratio={aspectRatio(asset.settings.aspect)}
                      rounded="rounded-[12px]"
                      className="w-full border border-border"
                      sensitive={isSensitiveAsset(asset)}
                    />
                  </button>
                ) : (
                  <Link
                    href={`/results?id=${asset.id}`}
                    aria-label={`Open ${asset.title}`}
                    className="relative block"
                  >
                    <MediaFrame
                      src={asset.posterUrl ?? asset.url}
                      alt={asset.title}
                      ratio={aspectRatio(asset.settings.aspect)}
                      rounded="rounded-[12px]"
                      className="w-full border border-border"
                      sensitive={isSensitiveAsset(asset)}
                    />
                    {isVideo && (
                      <span className="pointer-events-none absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                        <Icon name="play" size={10} />
                        {String(asset.settings.duration ?? "")}
                      </span>
                    )}
                  </Link>
                )}

                {manage ? (
                  <span
                    className={`absolute left-3.5 top-3.5 flex size-6 items-center justify-center rounded-full border-2 ${
                      isSelected
                        ? "border-primary bg-primary-strong text-white"
                        : "border-white/70 bg-black/30 text-transparent"
                    }`}
                  >
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={asset.favorite ? "Remove favourite" : "Add favourite"}
                    onClick={() => toggleFavorite(asset.id)}
                    className={`absolute left-3.5 top-3.5 flex size-7 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-opacity ${
                      asset.favorite
                        ? "text-warning opacity-100"
                        : "text-white opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}

                {!manage && (
                  <div className="absolute right-3.5 top-3.5">
                    <button
                      type="button"
                      aria-label={`Actions for ${asset.title}`}
                      aria-expanded={menuId === asset.id}
                      onClick={() =>
                        setMenuId((id) => (id === asset.id ? null : asset.id))
                      }
                      className="flex size-7 items-center justify-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 aria-expanded:opacity-100"
                    >
                      <Icon name="more" size={15} />
                    </button>
                    {menuId === asset.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Close menu"
                          className="fixed inset-0 z-10 cursor-default"
                          onClick={() => setMenuId(null)}
                        />
                        <div
                          role="menu"
                          className="absolute right-0 top-9 z-20 w-52 rounded-[14px] border border-border bg-raised p-1.5 shadow-lift"
                        >
                          <MenuItem
                            icon="image"
                            label="Open in Results"
                            href={`/results?id=${asset.id}`}
                            onDone={() => setMenuId(null)}
                          />
                          <MenuItem
                            icon="download"
                            label="Download"
                            onSelect={() => {
                              downloadMedia(
                                asset.url,
                                `perabyte-${asset.kind}-${Date.now()}`,
                              );
                              toast.push("Your download has started.", "success");
                              setMenuId(null);
                            }}
                          />
                          <MenuItem
                            icon="refresh"
                            label="Reuse prompt"
                            href={`/generate/${asset.kind === "video" ? "video" : "image"}?prompt=${encodeURIComponent(asset.prompt)}&style=${encodeURIComponent(String(asset.settings.style))}&aspect=${asset.settings.aspect}`}
                            onDone={() => setMenuId(null)}
                          />
                          <MenuItem
                            icon="copy"
                            label="Copy prompt"
                            onSelect={() => {
                              void navigator.clipboard
                                ?.writeText(asset.prompt)
                                .then(() => toast.push("Prompt copied.", "success"))
                                .catch(() =>
                                  toast.push("Could not copy the prompt.", "error"),
                                );
                              setMenuId(null);
                            }}
                          />
                          <MenuItem
                            icon="chip"
                            label="Add tag"
                            onSelect={() => {
                              setTagTargets([asset]);
                              setMenuId(null);
                            }}
                          />
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            icon="trash"
                            label="Delete"
                            tone="danger"
                            onSelect={() => {
                              setPendingDelete(asset);
                              setMenuId(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-1.5 px-1 pb-1 pt-2">
                  {isVideo && <Badge tone="primary">Video</Badge>}
                  {asset.favorite && (
                    <Badge tone="warning">
                      <Icon name="star" size={11} /> Favourite
                    </Badge>
                  )}
                  {tags.length > 0 && (
                    <span className="min-w-0 truncate text-[11.5px] text-ink-soft">
                      {tags.slice(0, 2).join(" · ")}
                      {tags.length > 2 ? ` +${tags.length - 2}` : ""}
                    </span>
                  )}
                </div>
                <p className="truncate px-1 pb-1 text-[12px] text-muted">{asset.title}</p>
              </div>
            );
          })}
        </div>
      )}

      <TagEditorDialog
        open={Boolean(tagTargets)}
        title={
          tagTargets && tagTargets.length > 1 ? `Tag ${tagTargets.length} items` : "Edit tags"
        }
        initial={tagTargets?.length === 1 ? assetTags(tagTargets[0]) : []}
        onSave={(tags) => tagTargets && saveTags(tagTargets, tags)}
        onCancel={() => setTagTargets(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete “${pendingDelete?.title ?? ""}”?`}
        body="This removes the render from your library. It cannot be undone."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            removeAssets([pendingDelete.id]);
            toast.push("Render deleted.", "success");
          }
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={confirmBulk}
        title={`Delete ${selected.size} selected item${selected.size === 1 ? "" : "s"}?`}
        body="This removes everything you selected from your library. It cannot be undone."
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => {
          removeAssets([...selected]);
          toast.push(
            `${selected.size} item${selected.size === 1 ? "" : "s"} deleted.`,
            "success",
          );
          setSelected(new Set());
          setConfirmBulk(false);
        }}
      />
    </LibraryShell>
  );
}
