import { chainPredecessor } from "@/lib/story/chain";
import { getJobExecutor } from "@/lib/jobs/executor";
import {
  getStoriesRepository,
  patchStoryRepository,
} from "@/lib/repositories/stories.repository";
import { listActiveJobsRepository } from "@/lib/repositories/jobs.repository";
import { createJob } from "@/lib/jobs/jobs.service";
import { GenerationServiceError } from "@/lib/services/generation.service";
import { logger as rootLogger, type Logger } from "@/lib/logging/logger";
import type { Asset, GenerationSettings, StoryScene } from "@/lib/types";

/**
 * The server-side story runner (Phase C). The story record IS the run: the
 * generate route snapshots the composed prompts and settings, then this
 * module drives the chain — enqueue the first runnable scene, and on every
 * absorbed completion enqueue the next — so a story keeps rendering with no
 * browser open. Canceled scenes stay transparent to the chain (the same
 * single rule the client runner and the UI agreed on); a failed scene halts
 * the run until the user re-runs it.
 */

export interface StoryRunInput {
  /** Current picker state, folded into the story's settings snapshot. */
  settingsPatch?: Partial<GenerationSettings>;
  /** sceneId → anchor-composed prompt, snapshotted at Generate. */
  runPrompts?: Record<string, string>;
}

function log(): Logger {
  return rootLogger.child({ module: "story-server-runner" });
}

export function isStoryRunning(story: Asset): boolean {
  return story.meta?.running === true;
}

/** Compose one scene's render request from the story snapshot. */
export function sceneRequestBody(story: Asset, scene: StoryScene): Record<string, unknown> {
  const settings = story.settings;
  const continuity = story.meta?.continuity !== false;
  const index = story.scenes?.findIndex((s) => s.id === scene.id) ?? -1;
  const predecessor =
    continuity && index > 0 && story.scenes
      ? chainPredecessor(story.scenes, index)
      : undefined;
  const startRef = scene.startImageRef ?? predecessor?.endFrameRef ?? undefined;
  // Chained scenes render with the story's chain model (the family i2v
  // sibling) — the same preset the client runner applied.
  const chainModelId =
    startRef && typeof settings.chainModelId === "string" ? settings.chainModelId : undefined;
  return {
    kind: scene.kind,
    prompt: scene.runPrompt ?? scene.prompt,
    aspect: settings.aspect,
    resolution: settings.resolution,
    style: settings.style,
    duration: settings.duration,
    count: 1,
    negativePrompt: settings.negativePrompt ?? "",
    enhance: settings.enhance ?? false,
    safe: settings.safe !== false,
    modelId: chainModelId ?? settings.modelId ?? null,
    ...(startRef ? { startImageRef: startRef } : {}),
    ...(scene.endImageRef ? { endImageRef: scene.endImageRef } : {}),
    clientTag: `${story.id}:${scene.id}`,
  };
}

/**
 * Start (or resume) a story's server run: reset settled scenes to queued,
 * snapshot settings/prompts, then advance. Idempotent — a run already in
 * flight is resumed, never duplicated.
 */
export async function startStoryRun(storyId: string, input: StoryRunInput = {}): Promise<Asset> {
  const story = getStoriesRepository(storyId);
  if (!story || story.kind !== "story") {
    throw new GenerationServiceError("That story does not exist.", { retryable: false });
  }
  const scenes = story.scenes ?? [];
  if (!scenes.length) {
    throw new GenerationServiceError("Add at least one scene before generating.", {
      retryable: false,
    });
  }

  const settings: GenerationSettings = {
    ...(story.settings as GenerationSettings),
    ...(input.settingsPatch ?? {}),
  };
  const settled: StoryScene[] = scenes.map((scene) =>
    scene.status === "failed" || scene.status === "canceled" || scene.status === "generating"
      ? { ...scene, status: "queued" as const, error: undefined }
      : scene,
  );
  const runPrompts = input.runPrompts ?? {};
  const withPrompts: StoryScene[] = settled.map((scene) => ({
    ...scene,
    ...(runPrompts[scene.id] ? { runPrompt: runPrompts[scene.id] } : {}),
  }));
  patchStoryRepository(storyId, {
    settings,
    scenes: withPrompts,
    meta: { ...(story.meta ?? {}), running: true },
  });
  log().info("story run started", { storyId, scenes: settled.length });
  return advanceStoryChain(storyId);
}

/**
 * Enqueue the next runnable scene if the run is active and nothing is in
 * flight. Called after each absorbed completion and by start/resume — the
 * single choke point keeps double-enqueue impossible (the scene flips to
 * generating synchronously before the job is created).
 */
export async function advanceStoryChain(storyId: string): Promise<Asset> {
  const story = getStoriesRepository(storyId);
  if (!story || !isStoryRunning(story)) return story as Asset;
  const scenes = story.scenes ?? [];
  if (scenes.some((s) => s.status === "generating")) return story;

  const next = scenes.find((s) => s.status === "queued" && s.prompt?.trim());
  if (!next) {
    // Nothing left to render — the run is complete.
    patchStoryRepository(storyId, {
      meta: { ...(story.meta ?? {}), running: false },
    });
    log().info("story run complete", { storyId });
    return getStoriesRepository(storyId) as Asset;
  }

  // A failed (non-canceled) predecessor halts the chain — the user decides
  // whether to re-run it. Canceled predecessors are transparent.
  const index = scenes.findIndex((s) => s.id === next.id);
  const predecessor = chainPredecessor(scenes, index);
  if (predecessor && story.meta?.continuity !== false) {
    if (predecessor.status === "failed") {
      patchStoryRepository(storyId, {
        meta: { ...(story.meta ?? {}), running: false },
      });
      log().info("story run halted on failed predecessor", {
        storyId,
        sceneId: next.id,
        predecessorId: predecessor.id,
      });
      return getStoriesRepository(storyId) as Asset;
    }
  }

  // Flip first (synchronous), then create the job — no await between, so a
  // concurrent advance can never double-enqueue this scene.
  patchStoryRepository(storyId, {
    scenes: (getStoriesRepository(storyId)?.scenes ?? scenes).map((s) =>
      s.id === next.id ? { ...s, status: "generating" as const, error: undefined } : s,
    ),
  });
  try {
    createJob(sceneRequestBody(story, next));
    log().info("story scene enqueued", { storyId, sceneId: next.id });
  } catch (error) {
    const message =
      error instanceof GenerationServiceError
        ? error.message
        : ((error as Error)?.message ?? "The scene could not be queued.");
    patchStoryRepository(storyId, {
      scenes: (getStoriesRepository(storyId)?.scenes ?? scenes).map((s) =>
        s.id === next.id ? { ...s, status: "failed" as const, error: message } : s,
      ),
      meta: { ...(getStoriesRepository(storyId)?.meta ?? {}), running: false },
    });
    log().warn("story scene failed to enqueue", { storyId, sceneId: next.id, message });
  }
  return getStoriesRepository(storyId) as Asset;
}

/** Stop a run: cancel its in-flight jobs, park generating scenes as queued. */
export async function cancelStoryRun(storyId: string): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  if (!story) return undefined;
  for (const job of listActiveJobsRepository()) {
    if (job.clientTag?.startsWith(`${storyId}:`)) {
      getJobExecutor().cancel(job.id);
    }
  }
  patchStoryRepository(storyId, {
    scenes: (story.scenes ?? []).map((s) =>
      s.status === "generating" ? { ...s, status: "queued" as const } : s,
    ),
    meta: { ...(story.meta ?? {}), running: false },
  });
  log().info("story run canceled", { storyId });
  return getStoriesRepository(storyId);
}

/** Stop one scene: queued → canceled outright; generating → cancel the job
 * and park it canceled (mirrors the client runner's cancelScene). */
export async function cancelStoryScene(storyId: string, sceneId: string): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  const scene = story?.scenes?.find((s) => s.id === sceneId);
  if (!story || !scene) return undefined;
  if (scene.status === "generating") {
    for (const job of listActiveJobsRepository()) {
      if (job.clientTag === `${storyId}:${sceneId}`) {
        getJobExecutor().cancel(job.id);
      }
    }
  }
  if (scene.status !== "completed") {
    patchStoryRepository(storyId, {
      scenes: (story.scenes ?? []).map((s) =>
        s.id === sceneId ? { ...s, status: "canceled" as const, progress: undefined } : s,
      ),
    });
  }
  return getStoriesRepository(storyId);
}

/** Re-run one settled scene: back to queued, then the chain advances if a
 * run is active (mirrors the client runner's requeueScene). */
export async function requeueStoryScene(storyId: string, sceneId: string): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  const scene = story?.scenes?.find((s) => s.id === sceneId);
  if (!story || !scene || scene.status === "generating" || scene.status === "queued") {
    return story;
  }
  patchStoryRepository(storyId, {
    scenes: (story.scenes ?? []).map((s) =>
      s.id === sceneId ? { ...s, status: "queued" as const, error: undefined } : s,
    ),
  });
  log().info("story scene requeued", { storyId, sceneId });
  if (isStoryRunning(story)) return advanceStoryChain(storyId);
  return getStoriesRepository(storyId);
}
