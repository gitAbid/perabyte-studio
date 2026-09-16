"use client";

import {
  requestGeneration,
  type GenerationProgress,
} from "@/lib/generation";
import { extractLastFrame, refFromMediaUrl, uploadFrameRef } from "@/lib/media/frame";
import { getAsset, updateStoryScenes } from "@/lib/store";
import { composeSceneWithCharacter } from "@/lib/character";
import {
  getCharacter,
  type SavedCharacter,
} from "@/lib/repositories/characters.repository";
import type { Asset, GenerationResponse, StoryScene } from "@/lib/types";

/**
 * Story queue runner (spec §5). The persisted story asset IS the queue; this
 * module owns execution. Dependency-injected for tests — `appRunner` below
 * binds the real store and services for the app.
 */

export interface StoryRunnerDeps {
  getStory(id: string): Asset | undefined;
  updateStoryScenes(id: string, updater: (scenes: StoryScene[]) => StoryScene[]): void;
  requestGeneration(input: {
    settings: Asset["settings"];
    prompt: string;
    startImageRef?: string;
    endImageRef?: string;
    signal?: AbortSignal;
    /** Associates the render with this scene for detached-render recovery. */
    clientTag?: string;
    /** Live provider ticks for the UI (transient — never persisted). */
    onProgress?: (progress: GenerationProgress) => void;
  }): Promise<GenerationResponse>;
  uploadFrameRef(blob: Blob): Promise<string>;
  extractLastFrame(videoUrl: string): Promise<Blob>;
  refFromMediaUrl(url: string | null | undefined): string | null;
  /** Resolves a story's attached saved character; undefined when none. */
  getCharacter?(id: string): SavedCharacter | undefined;
  onNotice?(message: string, tone?: "info" | "error"): void;
}

interface ActiveStory {
  /** One live controller per in-flight scene, keyed by scene id. */
  controllers: Map<string, AbortController>;
  /** Scenes whose abort was user-requested — they settle as "canceled"
   * instead of requeueing. */
  canceled: Set<string>;
}

/** Optional UI hooks — the page subscribes for live render ticks. */
export interface StoryRunnerHooks {
  onSceneProgress?(sceneId: string, progress: GenerationProgress): void;
  /** The scene left "generating" (completed, failed, or canceled). */
  onSceneSettled?(sceneId: string): void;
}

export function createStoryRunner(deps: StoryRunnerDeps) {
  const active = new Map<string, ActiveStory>();
  let hooks: StoryRunnerHooks = {};
  /** Scenes whose end frame is being derived right now (dedupe guard). */
  const deriving = new Set<string>();
  /** Scenes whose end-frame derivation was attempted and failed — their
   * successors run prompt-only instead of waiting forever (spec §7). */
  const backfillFailed = new Set<string>();

  function patch(storyId: string, sceneId: string, changes: Partial<StoryScene>) {
    deps.updateStoryScenes(storyId, (scenes) =>
      scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...changes } : scene)),
    );
  }

  function continuityOn(story: Asset): boolean {
    return story.meta?.continuity !== false;
  }

  /** The nearest non-canceled scene before `index` — a canceled scene is
   * transparent to the chain, so its successor continues from the scene
   * before it. Undefined means "run without a chain ref" (like scene 1). */
  function chainPredecessor(scenes: StoryScene[], index: number): StoryScene | undefined {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (scenes[i].status !== "canceled") return scenes[i];
    }
    return undefined;
  }

  /** A chain scene runs when it has an explicit ref, is first (or everything
   * before it was canceled), or its predecessor is done chaining: completed
   * with a derived frame (chain with it), still deriving (wait), or
   * derivation failed (run prompt-only). */
  function isRunnable(scenes: StoryScene[], index: number, chained: boolean): boolean {
    const scene = scenes[index];
    if (scene.status !== "queued") return false;
    // Never spend a render on an empty scene — it would also strand every
    // successor behind a predecessor that can never complete.
    if (!scene.prompt?.trim()) return false;
    if (scene.startImageRef) return true; // manual/converted ref: independent
    if (index === 0 || !chained) return true;
    const predecessor = chainPredecessor(scenes, index);
    if (!predecessor) return true;
    if (predecessor.status !== "completed") return false;
    if (predecessor.endFrameRef) return true;
    if (deriving.has(predecessor.id)) return false;
    return backfillFailed.has(predecessor.id);
  }

  function schedule(storyId: string) {
    const entry = active.get(storyId);
    if (!entry) return;
    const story = deps.getStory(storyId);
    if (!story?.scenes?.length) return;

    const chained = continuityOn(story);
    const scenes = story.scenes;
    // Chained scenes go one at a time; ref-carrying scenes are independent.
    const chainInFlight = scenes.filter(
      (s) => s.status === "generating" && !s.startImageRef,
    ).length;
    let chainUsed = chainInFlight;

    for (let index = 0; index < scenes.length; index += 1) {
      if (!isRunnable(scenes, index, chained)) continue;
      const scene = scenes[index];
      const isChainScene = !scene.startImageRef;
      if (isChainScene) {
        if (chainUsed >= 1) continue;
        chainUsed += 1;
      }
      void runScene(storyId, story, scene, index, entry);
    }

    // Backfill: a predecessor completed before this runner existed (or whose
    // derivation failed earlier) carries no endFrameRef — try deriving it from
    // its stored media so the chain can proceed with the real frame.
    if (chained) {
      for (let index = 1; index < scenes.length; index += 1) {
        const predecessor = scenes[index - 1];
        if (
          predecessor.status === "completed" &&
          predecessor.url &&
          !predecessor.endFrameRef &&
          !deriving.has(predecessor.id) &&
          !backfillFailed.has(predecessor.id)
        ) {
          void backfillEndFrame(storyId, predecessor);
        }
      }
    }
  }

  async function backfillEndFrame(storyId: string, scene: StoryScene) {
    deriving.add(scene.id);
    try {
      const response = {
        media: [{ url: scene.url }],
      } as unknown as GenerationResponse;
      const endFrameRef = await deriveEndFrameRef(response, scene);
      if (endFrameRef) {
        patch(storyId, scene.id, { endFrameRef });
      } else {
        backfillFailed.add(scene.id);
      }
    } catch {
      backfillFailed.add(scene.id);
    } finally {
      deriving.delete(scene.id);
      schedule(storyId);
    }
  }

  /** True while the story still has a render in flight — per-scene controls
   * only re-schedule a mid-run queue, never a paused one. */
  function hasInFlight(storyId: string): boolean {
    return deps.getStory(storyId)?.scenes?.some((s) => s.status === "generating") ?? false;
  }

  async function runScene(
    storyId: string,
    story: Asset,
    scene: StoryScene,
    index: number,
    entry: ActiveStory,
  ) {
    const controller = new AbortController();
    entry.controllers.set(scene.id, controller);
    patch(storyId, scene.id, { status: "generating", error: undefined });
    try {
      const scenes = deps.getStory(storyId)?.scenes ?? [];
      const predecessor = scene.startImageRef ? undefined : chainPredecessor(scenes, index);
      const startRef = scene.startImageRef ?? predecessor?.endFrameRef;
      // Attached saved character: its sanitized anchor leads every scene
      // prompt (scene prompts stay clean in the UI). safe=false marks the
      // story as rendered under the Uncensored gate.
      const characterId =
        typeof story.meta?.characterId === "string" ? story.meta.characterId : "";
      const character = characterId ? deps.getCharacter?.(characterId) : undefined;
      const uncensored = story.settings.safe === false;
      const response = await deps.requestGeneration({
        settings: { ...story.settings, kind: scene.kind },
        prompt: composeSceneWithCharacter(scene.prompt, character?.spec ?? null, uncensored),
        ...(startRef ? { startImageRef: startRef } : {}),
        ...(scene.endImageRef ? { endImageRef: scene.endImageRef } : {}),
        // Lets a detached render (provider outlived our timeout) be attached
        // back to this exact scene when it finishes.
        clientTag: `${storyId}:${scene.id}`,
        signal: controller.signal,
        onProgress: (progress) => hooks.onSceneProgress?.(scene.id, progress),
      });

      const endFrameRef = await deriveEndFrameRef(response, scene);
      patch(storyId, scene.id, {
        url: response.media[0]?.url ?? null,
        mime: response.media[0]?.mime,
        // Persist the render's safety state so masking (18+ veil) survives
        // reloads exactly like the solo generator's saves.
        safe: story.settings.safe,
        status: "completed",
        effectiveModelId: response.effectiveModelId,
        effectiveModelLabel: response.effectiveModelLabel,
        frameUsed: response.frameUsed,
        ...(endFrameRef ? { endFrameRef } : {}),
      });
      hooks.onSceneSettled?.(scene.id);
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || controller.signal.aborted) {
        // Per-scene cancel parks the scene as canceled (Generate re-queues
        // it) and skips the queue forward; a story-level abort just requeues
        // it and pauses until the next explicit Generate.
        const canceled = entry.canceled.delete(scene.id);
        patch(storyId, scene.id, { status: canceled ? "canceled" : "queued" });
        hooks.onSceneSettled?.(scene.id);
        entry.controllers.delete(scene.id);
        if (canceled) schedule(storyId);
        return;
      }
      patch(storyId, scene.id, {
        status: "failed",
        error: (error as Error).message ?? "Scene generation failed.",
      });
      hooks.onSceneSettled?.(scene.id);
      deps.onNotice?.((error as Error).message ?? "Scene generation failed.", "error");
    }
    entry.controllers.delete(scene.id);
    schedule(storyId); // advance the chain / fill capacity
  }

  /** The frame the NEXT scene continues from (spec §4). Preference: the
   * provider's exact export (Seedance 2.5), then the image itself, then a
   * browser-side canvas extraction of the video's final frame. */
  async function deriveEndFrameRef(
    response: GenerationResponse,
    scene: StoryScene,
  ): Promise<string | undefined> {
    const media = response.media[0];
    if (!media?.url) return undefined;
    const exported = deps.refFromMediaUrl(media.endFrameUrl);
    if (exported) return exported;
    if (scene.kind === "image") return deps.refFromMediaUrl(media.url) ?? undefined;
    try {
      const blob = await deps.extractLastFrame(media.url);
      return await deps.uploadFrameRef(blob);
    } catch {
      deps.onNotice?.("Couldn't read the last frame — continuing without it.");
      return undefined;
    }
  }

  return {
    /** Subscribe UI hooks (idempotent — replaces the previous set). */
    setHooks(next: StoryRunnerHooks) {
      hooks = next ?? {};
    },

    /** Idempotent: schedule (or resume) one story's queue. Failed and
     * canceled scenes are reset to queued — pressing Generate again retries
     * the whole story. */
    start(storyId: string) {
      if (!active.has(storyId)) {
        active.set(storyId, { controllers: new Map(), canceled: new Set() });
      }
      const story = deps.getStory(storyId);
      if (story?.scenes?.some((s) => s.status === "failed" || s.status === "canceled")) {
        deps.updateStoryScenes(storyId, (scenes) =>
          scenes.map((scene) =>
            scene.status === "failed" || scene.status === "canceled"
              ? { ...scene, status: "queued" as const }
              : scene,
          ),
        );
      }
      active.get(storyId)!.canceled.clear();
      schedule(storyId);
    },

    /** Abort in-flight requests; queued scenes stay queued, generating requeue. */
    cancel(storyId: string) {
      const entry = active.get(storyId);
      if (!entry) return;
      for (const controller of entry.controllers.values()) controller.abort();
      entry.controllers.clear();
      const story = deps.getStory(storyId);
      if (story?.scenes?.some((s) => s.status === "generating")) {
        deps.updateStoryScenes(storyId, (scenes) =>
          scenes.map((scene) =>
            scene.status === "generating" ? { ...scene, status: "queued" as const } : scene,
          ),
        );
      }
    },

    /** Stop ONE scene. An in-flight render aborts and parks the scene as
     * "canceled"; a queued scene flips to canceled outright. Canceled scenes
     * are never auto-scheduled and are transparent to the chain — the run
     * skips forward and successors chain across them. Generate re-queues. */
    cancelScene(storyId: string, sceneId: string) {
      const entry = active.get(storyId);
      const controller = entry?.controllers.get(sceneId);
      if (entry && controller) {
        entry.canceled.add(sceneId);
        controller.abort();
        return;
      }
      const scene = deps.getStory(storyId)?.scenes?.find((s) => s.id === sceneId);
      if (scene?.status === "queued") {
        patch(storyId, sceneId, { status: "canceled" });
        if (hasInFlight(storyId)) schedule(storyId);
      }
    },

    /** Drop a scene from the queue entirely (a still in-flight scene aborts
     * first). Successors chain to the scene before it instead. Only
     * re-schedules while a run is actually in progress — removal never
     * starts generating on its own. */
    removeScene(storyId: string, sceneId: string) {
      const entry = active.get(storyId);
      const controller = entry?.controllers.get(sceneId);
      if (entry && controller) {
        entry.canceled.add(sceneId); // the abort settles it, the splice drops it
        controller.abort();
        entry.controllers.delete(sceneId);
      }
      deps.updateStoryScenes(storyId, (scenes) =>
        scenes.filter((scene) => scene.id !== sceneId),
      );
      if (hasInFlight(storyId)) schedule(storyId);
    },

    /** Attach a recovered detached render (a scene whose provider render
     * finished after our timeout) to its scene: mark completed, derive the
     * chaining end frame, and let the queue advance. No-op when the scene is
     * already completed or gone — the caller then drops the record. */
    async absorbRecovered(
      storyId: string,
      sceneId: string,
      media: { url: string; mime?: string },
    ): Promise<boolean> {
      const story = deps.getStory(storyId);
      const scene = story?.scenes?.find((s) => s.id === sceneId);
      if (!story || !scene || scene.status === "completed") return false;

      // Same preference order as a live render: provider end-frame export,
      // then the image itself, then canvas extraction of the video's frame.
      let endFrameRef: string | undefined;
      try {
        endFrameRef = await deriveEndFrameRef(
          { media: [{ url: media.url }] } as GenerationResponse,
          scene,
        );
      } catch {
        endFrameRef = undefined; // chaining degrades to prompt-only, as elsewhere
      }

      patch(storyId, sceneId, {
        url: media.url,
        mime: media.mime,
        status: "completed",
        error: undefined,
        ...(endFrameRef ? { endFrameRef } : {}),
      });
      deps.onNotice?.(
        "A scene that kept rendering on the provider has finished — attached.",
        "info",
      );
      hooks.onSceneSettled?.(sceneId);
      // The page poller may call this without a prior start() in this session
      // (fresh reload) — bootstrap the entry so the chain can advance. Cancel
      // and failed scenes stay put; only queued successors run.
      if (!active.has(storyId)) {
        active.set(storyId, { controllers: new Map(), canceled: new Set() });
      }
      schedule(storyId);
      return true;
    },

    /** Boot-time resume: flip orphaned generating scenes back to queued, then
     * resume stories that were mid-run when the tab closed. */
    rehydrate(storyIds: string[]) {      for (const id of storyIds) {
        const story = deps.getStory(id);
        if (!story?.scenes?.length) continue;
        const orphaned = story.scenes.some((s) => s.status === "generating");
        if (orphaned) {
          deps.updateStoryScenes(id, (scenes) =>
            scenes.map((scene) =>
              scene.status === "generating" ? { ...scene, status: "queued" as const } : scene,
            ),
          );
        }
        // Only auto-resume stories that had work in flight when we left off.
        if (orphaned || story.scenes.some((s) => s.status === "queued")) {
          if (story.meta?.running === true) this.start(id);
        }
      }
    },
  };
}

/** App binding: the real store + real client services. */
export const appRunner = createStoryRunner({
  getStory: (id) => getAsset(id),
  updateStoryScenes,
  requestGeneration,
  uploadFrameRef,
  extractLastFrame,
  refFromMediaUrl,
  getCharacter,
});
