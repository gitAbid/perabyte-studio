"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  formatDate,
  formatTime,
  useToast,
} from "@/components/ui";
import { ASPECTS } from "@/lib/constants";
import { isSensitiveAsset } from "@/lib/domain/models";
import { downloadMedia } from "@/lib/generation";
import { isVideoSource } from "@/lib/renderer";
import { getAsset, removeAsset, toggleFavorite, useAssets } from "@/lib/store";
import { storyCover } from "@/lib/library-selectors";
import type { Asset } from "@/lib/types";
import { StoryPlayer } from "@/components/StoryPlayer";

/**
 * Asset detail viewer: an immersive dark media stage beside a sticky info
 * panel (title, prompt, actions, render details). Story assets keep the
 * full-story player and editor entry point.
 */
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

  /** Scrollable "more generations" strip: newest others, mixed kinds. */
  const others = useMemo(() => {
    if (!asset) return [];
    return assets
      .filter((a) => a.id !== asset.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 24);
  }, [assets, asset]);

  if (!asset) {
    return (
      <div className="mx-auto w-full max-w-[820px] px-4 py-16 sm:px-6">
        {missing ? (
          <EmptyState
            icon="alert"
            title="That render is no longer available"
            body="It may have been deleted from your library. Your remaining renders are safe."
            action={
              <Link
                href="/images"
                className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-primary-strong px-4 text-sm font-semibold text-white"
              >
                Back to the library
              </Link>
            }
          />
        ) : (
          <div className="skeleton h-72 w-full rounded-[20px]" />
        )}
      </div>
    );
  }

  const aspect = ASPECTS[asset.settings.aspect];
  const ratio = `${aspect?.width ?? 16}/${aspect?.height ?? 9}`;
  // The stage honours the render's native aspect ratio but never exceeds the
  // viewport height: maxWidth = the width at which the stage is ~64dvh tall
  // inside its dark mat, so a portrait render centres at a sane size.
  const stageMaxWidth = `calc(64dvh * ${aspect?.width ?? 16} / ${aspect?.height ?? 9})`;
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
    toast.push("Render deleted.", "success");
    setAsset(null);
  }

  function handleCopyPrompt() {
    void navigator.clipboard
      ?.writeText(asset!.prompt)
      .then(() => toast.push("Prompt copied.", "success"))
      .catch(() => toast.push("Could not copy the prompt.", "error"));
  }

  /** Swap the viewed asset in place; the URL stays deep-linkable. */
  function selectAsset(next: Asset) {
    window.history.replaceState(null, "", `/results?id=${next.id}`);
    setAsset(next);
    setVariant(0);
  }

  /** Generator deep link carrying this render's configuration. The model
   * deliberately stays the user's current pick — reuse transfers the look
   * (prompt/style/shape), not the engine. */
  function reuseUrl(scope: "all" | "prompt" | "style" | "aspect"): string {
    if (!asset) return "#";
    const params = new URLSearchParams();
    params.set("prompt", asset.prompt);
    if (scope === "all" || scope === "style") {
      params.set("style", String(asset.settings.style));
    }
    if (scope === "all" || scope === "aspect") {
      params.set("aspect", asset.settings.aspect);
    }
    if (scope === "all") {
      params.set("resolution", asset.settings.resolution);
    }
    return `/generate/${isVideo ? "video" : "image"}?${params.toString()}`;
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-12 pt-6 sm:px-6">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/images"
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-raised pl-2.5 pr-3.5 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
        >
          <Icon name="arrow-left" size={14} />
          Library
        </Link>
        {isStory && (
          <Link
            href={`/story?id=${asset.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-raised px-3.5 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="video" size={14} />
            Open in editor
          </Link>
        )}
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* ── Media stage ─────────────────────────────────────────── */}
        <div className="min-w-0">
          <div className="mx-auto w-fit max-w-full rounded-[24px] bg-black p-3 shadow-lift sm:p-4">
            <div className="mx-auto w-full" style={{ maxWidth: stageMaxWidth }}>
              {isVideo ? (
                <VideoStage
                  posterUrl={currentUrl}
                  videoUrl={isVideoSource(currentUrl) ? currentUrl : undefined}
                  title={asset.title}
                  durationSeconds={Number(String(asset.settings.duration).replace("s", "")) || 5}
                  ratio={ratio}
                  sensitive={isSensitiveAsset(asset)}
                />
              ) : (
                <MediaFrame
                  src={currentUrl}
                  alt={asset.title}
                  ratio={ratio}
                  rounded="rounded-[16px]"
                  className="bg-black"
                  priority
                  sensitive={isSensitiveAsset(asset)}
                  detailed
                />
              )}
            </div>
          </div>

          {asset.variants.length > 1 && (
            <div className="mt-3 flex justify-center gap-2.5 overflow-x-auto no-scrollbar">
              {asset.variants.map((url, index) => (
                <button
                  key={`${url}-${index}`}
                  type="button"
                  onClick={() => setVariant(index)}
                  aria-label={`Variation ${index + 1}`}
                  aria-pressed={index === variant}
                  className={`shrink-0 overflow-hidden rounded-[12px] transition-all duration-150 ${
                    index === variant
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-canvas"
                      : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <MediaFrame
                    src={url}
                    alt=""
                    ratio="1/1"
                    rounded="rounded-[10px]"
                    className="w-[84px]"
                    sensitive={isSensitiveAsset(asset)}
                  />
                </button>
              ))}
            </div>
          )}

          {/* More from your library — click to preview in place */}
          {others.length > 0 && (
            <section className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-bold text-ink">More from your library</h2>
                <Link
                  href="/images"
                  className="text-[12px] font-semibold text-muted transition-colors hover:text-ink"
                >
                  View all →
                </Link>
              </div>
              <div className="mt-3 flex gap-3 overflow-x-auto no-scrollbar pb-1">
                {others.map((other) => {
                  const cover =
                    other.kind === "story"
                      ? storyCover(other)
                      : other.posterUrl ?? other.url;
                  return (
                    <button
                      key={other.id}
                      type="button"
                      onClick={() => selectAsset(other)}
                      aria-label={`Preview ${other.title}`}
                      className="group relative w-[148px] shrink-0 overflow-hidden rounded-[14px] border border-border bg-surface-2 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift motion-reduce:hover:transform-none"
                    >
                      <MediaFrame
                        src={cover ?? null}
                        alt={other.title}
                        ratio="1/1"
                        rounded="rounded-[13px]"
                        sensitive={isSensitiveAsset(other)}
                      />
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2.5 pb-2 pt-6 text-left">
                        <span className="block truncate text-[11.5px] font-semibold text-white">
                          {other.title}
                        </span>
                        <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-wide text-white/60">
                          {other.kind === "video"
                            ? "Video"
                            : other.kind === "story"
                              ? "Story"
                              : "Image"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* ── Info panel ──────────────────────────────────────────── */}
        <aside className="flex min-w-0 flex-col gap-4 rounded-[24px] border border-border bg-raised p-5 shadow-card lg:sticky lg:top-6">
          {/* Title + favourite */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="break-words text-[19px] font-extrabold leading-tight tracking-[-0.02em] text-ink">
                {asset.title}
              </h1>
              <p className="mt-1 text-[12px] text-muted">
                {asset.mode} · {formatDate(asset.createdAt)}{" "}
                {formatTime(asset.createdAt)}
              </p>
            </div>
            <button
              type="button"
              aria-label={asset.favorite ? "Remove favourite" : "Save to favourites"}
              aria-pressed={asset.favorite}
              onClick={handleFavorite}
              className={`flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
                asset.favorite
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-border bg-surface text-muted hover:border-border-strong hover:text-ink"
              }`}
            >
              <Icon name="star" size={16} />
            </button>
          </div>

          {asset.meta?.example === true && (
            <span className="inline-flex w-fit items-center rounded-md bg-warning/10 px-2 py-1 text-[11px] font-semibold text-warning">
              Example render
            </span>
          )}

          {/* Prompt */}
          <div className="rounded-[14px] border border-border bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
                Prompt
              </span>
              <button
                type="button"
                aria-label="Copy prompt"
                onClick={handleCopyPrompt}
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="copy" size={14} />
              </button>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-soft">
              {asset.prompt}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <Link
              href={`/generate/${isVideo ? "video" : "image"}?prompt=${encodeURIComponent(asset.prompt)}&style=${encodeURIComponent(String(asset.settings.style))}&aspect=${asset.settings.aspect}`}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-primary-strong text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
            >
              <Icon name="refresh" size={16} />
              Regenerate
            </Link>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
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
              {isStory && storyScenes.length > 0 && (
                <Button variant="secondary" icon="play" onClick={() => setPlayOpen(true)}>
                  Play story
                </Button>
              )}
              {isStory && (
                <Link
                  href={`/story?id=${asset.id}`}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-border-strong bg-surface text-[13px] font-semibold text-ink transition-colors hover:border-primary hover:text-primary"
                >
                  <Icon name="video" size={15} />
                  Editor
                </Link>
              )}
            </div>
          </div>

          {/* Reuse configuration */}
          <div className="rounded-[14px] border border-border bg-surface p-3">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Reuse in generator
            </span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "Everything", "layers"],
                  ["prompt", "Prompt", "copy"],
                  ["style", "Style", "sparkle"],
                  ["aspect", "Aspect", "grid"],
                ] as const
              ).map(([scope, label, icon]) => (
                <Link
                  key={scope}
                  href={reuseUrl(scope)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-raised px-3 text-[12px] font-semibold text-ink-soft transition-colors hover:border-primary hover:text-primary"
                >
                  <Icon name={icon} size={12} />
                  {label}
                </Link>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Loads into the generator with your current model.
            </p>
          </div>

          {/* Render details */}
          <div className="rounded-[14px] border border-border bg-surface p-3.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Render details
            </span>
            <dl className="mt-2.5 space-y-2 text-[12.5px]">
              <Row label="Style" value={String(asset.settings.style)} />
              <Row label="Aspect" value={asset.settings.aspect} />
              <Row label="Resolution" value={asset.settings.resolution} />
              {asset.meta?.seeds && <Row label="Seed(s)" value={String(asset.meta.seeds)} />}
              {isStory && asset.meta?.scenes && (
                <Row label="Scenes" value={String(asset.meta.scenes)} />
              )}
              {asset.meta?.requestId && (
                <Row label="Request ID" value={String(asset.meta.requestId)} />
              )}
            </dl>
          </div>

          {/* Danger zone */}
          <Button
            variant="ghost"
            icon="trash"
            className="text-danger hover:bg-danger-soft hover:text-danger"
            onClick={() => setConfirmOpen(true)}
          >
            Delete render
          </Button>
        </aside>
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
        body="It will be removed from your library. This cannot be undone."
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-ink">{value}</dd>
    </div>
  );
}
