"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaPreview } from "@/components/production/primitives/media";
import { Badge, formatDate } from "@/components/ui";
import {
  CARD_INFO,
  CARD_INFO_META,
  CARD_SHELL,
  CARD_STAR,
  CARD_STAR_GHOST,
  CARD_STAR_ON,
  CARD_TITLE,
} from "@/components/library/card-styles";
import {
  formatLineage,
  type LibraryItem,
  type LibraryItemKind,
} from "@/lib/library/read-model";

const KIND_LABELS: Record<LibraryItemKind, string> = {
  character: "Character",
  environment: "Environment",
  image: "Image",
  video: "Video",
};

/**
 * One library card (spec 16 §6): lightweight thumbnail via the shared
 * MediaPreview, Canon badge on creative canon, lineage chips ("From Milo v3")
 * when the item carries provenance, and a favorite toggle that never
 * navigates. The card links OUT to the surface that owns the item —
 * /library never duplicates a detail view.
 *
 * Interactive-element hygiene: the favorite button and the 18+ reveal sit as
 * siblings of the media link (never inside it), and a video preview — which
 * carries native controls — renders OUTSIDE the link entirely, with the
 * title serving as the navigation target instead.
 */
export function LibraryCard({
  item,
  favorite,
  onToggleFavorite,
}: {
  item: LibraryItem;
  /** Resolved favorite state (localStorage overlay applied by the explorer). */
  favorite: boolean;
  onToggleFavorite(id: string): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const masked = item.sensitive && !revealed;
  const previewIsVideo =
    item.preview.phase === "ready" && item.preview.media.kind === "video";
  // A linked media zone would trap the video player's native controls inside
  // an anchor — invalid HTML, so videos keep an unlinked player and navigate
  // via the title link below.
  const mediaLinked = !previewIsVideo;
  const cardId = `library.card.${item.id}`;

  const preview = (
    <MediaPreview
      state={item.preview}
      ratio={item.ratio}
      fit="cover"
      rounded="none"
      className={`w-full rounded-t-[7px] ${masked ? "pointer-events-none blur-2xl" : ""}`}
      testId={`${cardId}.preview`}
    />
  );

  return (
    <article data-testid={cardId} className={`${CARD_SHELL} flex flex-col`}>
      <div className="relative">
        {mediaLinked ? (
          <Link
            href={item.href}
            aria-label={`Open ${item.title}`}
            data-testid={`${cardId}.open`}
            className="block"
          >
            {preview}
          </Link>
        ) : (
          preview
        )}

        {/* 18+ veil: sibling overlay, so it neither traps the link nor the player. */}
        {masked && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/25 text-center">
            <span className="rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-white">
              18+
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`Show sensitive content for ${item.title}`}
              data-testid={`${cardId}.reveal`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setRevealed(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setRevealed(true);
                }
              }}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink shadow-card transition-colors hover:bg-surface-2"
            >
              <Icon name="eye" size={13} />
              Show
            </span>
          </div>
        )}

        {/* Still-poster chip: video thumbnails show a frame, label says what opens. */}
        {item.kind === "video" && !previewIsVideo && (
          <span
            data-testid={`${cardId}.video-chip`}
            className="absolute bottom-2 left-2 z-[5] inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-semibold text-white backdrop-blur-sm"
          >
            <Icon name="play" size={10} aria-hidden="true" />
            Video
          </span>
        )}

        <button
          type="button"
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
          data-testid={`library.favorite.${item.id}`}
          onClick={() => onToggleFavorite(item.id)}
          className={`${CARD_STAR} ${favorite ? CARD_STAR_ON : CARD_STAR_GHOST}`}
        >
          <Icon name="star" size={14} />
        </button>
      </div>

      <div className={`${CARD_INFO} flex flex-1 flex-col`}>
        <div className="flex items-start justify-between gap-2">
          {mediaLinked ? (
            <span className={CARD_TITLE}>{item.title}</span>
          ) : (
            <Link
              href={item.href}
              data-testid={`${cardId}.open`}
              className={`${CARD_TITLE} hover:underline focus-visible:underline focus-visible:outline-none`}
            >
              {item.title}
            </Link>
          )}
        </div>
        <div className={CARD_INFO_META}>
          <span className="min-w-0 truncate">{KIND_LABELS[item.kind]}</span>
          <span className="shrink-0">{formatDate(item.createdAt)}</span>
        </div>
        {item.detail && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-soft">
            {item.detail}
          </p>
        )}

        {(item.canon || item.lineage.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {item.canon && (
              <span data-testid={`${cardId}.canon`} className="inline-flex items-center">
                <Badge tone="success">
                  <Icon name="check" size={10} aria-hidden="true" />
                  Canon
                  <span className="sr-only">
                    — saved to your reusable library. PeraByte reuses it to keep scenes consistent.
                  </span>
                </Badge>
              </span>
            )}
            {item.lineage.map((ref) => (
              <span
                key={`${ref.kind}-${ref.name}-${ref.revision ?? 0}`}
                data-testid={`${cardId}.lineage`}
                title={ref.href ? `${formatLineage(ref)} — open ${ref.kind}` : formatLineage(ref)}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-soft"
              >
                <Icon name="history" size={10} aria-hidden="true" />
                {formatLineage(ref)}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
