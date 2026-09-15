"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  formatDate,
  formatTime,
  useToast,
} from "@/components/ui";
import { ASPECTS } from "@/lib/constants";
import { downloadMedia } from "@/lib/generation";
import { isVideoSource } from "@/lib/renderer";
import { getAsset, removeAsset, toggleFavorite, useAssets } from "@/lib/store";
import type { Asset } from "@/lib/types";
import { StoryPlayer } from "@/components/StoryPlayer";

export default function ResultsPage() {
  const { assets, ready } = useAssets();
  const toast = useToast();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [variant, setVariant] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const [playOpen, setPlayOpen] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      setAsset(assets[0] ?? null);
      return;
    }
    const found = getAsset(id);
    if (found) setAsset(found);
    else if (ready) setMissing(true);
  }, [assets, ready]);

  useEffect(() => setVariant(0), [asset?.id]);

  if (!asset) {
    return (
      <div className="mx-auto w-full max-w-[820px] px-4 py-16 sm:px-6">
        {missing ? (
          <EmptyState
            icon="alert"
            title="That render is no longer available"
            body="It may have been deleted from this browser. Your remaining history is safe."
            action={
              <Link
                href="/history"
                className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-primary px-4 text-sm font-semibold text-white"
              >
                Back to History
              </Link>
            }
          />
        ) : (
          <div className="skeleton h-72 w-full rounded-[20px]" />
        )}
      </div>
    );
  }

  const ratio = `${ASPECTS[asset.settings.aspect]?.width ?? 16}/${ASPECTS[asset.settings.aspect]?.height ?? 9}`;
  const currentUrl = asset.variants[variant] ?? asset.url;
  // Video player selection follows the media itself, not just the asset kind:
  // story assets persist kind "story" even when every scene is a rendered
  // mp4, and falling through to MediaFrame would show a frozen, control-less
  // first frame instead of the playable video.
  const isVideo = asset.kind === "video" || isVideoSource(currentUrl);
  const isStory = asset.kind === "story";
  // Reel for the full-story player: persisted scenes when available
  // (newest saves carry mime), falling back to the variant list.
  const storyScenes = isStory
    ? asset.scenes?.some((scene) => scene.url)
      ? asset.scenes
          .filter((scene) => scene.url)
          .map((scene) => ({
            url: scene.url as string,
            mime: scene.mime,
            label: scene.prompt,
          }))
      : asset.variants.map((url) => ({ url }))
    : [];

  function handleFavorite() {
    if (!asset) return;
    toggleFavorite(asset.id);
    setAsset({ ...asset, favorite: !asset.favorite });
    toast.push(asset.favorite ? "Removed from favourites." : "Saved to favourites.", "success");
  }

  function handleDelete() {
    if (!asset) return;
    removeAsset(asset.id);
    setConfirmOpen(false);
    toast.push("Render deleted from this browser.", "success");
    setAsset(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-12 pt-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/history"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted transition-colors hover:text-ink"
        >
          <Icon name="arrow-left" size={15} />
          Back
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={() => {
              downloadMedia(currentUrl, `perabyte-${asset.kind}-${Date.now()}`);
              toast.push("Your download has started.", "success");
            }}
          >
            Download
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="share"
            onClick={() => {
              const url = `${window.location.origin}/results?id=${asset.id}`;
              void navigator.clipboard
                ?.writeText(url)
                .then(() => toast.push("Share link copied to clipboard.", "success"))
                .catch(() => toast.push("Could not copy the link.", "error"));
            }}
          >
            Share
          </Button>
        </div>
      </div>

      <h1 className="mt-4 text-[26px] font-extrabold tracking-[-0.03em] text-ink sm:text-[30px]">
        {asset.title}
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge tone="primary">{asset.mode}</Badge>
        <Badge>{formatDate(asset.createdAt)}</Badge>
        <Badge>{formatTime(asset.createdAt)}</Badge>
        {asset.meta?.example === true && <Badge tone="warning">Example render</Badge>}
        {asset.favorite && (
          <Badge tone="success">
            <Icon name="heart" size={12} /> Favourite
          </Badge>
        )}
      </div>

      <div className="mt-6 space-y-4">
        {isVideo ? (
          <VideoStage
            posterUrl={currentUrl}
            videoUrl={isVideoSource(currentUrl) ? currentUrl : undefined}
            title={asset.title}
            durationSeconds={Number(String(asset.settings.duration).replace("s", "")) || 5}
          />
        ) : (
          <MediaFrame
            src={currentUrl}
            alt={asset.title}
            ratio={ratio}
            rounded="rounded-[20px]"
            className="bg-ink"
            priority
          />
        )}

        {asset.variants.length > 1 && (
          <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
            {asset.variants.map((url, index) => (
              <button
                key={`${url}-${index}`}
                type="button"
                onClick={() => setVariant(index)}
                aria-label={`Variation ${index + 1}`}
                aria-pressed={index === variant}
                className={`shrink-0 overflow-hidden rounded-[14px] border-2 transition-all ${
                  index === variant
                    ? "border-primary"
                    : "border-transparent hover:border-border-strong"
                }`}
              >
                <MediaFrame
                  src={url}
                  alt=""
                  ratio="1/1"
                  rounded="rounded-[12px]"
                  className="w-[92px]"
                />
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/generate/${isVideo ? "video" : "image"}?prompt=${encodeURIComponent(asset.prompt)}&style=${encodeURIComponent(String(asset.settings.style))}&aspect=${asset.settings.aspect}`}
            className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            <Icon name="refresh" size={16} />
            Regenerate
          </Link>
          <Button
            variant="secondary"
            icon="sparkle"
            onClick={() => toast.push("Draft a fresh variation from the generator — your settings are carried over.")}
          >
            Generate Another
          </Button>
          {isStory && storyScenes.length > 0 && (
            <Button variant="secondary" icon="play" onClick={() => setPlayOpen(true)}>
              Play story
            </Button>
          )}
          <Button variant="secondary" icon="heart" onClick={handleFavorite}>
            {asset.favorite ? "Unsave" : "Save"}
          </Button>
          <Button
            variant="secondary"
            icon="trash"
            onClick={() => setConfirmOpen(true)}
          >
            Delete
          </Button>
        </div>

        <Card className="bg-surface">
          <h2 className="text-[14px] font-bold text-ink">Render details</h2>
          <dl className="mt-4 grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2">
            <Row label="Prompt" value={asset.prompt} span />
            <Row label="Mode" value={asset.mode} />
            <Row label="Style" value={String(asset.settings.style)} />
            <Row label="Aspect" value={asset.settings.aspect} />
            <Row label="Resolution" value={asset.settings.resolution} />
            {asset.meta?.requestId && (
              <Row label="Request ID" value={String(asset.meta.requestId)} />
            )}
            {asset.meta?.seeds && <Row label="Seed(s)" value={String(asset.meta.seeds)} />}
            {isStory && asset.meta?.scenes && (
              <Row label="Scenes" value={String(asset.meta.scenes)} />
            )}
          </dl>
          {isStory && (
            <p className="mt-4 rounded-[12px] border border-border bg-white p-3 text-[12.5px] text-muted">
              This is a story project: open History to revisit every scene or
              regenerate individual frames.
            </p>
          )}
        </Card>
      </div>

      {playOpen && storyScenes.length > 0 && (
        <StoryPlayer
          scenes={storyScenes}
          sceneSeconds={Number(String(asset.settings.duration).replace("s", "")) || 5}
          onClose={() => setPlayOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this render?"
        body="It will be removed from this browser's history. This cannot be undone."
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function Row({
  label,
  value,
  span,
}: {
  label: string;
  value: string;
  span?: boolean;
}) {
  return (
    <div className={span ? "sm:col-span-2" : ""}>
      <dt className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-ink-soft">{value}</dd>
    </div>
  );
}