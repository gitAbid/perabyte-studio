"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { MenuItem } from "@/components/library/MenuItem";
import { PromptDialog } from "@/components/library/PromptDialog";
import { TagEditorDialog } from "@/components/library/TagEditorDialog";
import {
  CARD_CHECK,
  CARD_FALLBACK,
  CARD_MEDIA,
  CARD_MENU_BTN,
  CARD_TITLE,
  CARD_OVERLAY_CHIP,
  CARD_INFO,
  CARD_INFO_META,
  CARD_INFO_REVEAL,
  CARD_SELECTED,
  CARD_SHELL,
  CARD_STAR,
  CARD_STAR_GHOST,
  CARD_STAR_ON,
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
import { isSensitiveAsset } from "@/lib/domain/models";
import {
  assetTags,
  collectAssetTags,
  duplicateStoryAsset,
  selectStories,
  storyCover,
  storyProgress,
  type MediaLibraryState,
  type SortMode,
} from "@/lib/library-selectors";
import { addAsset, removeAssets, toggleFavorite, updateAsset, useAssets } from "@/lib/store";
import type { Asset } from "@/lib/types";

/**
 * The stories library: cover cards over the server-backed story records with
 * live scene progress, open-in-editor, rename, duplicate (completed scenes
 * keep their renders, in-flight ones reset), and delete. Zero backend — it
 * slices useAssets().
 */
export function StoriesLibrary() {
  const toast = useToast();
  const router = useRouter();
  const { assets, ready } = useAssets();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Asset | null>(null);
  const [tagTargets, setTagTargets] = useState<Asset[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const stories = useMemo(() => assets.filter((a) => a.kind === "story"), [assets]);
  const allTags = useMemo(() => collectAssetTags(stories), [stories]);
  const state: MediaLibraryState = { query, favouritesOnly, sort, activeTags };
  const visible = useMemo(() => selectStories(stories, state), [stories, state]);

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
    targets.forEach((story) =>
      updateAsset(story.id, {
        meta: { ...story.meta, ...(tags.length ? { tags } : { tags: [] }) },
      }),
    );
    toast.push(
      targets.length === 1 ? "Tags updated." : `Tags applied to ${targets.length} stories.`,
      "success",
    );
    setTagTargets(null);
  }

  function duplicate(story: Asset) {
    const copy = duplicateStoryAsset(story);
    addAsset(copy);
    toast.push(`“${copy.title}” created — open it to continue.`, "success");
  }

  const favouriteCount = stories.filter((a) => a.favorite).length;

  return (
    <LibraryShell
      title="Stories"
      caption={`${stories.length} stor${stories.length === 1 ? "y" : "ies"} · ${favouriteCount} favorite${favouriteCount === 1 ? "" : "s"}`}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search titles and scene prompts"
      sort={sort}
      onSortChange={setSort}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => setFavouritesOnly((v) => !v)}
      cta={
        <LinkButton href="/story" icon="plus">
          New story
        </LinkButton>
      }
      manage={manage}
      onToggleManage={() => (manage ? exitManage() : setManage(true))}
      loading={!ready}
      loadingTiles={6}
      empty={
        ready && stories.length === 0 ? (
          <EmptyState
            icon="story"
            title="No stories yet"
            body="Chain scenes into a coherent story — the server renders them one by one, even with the tab closed."
            action={
              <LinkButton href="/story" icon="plus">
                Start your first story
              </LinkButton>
            }
          />
        ) : ready && visible.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            body="Try a different word, or clear the filters to see every story."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setActiveTags([]);
                  setFavouritesOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : null
      }
      filters={
        allTags.length > 0 ? (
          <>
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
                const story = stories.find((a) => a.id === id);
                if (story && !story.favorite) toggleFavorite(id);
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
            onClick={() => setTagTargets(stories.filter((a) => selected.has(a.id)))}
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
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!manage && (
            <Link
              href="/story"
              aria-label="New story"
              className="flex aspect-video flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border bg-surface text-muted transition-colors hover:border-primary hover:bg-primary-soft/40 hover:text-primary"
            >
              <Icon name="plus" size={22} />
              <span className="text-[13px] font-semibold">New story</span>
            </Link>
          )}
          {visible.map((story) => {
            const isSelected = selected.has(story.id);
            const progress = storyProgress(story);
            const tags = assetTags(story);
            const media = <StoryCover story={story} />;
            return (
              <div
                key={story.id}
                className={`${CARD_SHELL} ${
                  manage && isSelected ? CARD_SELECTED : "border-border"
                }`}
              >
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${story.title}`}
                    onClick={() => toggleSelected(story.id)}
                    className="block w-full"
                  >
                    {media}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Open ${story.title} in the editor`}
                    onClick={() => router.push(`/story?id=${story.id}`)}
                    className="block w-full text-left"
                  >
                    {media}
                  </button>
                )}

                {/* Info scrim — always-on title, hover reveals prompt + tags */}
                <div className={CARD_INFO}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={CARD_TITLE}>{story.title}</span>
                    {progress.live && (
                      <span className={`shrink-0 ${CARD_OVERLAY_CHIP}`}>
                        <span className="size-1.5 animate-pulse rounded-full bg-current" />
                        Generating
                      </span>
                    )}
                  </div>
                  <div className={CARD_INFO_META}>
                    <span className="min-w-0 truncate">
                      {progress.done}/{progress.total} scene
                      {progress.total === 1 ? "" : "s"} rendered
                    </span>
                    <span className="shrink-0">{formatDate(story.createdAt)}</span>
                  </div>
                  <div className={CARD_INFO_REVEAL}>
                    <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-soft">
                      {story.prompt}
                    </p>
                    {tags.length > 0 && (
                      <p className="mt-1 truncate text-[11px] font-medium text-muted">
                        {tags.join(" \u00b7 ")}
                      </p>
                    )}
                  </div>
                </div>

                {manage ? (
                  <span role="checkbox" aria-checked={isSelected} className={CARD_CHECK}>
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={story.favorite ? "Remove favourite" : "Add favourite"}
                    onClick={() => toggleFavorite(story.id)}
                    className={`${CARD_STAR} ${story.favorite ? CARD_STAR_ON : CARD_STAR_GHOST}`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}
                {!manage && (
                  <button
                    type="button"
                    aria-label={`Actions for ${story.title}`}
                    aria-expanded={menuId === story.id}
                    onClick={() => setMenuId((id) => (id === story.id ? null : story.id))}
                    className={CARD_MENU_BTN}
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
                {menuId === story.id && !manage && (
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
                        icon="story"
                        label="Open in editor"
                        href={`/story?id=${story.id}`}
                        onDone={() => setMenuId(null)}
                      />
                      <MenuItem
                        icon="copy"
                        label="Rename"
                        onSelect={() => {
                          setRenameTarget(story);
                          setMenuId(null);
                        }}
                      />
                      <MenuItem
                        icon="layers"
                        label="Duplicate"
                        onSelect={() => {
                          duplicate(story);
                          setMenuId(null);
                        }}
                      />
                      <MenuItem
                        icon="chip"
                        label="Add tag"
                        onSelect={() => {
                          setTagTargets([story]);
                          setMenuId(null);
                        }}
                      />
                      <div className="my-1 h-px bg-border" />
                      <MenuItem
                        icon="trash"
                        label="Delete"
                        tone="danger"
                        onSelect={() => {
                          setPendingDelete(story);
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

      <PromptDialog
        open={Boolean(renameTarget)}
        title="Rename story"
        label="Title"
        initial={renameTarget?.title ?? ""}
        confirmLabel="Rename"
        onSave={(title) => {
          if (renameTarget) updateAsset(renameTarget.id, { title });
          setRenameTarget(null);
          toast.push("Story renamed.", "success");
        }}
        onCancel={() => setRenameTarget(null)}
      />

      <TagEditorDialog
        open={Boolean(tagTargets)}
        title={
          tagTargets && tagTargets.length > 1 ? `Tag ${tagTargets.length} stories` : "Edit tags"
        }
        initial={tagTargets?.length === 1 ? assetTags(tagTargets[0]) : []}
        onSave={(tags) => tagTargets && saveTags(tagTargets, tags)}
        onCancel={() => setTagTargets(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete “${pendingDelete?.title ?? ""}”?`}
        body="This deletes the story record and its scene list. Renders already saved as individual images stay in your library. It cannot be undone."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            removeAssets([pendingDelete.id]);
            toast.push("Story deleted.", "success");
          }
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={confirmBulk}
        title={`Delete ${selected.size} selected stor${selected.size === 1 ? "y" : "ies"}?`}
        body="This deletes the selected story records and their scene lists. It cannot be undone."
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => {
          removeAssets([...selected]);
          toast.push(
            `${selected.size} stor${selected.size === 1 ? "y" : "ies"} deleted.`,
            "success",
          );
          setSelected(new Set());
          setConfirmBulk(false);
        }}
      />
    </LibraryShell>
  );
}

/** 16:9 story cover from the first rendered scene, letter tile when none. */
function StoryCover({ story }: { story: Asset }) {
  const cover = storyCover(story);
  if (cover) {
    return (
      <MediaFrame
        src={cover}
        alt={story.title}
        ratio="16/9"
        rounded="rounded-t-[15px]"
        className={CARD_MEDIA}
        sensitive={isSensitiveAsset(story)}
      />
    );
  }
  return (
    <div className={`${CARD_FALLBACK} aspect-video rounded-[15px]`}>
      <Icon name="story" size={26} />
    </div>
  );
}
