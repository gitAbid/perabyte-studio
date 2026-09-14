"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import { PromptComposer } from "@/components/PromptComposer";
import { Badge, Button, Segmented, useToast } from "@/components/ui";
import {
  ASPECTS,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  IMAGE_STYLES,
  PROMPT_MAX,
  VIDEO_STYLES,
  type AspectKey,
} from "@/lib/constants";
import { downloadMedia, useGeneration } from "@/lib/generation";
import { addAsset, assetFromResponse, toggleFavorite } from "@/lib/store";
import type { GenerationSettings } from "@/lib/types";

const COPY = {
  image: {
    title: "Generate Image",
    previewBody: "Describe a scene below and press Generate.",
  },
  video: {
    title: "Generate Video",
    previewBody: "Describe a scene below and press Generate.",
  },
} as const;

export function GeneratorScreen({ kind }: { kind: "image" | "video" }) {
  const router = useRouter();
  const toast = useToast();
  const copy = COPY[kind];

  const [settings, setSettings] = useState<GenerationSettings>(
    kind === "video"
      ? { ...DEFAULT_VIDEO_SETTINGS }
      : { ...DEFAULT_IMAGE_SETTINGS },
  );
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | undefined>();
  const [assetId, setAssetId] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [activeVariant, setActiveVariant] = useState(0);

  const { job, run, cancel, reset } = useGeneration();

  // Prefill from History / Results "Regenerate" links.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incoming = params.get("prompt");
    if (!incoming) return;
    setPrompt(incoming.slice(0, PROMPT_MAX));
    const style = params.get("style");
    const aspect = params.get("aspect");
    if (style) {
      const table = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
      if (style in table) setSettings((s) => ({ ...s, style }));
    }
    if (aspect && aspect in ASPECTS) {
      setSettings((s) => ({ ...s, aspect: aspect as AspectKey }));
    }
  }, [kind]);

  const busy = job.phase === "queued" || job.phase === "generating";
  const result = job.phase === "completed" ? job.response : null;
  const shownUrl = result?.media[activeVariant]?.url ?? result?.media[0]?.url ?? null;

  useEffect(() => setActiveVariant(0), [result?.requestId]);

  const aspectRatio = (() => {
    const [w, h] = settings.aspect.split(":").map(Number);
    return `${w} / ${h}`;
  })();

  function patchSettings(patch: Partial<GenerationSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      setPromptError("Describe what you want to create before generating.");
      return;
    }
    setPromptError(undefined);
    setAssetId(null);

    const response = await run({
      settings: { ...settings, kind },
      prompt: prompt.trim(),
    });
    if (!response) return;

    const asset = assetFromResponse(response, { ...settings, kind }, prompt.trim());
    addAsset(asset);
    setAssetId(asset.id);
    setFavorite(false);
    toast.push(
      `${kind === "video" ? "Video" : "Image"} generated and saved to History.`,
      "success",
    );
    // The provider throttles us when several renders are requested at once, so
    // say so instead of leaving the user staring at a loading placeholder.
    if (response.prewarmed === false) {
      toast.push(
        "The render provider is busy — your render may take a few seconds to appear.",
      );
    }
  }

  function handleFavorite() {
    if (!assetId) return;
    toggleFavorite(assetId);
    setFavorite((f) => !f);
    toast.push("Saved to favourites.", "success");
  }

  function handleDownload() {
    if (!shownUrl) return;
    downloadMedia(shownUrl, `perabyte-${kind}-${Date.now()}`);
    toast.push("Your download has started.", "success");
  }

  function handleCopyPrompt() {
    void navigator.clipboard
      ?.writeText(prompt)
      .then(() => toast.push("Prompt copied.", "success"))
      .catch(() => toast.push("Could not copy the prompt.", "error"));
  }

  return (
    // `main` is a flex column, so flex-1 + min-h-0 makes this fill the viewport
    // under the header exactly — no calc, no rounding gap, no page scrolling.
    <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col gap-3 overflow-hidden px-4 py-4 sm:px-6">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/"
            aria-label="Back to home"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
          >
            <Icon name="arrow-left" size={16} />
          </Link>
          <h1 className="truncate text-[18px] font-extrabold tracking-[-0.02em] text-ink sm:text-[22px]">
            <span className="sm:hidden">{kind === "video" ? "Video" : "Image"}</span>
            <span className="hidden sm:inline">{copy.title}</span>
          </h1>
          {result && (
            <span className="hidden sm:inline-flex">
              <Badge tone="primary">
                <Icon name="check" size={11} /> Ready
              </Badge>
            </span>
          )}
        </div>

        <Segmented
          ariaLabel="Generation type"
          size="sm"
          collapseOnMobile
          value={kind}
          onChange={(next) => router.push(`/generate/${next}`)}
          options={[
            { value: "image", label: "Image", icon: "image" },
            { value: "video", label: "Video", icon: "video" },
          ]}
        />
      </div>

      {/* ------------------------------ Preview ------------------------------ */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[20px] border border-border bg-surface p-3">
        {job.phase === "idle" && (
          <div className="flex h-full w-full flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong px-6 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-white text-muted shadow-card">
              <Icon name={kind === "video" ? "video" : "image"} size={22} />
            </span>
            <p className="mt-3.5 text-[15px] font-bold text-ink">
              {kind === "video"
                ? "Your video will appear here"
                : "Your image will appear here"}
            </p>
            <p className="mt-1 max-w-xs text-[13px] text-muted">
              {copy.previewBody}
            </p>
          </div>
        )}

        {busy && (
          <div className="flex h-full w-full items-center justify-center">
            <div className="flex max-h-full flex-col items-center gap-3">
              <div
                className="skeleton max-h-[60vh] w-[min(100%,640px)] rounded-[16px]"
                style={{ aspectRatio: aspectRatio }}
              />
              <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
                <Icon name="clock" size={14} />
                {job.phase === "queued"
                  ? "Queued — waiting for a free render slot…"
                  : "Generating your render…"}
              </p>
            </div>
          </div>
        )}

        {job.phase === "failed" && (
          <div className="flex flex-col items-center px-6 text-center">
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-white text-danger shadow-card">
              <Icon name="alert" size={20} />
            </span>
            <p className="mt-3 text-[14px] font-bold text-ink">
              Generation failed
            </p>
            <p className="mt-1 max-w-sm text-[12.5px] text-ink-soft">
              {job.message}
            </p>
            {job.retryable && (
              <Button
                size="sm"
                className="mt-4"
                icon="refresh"
                onClick={handleGenerate}
              >
                Retry with same settings
              </Button>
            )}
          </div>
        )}

        {job.phase === "completed" && result && (
          <>
            {kind === "video" ? (
              <VideoStage
                fit
                posterUrl={shownUrl}
                title={prompt || "Generated video"}
                durationSeconds={Number(settings.duration.replace("s", ""))}
              />
            ) : (
              <MediaFrame
                fit
                src={shownUrl}
                alt={prompt || "Generated image"}
                rounded="rounded-[14px]"
                priority
              />
            )}

            {/* Floating actions, so no space is spent on a toolbar row. */}
            <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-1.5">
              <OverlayButton
                icon="download"
                label="Download"
                onClick={handleDownload}
              />
              <OverlayButton
                icon="heart"
                label={favorite ? "Saved to favourites" : "Save to favourites"}
                active={favorite}
                disabled={!assetId}
                onClick={handleFavorite}
              />
              <OverlayButton
                icon="copy"
                label="Copy prompt"
                onClick={handleCopyPrompt}
              />
              {assetId ? (
                <Link
                  href={`/results?id=${assetId}`}
                  aria-label="Open in Results"
                  title="Open in Results"
                  className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-white/90 text-ink-soft backdrop-blur transition-colors hover:text-ink"
                >
                  <Icon name="arrow-right" size={15} />
                </Link>
              ) : null}
              <OverlayButton
                icon="refresh"
                label="Generate another"
                onClick={reset}
              />
            </div>

            {result.media.length > 1 && (
              <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2 rounded-full border border-border bg-white/90 p-1.5 backdrop-blur">
                {result.media.map((media, index) => (
                  <button
                    key={media.id}
                    type="button"
                    onClick={() => setActiveVariant(index)}
                    aria-label={`Show variation ${index + 1}`}
                    aria-pressed={index === activeVariant}
                    className={`overflow-hidden rounded-full border-2 transition-all ${
                      index === activeVariant
                        ? "border-primary"
                        : "border-transparent hover:border-border-strong"
                    }`}
                  >
                    <MediaFrame
                      src={media.url}
                      alt=""
                      ratio="1/1"
                      rounded="rounded-full"
                      className="w-9"
                    />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ------------------------------ Composer ----------------------------- */}
      <PromptComposer
        kind={kind}
        prompt={prompt}
        onPromptChange={(value) => {
          setPrompt(value);
          if (promptError) setPromptError(undefined);
        }}
        promptError={promptError}
        settings={settings}
        onSettingsChange={patchSettings}
        busy={busy}
        onGenerate={handleGenerate}
        onCancel={cancel}
        onCopyPrompt={handleCopyPrompt}
      />
    </div>
  );
}

function OverlayButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex size-8 items-center justify-center rounded-full border backdrop-blur transition-colors disabled:opacity-50 ${
        active
          ? "border-warning bg-white/90 text-warning"
          : "border-border bg-white/90 text-ink-soft hover:text-ink"
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
