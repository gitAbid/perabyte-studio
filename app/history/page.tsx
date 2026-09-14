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
import { ASPECTS } from "@/lib/constants";
import { downloadMedia } from "@/lib/generation";
import { removeAsset, toggleFavorite, useAssets } from "@/lib/store";
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
        <Button
          variant="secondary"
          size="sm"
          icon="star"
          onClick={() => setFavouritesOnly((v) => !v)}
          aria-pressed={favouritesOnly}
        >
          {favouritesOnly ? "Showing favourites" : "Favourites only"}
        </Button>
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
            className="h-11 w-full rounded-[12px] border border-border-strong bg-white pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </div>

        <label className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort history"
            className="h-11 rounded-[12px] border border-border-strong bg-white px-3 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
          </select>
        </label>
      </div>

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
              className="relative flex items-center gap-4 rounded-[16px] border border-border bg-white p-3 shadow-card transition-shadow hover:shadow-lift"
            >
              <Link
                href={`/results?id=${asset.id}`}
                className="shrink-0"
                aria-label={`Open ${asset.title}`}
              >
                <MediaFrame
                  src={asset.url}
                  alt={asset.title}
                  ratio={
                    ASPECTS[asset.settings.aspect]
                      ? `${ASPECTS[asset.settings.aspect].width}/${ASPECTS[asset.settings.aspect].height}`
                      : "1/1"
                  }
                  rounded="rounded-[12px]"
                  className="w-[92px]"
                />
              </Link>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/results?id=${asset.id}`}
                    className="truncate text-[14.5px] font-bold text-ink hover:text-primary"
                  >
                    {asset.title}
                  </Link>
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
                      className="absolute right-0 top-11 z-20 w-52 rounded-[14px] border border-border bg-white p-1.5 shadow-lift"
                    >
                      <MenuItem
                        icon="image"
                        label="Open in Results"
                        href={`/results?id=${asset.id}`}
                        onDone={() => setOpenMenu(null)}
                      />
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
    </div>
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