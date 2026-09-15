"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
} from "@/lib/constants";
import { downloadMedia, requestGeneration } from "@/lib/generation";
import { requestPromptEnhancement } from "@/lib/enhancement";
import { useModelCatalog } from "@/lib/model-catalog";
import {
  setSelectedModel,
  useSettings,
} from "@/lib/repositories/settings.repository";
import { isVideoSource } from "@/lib/renderer";
import { addAsset } from "@/lib/store";
import type { Asset, GenerationSettings, StoryScene } from "@/lib/types";
import { StoryPlayer } from "@/components/StoryPlayer";

const CONTINUATIONS = [
  "an establishing wide shot that sets the scene",
  "the journey continues deeper into the landscape",
  "a quiet turning point with dramatic light",
  "the closing resolve shot, warm and hopeful",
];

/** Placeholder copy for empty scene slots (after the first). */
const PLACEHOLDERS = ["Continue the story", "Add an end…", "Add another scene"];

export default function StoryPage() {
  const toast = useToast();
  const router = useRouter();
  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | undefined>();
  const [enhancing, setEnhancing] = useState(false);
  const [settings, setSettings] = useState<GenerationSettings>({
    ...DEFAULT_IMAGE_SETTINGS,
    kind: "image",
    count: 1,
  });
  const [scenes, setScenes] = useState<StoryScene[]>([]);
  const [busy, setBusy] = useState(false);
  const [storyId, setStoryId] = useState<string | null>(null);
  const [playOpen, setPlayOpen] = useState(false);

  const { settings: userSettings } = useSettings();
  const catalog = useModelCatalog(kind);
  const modelId =
    (kind === "video" ? userSettings.videoModel : userSettings.imageModel) ??
    catalog.defaultModelId;
  // Style presets are per-model: provider-workflow models take only the raw
  // prompt, so both the picker and enhancement skip the style context.
  const stylesSupported =
    catalog.models.find((model) => model.id === modelId)?.stylesSupported ?? true;

  function currentSettings(): GenerationSettings {
    return {
      ...settings,
      kind,
      modelId: modelId ?? undefined,
      safe: !userSettings.uncensoredEnabled,
    };
  }

  async function generateScene(index: number, draft: StoryScene[]) {
    const scene = draft[index];
    const settingsValue = currentSettings();
    const response = await requestGeneration({
      settings: settingsValue,
      prompt: scene.prompt,
      uncensored: userSettings.uncensoredEnabled,
      // Stream the render pipeline into the scene slot so a slow video render
      // shows live progress instead of a frozen skeleton.
      onProgress: (progress) =>
        setScenes((prev) =>
          prev.map((s) => (s.id === scene.id ? { ...s, progress } : s)),
        ),
    });
    const media = response.media[0];
    const url = media?.url ?? null;
    const next = draft.map((s, i) =>
      i === index
        ? {
            ...s,
            url,
            mime: media?.mime,
            status: "completed" as const,
            kind,
            progress: undefined,
          }
        : s,
    );
    setScenes([...next]);
    persistStory(next, settingsValue);
    return next;
  }

  function persistStory(list: StoryScene[], settingsValue: GenerationSettings) {
    const withMedia = list.filter((s) => s.url);
    if (!withMedia.length) return;
    const asset: Asset = {
      id: storyId ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: "story",
      title: prompt.slice(0, 40) || "Untitled story",
      prompt,
      url: withMedia[0].url as string,
      variants: withMedia.map((s) => s.url as string),
      posterUrl: withMedia[0].url as string,
      settings: settingsValue,
      createdAt: Date.now(),
      favorite: false,
      mode: "Story Mode",
      scenes: list,
      meta: { scenes: withMedia.length, style: settingsValue.style },
    };
    addAsset(asset);
    setStoryId(asset.id);
  }

  async function handleGenerateAll() {
    if (!prompt.trim()) {
      setPromptError("Describe the first scene of your story before generating.");
      return;
    }
    setPromptError(undefined);
    setBusy(true);

    let draft: StoryScene[] = scenes.length
      ? scenes
      : [
          {
            id: "sc_1",
            prompt: prompt.trim(),
            url: null,
            status: "queued",
            kind,
          },
        ];
    setScenes(draft);

    try {
      for (let i = 0; i < draft.length; i += 1) {
        if (draft[i].url) continue;
        draft = draft.map((s, idx) =>
          idx === i ? { ...s, status: "generating" as const } : s,
        );
        setScenes([...draft]);
        draft = await generateScene(i, draft);
      }
      toast.push(`Story saved with ${draft.filter((s) => s.url).length} scenes.`, "success");
    } catch (error) {
      const message = (error as Error).message ?? "Scene generation failed.";
      setScenes((prev) =>
        prev.map((s) => (s.status === "generating" ? { ...s, status: "failed" } : s)),
      );
      toast.push(message, "error");
    } finally {
      setBusy(false);
    }
  }

  function addScene() {
    const index = scenes.length;
    const continuation = CONTINUATIONS[Math.min(index, CONTINUATIONS.length - 1)];
    setScenes((prev) => [
      ...prev,
      {
        id: `sc_${prev.length + 1}_${Math.random().toString(36).slice(2, 5)}`,
        prompt: `${prompt.trim()}, ${continuation}`,
        url: null,
        status: "queued",
        kind,
      },
    ]);
    toast.push("Scene added. Generate the story to render it.");
  }

  function reset() {
    setScenes([]);
    setStoryId(null);
    setPlayOpen(false);
  }

  // Completed scenes in story order — the reel the player walks through.
  const playableScenes = scenes
    .filter((scene): scene is StoryScene & { url: string } => Boolean(scene.url))
    .map((scene) => ({ url: scene.url, mime: scene.mime, label: scene.prompt }));

  // Enhancement carries the story configuration too: the scene position tells
  // the enhancer to keep characters and environment consistent across scenes.
  async function handleEnhancePrompt() {
    const current = prompt.trim();
    if (!current || busy || enhancing) return;
    setEnhancing(true);
    try {
      const sceneCount = Math.max(1, scenes.length);
      const result = await requestPromptEnhancement({
        prompt: current,
        kind,
        style: stylesSupported ? settings.style : null,
        stylesSupported,
        aspect: settings.aspect,
        duration: kind === "video" ? settings.duration : null,
        sceneIndex: 1,
        sceneCount,
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

  return (
    // Same workspace contract as the solo generator: on desktop the two panels
    // stretch to fill the viewport; on mobile the stack flows and the page
    // scrolls when scenes grow beyond it.
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
                Generate a Story
              </h1>
            <p className="mt-0.5 hidden truncate text-[12px] text-muted lg:block">
              A sequence of scenes that tell one story.
            </p>
            </div>
          </div>

          <Segmented
            ariaLabel="Story media type"
            size="sm"
            collapseOnMobile
            value={kind}
            onChange={(next) => {
              setKind(next);
              // The style table is kind-specific; a stale image style on a
              // video scene used to fail validation server-side.
              setSettings((s) => ({
                ...s,
                kind: next,
                style:
                  next === "video"
                    ? DEFAULT_VIDEO_SETTINGS.style
                    : DEFAULT_IMAGE_SETTINGS.style,
              }));
            }}
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
            value="story"
            onChange={(next) => {
              if (next === "solo") router.push("/generate/image");
            }}
            options={[
              { value: "solo", label: "Solo Mode", icon: "user" },
              { value: "story", label: "Story Mode", icon: "story" },
            ]}
          />
        </div>
      </div>

      {/* ---------------------------- Workspace ---------------------------- */}
      <div className="mt-3 grid min-w-0 gap-4 sm:mt-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(330px,400px)_minmax(0,1fr)] lg:items-stretch">
        {/* Composer column */}
        <div className="order-1 flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <PromptComposer
              kind={kind}
              title="Story composer"
              headerBadge={
                <Badge tone="primary">
                  <Icon name="story" size={12} /> {scenes.length || 1} scene
                  {scenes.length === 1 ? "" : "s"}
                </Badge>
              }
              prompt={prompt}
              onPromptChange={(value) => {
                setPrompt(value);
                if (promptError) setPromptError(undefined);
              }}
              promptError={promptError}
              settings={currentSettings()}
              onSettingsChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
              models={catalog.models}
              modelId={modelId}
              stylesSupported={stylesSupported}
              onModelChange={(nextModel) => {
                setSelectedModel(kind, nextModel);
                setSettings((s) => ({ ...s, modelId: nextModel }));
              }}
              busy={busy}
              onGenerate={handleGenerateAll}
              onCancel={() => setBusy(false)}
              onEnhancePrompt={() => void handleEnhancePrompt()}
              enhancing={enhancing}
              onCopyPrompt={() => {
                void navigator.clipboard
                  ?.writeText(prompt)
                  .then(() => toast.push("Prompt copied.", "success"));
              }}
            />
          </div>

          <div className="mt-3 flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              block
              icon="plus"
              disabled={busy || scenes.length >= 6}
              onClick={addScene}
            >
              Add scene
            </Button>
            <span className="shrink-0 text-[11px] text-muted">Max 6</span>
          </div>
        </div>

        {/* Scenes column */}
        <div className="order-2 flex min-h-[300px] min-w-0 flex-col rounded-[20px] border border-border bg-surface p-4 sm:min-h-[360px] lg:min-h-0">
          {/* Story starts with Scene 1 in the top-left slot; the remaining
              slots stay as placeholders (three are always visible). */}
          {/* Scenes flow top-left, left to right, wrapping downward. */}
          <div className="grid flex-1 content-start gap-4 sm:grid-cols-3">
            {Array.from({ length: Math.max(3, scenes.length) }, (_, index) => {
              const typed = scenes[index] as StoryScene | undefined;
              const ratioStyle = {
                aspectRatio: `${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`,
              };
              return (
                <div key={typed?.id ?? `slot-${index}`} className="min-w-0">
                  {typed?.url ? (
                    kind === "video" ? (
                      <VideoStage
                        posterUrl={typed.url}
                        videoUrl={
                          typed.mime?.startsWith("video/") || isVideoSource(typed.url)
                            ? typed.url
                            : undefined
                        }
                        title={typed.prompt}
                        durationSeconds={Number(String(settings.duration).replace("s", "")) || 5}
                      />
                    ) : (
                      <MediaFrame
                        src={typed.url}
                        alt={typed.prompt}
                        ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                      />
                    )
                  ) : typed && (typed.status === "generating" || typed.status === "queued") ? (
                    // Live render progress: video scenes take 30–90s, so the
                    // slot streams the pipeline's stage + percent (same design
                    // language as the solo preview) instead of a bare skeleton.
                    <div
                      className="relative w-full overflow-hidden rounded-[14px] border border-border bg-surface-2"
                      style={ratioStyle}
                    >
                      <div className="skeleton absolute inset-0" />
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
                        <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted">
                          <Icon name="clock" size={13} />
                          {typed.progress?.message ??
                            (typed.status === "queued"
                              ? "Queued — waiting for a free render slot…"
                              : "Generating scene…")}
                        </p>
                        <div className="h-1 w-28 overflow-hidden rounded-full bg-ink/10">
                          {typed.progress?.percent !== undefined ? (
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                              style={{ width: `${typed.progress.percent}%` }}
                            />
                          ) : (
                            <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
                          )}
                        </div>
                      </div>
                    </div>
                  ) : index === 0 ? (
                    // Scene 1: an active starting point, not a dashed slot.
                    <div
                      className="flex flex-col items-center justify-center rounded-[16px] border border-border bg-white px-3 text-center shadow-card"
                      style={ratioStyle}
                    >
                      <span className="inline-flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary">
                        <Icon name="sparkle" size={18} />
                      </span>
                      <p className="mt-2 text-[12.5px] font-bold text-ink">
                        Your first scene
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        Describe it in the composer
                      </p>
                    </div>
                  ) : (
                    <div
                      className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong bg-white px-3 text-center"
                      style={ratioStyle}
                    >
                      <Icon name="image" size={20} className="text-muted" />
                      <p className="mt-2 text-[12px] font-semibold text-muted">
                        {PLACEHOLDERS[Math.min(index - 1, PLACEHOLDERS.length - 1)]}
                      </p>
                    </div>
                  )}
                  <p className="mt-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                    Scene {index + 1}
                  </p>
                  {typed?.prompt && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft">
                      {typed.prompt}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3.5">
            {scenes.some((s) => s.url) ? (
              <>
                <Button
                  size="sm"
                  icon="play"
                  onClick={() => setPlayOpen(true)}
                  disabled={!playableScenes.length}
                >
                  Play story
                </Button>
                <Button
                  size="sm"
                  icon="download"
                  onClick={() => {
                    const first = scenes.find((s) => s.url);
                    if (first?.url) {
                      downloadMedia(first.url, `perabyte-story-${Date.now()}`);
                      toast.push("Your download has started.", "success");
                    }
                  }}
                >
                  Download first scene
                </Button>
                {storyId && (
                  <Link
                    href={`/results?id=${storyId}`}
                    className="inline-flex h-9 items-center gap-2 rounded-[12px] border border-border-strong bg-white px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                  >
                    Open in Results
                    <Icon name="arrow-right" size={15} />
                  </Link>
                )}
                <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
                  Start over
                </Button>
              </>
            ) : (
              <p className="text-[11.5px] text-muted">
                Scenes render one at a time. Every completed scene is stored in History.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Full-story reel: plays every completed scene back-to-back. */}
      {playOpen && playableScenes.length > 0 && (
        <StoryPlayer
          scenes={playableScenes}
          sceneSeconds={Number(String(settings.duration).replace("s", "")) || 5}
          onClose={() => setPlayOpen(false)}
        />
      )}
    </div>
  );
}
