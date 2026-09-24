import { chainPredecessor } from "@/lib/story/chain";
import { mergedSceneSettings } from "@/lib/story/scene-settings";
import { composeShot, sceneCast } from "@/lib/story/compose-shot";
import {
  keyframePrompt,
  resolveKeyframeStrategy,
  type KeyframeStrategy,
} from "@/lib/story/keyframe";
import { listImageModelDescriptors } from "@/lib/story/keyframe-models";
import { deriveSceneSeed, mintSeed } from "@/lib/story/seeds";
import { getJobExecutor } from "@/lib/jobs/executor";
import {
  getStoriesRepository,
  patchStoryRepository,
} from "@/lib/repositories/stories.repository";
import { listCharactersRepository } from "@/lib/repositories/characters.repository";
import {
  getLocationsRepository,
  listLocationsRepository,
} from "@/lib/repositories/locations.repository";
import { listActiveJobsRepository } from "@/lib/repositories/jobs.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { createJob } from "@/lib/jobs/jobs.service";
import { GenerationServiceError } from "@/lib/services/generation.service";
import { logger as rootLogger, type Logger } from "@/lib/logging/logger";
import type { GenerationKind } from "@/lib/constants";
import type { Asset, GenerationSettings, SceneState, StoryScene, StoryWorld } from "@/lib/types";

/**
 * The server-side story runner (Phase C). The story record IS the run: the
 * generate route snapshots the settings, then this module drives the chain —
 * enqueue the first runnable scene, and on every absorbed completion enqueue
 * the next — so a story keeps rendering with no browser open. Canceled scenes
 * stay transparent to the chain (the same single rule the client runner and
 * the UI agreed on); a failed scene halts the run until the user re-runs it.
 *
 * Prompts and seeds are composed HERE (composeShot + deriveSceneSeed): the
 * runner is the single prompt truth, and scene seeds stay stable across
 * re-runs instead of re-rolling per render.
 */

export interface StoryRunInput {
  /** Current picker state, folded into the story's settings snapshot. */
  settingsPatch?: Partial<GenerationSettings>;
}

function log(): Logger {
  return rootLogger.child({ module: "story-server-runner" });
}

export function isStoryRunning(story: Asset): boolean {
  return story.meta?.running === true;
}

/** The attached cast, in story order (meta.characterIds). Shared with the
 * executor's keyframe gate, which recomposes the same expectations the
 * strategy build used. */
export function storyCast(story: Asset) {
  const ids = story.meta?.characterIds;
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  const rows = listCharactersRepository().filter((row) => wanted.has(row.id));
  const order = new Map((ids as string[]).map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Mint the story's base seed once; every scene seed derives from it. */
function ensureWorld(story: Asset): { world: StoryWorld; changed: boolean } {
  const existing = story.world;
  if (existing?.baseSeed !== undefined) return { world: existing, changed: false };
  return { world: { ...existing, baseSeed: mintSeed() }, changed: true };
}

/** The story's base seed, minting and persisting one for a legacy record
 * that somehow reached the chain without it. */
function ensureBaseSeed(story: Asset): number {
  const existing = story.world?.baseSeed;
  if (existing !== undefined) return existing;
  const baseSeed = mintSeed();
  patchStoryRepository(story.id, { world: { ...story.world, baseSeed } });
  return baseSeed;
}

/** The scene's keyframe location row: its resolved location, else the
 * story world's first pick. Undefined when neither resolves. */
function sceneLocation(story: Asset, scene: StoryScene) {
  const id = scene.state?.locationId ?? story.world?.locationIds?.[0];
  return id ? getLocationsRepository(id) : undefined;
}

/** Resolve each scene's free-text location once against the story's world
 * locations — a case-insensitive name match writes the locationId into the
 * persisted state so the keyframe strategy picks up the location plate. */
function resolveSceneLocations(
  scenes: StoryScene[],
  world: StoryWorld,
): { scenes: StoryScene[]; changed: boolean } {
  const allowed = world.locationIds ?? [];
  if (!allowed.length) return { scenes, changed: false };
  const wanted = new Set(allowed);
  const pool = listLocationsRepository().filter((row) => wanted.has(row.id));
  if (!pool.length) return { scenes, changed: false };
  let changed = false;
  const next = scenes.map((scene) => {
    const needle = scene.state?.locationText?.trim().toLowerCase();
    if (!scene.state || scene.state.locationId || !needle) return scene;
    const match = pool.find(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        needle.includes(row.name.toLowerCase()),
    );
    if (!match) return scene;
    changed = true;
    return { ...scene, state: { ...scene.state, locationId: match.id } };
  });
  return { scenes: next, changed };
}

/** Whether this scene's animation must be preceded by a keyframe render:
 * consistency ON, a video scene (image scenes ARE stills), no manual start
 * frame (the user's pick wins), no keyframe yet, and a strategy that can
 * anchor one. */
function keyframeNeeded(story: Asset, scene: StoryScene, strategy: KeyframeStrategy): boolean {
  if (getProviderConfig().sceneConsistency === false) return false;
  if (scene.kind !== "video") return false;
  if (scene.startImageRef) return false;
  if (scene.keyframeRef) return false;
  return strategy.rung !== "none";
}

/** The keyframe job body (clientTag `k_<storyId>:<sceneId>`): the composed
 * shot prompt with the keyframe framing clause, the scene's derived seed
 * (the attempt number makes a gate retry differ), and the strategy's
 * references — multi-ref for edit models, one start ref for img2img. */
function keyframeRequestBody(
  story: Asset,
  scene: StoryScene,
  strategy: Extract<KeyframeStrategy, { rung: "multi" } | { rung: "single" }>,
): Record<string, unknown> {
  const settings = mergedSceneSettings(story.settings as GenerationSettings, scene);
  return {
    kind: "image" as const,
    prompt: keyframePrompt(composeShot(story, scene, { characters: storyCast(story) })),
    aspect: settings.aspect,
    resolution: settings.resolution,
    style: settings.style,
    count: 1,
    // The attempt number enters the seed: a gate retry is a different roll,
    // everything else stays deterministic.
    seed: deriveSceneSeed(ensureBaseSeed(story), scene.id, scene.attempts ?? 0),
    negativePrompt: settings.negativePrompt ?? "",
    enhance: settings.enhance ?? false,
    safe: settings.safe !== false,
    modelId: strategy.modelId,
    ...(strategy.rung === "multi"
      ? { referenceImageRefs: strategy.refs }
      : { startImageRef: strategy.startRef }),
    clientTag: `k_${story.id}:${scene.id}`,
  };
}

/** Stamp any scene still missing its deterministic seed. */
function withSeeds(world: StoryWorld, scenes: StoryScene[]): { scenes: StoryScene[]; changed: boolean } {
  let changed = false;
  const next = scenes.map((scene) => {
    if (scene.seed !== undefined) return scene;
    changed = true;
    return { ...scene, seed: deriveSceneSeed(world.baseSeed ?? 0, scene.id) };
  });
  return { scenes: next, changed };
}

/** Compose one scene's render request. The scene's settings overrides ride
 * on top of the story snapshot (lib/story/scene-settings.ts). */
export function sceneRequestBody(story: Asset, scene: StoryScene): Record<string, unknown> {
  const settings = mergedSceneSettings(story.settings as GenerationSettings, scene);
  const continuity = story.meta?.continuity !== false;
  const index = story.scenes?.findIndex((s) => s.id === scene.id) ?? -1;
  const predecessor =
    continuity && index > 0 && story.scenes
      ? chainPredecessor(story.scenes, index)
      : undefined;
  // Anchor precedence: the user's manual frame, else the scene's own
  // keyframe render, else the chain predecessor's final frame.
  const startRef =
    scene.startImageRef ?? scene.keyframeRef ?? predecessor?.endFrameRef ?? undefined;
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
    // Deterministic per scene (seeded once at Generate); null = the service
    // rolls a fresh seed, the pre-consistency behavior for legacy scenes.
    seed: scene.seed ?? null,
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
 * snapshot settings, seed the world and compose the shot prompts, then
 * advance. Idempotent — a run already in flight is resumed, never duplicated.
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
  const { world, changed: worldChanged } = ensureWorld(story);
  const { scenes: seeded, changed: seedsChanged } = withSeeds(world, settled);
  // Free-text locations resolve once at run start so the keyframe strategy
  // sees the location plate, not just the prose.
  const { scenes: located, changed: locatedChanged } = resolveSceneLocations(seeded, world);
  const cast = storyCast(story);
  const ctx = { characters: cast };
  const withPrompts: StoryScene[] = located.map((scene) => ({
    ...scene,
    runPrompt: composeShot({ ...story, settings }, scene, ctx),
  }));
  patchStoryRepository(storyId, {
    settings,
    scenes: withPrompts,
    ...(worldChanged ? { world } : {}),
    meta: { ...(story.meta ?? {}), running: true },
  });
  if (worldChanged) log().info("story world seeded", { storyId, baseSeed: world.baseSeed });
  if (locatedChanged) log().info("scene locations resolved", { storyId });
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
  const flip = (patch: Partial<StoryScene>) =>
    patchStoryRepository(storyId, {
      scenes: (getStoriesRepository(storyId)?.scenes ?? scenes).map((s) =>
        s.id === next.id ? { ...s, ...patch } : s,
      ),
    });

  // Scene-consistency rung: anchor the scene with a keyframe still first.
  // The scene flips to generating under a `keyframe` progress stage and the
  // IMAGE job carries a `k_` clientTag the executor absorbs separately.
  const strategy = resolveKeyframeStrategy({
    story,
    scene: next,
    cast: sceneCast(next.state, { characters: storyCast(story) }),
    location: sceneLocation(story, next),
    predecessorEndRef:
      story.meta?.continuity !== false && predecessor?.status === "completed"
        ? predecessor.endFrameRef
        : undefined,
    imageModels: listImageModelDescriptors(),
  });
  if (keyframeNeeded(story, next, strategy) && strategy.rung !== "none") {
    flip({
      status: "generating",
      error: undefined,
      progress: { stage: "keyframe", message: "Rendering keyframe…" },
    });
    try {
      createJob(keyframeRequestBody(story, next, strategy));
      log().info("story keyframe enqueued", { storyId, sceneId: next.id });
    } catch (error) {
      failSceneEnqueue(storyId, next.id, enqueueErrorMessage(error));
    }
    return getStoriesRepository(storyId) as Asset;
  }

  flip({ status: "generating" as const, error: undefined });
  try {
    createJob(sceneRequestBody(story, next));
    log().info("story scene enqueued", { storyId, sceneId: next.id });
  } catch (error) {
    failSceneEnqueue(storyId, next.id, enqueueErrorMessage(error));
  }
  return getStoriesRepository(storyId) as Asset;
}

function enqueueErrorMessage(error: unknown): string {
  return error instanceof GenerationServiceError
    ? error.message
    : ((error as Error)?.message ?? "The scene could not be queued.");
}

/** An enqueue failure writes the failure into its scene and halts the run —
 * shared by the scene and keyframe enqueue paths. */
function failSceneEnqueue(storyId: string, sceneId: string, message: string): void {
  patchStoryRepository(storyId, {
    scenes: (getStoriesRepository(storyId)?.scenes ?? []).map((s) =>
      s.id === sceneId
        ? { ...s, status: "failed" as const, error: message, progress: undefined }
        : s,
    ),
    meta: { ...(getStoriesRepository(storyId)?.meta ?? {}), running: false },
  });
  log().warn("story scene failed to enqueue", { storyId, sceneId, message });
}

/**
 * Start a generating scene's own render right after its keyframe was
 * accepted (or the gate was unavailable). The scene never left "generating",
 * so the queued-picking advance can't serve it — the flip already happened
 * when the keyframe was enqueued, and with `keyframeRef` set a second
 * keyframe is impossible, so creating the video job here keeps the
 * one-renders-at-a-time chain intact.
 */
export async function advanceSceneAfterKeyframe(
  storyId: string,
  sceneId: string,
): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  const scene = story?.scenes?.find((s) => s.id === sceneId);
  if (!story || !scene || !isStoryRunning(story)) return story;
  if (scene.status !== "generating") return advanceStoryChain(storyId);
  try {
    createJob(sceneRequestBody(story, scene));
    log().info("story scene enqueued after keyframe", { storyId, sceneId });
  } catch (error) {
    failSceneEnqueue(storyId, sceneId, enqueueErrorMessage(error));
  }
  return getStoriesRepository(storyId);
}

/** Stop a run: cancel its in-flight jobs (scene renders and keyframes),
 * park generating scenes as queued. */
export async function cancelStoryRun(storyId: string): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  if (!story) return undefined;
  for (const job of listActiveJobsRepository()) {
    const tag = job.clientTag;
    if (tag && (tag.startsWith(`${storyId}:`) || tag.startsWith(`k_${storyId}:`))) {
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
    const tags = new Set([`${storyId}:${sceneId}`, `k_${storyId}:${sceneId}`]);
    for (const job of listActiveJobsRepository()) {
      if (job.clientTag && tags.has(job.clientTag)) {
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
 * run is active (mirrors the client runner's requeueScene). The scene keeps
 * its seed — a re-roll must be an explicit choice, not a side effect — but
 * any keyframe is dropped (a fresh one renders) and the gate attempt ladder
 * restarts. */
export async function requeueStoryScene(storyId: string, sceneId: string): Promise<Asset | undefined> {
  const story = getStoriesRepository(storyId);
  const scene = story?.scenes?.find((s) => s.id === sceneId);
  if (!story || !scene || scene.status === "generating" || scene.status === "queued") {
    return story;
  }
  const world = story.world ?? { baseSeed: mintSeed() };
  const seed = scene.seed ?? deriveSceneSeed(world.baseSeed ?? 0, sceneId);
  patchStoryRepository(storyId, {
    scenes: (story.scenes ?? []).map((s) =>
      s.id === sceneId
        ? {
            ...s,
            status: "queued" as const,
            error: undefined,
            seed,
            keyframeRef: undefined,
            score: undefined,
            attempts: 0,
          }
        : s,
    ),
    ...(story.world ? {} : { world }),
  });
  log().info("story scene requeued", { storyId, sceneId });
  if (isStoryRunning(story)) return advanceStoryChain(storyId);
  return getStoriesRepository(storyId);
}

/* ------------------------------------------------------------------ */
/* Console mutations (server read-modify-write)                         */
/* ------------------------------------------------------------------ */

export type SceneMutation =
  | { op: "add"; scene: StoryScene }
  | { op: "remove"; sceneId: string }
  | { op: "move"; sceneId: string; delta: -1 | 1 }
  | { op: "edit"; sceneId: string; prompt: string }
  | { op: "continuity"; value: boolean }
  | { op: "world"; world: StoryWorld }
  | { op: "update"; sceneId: string; patch: SceneUpdatePatch };

/** Per-scene update from the composer's scene edit mode (or the Writer plan).
 * Ref values of null clear the ref. The render prompt is recomposed HERE from
 * the fresh prompt/state — the client never sends one. An explicit empty
 * `settings` object clears the scene's overrides; an absent key preserves
 * them. */
export interface SceneUpdatePatch {
  prompt?: string;
  kind?: GenerationKind;
  settings?: Partial<GenerationSettings>;
  startImageRef?: string | null;
  endImageRef?: string | null;
  state?: SceneState | null;
}

/** Apply one scene-level edit to the live story record. A generating scene
 * is never removed or edited mid-flight (cancel it first), mirroring the
 * client runner's guards. */
export function mutateStoryScenes(
  storyId: string,
  mutation: SceneMutation,
): Asset | undefined {
  const story = getStoriesRepository(storyId);
  if (!story || story.kind !== "story") return undefined;
  const scenes = story.scenes ?? [];

  if (mutation.op === "continuity") {
    patchStoryRepository(storyId, {
      meta: { ...(story.meta ?? {}), continuity: mutation.value },
    });
    return getStoriesRepository(storyId);
  }

  if (mutation.op === "world") {
    // The story's consistency world (location picks). Next run start reads
    // it for the keyframe location plate.
    patchStoryRepository(storyId, { world: mutation.world });
    return getStoriesRepository(storyId);
  }

  if (mutation.op === "add") {
    if (!mutation.scene.prompt?.trim() || scenes.length >= 6) {
      return getStoriesRepository(storyId);
    }
    patchStoryRepository(storyId, { scenes: [...scenes, mutation.scene] });
    return getStoriesRepository(storyId);
  }

  const index = scenes.findIndex((s) => s.id === mutation.sceneId);
  if (index === -1) return getStoriesRepository(storyId);

  if (mutation.op === "remove") {
    if (scenes[index].status === "generating") return getStoriesRepository(storyId);
    patchStoryRepository(storyId, { scenes: scenes.filter((s) => s.id !== mutation.sceneId) });
    return getStoriesRepository(storyId);
  }
  if (mutation.op === "edit") {
    const next = mutation.prompt.trim();
    if (!next || scenes[index].status === "generating") return getStoriesRepository(storyId);
    // Same budget the composer enforced client-side (Settings → General).
    const promptMax = getProviderConfig().promptMaxChars;
    patchStoryRepository(storyId, {
      scenes: scenes.map((s) =>
        s.id === mutation.sceneId ? { ...s, prompt: next.slice(0, promptMax) } : s,
      ),
    });
    return getStoriesRepository(storyId);
  }
  if (mutation.op === "update") {
    const scene = scenes[index];
    // A rendering scene owns its request; a completed scene owns its media.
    // Everything else (queued/canceled/failed) is fair game — the runner
    // reads these fields when the chain reaches the scene.
    if (!scene || scene.status === "generating" || scene.status === "completed") {
      return getStoriesRepository(storyId);
    }
    const patch = mutation.patch;
    const promptMax = getProviderConfig().promptMaxChars;
    const prompt =
      typeof patch.prompt === "string" && patch.prompt.trim()
        ? patch.prompt.trim().slice(0, promptMax)
        : undefined;
    const kind =
      patch.kind === "image" || patch.kind === "video" ? patch.kind : undefined;
    const clearSettings =
      "settings" in patch && !(patch.settings && Object.keys(patch.settings).length);
    const nextSettings = clearSettings
      ? undefined
      : (patch.settings as Partial<GenerationSettings> | undefined);
    const clearState = patch.state === null;
    const nextState = clearState ? undefined : patch.state;
    patchStoryRepository(storyId, {
      scenes: scenes.map((s) => {
        if (s.id !== mutation.sceneId) return s;
        const next: StoryScene = {
          ...s,
          ...(prompt ? { prompt } : {}),
          ...(kind ? { kind } : {}),
          ...(nextSettings ? { settings: nextSettings } : {}),
          ...(patch.startImageRef !== undefined
            ? { startImageRef: patch.startImageRef ?? undefined }
            : {}),
          ...(patch.endImageRef !== undefined
            ? { endImageRef: patch.endImageRef ?? undefined }
            : {}),
          ...(nextState ? { state: nextState } : {}),
        };
        if (clearSettings) delete next.settings;
        if (clearState) delete next.state;
        // One prompt truth: recomposed server-side from the fresh prompt +
        // state with the live cast — the client never sends a runPrompt.
        next.runPrompt = composeShot(story, next, { characters: storyCast(story) });
        return next;
      }),
    });
    return getStoriesRepository(storyId);
  }
  // move
  const target = index + mutation.delta;
  if (target < 0 || target >= scenes.length) return getStoriesRepository(storyId);
  const reordered = [...scenes];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  patchStoryRepository(storyId, { scenes: reordered });
  return getStoriesRepository(storyId);
}
