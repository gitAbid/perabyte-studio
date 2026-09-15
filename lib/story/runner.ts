"use client";

import { requestGeneration } from "@/lib/generation";
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
  }): Promise<GenerationResponse>;
  uploadFrameRef(blob: Blob): Promise<string>;
  extractLastFrame(videoUrl: string): Promise<Blob>;
  refFromMediaUrl(url: string | null | undefined): string | null;
  /** Resolves a story's attached saved character; undefined when none. */
  getCharacter?(id: string): SavedCharacter | undefined;
  onNotice?(message: string, tone?: "info" | "error"): void;
}

interface ActiveStory {
  controllers: Set<AbortController>;
}

export function createStoryRunner(deps: StoryRunnerDeps) {
  const active = new Map<string, ActiveStory>();
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

  /** A chain scene runs when it has an explicit ref, is first, or its
   * predecessor is done chaining: completed with a derived frame (chain with
   * it), still deriving (wait), or derivation failed (run prompt-only). */
  function isRunnable(scenes: StoryScene[], index: number, chained: boolean): boolean {
    const scene = scenes[index];
    if (scene.status !== "queued") return false;
    if (scene.startImageRef) return true; // manual/converted ref: independent
    if (index === 0 || !chained) return true;
    const predecessor = scenes[index - 1];
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

  async function runScene(
    storyId: string,
    story: Asset,
    scene: StoryScene,
    index: number,
    entry: ActiveStory,
  ) {
    const controller = new AbortController();
    entry.controllers.add(controller);
    patch(storyId, scene.id, { status: "generating", error: undefined });
    try {
      const scenes = deps.getStory(storyId)?.scenes ?? [];
      const predecessor = scene.startImageRef ? undefined : scenes[index - 1];
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
        signal: controller.signal,
      });

      const endFrameRef = await deriveEndFrameRef(response, scene);
      patch(storyId, scene.id, {
        url: response.media[0]?.url ?? null,
        status: "completed",
        effectiveModelId: response.effectiveModelId,
        frameUsed: response.frameUsed,
        ...(endFrameRef ? { endFrameRef } : {}),
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || controller.signal.aborted) {
        patch(storyId, scene.id, { status: "queued" });
        entry.controllers.delete(controller);
        return;
      }
      patch(storyId, scene.id, {
        status: "failed",
        error: (error as Error).message ?? "Scene generation failed.",
      });
      deps.onNotice?.((error as Error).message ?? "Scene generation failed.", "error");
    }
    entry.controllers.delete(controller);
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
    /** Idempotent: schedule (or resume) one story's queue. Failed scenes are
     * reset to queued — pressing Generate again retries them. */
    start(storyId: string) {
      if (!active.has(storyId)) active.set(storyId, { controllers: new Set() });
      const story = deps.getStory(storyId);
      if (story?.scenes?.some((s) => s.status === "failed")) {
        deps.updateStoryScenes(storyId, (scenes) =>
          scenes.map((scene) =>
            scene.status === "failed" ? { ...scene, status: "queued" as const } : scene,
          ),
        );
      }
      schedule(storyId);
    },

    /** Abort in-flight requests; queued scenes stay queued, generating requeue. */
    cancel(storyId: string) {
      const entry = active.get(storyId);
      if (!entry) return;
      for (const controller of entry.controllers) controller.abort();
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

    /** Boot-time resume: flip orphaned generating scenes back to queued, then
     * resume stories that were mid-run when the tab closed. */
    rehydrate(storyIds: string[]) {
      for (const id of storyIds) {
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
