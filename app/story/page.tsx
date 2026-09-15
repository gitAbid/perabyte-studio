"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ConvertDialog } from "@/components/story/ConvertDialog";
import { SceneRefChips } from "@/components/story/SceneRefChips";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import { PromptComposer } from "@/components/PromptComposer";
import { Badge, Button, Segmented, useToast } from "@/components/ui";
import {
  ASPECTS,
  DEFAULT_IMAGE_SETTINGS,
  PROMPT_MAX,
  VIDEO_STYLES,
} from "@/lib/constants";
import { downloadMedia } from "@/lib/generation";
import {
  EnhancementError,
  requestPromptEnhancement,
} from "@/lib/enhancement";
import { useModelCatalog, type ModelOption } from "@/lib/model-catalog";
import { refFromMediaUrl, uploadFrameRef } from "@/lib/media/frame";
import {
  addAsset,
  updateAsset,
  updateStoryScenes,
  useAssets,
} from "@/lib/store";
import { appRunner } from "@/lib/story/runner";
import {
  buildClipScenes,
  resolveEndCapableModel,
  type ConvertSource,
} from "@/lib/story/convert";
import { isVideoSource } from "@/lib/renderer";
import {
  setSelectedModel,
  useSettings,
} from "@/lib/repositories/settings.repository";
import type { Asset, GenerationSettings, StoryScene } from "@/lib/types";

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
  const [settings, setSettings] = useState<GenerationSettings>({
    ...DEFAULT_IMAGE_SETTINGS,
    kind: "image",
    count: 1,
  });
  const [storyId, setStoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [continuityOn, setContinuityOn] = useState(true);
  const [convertOpen, setConvertOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);

  const { assets } = useAssets();
  const story = storyId ? assets.find((a) => a.id === storyId) : undefined;
  const scenes: StoryScene[] = useMemo(() => story?.scenes ?? [], [story]);

  const { settings: userSettings } = useSettings();
  const catalog = useModelCatalog(kind);
  const modelId =
    (kind === "video" ? userSettings.videoModel : userSettings.imageModel) ??
    catalog.defaultModelId;

  // End-capable catalog for the conversion dialog (image stories only).
  const endCatalog = useModelCatalog("video", "end");

  const selectedModel = catalog.models.find((m) => m.id === modelId);
  const endSupported = Boolean(selectedModel?.frameInput?.end);

  function currentSettings(): GenerationSettings {
    return {
      ...settings,
      kind,
      modelId: modelId ?? undefined,
      safe: !userSettings.uncensoredEnabled,
    };
  }

  /* ------------------------- queue integration ------------------------- */

  async function handleGenerateAll() {
    if (!prompt.trim()) {
      setPromptError("Describe the first scene of your story before generating.");
      return;
    }
    setPromptError(undefined);

    // The persisted story asset IS the queue; the runner executes it.
    const draft: StoryScene[] = scenes.length
      ? [...scenes]
      : [
          {
            id: "sc_1",
            prompt: prompt.trim(),
            url: null,
            status: "queued",
            kind,
          },
        ];
    const id =
      storyId ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const asset: Asset = {
      id,
      kind: "story",
      title: prompt.slice(0, 40) || "Untitled story",
      prompt,
      url: draft.find((s) => s.url)?.url ?? "",
      variants: [],
      settings: currentSettings(),
      createdAt: Date.now(),
      favorite: false,
      mode: "Story Mode",
      scenes: draft,
      meta: {
        continuity: continuityOn,
        running: true,
        style: currentSettings().style,
      },
    };
    addAsset(asset);
    setStoryId(id);
    setBusy(true);
    appRunner.start(id);
    toast.push("Rendering your story — scenes appear as they finish.");
  }

  function setStoryRunning(running: boolean) {
    if (!storyId) return;
    const meta = { ...(story?.meta ?? {}), continuity: continuityOn, running };
    updateAsset(storyId, { meta });
  }

  function handleCancel() {
    if (storyId) {
      appRunner.cancel(storyId);
      setStoryRunning(false);
    }
    setBusy(false);
  }

  function toggleContinuity() {
    const next = !continuityOn;
    setContinuityOn(next);
    if (storyId) {
      // Re-schedule under the new rule: ON chains the rest from the latest
      // completed frame; OFF releases every queued scene in parallel.
      const meta = { ...(story?.meta ?? {}), continuity: next, running: true };
      updateAsset(storyId, { meta });
      appRunner.start(storyId);
    }
  }

  /* ------------------------------ convert ------------------------------ */

  const convertSources: (ConvertSource & { url: string })[] = scenes
    .filter((s) => s.status === "completed" && s.url && s.kind === "image")
    .map((s) => ({
      sceneId: s.id,
      prompt: s.prompt,
      url: s.url as string,
      ref: refFromMediaUrl(s.url),
    }))
    .filter((s): s is ConvertSource & { url: string } => Boolean(s.ref));
  const canConvert = convertSources.length >= 2;
  const clipCount = Math.max(0, convertSources.length - 1);
  const conversionModelId = resolveEndCapableModel(
    modelId ?? undefined,
    new Set(endCatalog.models.map((m) => m.id)),
    endCatalog.models.map((m) => m.id),
  );

  async function handleConvert(chosenModelId: string) {
    setConvertOpen(false);
    if (convertSources.length < 2) return;
    try {
      // Normalize refs: provider-URL scenes (Pollinations) must be fetched
      // through our proxy and uploaded into the cache first.
      const sources: ConvertSource[] = [];
      for (const source of convertSources) {
        sources.push({
          sceneId: source.sceneId,
          prompt: source.prompt,
          ref: source.ref
            ? source.ref
            : await uploadFrameRef(
                await (await fetch(`/api/media?u=${encodeURIComponent(source.url)}`)).blob(),
              ),
        });
      }

      const clips = buildClipScenes(sources);
      if (!clips.length) return;
      const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const asset: Asset = {
        id,
        kind: "story",
        title: `${story?.title ?? (prompt.slice(0, 40) || "Story")} (video)`,
        prompt: story?.prompt ?? prompt,
        url: clips[0].startImageRef ? `/api/media?f=${clips[0].startImageRef}` : "",
        variants: [],
        settings: {
          ...currentSettings(),
          kind: "video",
          style: Object.keys(VIDEO_STYLES)[0],
          modelId: chosenModelId,
        },
        createdAt: Date.now(),
        favorite: false,
        mode: "Story Mode",
        scenes: clips,
        meta: {
          continuity: true,
          running: true,
          convertedFrom: storyId ?? "",
          style: currentSettings().style,
        },
      };
      addAsset(asset);
      setStoryId(id);
      setKind("video");
      setBusy(true);
      appRunner.start(id);
      toast.push(`Animating ${clips.length} clip${clips.length === 1 ? "" : "s"}…`, "success");
    } catch (error) {
      toast.push((error as Error).message ?? "Conversion failed. Please retry.", "error");
    }
  }

  /* ------------------------------ helpers ------------------------------ */

  function addScene() {
    const index = scenes.length;
    const continuation = CONTINUATIONS[Math.min(index, CONTINUATIONS.length - 1)];
    const draft: StoryScene = {
      id: `sc_${index + 1}_${Math.random().toString(36).slice(2, 5)}`,
      prompt: `${prompt.trim()}, ${continuation}`,
      url: null,
      status: "queued",
      kind,
    };
    if (storyId && story) {
      updateStoryScenes(storyId, (list) => [...list, draft]);
      setStoryRunning(true);
      appRunner.start(storyId);
    } else {
      // No story yet — create the queue asset with just this scene.
      const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const asset: Asset = {
        id,
        kind: "story",
        title: prompt.slice(0, 40) || "Untitled story",
        prompt,
        url: "",
        variants: [],
        settings: currentSettings(),
        createdAt: Date.now(),
        favorite: false,
        mode: "Story Mode",
        scenes: [draft],
        meta: { continuity: continuityOn, running: false, style: currentSettings().style },
      };
      addAsset(asset);
      setStoryId(id);
    }
    toast.push("Scene added to the queue.");
  }

  function reset() {
    if (storyId) appRunner.cancel(storyId);
    setStoryId(null);
    setBusy(false);
  }

  async function handleEnhancePrompt() {
    if (!prompt.trim() || busy || enhancing) return;
    setEnhancing(true);
    try {
      const result = await requestPromptEnhancement({
        prompt,
        kind,
        style: selectedModel?.stylesSupported === false ? null : settings.style,
        stylesSupported: selectedModel?.stylesSupported !== false,
        aspect: settings.aspect,
        duration: kind === "video" ? settings.duration : null,
        sceneIndex: scenes.length ? scenes.length : 1,
        sceneCount: Math.max(1, scenes.length),
        negativePrompt: settings.negativePrompt || null,
      });
      setPrompt(result.enhanced.slice(0, PROMPT_MAX));
      toast.push("Prompt enhanced — review it and press Generate.", "success");
    } catch (error) {
      if ((error as EnhancementError)?.name !== "AbortError") {
        toast.push(
          (error as EnhancementError).message ?? "Prompt enhancement failed.",
          "error",
        );
      }
    } finally {
      setEnhancing(false);
    }
  }

  /* ------------------------------ rendering ---------------------------- */

  const hasAnyMedia = scenes.some((s) => s.url);

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
              setSettings((s) => ({ ...s, kind: next }));
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
              onModelChange={(nextModel) => {
                setSelectedModel(kind, nextModel);
                setSettings((s) => ({ ...s, modelId: nextModel }));
              }}
              busy={busy}
              onGenerate={handleGenerateAll}
              onCancel={handleCancel}
              onEnhancePrompt={handleEnhancePrompt}
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
            <button
              type="button"
              aria-pressed={continuityOn}
              onClick={toggleContinuity}
              title="Chain each scene to the previous scene's final frame"
              className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[12px] border px-3 text-[12.5px] font-semibold transition-colors ${
                continuityOn
                  ? "border-primary/30 bg-primary-soft text-primary"
                  : "border-border bg-white text-muted hover:text-ink"
              }`}
            >
              <Icon name="link" size={13} />
              Continuity: {continuityOn ? "On" : "Off"}
            </button>
          </div>
          <span className="mt-1.5 shrink-0 text-[11px] text-muted">
            {continuityOn
              ? "Scenes render one by one, each continuing from the last frame."
              : "Scenes render in parallel, independently."}
          </span>
        </div>

        {/* Scenes column */}
        <div className="order-2 relative flex min-h-[300px] min-w-0 flex-col rounded-[20px] border border-border bg-surface p-4 sm:min-h-[360px] lg:min-h-0">
          {convertOpen && (
            <ConvertDialog
              clipCount={clipCount}
              models={endCatalog.models as ModelOption[]}
              defaultModelId={conversionModelId}
              onConfirm={(chosen) => void handleConvert(chosen)}
              onClose={() => setConvertOpen(false)}
            />
          )}
          {/* Scenes flow top-left, left to right, wrapping downward. */}
          <div className="grid flex-1 content-start gap-4 sm:grid-cols-3">
            {Array.from({ length: Math.max(3, scenes.length) }, (_, index) => {
              const typed = scenes[index] as StoryScene | undefined;
              const ratioStyle = {
                aspectRatio: `${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`,
              };
              // A queued chain scene whose predecessor hasn't finished.
              const waitingFor =
                typed &&
                typed.status === "queued" &&
                continuityOn &&
                index > 0 &&
                !typed.startImageRef &&
                scenes[index - 1]?.status !== "completed";
              return (
                <div key={typed?.id ?? `slot-${index}`} className="min-w-0">
                  {typed?.url ? (
                    typed.kind === "video" ? (
                      <VideoStage
                        posterUrl={typed.url}
                        videoUrl={isVideoSource(typed.url) ? typed.url : undefined}
                        title={typed.prompt}
                        durationSeconds={5}
                      />
                    ) : (
                      <MediaFrame
                        src={typed.url}
                        alt={typed.prompt}
                        ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                      />
                    )
                  ) : typed && (typed.status === "generating" || typed.status === "queued") ? (
                    <div className="relative">
                      <div className="skeleton w-full rounded-[14px]" style={ratioStyle} />
                      {waitingFor && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-[14px]">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-ink shadow-card">
                            <Icon name="link" size={12} /> Waiting for Scene {index}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : index === 0 && !typed ? (
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
                    !typed && (
                      <div
                        className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong bg-white px-3 text-center"
                        style={ratioStyle}
                      >
                        <Icon name="image" size={20} className="text-muted" />
                        <p className="mt-2 text-[12px] font-semibold text-muted">
                          {PLACEHOLDERS[Math.min(index - 1, PLACEHOLDERS.length - 1)]}
                        </p>
                      </div>
                    )
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                      Scene {index + 1}
                    </p>
                    {typed?.status === "failed" && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600">
                        <Icon name="alert" size={11} /> failed
                      </span>
                    )}
                    {typed?.effectiveModelId && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold text-primary"
                        title={`Rendered with ${typed.effectiveModelId}`}
                      >
                        <Icon name="link" size={9} /> i2v
                      </span>
                    )}
                    {typed?.status === "completed" &&
                      scenes[index + 1]?.status === "queued" &&
                      continuityOn &&
                      !scenes[index + 1]?.startImageRef && (
                        <Icon name="link" size={11} className="text-muted" />
                      )}
                  </div>
                  {typed?.prompt && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft">
                      {typed.prompt}
                    </p>
                  )}
                  {typed && typed.status !== "generating" && (
                    <SceneRefChips
                      scene={typed}
                      endSupported={endSupported}
                      disabled={busy}
                      onChange={(patch) => {
                        if (!storyId) return;
                        updateStoryScenes(storyId, (list) =>
                          list.map((s) => (s.id === typed.id ? { ...s, ...patch } : s)),
                        );
                      }}
                      onError={(message) => toast.push(message, "error")}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3.5">
            {hasAnyMedia || scenes.length ? (
              <>
                {hasAnyMedia && (
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
                )}
                {canConvert && (
                  <Button
                    size="sm"
                    icon="video"
                    onClick={() => setConvertOpen(true)}
                    disabled={endCatalog.loading || !conversionModelId}
                  >
                    Convert to video
                  </Button>
                )}
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
                With Continuity on, scenes chain frame-to-frame. Every completed scene is stored in
                History.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
