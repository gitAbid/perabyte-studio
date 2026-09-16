"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Segmented,
  formatDate,
  formatTime,
  useToast,
} from "@/components/ui";
import { isSensitiveAsset } from "@/lib/domain/models";
import { downloadMedia } from "@/lib/generation";
import {
  clearAssets,
  removeAsset,
  removeAssets,
  toggleFavorite,
  useAssets,
} from "@/lib/store";
import type { Asset } from "@/lib/types";

type Filter = "all" | "image" | "video" | "story";
type Sort = "newest" | "oldest" | "title";

export default function HistoryPage() {
  const { assets, ready } = useAssets();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  // Bulk manage: selection lives only while manage mode is open.
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<"selected" | "all" | null>(null);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    let list = assets.slice();

    if (filter !== "all") list = list.filter((a) => a.kind === filter);
    if (favouritesOnly) list = list.filter((a) => a.favorite);
    if (term) {
      list = list.filter(
        (a) =>
          a.title.toLowerCase().includes(term) ||
          a.prompt.toLowerCase().includes(term),
      );
    }

    list.sort((a, b) => {
      if (sort === "newest") return b.createdAt - a.createdAt;
      if (sort === "oldest") return a.createdAt - b.createdAt;
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [assets, filter, favouritesOnly, query, sort]);

  const allVisibleSelected =
    visible.length > 0 && visible.every((a) => selected.has(a.id));

  function exitManage() {
    setManage(false);
    setSelected(new Set());
    setConfirmBulk(null);
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmBulkDelete() {
    if (confirmBulk === "all") {
      const count = assets.length;
      clearAssets();
      toast.push(`Library cleaned — ${count} item${count === 1 ? "" : "s"} deleted from this browser.`, "success");
    } else if (confirmBulk === "selected") {
      const ids = [...selected];
      const count = ids.length;
      removeAssets(ids);
      toast.push(`${count} item${count === 1 ? "" : "s"} deleted from this browser.`, "success");
    }
    setSelected(new Set());
    setConfirmBulk(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pb-12 pt-8 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[-0.03em] text-ink sm:text-[34px]">
            Your History
          </h1>
          <p className="mt-2 text-sm text-muted">
            Access and manage your past generations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon="star"
            onClick={() => setFavouritesOnly((v) => !v)}
            aria-pressed={favouritesOnly}
          >
            {favouritesOnly ? "Showing favourites" : "Favourites only"}
          </Button>
          <Button
            variant={manage ? "primary" : "secondary"}
            size="sm"
            icon="grid"
            aria-pressed={manage}
            onClick={() => (manage ? exitManage() : setManage(true))}
          >
            {manage ? "Done managing" : "Manage"}
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented
          ariaLabel="Filter by type"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "image", label: "Images" },
            { value: "video", label: "Videos" },
            { value: "story", label: "Stories" },
          ]}
        />

        <div className="relative flex-1 sm:max-w-xs">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles and prompts"
            aria-label="Search history"
            className="h-11 w-full rounded-[12px] border border-border-strong bg-raised pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </div>

        <label className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort history"
            className="h-11 rounded-[12px] border border-border-strong bg-raised px-3 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
          </select>
        </label>
      </div>

      {manage && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-border bg-surface px-3.5 py-3">
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
                allVisibleSelected
                  ? new Set()
                  : new Set(visible.map((a) => a.id)),
              )
            }
          >
            {allVisibleSelected ? "Deselect all" : "Select all"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={selected.size === 0}
            onClick={() => setConfirmBulk("selected")}
          >
            Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={assets.length === 0}
            onClick={() => setConfirmBulk("all")}
          >
            Clean library ({assets.length})
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={exitManage}
          >
            Done
          </Button>
        </div>
      )}

      {!ready && (
        <div className="mt-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-[86px] rounded-[16px]" />
          ))}
        </div>
      )}

      {ready && visible.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon={query ? "search" : "image"}
            title={query ? "No matches" : "Nothing here yet"}
            body={
              query
                ? "Try a different word, or clear the search to see everything."
                : "Generate your first image, video or story and it will appear here."
            }
            action={
              query ? (
                <Button variant="secondary" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Link
                  href="/generate/image"
                  className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-primary px-4 text-sm font-semibold text-white"
                >
                  <Icon name="sparkle" size={16} />
                  Create something
                </Link>
              )
            }
          />
        </div>
      )}

      {ready && visible.length > 0 && (
        <ul className="mt-6 space-y-3">
          {visible.map((asset) => (
            <li
              key={asset.id}
              className={`relative flex items-center gap-4 rounded-[16px] border bg-raised p-3 shadow-card transition-shadow hover:shadow-lift ${
                manage && selected.has(asset.id)
                  ? "border-primary"
                  : "border-border"
              }`}
            >
              {manage && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected.has(asset.id)}
                  aria-label={`Select ${asset.title}`}
                  onClick={() => toggleSelected(asset.id)}
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                    selected.has(asset.id)
                      ? "border-primary bg-primary text-white"
                      : "border-border-strong bg-raised text-transparent hover:border-muted"
                  }`}
                >
                  <Icon name="check" size={13} />
                </button>
              )}

              <MediaThumb asset={asset} manage={manage} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {manage ? (
                    <span className="truncate text-[14.5px] font-bold text-ink">
                      {asset.title}
                    </span>
                  ) : (
                    <Link
                      href={`/results?id=${asset.id}`}
                      className="truncate text-[14.5px] font-bold text-ink hover:text-primary"
                    >
                      {asset.title}
                    </Link>
                  )}
                  {asset.meta?.example === true && <Badge>Example</Badge>}
                  {asset.favorite && (
                    <Badge tone="warning">
                      <Icon name="star" size={11} /> Favourite
                    </Badge>
                  )}
                </div>
                <p className="mt-1 truncate text-[12.5px] text-muted">
                  {asset.mode} · {formatDate(asset.createdAt)} ·{" "}
                  {formatTime(asset.createdAt)}
                </p>
                <p className="mt-1 line-clamp-1 text-[12.5px] text-ink-soft">
                  {asset.prompt}
                </p>
              </div>

              {!manage && (
                <>
                  <button
                    type="button"
                    aria-label={asset.favorite ? "Remove favourite" : "Add favourite"}
                    onClick={() => {
                      toggleFavorite(asset.id);
                      toast.push(
                        asset.favorite ? "Removed from favourites." : "Saved to favourites.",
                        "success",
                      );
                    }}
                    className={`hidden shrink-0 rounded-full p-2 transition-colors sm:block ${
                      asset.favorite ? "text-warning" : "text-muted hover:text-ink"
                    }`}
                  >
                    <Icon name="star" size={17} />
                  </button>

                  <div className="relative shrink-0">
                    <button
                      type="button"
                      aria-label={`Actions for ${asset.title}`}
                      aria-expanded={openMenu === asset.id}
                      onClick={() =>
                        setOpenMenu((id) => (id === asset.id ? null : asset.id))
                      }
                      className="rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <Icon name="more" size={18} />
                    </button>

                    {openMenu === asset.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Close menu"
                          className="fixed inset-0 z-10 cursor-default"
                          onClick={() => setOpenMenu(null)}
                        />
                        <div
                          role="menu"
                          className="absolute right-0 top-11 z-20 w-52 rounded-[14px] border border-border bg-raised p-1.5 shadow-lift"
                        >
                          <MenuItem
                            icon="image"
                            label="Open in Results"
                            href={`/results?id=${asset.id}`}
                            onDone={() => setOpenMenu(null)}
                          />
                          {asset.kind === "story" && (
                            <MenuItem
                              icon="video"
                              label="Continue in editor"
                              href={`/story?id=${asset.id}`}
                              onDone={() => setOpenMenu(null)}
                            />
                          )}
                          <MenuItem
                            icon="download"
                            label="Download"
                            onSelect={() => {
                              downloadMedia(asset.url, `perabyte-${asset.kind}-${Date.now()}`);
                              toast.push("Your download has started.", "success");
                              setOpenMenu(null);
                            }}
                          />
                          <MenuItem
                            icon="refresh"
                            label="Regenerate"
                            href={`/generate/${asset.kind === "video" ? "video" : "image"}?prompt=${encodeURIComponent(asset.prompt)}&style=${encodeURIComponent(String(asset.settings.style))}&aspect=${asset.settings.aspect}`}
                            onDone={() => setOpenMenu(null)}
                          />
                          <MenuItem
                            icon="copy"
                            label="Copy prompt"
                            onSelect={() => {
                              void navigator.clipboard
                                ?.writeText(asset.prompt)
                                .then(() => toast.push("Prompt copied.", "success"))
                                .catch(() => toast.push("Could not copy the prompt.", "error"));
                              setOpenMenu(null);
                            }}
                          />
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            icon="trash"
                            label="Delete"
                            tone="danger"
                            onSelect={() => {
                              setPendingDelete(asset);
                              setOpenMenu(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete “${pendingDelete?.title ?? ""}”?`}
        body="This removes the render from this browser's history. It cannot be undone."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            removeAsset(pendingDelete.id);
            toast.push("Render deleted from this browser.", "success");
          }
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={confirmBulk === "selected"}
        title={`Delete ${selected.size} selected item${selected.size === 1 ? "" : "s"}?`}
        body="This removes everything you selected from this browser's history. It cannot be undone."
        onCancel={() => setConfirmBulk(null)}
        onConfirm={confirmBulkDelete}
      />

      <ConfirmDialog
        open={confirmBulk === "all"}
        title="Clean your library?"
        body={`This deletes all ${assets.length} images, videos and stories from this browser's history, including favourites. It cannot be undone.`}
        confirmLabel="Delete everything"
        onCancel={() => setConfirmBulk(null)}
        onConfirm={confirmBulkDelete}
      />
    </div>
  );
}

/** Row thumbnail: a link outside manage mode, plain media inside it. */
function MediaThumb({ asset, manage }: { asset: Asset; manage: boolean }) {
  const frame = (
    <MediaFrame
      src={asset.url}
      alt={asset.title}
      ratio="16/9"
      rounded="rounded-[12px]"
      className="w-[104px]"
      sensitive={isSensitiveAsset(asset)}
    />
  );
  if (manage) {
    return <div className="shrink-0">{frame}</div>;
  }
  return (
    <Link
      href={`/results?id=${asset.id}`}
      className="shrink-0"
      aria-label={`Open ${asset.title}`}
    >
      {frame}
    </Link>
  );
}

function MenuItem({
  icon,
  label,
  href,
  onSelect,
  onDone,
  tone = "default",
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  href?: string;
  onSelect?: () => void;
  onDone?: () => void;
  tone?: "default" | "danger";
}) {
  const className = `flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
    tone === "danger"
      ? "text-danger hover:bg-danger-soft"
      : "text-ink-soft hover:bg-surface-2"
  }`;

  if (href) {
    return (
      <Link href={href} role="menuitem" className={className} onClick={onDone}>
        <Icon name={icon} size={15} />
        {label}
      </Link>
    );
  }

  return (
    <button type="button" role="menuitem" className={className} onClick={onSelect}>
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}
