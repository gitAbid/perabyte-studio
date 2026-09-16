"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConvertDialog } from "@/components/story/ConvertDialog";
import { SceneChainBadge } from "@/components/story/SceneChainBadge";
import { SceneRefChips } from "@/components/story/SceneRefChips";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import { PromptComposer } from "@/components/PromptComposer";
import { PillSelect } from "@/components/PillSelect";
import { RenderProgress } from "@/components/RenderProgress";
import { StoryPlayer } from "@/components/StoryPlayer";
import { Badge, Button, Segmented, useToast } from "@/components/ui";
import {
  ASPECTS,
  DEFAULT_IMAGE_SETTINGS,
  PROMPT_MAX,
} from "@/lib/constants";
import {
  downloadMedia,
  storyProgressPercent,
  type GenerationProgress,
} from "@/lib/generation";
import {
  EnhancementError,
  requestPromptEnhancement,
} from "@/lib/enhancement";
import { useModelCatalog, type ModelOption } from "@/lib/model-catalog";
import { snapLorasForModel } from "@/lib/lora-options";
import { refFromMediaUrl, uploadFrameRef } from "@/lib/media/frame";
import {
  addAsset,
  updateAsset,
  updateStoryScenes,
  useAssets,
} from "@/lib/store";
import { appRunner } from "@/lib/story/runner";
import {
  chainPredecessorIndex,
  effectiveChainRef,
  resolveChainModelPlan,
  type EffectiveChainRef,
} from "@/lib/story/chain";
import {
  buildClipScenes,
  buildConvertSettings,
  resolveEndCapableModel,
  type ConvertSource,
} from "@/lib/story/convert";
import { isVideoSource } from "@/lib/renderer";
import {
  setSelectedModel,
  setStoryCharacters,
  useSettings,
} from "@/lib/repositories/settings.repository";
import { useCharacters } from "@/lib/repositories/characters.repository";
import type { Asset, GenerationSettings, StoryScene } from "@/lib/types";

const CONTINUATIONS = [
  "an establishing wide shot that sets the scene",
  "the journey continues deeper into the landscape",
  "a quiet turning point with dramatic light",
  "the closing resolve shot, warm and hopeful",
];

/** Placeholder copy for empty scene slots (after the first). */
const PLACEHOLDERS = ["Continue the story", "Add an end…", "Add another scene"];

/** Whether a badge's reference frame comes from an 18+ render — the thumb
 * inherits the veil the source scene's own card would show. */
function chainBadgeSensitive(
  resolution: EffectiveChainRef,
  scenes: StoryScene[],
  scene: StoryScene,
): boolean {
  if (resolution.state === "chained") {
    return scenes[resolution.predecessorIndex]?.safe === false;
  }
  return scene.safe === false;
}

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
  const [storyId, setStoryIdState] = useState<string | null>(null);
  // Frame refs for the scene being authored in the composer. They attach to
  // the scene when it is committed (Generate or Add scene), then reset for
  // the next draft.
  const [draftRefs, setDraftRefs] = useState<{ startImageRef?: string; endImageRef?: string }>({});
  // Inline scene-prompt editing: one scene at a time, queued/canceled only.
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Guards against Escape unmounting the textarea and its blur committing
  // the edit anyway.
  const editCancelingRef = useRef(false);

  function setStoryId(id: string | null) {
    setStoryIdState(id);
    if (typeof window !== "undefined") {
      if (id) {
        sessionStorage.setItem("perabyte.active_story", id);
      } else {
        sessionStorage.removeItem("perabyte.active_story");
      }
    }
  }

  // Restore the active story on mount or reload (spec §5 — the queue survives
  // reloads; ?id= wins over the last active story). Opening via ?id= adopts
  // the story as active so refreshes keep it — addressable stories,
  // durable-jobs spec Phase A.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromUrl = new URLSearchParams(window.location.search).get("id");
    const fromStorage = sessionStorage.getItem("perabyte.active_story");
    const targetId = fromUrl ?? fromStorage;
    if (targetId) {
      setStoryId(targetId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [continuityOn, setContinuityOn] = useState(true);
  const [convertOpen, setConvertOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [playOpen, setPlayOpen] = useState(false);
  /** Live render ticks per scene id — transient, never persisted. */
  const [sceneProgress, setSceneProgress] = useState<Record<string, GenerationProgress>>({});

  const { assets } = useAssets();
  const story = storyId ? assets.find((a) => a.id === storyId) : undefined;
  const scenes: StoryScene[] = useMemo(() => story?.scenes ?? [], [story]);

  // The runner owns execution: the page is "busy" exactly while a scene is
  // in flight. Queued-but-blocked scenes don't count (their Generate press
  // retries/resumes).
  const running = scenes.some((s) => s.status === "generating");

  // Live provider ticks flow through the runner's hooks; a settled scene
  // never leaves a stale readout behind.
  useEffect(() => {
    appRunner.setHooks({
      onSceneProgress: (sceneId, progress) =>
        setSceneProgress((prev) => ({ ...prev, [sceneId]: progress })),
      onSceneSettled: (sceneId) =>
        setSceneProgress((prev) => {
          if (!(sceneId in prev)) return prev;
          const { [sceneId]: _drop, ...rest } = prev;
          return rest;
        }),
    });
  }, []);

  // Detached-render recovery: a scene whose provider render outlived our
  // timeout keeps going on their side; the pending-renders registry reports
  // it as recovered and we attach it to the waiting scene. Polled while the
  // story page is open.
  const recoveredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!storyId) return;
    const activeStoryId = storyId;
    const prefix = `${activeStoryId}:`;
    async function absorb() {
      try {
        const response = await fetch("/api/renders/pending", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          renders?: {
            id: string;
            provider: string;
            status: string;
            clientTag?: string;
            media?: { url: string; mime?: string };
          }[];
        };
        for (const render of payload.renders ?? []) {
          if (recoveredRef.current.has(render.id)) continue;
          const tag = typeof render.clientTag === "string" ? render.clientTag : "";
          if (!tag.startsWith(prefix)) continue;
          recoveredRef.current.add(render.id);
          if (render.status !== "recovered" || !render.media?.url) continue;
          const sceneId = tag.slice(prefix.length);
          const attached = await appRunner.absorbRecovered(activeStoryId, sceneId, render.media);
          if (attached) {
            await fetch(`/api/renders/pending?id=${encodeURIComponent(render.id)}`, {
              method: "DELETE",
            });
            toast.push(
              "A scene that kept rendering on the provider just finished — attached.",
              "success",
            );
          }
        }
      } catch {
        // Offline or server restarting — the next tick retries.
      }
    }
    void absorb();
    const timer = setInterval(absorb, 20_000);
    return () => clearInterval(timer);
  }, [storyId, toast]);

  // Sync continuity, prompt and media kind when the active story loads.
  useEffect(() => {
    if (!story) return;
    if (story.meta && typeof story.meta.continuity === "boolean") {
      setContinuityOn(story.meta.continuity);
    }
    if (story.prompt && !prompt) {
      setPrompt(story.prompt);
    }
    const storyMediaKind = story.settings?.kind;
    if (
      storyMediaKind &&
      (storyMediaKind === "image" || storyMediaKind === "video") &&
      storyMediaKind !== kind
    ) {
      setKind(storyMediaKind);
    }
    // Adopt the story's native aspect so scene tiles show what was actually
    // rendered (a 9:16 story must not present 16:9 tiles after a reload).
    const storyAspect = story.settings?.aspect;
    if (storyAspect && storyAspect in ASPECTS) {
      setSettings((s) => ({ ...s, aspect: storyAspect as typeof s.aspect }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  const { settings: userSettings } = useSettings();
  const { characters } = useCharacters();
  // Character reuse: the runner folds the attached cast's sanitized anchors
  // into every scene prompt at render time.
  const attachedCharacters = characters.filter((character) =>
    userSettings.storyCharacterIds.includes(character.id),
  );
  const catalog = useModelCatalog(kind);
  const modelId =
    (kind === "video" ? userSettings.videoModel : userSettings.imageModel) ??
    catalog.defaultModelId;

  // End-capable catalog for the conversion dialog (image stories only).
  const endCatalog = useModelCatalog("video", "end");
  // Start-capable catalog (hidden i2v siblings included) — names the model
  // chained scenes actually render with when the pick can't take a frame.
  const startCatalog = useModelCatalog("video", "start");

  const selectedModel = catalog.models.find((m) => m.id === modelId);
  const endSupported = Boolean(selectedModel?.frameInput?.end);
  // Style presets are per-model: provider-workflow models take only the raw prompt.
  const stylesSupported = selectedModel?.stylesSupported ?? true;

  // The kind toggle swaps the model silently (it reads the other kind's saved
  // pick without firing onModelChange), so LoRA selections need the same
  // reactive snap the solo screen applies: adapters the active model doesn't
  // accept — or the Uncensored gate no longer allows — would otherwise ride
  // into every scene request and get dropped server-side. An unavailable
  // catalog leaves selections untouched rather than wiping them.
  useEffect(() => {
    if (!catalog.loras.length || !selectedModel) return;
    setSettings((s) => ({
      ...s,
      loras: snapLorasForModel(
        s.loras ?? [],
        catalog.loras,
        selectedModel.model,
        catalog.loraMaxPerRequest,
        userSettings.uncensoredEnabled,
      ),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on model/catalog/gate changes
  }, [modelId, catalog.loras, userSettings.uncensoredEnabled]);

  // Chain preset: which model frame-carrying scenes (chained or manual start)
  // render with. Only a decision when the picked model can't chain itself —
  // Seedance/Grok render every scene on the pick, so no pill then.
  const chainPlan =
    kind === "video" && selectedModel && !startCatalog.loading
      ? resolveChainModelPlan({ picked: selectedModel, startCapable: startCatalog.models })
      : null;
  const showChainPill = chainPlan !== null;
  const autoChainLabel =
    chainPlan?.action === "swap" ? `Auto · ${chainPlan.label}` : "Auto · none";
  const chainOptions = [
    { value: "", label: autoChainLabel },
    ...startCatalog.models
      .filter((model) => !model.model.toLowerCase().includes("flf2v"))
      .map((model) => ({ value: model.id, label: model.label, group: model.providerLabel })),
  ];
  /** The override when still valid against the catalog — stale ids drop to
   * Auto instead of failing the run. Unjudged while the catalog loads. */
  function resolvedChainModelId(): string | undefined {
    const override = settings.chainModelId;
    if (!override) return undefined;
    if (startCatalog.loading) return override;
    return startCatalog.models.some((model) => model.id === override) ? override : undefined;
  }

  function currentSettings(): GenerationSettings {
    return {
      ...settings,
      kind,
      modelId: modelId ?? undefined,
      chainModelId: resolvedChainModelId(),
      safe: !userSettings.uncensoredEnabled,
    };
  }

  /* ------------------------- queue integration ------------------------- */

  /**
   * Say up front which model chained scenes will really render with: the
   * explicit chain override when set, else the picked model's family i2v
   * sibling (i2v requires a reference image, so scene 1 stays on the pick).
   * Skipped while the start-capable catalog is still loading — a wrong
   * "frames dropped" claim is worse than no notice.
   */
  function announceChainModel(draft: StoryScene[]) {
    if (kind !== "video" || !selectedModel || startCatalog.loading) return;
    const framesFlow =
      (continuityOn && draft.length >= 2) ||
      Boolean(draftRefs.startImageRef) ||
      draft.some((scene) => scene.startImageRef);
    if (!framesFlow) return;
    const override = resolvedChainModelId();
    if (override) {
      const label =
        startCatalog.models.find((model) => model.id === override)?.label ?? override;
      toast.push(
        `Chained scenes render with ${label} — ${selectedModel.label} can't take a start frame.`,
      );
      return;
    }
    const plan = resolveChainModelPlan({
      picked: selectedModel,
      startCapable: startCatalog.models,
    });
    if (!plan) return;
    if (plan.action === "swap") {
      toast.push(
        `Chained scenes render with ${plan.label} — ${selectedModel.label} can't take a start frame.`,
      );
    } else {
      toast.push(
        `${selectedModel.label} can't chain start frames — later scenes continue prompt-only.`,
      );
    }
  }

  async function handleGenerateAll() {
    // A blank composer is fine when scenes are already queued — but a typed
    // draft joins the queue as one more scene instead of being dropped.
    const draftPrompt = prompt.trim();
    if (!draftPrompt && !scenes.length) {
      setPromptError("Describe the first scene of your story before generating.");
      return;
    }
    setPromptError(undefined);

    // The persisted story asset IS the queue; the runner executes it. Nothing
    // renders until this press — scenes run one after another, chaining from
    // the previous scene's final frame while Continuity is on.
    const draft: StoryScene[] = [...scenes];
    if (draftPrompt) {
      draft.push({
        id: `sc_${draft.length + 1}_${Math.random().toString(36).slice(2, 5)}`,
        prompt: draftPrompt,
        url: null,
        status: "queued",
        kind,
        ...draftRefs,
      });
    }
    if (!draft.length) return;
    setDraftRefs({});
    const id =
      storyId ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const asset: Asset = {
      id,
      kind: "story",
      title: story?.title ?? (draftPrompt.slice(0, 40) || "Untitled story"),
      prompt: story?.prompt ?? prompt,
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
        characterIds: attachedCharacters.map((c) => c.id),
      },
    };
    addAsset(asset);
    setStoryId(id);
    announceChainModel(draft);
    appRunner.start(id);
    toast.push(
      `Rendering ${draft.length} scene${draft.length === 1 ? "" : "s"} — one after another.`,
    );
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
  }

  /** Stop one scene: aborts it if rendering, parks it as canceled otherwise.
   * A mid-run queue skips forward; canceled scenes are transparent to the
   * chain (successors continue from the last completed scene). */
  function handleCancelScene(sceneId: string) {
    if (!storyId) return;
    appRunner.cancelScene(storyId, sceneId);
  }

  /** Take a queued/canceled scene back out of the queue. */
  function handleRemoveScene(sceneId: string) {
    if (!storyId) return;
    appRunner.removeScene(storyId, sceneId);
  }

  /** Commit an inline prompt edit. Empty prompts can never render, so they're
   * refused (composer parity); the runner reads prompts at run time, so edits
   * land for any scene that hasn't started. */
  function commitScenePromptEdit(sceneId: string) {
    setEditingSceneId(null);
    if (!storyId) return;
    const next = editDraft.trim();
    if (!next) {
      toast.push("A scene needs a prompt before it can render.", "error");
      return;
    }
    updateStoryScenes(storyId, (list) =>
      list.map((scene) =>
        scene.id === sceneId ? { ...scene, prompt: next.slice(0, PROMPT_MAX) } : scene,
      ),
    );
    toast.push("Scene prompt updated.");
  }

  /** Re-run ONE settled scene: park it back in the queue. A run in flight
   * picks it up after the current scene; an idle story waits for Generate
   * (the only trigger). Later scenes keep their results — same chain
   * semantics as cancel. */
  function handleRerunScene(sceneId: string) {
    if (!storyId) return;
    appRunner.requeueScene(storyId, sceneId);
    toast.push(
      scenes.some((scene) => scene.status === "generating")
        ? "Scene re-queued — it renders after the current scene."
        : "Scene re-queued — press Generate to render it.",
    );
  }

  /** Swap a scene with its neighbor. Purely an ordering edit — the chain
   * follows scene order, nothing re-renders from this. */
  function moveScene(index: number, delta: -1 | 1) {
    if (!storyId) return;
    const target = index + delta;
    if (target < 0 || target >= scenes.length) return;
    updateStoryScenes(storyId, (list) => {
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleContinuity() {
    const next = !continuityOn;
    setContinuityOn(next);
    if (storyId) {
      // Re-schedule under the new rule: ON chains the rest from the latest
      // completed frame; OFF releases every queued scene in parallel. A
      // paused queue keeps waiting — only a run in flight continues.
      const meta = { ...(story?.meta ?? {}), continuity: next };
      updateAsset(storyId, { meta });
      if (scenes.some((s) => s.status === "generating")) appRunner.start(storyId);
    }
  }

  /* ------------------------------ convert ------------------------------ */

  const convertSources: (Omit<ConvertSource, "ref"> & {
    url: string;
    ref?: string;
  })[] = scenes
    .filter((s) => s.status === "completed" && s.url && s.kind === "image")
    .map((s) => ({
      sceneId: s.id,
      prompt: s.prompt,
      url: s.url as string,
      // Provider-URL scenes (Pollinations) normalize at confirm time.
      ref: refFromMediaUrl(s.url) ?? undefined,
    }));
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
        settings: buildConvertSettings(currentSettings(), chosenModelId, endCatalog),
        createdAt: Date.now(),
        favorite: false,
        mode: "Story Mode",
        scenes: clips,
        meta: {
          continuity: true,
          running: true,
          convertedFrom: storyId ?? "",
          style: currentSettings().style,
          characterIds: attachedCharacters.map((c) => c.id),
        },
      };
      addAsset(asset);
      setStoryId(id);
      setKind("video");
      appRunner.start(id);
      toast.push(`Animating ${clips.length} clip${clips.length === 1 ? "" : "s"}…`, "success");
    } catch (error) {
      toast.push((error as Error).message ?? "Conversion failed. Please retry.", "error");
    }
  }

  /* ------------------------------ helpers ------------------------------ */

  function addScene() {
    // Validation: a scene without a prompt can never render, so it can't be
    // queued — blank prompts produce garbage like ", an establishing shot".
    if (!prompt.trim()) {
      setPromptError("Write a prompt for the scene before adding it.");
      return;
    }
    const index = scenes.length;
    const continuation = CONTINUATIONS[Math.min(index, CONTINUATIONS.length - 1)];
    const draft: StoryScene = {
      id: `sc_${index + 1}_${Math.random().toString(36).slice(2, 5)}`,
      prompt: `${prompt.trim()}, ${continuation}`,
      url: null,
      status: "queued",
      kind,
      ...draftRefs,
    };
    setDraftRefs({});
    setPrompt("");
    if (storyId && story) {
      // Queued only — nothing renders until Generate is pressed.
      updateStoryScenes(storyId, (list) => [...list, draft]);
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
        meta: {
          continuity: continuityOn,
          running: false,
          style: currentSettings().style,
          characterIds: attachedCharacters.map((c) => c.id),
        },
      };
      addAsset(asset);
      setStoryId(id);
    }
    toast.push("Scene added — press Generate to render the whole story.");
  }

  /** Start a fresh story: stops any run and clears the queue from the UI. */
  function reset() {
    if (storyId) appRunner.cancel(storyId);
    setStoryId(null);
    setPlayOpen(false);
    setPrompt("");
    setPromptError(undefined);
    setDraftRefs({});
    setSceneProgress({});
    setEditingSceneId(null);
    setEditDraft("");
  }

  async function handleEnhancePrompt() {
    if (!prompt.trim() || running || enhancing) return;
    setEnhancing(true);
    try {
      const result = await requestPromptEnhancement({
        prompt,
        kind,
        style: stylesSupported ? settings.style : null,
        stylesSupported,
        aspect: settings.aspect,
        duration: kind === "video" ? settings.duration : null,
        sceneIndex: scenes.length ? scenes.length : 1,
        sceneCount: Math.max(1, scenes.length),
        negativePrompt: settings.negativePrompt || null,
      });
      setPrompt(result.enhanced.slice(0, PROMPT_MAX));
      toast.push(
        result.source === "ai"
          ? "Prompt enhanced with AI — review it and press Generate."
          : "Prompt enriched with style and lighting cues — AI enhancement is unavailable right now.",
        "success",
      );
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

  // Completed scenes in story order — the reel the player walks through.
  const playableScenes = scenes
    .filter((scene): scene is StoryScene & { url: string } => Boolean(scene.url))
    .map((scene) => ({ url: scene.url, mime: scene.mime, label: scene.prompt }));

  // Story-level batch progress: which slot is rendering and how far the whole
  // story is (finished scenes count fully, the live scene contributes its
  // provider percent when one exists).
  const activeSceneId = scenes.find((s) => s.status === "generating")?.id ?? null;
  const activeIndex = activeSceneId ? scenes.findIndex((s) => s.id === activeSceneId) : -1;
  const completedScenes = scenes.filter((s) => s.url).length;
  const overallPercent = storyProgressPercent(
    completedScenes,
    scenes.length,
    activeSceneId ? sceneProgress[activeSceneId] : undefined,
  );

  return (
    // Same workspace contract as the solo generator: on desktop the two panels
    // stretch to exactly the viewport (h-dvh is the hard boundary — the body
    // only has min-h-dvh, so min-h-0 alone would let tall content grow the
    // page) and nothing may spill past it (overflow hidden) — the scenes grid
    // and composer scroll inside their own panels instead. On mobile the
    // stack flows and the page scrolls when scenes grow beyond it.
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5 lg:h-dvh lg:flex-none lg:overflow-hidden">
      <div className="relative flex shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link
              href="/"
              aria-label="Back to home"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
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

          {/* New story clears the queue from the UI (and stops any run);
              hidden while the workspace is empty. */}
          <div className="flex items-center gap-2">
            {(storyId || scenes.length > 0) && (
              <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
                New story
              </Button>
            )}
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
        {/* Composer column — scrolls internally at lg when the picker sections
            outgrow a short viewport, so the page itself never scrolls. */}
        <div className="order-1 flex min-h-0 min-w-0 flex-col thin-scrollbar lg:overflow-y-auto">
          <div className="flex min-h-0 flex-1 flex-col">
            <PromptComposer
              kind={kind}
              title="Story composer"
              headerBadge={
                <Badge tone="primary">
                  <Icon name="story" size={12} /> {scenes.length || 1} scene
                  {(scenes.length || 1) === 1 ? "" : "s"}
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
              loraCatalog={catalog.loras}
              loraMaxPerRequest={catalog.loraMaxPerRequest}
              loraCapable={selectedModel?.loraCapable === true}
              loraModel={selectedModel?.model}
              allowNsfwLoras={userSettings.uncensoredEnabled}
              onModelChange={(nextModel) => {
                setSelectedModel(kind, nextModel);
                const nextPicked = catalog.models.find((m) => m.id === nextModel);
                setSettings((s) => ({
                  ...s,
                  modelId: nextModel,
                  // A self-chaining pick ends the chain decision — the
                  // override (if any) is meaningless then.
                  ...(nextPicked?.frameInput?.start ? { chainModelId: undefined } : {}),
                  // Drop LoRA selections the new model doesn't accept so the
                  // queued scenes never render with a dead adapter set.
                  ...(catalog.loras.length
                    ? {
                        loras: snapLorasForModel(
                          s.loras ?? [],
                          catalog.loras,
                          catalog.models.find((m) => m.id === nextModel)?.model ?? "",
                          catalog.loraMaxPerRequest,
                        ),
                      }
                    : {}),
                }));
              }}
              characters={characters}
              characterIds={userSettings.storyCharacterIds}
              onCharactersChange={setStoryCharacters}
              busy={running}
              onGenerate={handleGenerateAll}
              onCancel={handleCancel}
              onEnhancePrompt={() => void handleEnhancePrompt()}
              enhancing={enhancing}
              onCopyPrompt={() => {
                void navigator.clipboard
                  ?.writeText(prompt)
                  .then(() => toast.push("Prompt copied.", "success"));
              }}
            />
          </div>

          {/* Optional start/end frames for the scene being authored. They are
              committed with the next Generate / Add scene, not per-tile — the
              composer is where a scene is composed. */}
          <div className="mt-3 shrink-0">
            <p className="mb-1.5 text-[11.5px] font-semibold text-muted">
              Scene frames{" "}
              <span className="font-normal">
                — optional; a start frame overrides chaining
              </span>
            </p>
            <SceneRefChips
              startRef={draftRefs.startImageRef}
              endRef={draftRefs.endImageRef}
              endSupported={endSupported}
              onChange={(patch) => setDraftRefs((r) => ({ ...r, ...patch }))}
              onError={(message) => toast.push(message, "error")}
            />
          </div>

          <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              block
              icon="plus"
              disabled={running || scenes.length >= 6}
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
                  : "border-border bg-raised text-muted hover:text-ink"
              }`}
            >
              <Icon name="link" size={13} />
              Continuity: {continuityOn ? "On" : "Off"}
            </button>
            {/* Chain preset: scene 1 renders on the picked model, every
                frame-carrying scene on this. Auto = the family's i2v sibling
                (the service swaps); a pick here overrides it for this story. */}
            {showChainPill && (
              <PillSelect
                icon="link"
                label="Chain model"
                value={resolvedChainModelId() ?? ""}
                options={chainOptions}
                onChange={(next) =>
                  setSettings((s) => ({ ...s, chainModelId: next || undefined }))
                }
              />
            )}
          </div>
          <span className="mt-1.5 shrink-0 text-[11px] text-muted">
            {continuityOn
              ? "Scenes render one by one, each continuing from the last frame."
              : "Scenes render in parallel, independently."}
          </span>
        </div>

        {/* Scenes column — the panel keeps the viewport height at lg and the
            scene grid scrolls inside it; the action bar stays pinned below. */}
        <div className="order-2 relative flex min-h-[300px] min-w-0 flex-col rounded-[20px] border border-border bg-surface p-4 sm:min-h-[360px] lg:min-h-0 lg:overflow-hidden">
          {convertOpen && (
            <ConvertDialog
              clipCount={clipCount}
              models={endCatalog.models as ModelOption[]}
              defaultModelId={conversionModelId}
              onConfirm={(chosen) => void handleConvert(chosen)}
              onClose={() => setConvertOpen(false)}
            />
          )}
          {/* Scenes flow top-left, left to right, wrapping downward. At lg the
              grid scrolls within the panel instead of growing the page — no
              matter how many scenes there are or which aspect ratio they use. */}
          <div className="thin-scrollbar grid flex-1 content-start gap-4 sm:grid-cols-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {Array.from({ length: Math.max(2, scenes.length) }, (_, index) => {
              const typed = scenes[index] as StoryScene | undefined;
              const ratioStyle = {
                aspectRatio: `${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`,
              };
              // The nearest non-canceled scene before this one — canceled
              // scenes are transparent to the chain (mirrors the runner).
              const chainPredIndex = chainPredecessorIndex(scenes, index);
              // A queued chain scene whose effective predecessor hasn't finished.
              const waitingFor =
                typed &&
                typed.status === "queued" &&
                continuityOn &&
                index > 0 &&
                !typed.startImageRef &&
                chainPredIndex >= 0 &&
                scenes[chainPredIndex].status !== "completed";
              const chainResolution: EffectiveChainRef = typed
                ? effectiveChainRef(scenes, index, continuityOn)
                : { state: "none" };
              const editable = typed?.status === "queued" || typed?.status === "canceled";
              return (
                <div key={typed?.id ?? `slot-${index}`} className="min-w-0">
                  {typed?.url ? (
                    <div className="group relative">
                      {typed.kind === "video" ? (
                        <VideoStage
                          posterUrl={typed.url}
                          videoUrl={
                            typed.mime?.startsWith("video/") || isVideoSource(typed.url)
                              ? typed.url
                              : undefined
                          }
                          title={typed.prompt}
                          durationSeconds={Number(String(settings.duration).replace("s", "")) || 5}
                          ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                          sensitive={typed.safe === false}
                        />
                      ) : (
                        <MediaFrame
                          src={typed.url}
                          alt={typed.prompt}
                          ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                          sensitive={typed.safe === false}
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`Re-render scene ${index + 1}`}
                        title="Render this scene again (later scenes keep their current results)"
                        onClick={() => handleRerunScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white opacity-0 shadow-card transition-opacity hover:bg-black/70 focus:opacity-100 group-hover:opacity-100"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </div>
                  ) : typed && typed.status === "generating" ? (
                    <div className="relative">
                      <div
                        className="skeleton relative w-full overflow-hidden rounded-[14px]"
                        style={ratioStyle}
                      >
                        <div className="absolute inset-0 flex items-center justify-center p-3">
                          <RenderProgress
                            message={sceneProgress[typed.id]?.message || "Rendering your scene…"}
                            percent={sceneProgress[typed.id]?.percent}
                          />
                        </div>
                      </div>
                      {/* A rendering scene shows only a resolvable frame —
                          "pending" here would mean a prompt-only run. */}
                      {chainResolution.state === "manual" ||
                      chainResolution.state === "chained" ? (
                        <SceneChainBadge
                          resolution={chainResolution}
                          sensitive={chainBadgeSensitive(chainResolution, scenes, typed)}
                        />
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Cancel scene ${index + 1}`}
                        title="Cancel this scene"
                        onClick={() => handleCancelScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-card transition-colors hover:bg-black/70"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ) : typed && typed.status === "queued" ? (
                    <div className="relative">
                      <div className="skeleton w-full rounded-[14px]" style={ratioStyle} />
                      <div className="absolute inset-0 flex items-center justify-center">
                        {waitingFor ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white shadow-card backdrop-blur-sm">
                            <Icon name="link" size={12} /> Waiting for Scene {chainPredIndex + 1}
                          </span>
                        ) : (
                          <span className="rounded-full bg-raised px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted shadow-card">
                            Queued
                          </span>
                        )}
                      </div>
                      <SceneChainBadge
                        resolution={chainResolution}
                        sensitive={chainBadgeSensitive(chainResolution, scenes, typed)}
                      />
                      <button
                        type="button"
                        aria-label={`Remove scene ${index + 1} from the queue`}
                        title="Remove from queue"
                        onClick={() => handleRemoveScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-card transition-colors hover:bg-black/70"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ) : typed && typed.status === "canceled" ? (
                    <div className="relative">
                      <div
                        className="flex w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-border-strong bg-surface px-3 text-center"
                        style={ratioStyle}
                      >
                        <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted shadow-card">
                          <Icon name="close" size={10} /> Canceled
                        </span>
                        <p className="mt-2 text-[11px] text-muted">
                          Press Generate to re-queue it
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove scene ${index + 1}`}
                        title="Remove scene"
                        onClick={() => handleRemoveScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-card transition-colors hover:bg-black/70"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ) : typed && typed.status === "failed" ? (
                    <div className="relative">
                      <div
                        className="flex w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-danger/40 bg-danger-soft px-3 text-center"
                        style={ratioStyle}
                      >
                        <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-danger shadow-card">
                          <Icon name="alert" size={10} /> Failed
                        </span>
                        <p className="mt-2 line-clamp-2 text-[11px] text-muted">
                          {typed.error ?? "The render didn't make it."}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Re-render scene ${index + 1}`}
                        title="Render this scene again"
                        onClick={() => handleRerunScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/25 bg-black/55 text-white shadow-card transition-colors hover:bg-black/70"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </div>
                  ) : index === 0 && !typed ? (
                    // Scene 1: an active starting point, not a dashed slot.
                    <div
                      className="flex flex-col items-center justify-center rounded-[16px] border border-border bg-raised px-3 text-center shadow-card"
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
                        className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong bg-raised px-3 text-center"
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
                    {typed?.effectiveModelId && (
                      <span
                        className="inline-flex min-w-0 items-center gap-0.5 rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold text-primary"
                        title={`Rendered with ${typed.effectiveModelLabel ?? typed.effectiveModelId}`}
                      >
                        <Icon name="link" size={9} />
                        <span className="max-w-[110px] truncate">
                          {typed.effectiveModelLabel ??
                            startCatalog.models.find(
                              (model) => model.id === typed.effectiveModelId,
                            )?.label ??
                            "i2v"}
                        </span>
                      </span>
                    )}
                    {typed?.startImageRef && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-muted"
                        title="This scene has a manual start frame"
                      >
                        <Icon name="upload" size={9} /> start
                      </span>
                    )}
                    {typed?.endImageRef && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-muted"
                        title="This scene has a manual end frame"
                      >
                        <Icon name="upload" size={9} /> end
                      </span>
                    )}
                    {typed?.status === "completed" &&
                      scenes[index + 1]?.status === "queued" &&
                      continuityOn &&
                      !scenes[index + 1]?.startImageRef && (
                        <Icon name="link" size={11} className="text-muted" />
                      )}
                    {typed && (
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={`Move scene ${index + 1} earlier`}
                          title="Move earlier"
                          disabled={running || index === 0}
                          onClick={() => moveScene(index, -1)}
                          className="inline-flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Icon name="chevron-down" size={12} className="rotate-180" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move scene ${index + 1} later`}
                          title="Move later"
                          disabled={running || index === scenes.length - 1}
                          onClick={() => moveScene(index, 1)}
                          className="inline-flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Icon name="chevron-down" size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  {typed?.prompt &&
                    (editingSceneId === typed.id && editable ? (
                      <textarea
                        autoFocus
                        rows={2}
                        maxLength={PROMPT_MAX}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onBlur={() => {
                          if (editCancelingRef.current) {
                            editCancelingRef.current = false;
                            return;
                          }
                          commitScenePromptEdit(typed.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            editCancelingRef.current = true;
                            setEditingSceneId(null);
                          }
                        }}
                        className="mt-0.5 w-full resize-none rounded-[8px] border border-primary/40 bg-raised px-2 py-1.5 text-[12px] leading-snug text-ink outline-none"
                      />
                    ) : (
                      <p
                        onClick={
                          editable
                            ? () => {
                                editCancelingRef.current = false; // a prior Escape must not swallow this commit
                                setEditDraft(typed.prompt);
                                setEditingSceneId(typed.id);
                              }
                            : undefined
                        }
                        title={editable ? "Click to edit the prompt" : undefined}
                        className={`mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft ${
                          editable ? "cursor-text hover:text-ink" : ""
                        }`}
                      >
                        {typed.prompt}
                      </p>
                    ))}
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3.5">
            {running && activeIndex >= 0 ? (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <p className="shrink-0 text-[11.5px] font-semibold text-ink-soft">
                  Rendering scene {activeIndex + 1} of {scenes.length}…
                </p>
                <div className="h-1 min-w-0 max-w-[220px] flex-1 overflow-hidden rounded-full bg-ink/10">
                  {overallPercent !== undefined ? (
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                      style={{ width: `${overallPercent}%` }}
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
                  )}
                </div>
              </div>
            ) : hasAnyMedia || scenes.length ? (
              <>
                {hasAnyMedia && (
                  <Button
                    size="sm"
                    icon="play"
                    onClick={() => setPlayOpen(true)}
                    disabled={!playableScenes.length}
                  >
                    Play story
                  </Button>
                )}
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
                    className="inline-flex h-9 items-center gap-2 rounded-[12px] border border-border-strong bg-raised px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                  >
                    Open in Results
                    <Icon name="arrow-right" size={15} />
                  </Link>
                )}
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
