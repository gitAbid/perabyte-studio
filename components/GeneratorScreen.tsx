"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import { PromptComposer } from "@/components/PromptComposer";
import { RenderProgress } from "@/components/RenderProgress";
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
import { isSensitiveAsset } from "@/lib/domain/models";
import { downloadMedia, useGeneration } from "@/lib/generation";
import { requestPromptEnhancement } from "@/lib/enhancement";
import { useModelCatalog } from "@/lib/model-catalog";
import { snapSettingsForModel } from "@/lib/render-options";
import { snapLorasForModel } from "@/lib/lora-options";
import { composeSceneWithCharacters } from "@/lib/character";
import {
  setSelectedModel,
  setSoloCharacters,
  useSettings,
} from "@/lib/repositories/settings.repository";
import { useCharacters } from "@/lib/repositories/characters.repository";
import { addAsset, assetFromResponse, DEMO_SPECS, toggleFavorite, useAssets } from "@/lib/store";
import type { DemoSpec } from "@/lib/store";
import type { GenerationSettings } from "@/lib/types";

const COPY = {
  image: {
    title: "Generate Image",
    subtitle: "Turn your idea into a stunning image.",
    emptyTitle: "Your image will appear here",
  },
  video: {
    title: "Generate Video",
    subtitle: "Bring your idea to life with motion.",
    emptyTitle: "Your video will appear here",
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
  const [enhancing, setEnhancing] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [activeVariant, setActiveVariant] = useState(0);

  const { job, run, cancel, reset } = useGeneration();
  const { assets } = useAssets();
  const { settings: userSettings } = useSettings();
  const { characters } = useCharacters();
  const catalog = useModelCatalog(kind);

  // Character reuse: the attached cast's identities are folded into the
  // prompt at generate time; the textarea keeps holding only the scene.
  const attachedCharacters = characters.filter((character) =>
    userSettings.soloCharacterIds.includes(character.id),
  );

  // Active model: the user's stored pick for this kind, else the catalog default.
  const modelId =
    (kind === "video" ? userSettings.videoModel : userSettings.imageModel) ??
    catalog.defaultModelId;
  const activeModel = catalog.models.find((model) => model.id === modelId);
  // Style presets are per-model: provider-workflow models (e.g. Seedance)
  // take only the raw prompt, so the style picker disables itself.
  const stylesSupported =
    catalog.models.find((model) => model.id === modelId)?.stylesSupported ?? true;

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
  // Live render progress (Sogni streams percents; other providers send coarse
  // stages) — falls back to the classic phase copy while nothing has arrived.
  const progress = job.phase === "generating" ? job.progress : undefined;
  const statusLine =
    progress?.message ??
    (job.phase === "queued" ? "Queued — waiting for a free render slot…" : "Generating your render…");
  const result = job.phase === "completed" ? job.response : null;
  const shownMedia =
    result?.media[activeVariant] ?? result?.media[0] ?? null;
  const shownUrl = shownMedia?.url ?? null;
  // Real provider mp4s carry a video mime; keyframe "videos" stay images.
  const isRealVideo = shownMedia?.mime?.startsWith("video/") ?? false;

  useEffect(() => setActiveVariant(0), [result?.requestId]);

  const [aspectW, aspectH] = settings.aspect.split(":").map(Number);
  const aspectRatio = `${aspectW} / ${aspectH}`;
  // object-contain behaviour for the ratio box: sized with container-query
  // units so a portrait selection (e.g. the video default 9:16) can never
  // overflow the preview panel on any aspect ratio or viewport.
  const fitBox = {
    aspectRatio: aspectRatio,
    width: `min(100cqw, calc(100cqh * ${aspectW} / ${aspectH}))`,
    height: `min(100cqh, calc(100cqw * ${aspectH} / ${aspectW}))`,
  } as const;

  function patchSettings(patch: Partial<GenerationSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  // Settings restored from storage may predate the active model's limits
  // (e.g. a 5s clip under MiniMax H3) — snap them once the catalog lands.
  // The effect settles after one pass: snapSettingsForModel returns an empty
  // patch once the settings already fit. LoRA selections snap too: entries
  // the new model doesn't accept drop, and an unavailable catalog (no loras
  // served) leaves selections untouched rather than wiping them.
  useEffect(() => {
    setSettings((s) => ({
      ...s,
      ...snapSettingsForModel(activeModel?.videoLimits, s),
      ...(catalog.loras.length && activeModel
        ? {
            loras: snapLorasForModel(
              s.loras ?? [],
              catalog.loras,
              activeModel.model,
              catalog.loraMaxPerRequest,
            ),
          }
        : {}),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the active model's identity changes
  }, [catalog.models, modelId]);

  // Detached-render recovery: a solo render that outlived its timeout keeps
  // going on the provider; when the pending-renders registry reports it
  // recovered, land it in History from here. (Story scenes attach via the
  // story page instead — their records carry a clientTag.)
  useEffect(() => {
    async function absorb() {
      try {
        const response = await fetch("/api/renders/pending", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          renders?: {
            id: string;
            kind: "image" | "video";
            modelId: string;
            prompt: string;
            clientTag?: string;
            status: string;
            media?: { url: string; mime: string };
          }[];
        };
        for (const render of payload.renders ?? []) {
          if (render.status !== "recovered" || !render.media?.url) continue;
          if (render.clientTag) continue;
          addAsset({
            id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            kind: render.kind,
            title: render.prompt.slice(0, 60),
            prompt: render.prompt,
            url: render.media.url,
            variants: [render.media.url],
            posterUrl: render.media.url,
            settings: {
              ...(render.kind === "video"
                ? { ...DEFAULT_VIDEO_SETTINGS }
                : { ...DEFAULT_IMAGE_SETTINGS }),
              kind: render.kind,
              modelId: render.modelId || undefined,
            },
            createdAt: Date.now(),
            favorite: false,
            mode: render.kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
            meta: { example: false },
          });
          await fetch(`/api/renders/pending?id=${encodeURIComponent(render.id)}`, {
            method: "DELETE",
          });
          toast.push(
            "A render that kept going on the provider finished — added to History.",
            "success",
          );
        }
      } catch {
        // Server unavailable — the next tick retries.
      }
    }
    void absorb();
    const timer = setInterval(absorb, 30_000);
    return () => clearInterval(timer);
  }, [toast]);

  async function handleGenerate() {
    if (!prompt.trim()) {
      setPromptError("Describe what you want to create before generating.");
      return;
    }
    setPromptError(undefined);
    setAssetId(null);

    // Uncensored Mode is the single gate: off ⇒ the provider safety checker
    // stays on; on ⇒ safety off for this request.
    const uncensored = userSettings.uncensoredEnabled;
    const nextSettings: GenerationSettings = {
      ...settings,
      kind,
      modelId: modelId ?? undefined,
      safe: !uncensored,
    };

    const response = await run({
      settings: nextSettings,
      // The attached cast's (sanitized) anchors lead; the scene follows.
      prompt: composeSceneWithCharacters(
        prompt.trim(),
        attachedCharacters.map((character) => character.spec),
        uncensored,
      ),
      uncensored,
    });
    if (!response) return;

    const asset = assetFromResponse(response, nextSettings, prompt.trim());
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

  function handleExamplePick(demo: DemoSpec) {
    setPrompt(demo.prompt.slice(0, PROMPT_MAX));
    if (promptError) setPromptError(undefined);
    toast.push(`“${demo.title}” example loaded — tweak it and press Generate.`);
  }

  // Enhancement considers the live studio configuration: kind, style (only
  // when the model honours presets), aspect, clip length and negative prompt.
  async function handleEnhancePrompt() {
    const current = prompt.trim();
    if (!current || busy || enhancing) return;
    setEnhancing(true);
    try {
      const result = await requestPromptEnhancement({
        prompt: current,
        kind,
        style: stylesSupported ? settings.style : null,
        stylesSupported,
        aspect: settings.aspect,
        duration: kind === "video" ? settings.duration : null,
        negativePrompt: settings.negativePrompt,
      });
      setPrompt(result.enhanced.slice(0, PROMPT_MAX));
      toast.push(
        result.source === "ai"
          ? "Prompt enhanced with AI — review it and press Generate."
          : "Prompt enriched with style and lighting cues — AI enhancement is unavailable right now.",
        "success",
      );
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      toast.push(
        (error as Error).message || "Could not enhance the prompt.",
        "error",
      );
    } finally {
      setEnhancing(false);
    }
  }

  // Newest renders from History, shown when the current result has no
  // variations to display. The active render itself is excluded.
  const previousAssets = useMemo(() => {
    return assets
      .filter((a) => a.id !== assetId)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6);
  }, [assets, assetId]);

  return (
    // `main` is a flex column: on desktop the workspace stretches to fill the
    // viewport under the header; on mobile the stack flows naturally and the
    // page scrolls instead of crushing the panels.
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5 lg:min-h-0">
      <div className="relative flex shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link
              href="/"
              aria-label="Back to home"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
            >
              <Icon name="arrow-left" size={16} />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-extrabold tracking-[-0.02em] text-ink sm:text-[21px]">
                {copy.title}
              </h1>
              <p className="mt-0.5 hidden truncate text-[12px] text-muted lg:block">
                {copy.subtitle}
              </p>
            </div>
            {result && (
              <span className="hidden shrink-0 sm:inline-flex">
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

        {/* Centered Solo ⇄ Story mode switch */}
        <div className="flex justify-center sm:absolute sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2">
          <Segmented
            ariaLabel="Studio mode"
            size="sm"
            value="solo"
            onChange={(next) => {
              if (next === "story") router.push("/story");
            }}
            options={[
              { value: "solo", label: "Solo Mode", icon: "user" },
              { value: "story", label: "Story Mode", icon: "story" },
            ]}
          />
        </div>
      </div>

      {/* ---------------------------- Workspace ---------------------------- */}
      <div className="mt-3 grid min-w-0 gap-4 lg:mt-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(330px,400px)_minmax(0,1fr)] lg:items-stretch">
        {/* Composer — first in the stack on every size; it fills its column
            on desktop so no space is wasted above or below it. */}
        <div className="order-1 flex min-h-0 min-w-0 flex-col">
          <PromptComposer
            kind={kind}
            prompt={prompt}
            onPromptChange={(value) => {
              setPrompt(value);
              if (promptError) setPromptError(undefined);
            }}
            promptError={promptError}
            settings={settings}
            headerBadge={
              <Badge tone="primary">
                <Icon name="sparkle" size={12} /> Solo
              </Badge>
            }
            models={catalog.models}
            modelId={modelId}
            onModelChange={(nextModel) => {
              setSelectedModel(kind, nextModel);
              // Keep the stored settings renderable by the NEW model: e.g.
              // switching to MiniMax H3 moves a 5s clip to its ≥5.167s floor.
              const next = catalog.models.find((model) => model.id === nextModel);
              patchSettings({
                modelId: nextModel,
                ...snapSettingsForModel(next?.videoLimits, settings),
              });
            }}
            stylesSupported={stylesSupported}
            videoLimits={activeModel?.videoLimits}
            loraCatalog={catalog.loras}
            loraMaxPerRequest={catalog.loraMaxPerRequest}
            loraCapable={activeModel?.loraCapable === true}
            loraModel={activeModel?.model}
            // The live Uncensored toggle is the gate — settings.safe is only
            // stamped onto the request at generate time, never before.
            allowNsfwLoras={userSettings.uncensoredEnabled}
            onSettingsChange={patchSettings}
            characters={characters}
            characterIds={userSettings.soloCharacterIds}
            onCharactersChange={setSoloCharacters}
            busy={busy}
            onGenerate={handleGenerate}
            onCancel={cancel}
            onCopyPrompt={handleCopyPrompt}
            onEnhancePrompt={() => void handleEnhancePrompt()}
            enhancing={enhancing}
          />
        </div>

        {/* Preview — the ratio-locked canvas sits top-left; a strip below the
            canvas shows variations, or previous generations when there are
            none, or examples on a first run. */}
        <div className="relative order-2 flex min-h-[300px] flex-col gap-3 overflow-hidden rounded-[20px] border border-border bg-surface p-3 sm:min-h-[360px] lg:min-h-0">
          {/* Canvas — a size container so ratio boxes fit-contain within it.
              The box hugs its ratio and hangs from the top, centred. */}
          <div
            className={`relative flex min-h-0 flex-1 [container-type:size] ${
              job.phase === "idle" || job.phase === "completed"
                ? "items-start justify-center"
                : "items-center justify-center"
            }`}
          >
            {job.phase === "idle" && (
              <div
                className="relative flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong px-6 text-center"
                style={fitBox}
              >
                <span className="inline-flex size-12 items-center justify-center rounded-full bg-white text-muted shadow-card">
                  <Icon name={kind === "video" ? "video" : "image"} size={22} />
                </span>
                <p className="mt-3.5 text-[15px] font-bold text-ink">
                  {copy.emptyTitle}
                </p>
                <p className="mt-1 max-w-xs text-[13px] text-muted">
                  Add a prompt and configure your settings to get started.
                </p>
                <span className="absolute bottom-3 right-3 rounded-full bg-white px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted shadow-card">
                  {settings.aspect} · {settings.resolution}
                </span>
              </div>
            )}

            {busy && (
              <div className="flex flex-col items-center gap-3">
                <div className="skeleton rounded-[16px]" style={fitBox} />
                <RenderProgress message={statusLine} percent={progress?.percent} />
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
              <div
                className="relative overflow-hidden rounded-[14px] bg-surface-2 shadow-card"
                style={fitBox}
              >
                {kind === "video" ? (
                  <VideoStage
                    fit
                    fitStyle={{
                      aspectRatio: fitBox.aspectRatio,
                      width: "100%",
                      height: "100%",
                    }}
                    posterUrl={shownUrl}
                    videoUrl={isRealVideo ? shownUrl : undefined}
                    title={prompt || "Generated video"}
                    durationSeconds={Number(settings.duration.replace("s", ""))}
                    sensitive={settings.safe === false}
                  />
                ) : (
                  <MediaFrame
                    fit
                    src={shownUrl}
                    alt={prompt || "Generated image"}
                    rounded="rounded-none"
                    priority
                    sensitive={settings.safe === false}
                    detailed
                  />
                )}

                {/* Floating actions, so no space is spent on a toolbar row. */}
                <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5">
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
              </div>
            )}
          </div>

          {/* Strip under the canvas: variations, else previous renders. */}
          {job.phase === "completed" && result && result.media.length > 1 && (
            <ThumbStrip
              label="Variations"
              thumbs={result.media.map((media, index) => ({
                key: media.id,
                src: media.url,
                title: `Show variation ${index + 1}`,
                active: index === activeVariant,
                sensitive: settings.safe === false,
                onClick: () => setActiveVariant(index),
              }))}
            />
          )}
          {!(job.phase === "completed" && result && result.media.length > 1) &&
            previousAssets.length > 0 && (
              <ThumbStrip
                label="Previous generations"
                thumbs={previousAssets.map((asset) => ({
                  key: asset.id,
                  src: asset.url,
                  title: asset.title,
                  sensitive: isSensitiveAsset(asset),
                  onClick: () => router.push(`/results?id=${asset.id}`),
                }))}
              />
            )}
          {(job.phase === "idle" || job.phase === "completed") &&
            previousAssets.length === 0 &&
            !(job.phase === "completed" && result && result.media.length > 1) && (
              <ExampleStrip onPick={handleExamplePick} />
            )}
        </div>
      </div>
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

/** A labelled horizontal row of thumbnails (variations, history, examples). */
function ThumbStrip({
  label,
  thumbs,
}: {
  label: string;
  thumbs: {
    key: string;
    src: string;
    title: string;
    active?: boolean;
    sensitive?: boolean;
    onClick: () => void;
  }[];
}) {
  if (!thumbs.length) return null;
  return (
    <div className="shrink-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
        {label}
      </p>
      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
        {thumbs.map((thumb) => (
          <button
            key={thumb.key}
            type="button"
            onClick={thumb.onClick}
            aria-label={thumb.title}
            aria-pressed={thumb.active}
            title={thumb.title}
            className={`shrink-0 overflow-hidden rounded-[12px] border-2 transition-colors ${
              thumb.active
                ? "border-primary"
                : "border-border hover:border-border-strong"
            }`}
          >
            <MediaFrame
              src={thumb.src}
              alt=""
              ratio="16/9"
              rounded="rounded-[10px]"
              className="w-36"
              sensitive={thumb.sensitive}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Pre-rendered examples under the empty preview; clicking loads the prompt. */
function ExampleStrip({ onPick }: { onPick: (demo: DemoSpec) => void }) {
  return (
    <ThumbStrip
      label="Try an example"
      thumbs={DEMO_SPECS.map((demo) => ({
        key: String(demo.seed),
        src: demo.file,
        title: demo.title,
        onClick: () => onPick(demo),
      }))}
    />
  );
}
