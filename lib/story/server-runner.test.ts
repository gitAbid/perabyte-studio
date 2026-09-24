import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Asset, StoryScene } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";
import {
  setAssetsPathForTests,
} from "@/lib/repositories/assets.repository";
import {
  putCharacterRepository,
  setCharactersPathForTests,
} from "@/lib/repositories/characters.repository";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import {
  getStoriesRepository,
  patchStoryRepository,
  putStoryRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import { setJobsPathForTests, type JobRecord } from "@/lib/repositories/jobs.repository";
import {
  setLocationsPathForTests,
  putLocationRepository,
} from "@/lib/repositories/locations.repository";
import {
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { advanceSceneAfterKeyframe } from "@/lib/story/server-runner";

vi.mock("@/lib/story/keyframe-models", () => ({
  listImageModelDescriptors: () => [
    {
      id: "sogni:qwen_image_edit_2511",
      provider: "sogni",
      model: "qwen_image_edit_2511",
      label: "Qwen Edit",
      kind: "image",
      contextImages: { min: 1, max: 3 },
    },
  ],
}));
import {
  advanceStoryChain,
  cancelStoryRun,
  cancelStoryScene,
  mutateStoryScenes,
  requeueStoryScene,
  startStoryRun,
  sceneRequestBody,
} from "@/lib/story/server-runner";

/**
 * The executor is stubbed at the boundary (createJob → jobs.service →
 * getJobExecutor): enqueue calls are captured instead of driving real
 * providers. The chain semantics under test are pure orchestration.
 */
const enqueued: { body: Record<string, unknown>; jobs: JobRecord[] } = {
  body: {},
  jobs: [],
};

let failEnqueueWith: Error | null = null;

import { vi } from "vitest";
import { type Mock } from "vitest";

vi.mock("@/lib/jobs/jobs.service", () => ({
  createJob: (body: Record<string, unknown>) => {
    if (failEnqueueWith) throw failEnqueueWith;
    enqueued.body = body;
    const job: JobRecord = {
      id: `job_${enqueued.jobs.length + 1}`,
      provider: "sogni",
      kind: body.kind === "video" ? "video" : "image",
      modelId: String(body.modelId ?? "m"),
      request: body,
      status: "queued",
      clientTag: String(body.clientTag ?? ""),
      createdAt: 1,
    };
    enqueued.jobs.push(job);
    return job;
  },
}));

function scene(id: string, over: Partial<StoryScene> = {}): StoryScene {
  return {
    id,
    prompt: `prompt for ${id}`,
    url: null,
    status: "queued",
    kind: "image",
    ...over,
  };
}

function story(id: string, scenes: StoryScene[], over: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: "story",
    title: `Story ${id}`,
    prompt: "s",
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS, kind: "image", count: 1 },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta: { continuity: true, running: false },
    ...over,
  };
}

let storyId: string;

function putStory(s: Asset) {
  putStoryRepository(s);
  storyId = s.id;
}

function current(): Asset {
  return getStoriesRepository(storyId) as Asset;
}

function sceneStatus(id: string): string {
  return current().scenes?.find((s) => s.id === id)?.status ?? "missing";
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-runner-"));
  setStoriesPathForTests(path.join(tmp, "stories.json"));
  setAssetsPathForTests(path.join(tmp, "assets.json"));
  setJobsPathForTests(path.join(tmp, "jobs.json"));
  setProviderConfigPathForTests(path.join(tmp, "settings.json"));
  setCharactersPathForTests(path.join(tmp, "characters.json"));
  setLocationsPathForTests(path.join(tmp, "locations.json"));
  enqueued.jobs = [];
  enqueued.body = {};
  failEnqueueWith = null;
});

describe("server story runner", () => {
  it("start resets failed/canceled scenes, composes prompts server-side, enqueues the first runnable", async () => {
    // A completed scene is NOT re-rendered by Generate (per-scene re-run
    // handles that) — same semantics as the client runner's start().
    putStory(story("s1", [
      scene("sc1", { status: "completed", url: "/api/media?f=a.png" }),
      scene("sc2", { status: "failed", error: "old" }),
    ]));
    const result = await startStoryRun("s1", {
      settingsPatch: { modelId: "sogni:krea2_turbo_fp8_scaled", safe: false },
    });

    expect(result.meta?.running).toBe(true);
    expect(sceneStatus("sc1")).toBe("completed");
    // Flip-then-enqueue: the scene shows generating the moment its job is
    // queued (no await between, so a concurrent advance can't double-fire).
    expect(sceneStatus("sc2")).toBe("generating");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s1:sc2");
    // Server-composed prompt: no cast and no state → the clean prompt.
    expect(enqueued.body.prompt).toBe("prompt for sc2");
    expect(enqueued.body.seed).toBeTypeOf("number");
    expect(enqueued.body.modelId).toBe("sogni:krea2_turbo_fp8_scaled");
    expect(enqueued.body.safe).toBe(false);
    expect(current().settings.modelId).toBe("sogni:krea2_turbo_fp8_scaled");
  });

  it("mints the world base seed once and keeps scene seeds stable across runs", async () => {
    putStory(story("s-seed", [scene("sc1"), scene("sc2")]));
    await startStoryRun("s-seed");
    const first = current();
    const baseSeed = first.world?.baseSeed;
    expect(baseSeed).toBeTypeOf("number");
    const seeds = first.scenes!.map((s) => s.seed);
    for (const seed of seeds) expect(seed).toBeTypeOf("number");
    // The enqueued request carries the scene's persisted seed.
    expect(enqueued.body.seed).toBe(seeds[0]);

    // A second start reuses the SAME base seed and scene seeds.
    patchStoryRepository(storyId, {
      scenes: current().scenes!.map((sc) =>
        sc.id === "sc1" ? { ...sc, status: "failed" as const } : sc,
      ),
      meta: { ...(current().meta ?? {}), running: false },
    });
    await startStoryRun("s-seed");
    expect(current().world?.baseSeed).toBe(baseSeed);
    expect(current().scenes!.map((s) => s.seed)).toEqual(seeds);
  });

  it("advance runs scenes one at a time and threads the chain ref", async () => {
    putStory(story("s2", [
      scene("sc1", {
        status: "generating",
        endFrameRef: "frame123.jpg",
        url: "/api/media?f=frame123.jpg",
      }),
      scene("sc2"),
    ], { meta: { continuity: true, running: true } }));

    // Simulate the executor's completion → absorb already happened client-
    // side of these tests; here we just flip sc1 to completed and advance.
    patchStoryRepository(storyId, {
      scenes: current().scenes!.map((sc) =>
        sc.id === "sc1" ? { ...sc, status: "completed" as const } : sc,
      ),
    });
    await advanceStoryChain(storyId);

    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s2:sc2");
    // The chain ref flows into the next request.
    expect(enqueued.body.startImageRef).toBe("frame123.jpg");
    expect(sceneStatus("sc2")).toBe("generating"); // flipped synchronously
  });

  it("canceled scenes are transparent; failed predecessors halt the run", async () => {
    putStory(story("s3", [
      scene("sc1", { status: "completed", endFrameRef: "f.jpg" }),
      scene("sc2", { status: "canceled" }),
      scene("sc3", { status: "failed", error: "provider exploded" }),
      scene("sc4"),
    ]));

    await advanceStoryChain(storyId);
    // sc3 failed and is sc4's nearest non-canceled predecessor — halted.
    expect(enqueued.jobs).toHaveLength(0);
    expect(current().meta?.running).toBe(false);

    // Recover sc3 → the chain proceeds across the canceled sc2.
    patchStoryRepository(storyId, {
      scenes: current().scenes!.map((sc) =>
        sc.id === "sc3" ? { ...sc, status: "queued" as const, error: undefined } : sc,
      ),
      meta: { ...(current().meta ?? {}), running: true },
    });
    await advanceStoryChain(storyId);
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s3:sc3");
  });

  it("a run with no queued scenes left completes itself", async () => {
    putStory(story("s4", [scene("sc1", { status: "completed" })]));
    const result = await advanceStoryChain(storyId);
    expect(result.meta?.running).toBe(false);
    expect(enqueued.jobs).toHaveLength(0);
  });

  it("cancel stops the run and parks generating scenes as queued", async () => {
    putStory(story("s5", [
      scene("sc1", { status: "generating" }),
      scene("sc2"),
    ]));
    patchStoryRepository(storyId, { meta: { continuity: true, running: true } });

    const result = await cancelStoryRun(storyId);
    expect(result?.meta?.running).toBe(false);
    expect(sceneStatus("sc1")).toBe("queued");
    expect(sceneStatus("sc2")).toBe("queued");
    expect(enqueued.jobs).toHaveLength(0);
  });

  it("scene cancel + rerun follow the client runner's semantics", async () => {
    putStory(story("s6", [
      scene("sc1", { status: "completed" }),
      scene("sc2", { status: "canceled" }),
    ]));
    // Rerun only works on settled scenes and does nothing while idle.
    const rerun = await requeueStoryScene(storyId, "sc2");
    expect(rerun?.scenes?.find((s) => s.id === "sc2")?.status).toBe("queued");
    expect(enqueued.jobs).toHaveLength(0); // no active run — Generate triggers it

    // Scene cancel on a queued scene parks it canceled.
    patchStoryRepository(storyId, {
      scenes: current().scenes!.map((sc) =>
        sc.id === "sc2" ? { ...sc, status: "queued" as const } : sc,
      ),
    });
    await cancelStoryScene(storyId, "sc2");
    expect(sceneStatus("sc2")).toBe("canceled");
  });

  it("an enqueue failure fails the scene and halts the run", async () => {
    putStory(story("s7", [scene("sc1")]));
    failEnqueueWith = new Error("provider not configured");
    const result = await startStoryRun("s7");
    expect(result.meta?.running).toBe(false);
    expect(sceneStatus("sc1")).toBe("failed");
    expect(current().scenes?.[0].error).toContain("provider not configured");
  });

  it("scene request bodies carry the chain model and manual start ref", () => {
    const s = story("s8", [
      scene("sc1", { status: "completed", endFrameRef: "f.jpg" }),
      scene("sc2", { startImageRef: "manual.png" }),
    ]);
    s.settings = { ...s.settings, chainModelId: "sogni:krea2_turbo_i2v" };
    const body = sceneRequestBody(s, s.scenes![1]);
    // Manual start ref wins over the chain, so the chain model applies.
    expect(body.startImageRef).toBe("manual.png");
    expect(body.modelId).toBe("sogni:krea2_turbo_i2v");
    expect(body.clientTag).toBe("s8:sc2");
  });

  it("scene request bodies honor a scene's settings overrides", () => {
    const s = story("s9", [
      scene("sc1", {
        settings: { aspect: "9:16", modelId: "prov:model-b", style: "Anime" },
      }),
    ]);
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![0]);
    expect(body.aspect).toBe("9:16");
    expect(body.modelId).toBe("prov:model-b");
    expect(body.style).toBe("Anime");
    // Untouched fields still come from the story settings.
    expect(body.duration).toBe(s.settings.duration);
  });

  it("scenes without overrides render exactly from story settings", () => {
    const s = story("s10", [scene("sc1")]);
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![0]);
    expect(body.aspect).toBe(s.settings.aspect);
    expect(body.modelId).toBe(s.settings.modelId ?? null);
  });

  it("story chainModelId wins over a scene model when a start ref exists", () => {
    const s = story("s11", [
      scene("sc1", { status: "completed", endFrameRef: "f.jpg" }),
      scene("sc2", { startImageRef: "manual.png", settings: { modelId: "prov:t2v" } }),
    ]);
    s.settings = {
      ...s.settings,
      chainModelId: "prov:i2v",
      modelId: "prov:t2v",
    };
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![1]);
    expect(body.modelId).toBe("prov:i2v");
  });

  it("a scene model override applies under Auto chain (no chainModelId)", () => {
    const s = story("s12", [
      scene("sc1", { status: "completed", endFrameRef: "f.jpg" }),
      scene("sc2", { startImageRef: "manual.png", settings: { modelId: "prov:i2v-custom" } }),
    ]);
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![1]);
    expect(body.modelId).toBe("prov:i2v-custom");
  });
});

describe("mutateStoryScenes update", () => {
  function putQueued(id: string, over: Partial<StoryScene> = {}) {
    putStory(story(id, [scene("sc1", over)]));
    return id;
  }

  it("updates prompt, kind, settings and refs on a queued scene", () => {
    putQueued("u1");
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: {
        prompt: "new prompt",
        kind: "video",
        settings: { aspect: "9:16" },
        startImageRef: "ref-start",
        endImageRef: null,
      },
    });
    const sc1 = updated?.scenes?.[0];
    expect(sc1?.prompt).toBe("new prompt");
    expect(sc1?.kind).toBe("video");
    expect(sc1?.settings).toEqual({ aspect: "9:16" });
    expect(sc1?.startImageRef).toBe("ref-start");
    expect(sc1?.endImageRef).toBeUndefined();
    // The render prompt is recomposed server-side — the client never sends one.
    expect(sc1?.runPrompt).toBe("new prompt");
  });

  it("state rides the update patch into the recomposed prompt and clears with null", () => {
    putQueued("u-state");
    let updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: {
        state: {
          locationText: "a rooftop bar downtown",
          timeOfDay: "night",
          props: ["red umbrella"],
        },
      },
    });
    let sc1 = updated?.scenes?.[0];
    expect(sc1?.state?.locationText).toBe("a rooftop bar downtown");
    expect(sc1?.runPrompt).toContain("Setting: a rooftop bar downtown");
    expect(sc1?.runPrompt).toContain("Time of day: night");
    expect(sc1?.runPrompt).toContain("red umbrella");

    updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { state: null },
    });
    sc1 = updated?.scenes?.[0];
    expect(sc1?.state).toBeUndefined();
    expect(sc1?.runPrompt).not.toContain("Setting:");
  });

  it("recomposes the prompt with the live cast anchors and outfit overrides", () => {
    putCharacterRepository({
      id: "ch_1",
      name: "Mara",
      spec: { ...DEFAULT_CHARACTER_SPEC, age: 30, outfit: "Formal" },
      createdAt: 1,
      updatedAt: 1,
    });
    putStory(
      story("u-cast", [scene("sc1")], {
        meta: { continuity: true, running: false, characterIds: ["ch_1"] },
      }),
    );
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: {
        state: { characters: [{ id: "ch_1", outfit: "Modern streetwear" }] },
      },
    });
    const sc1 = updated?.scenes?.[0];
    expect(sc1?.runPrompt).toContain("wearing modern streetwear");
    expect(sc1?.runPrompt).not.toContain("formal");
  });

  it("refuses a generating scene", () => {
    putQueued("u2", { status: "generating" });
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { prompt: "nope" },
    });
    expect(updated?.scenes?.[0]?.prompt).not.toBe("nope");
  });

  it("refuses a completed scene", () => {
    putQueued("u3", { status: "completed", url: "/api/media?f=x" });
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { prompt: "nope" },
    });
    expect(updated?.scenes?.[0]?.prompt).not.toBe("nope");
  });

  it("accepts canceled and failed scenes", () => {
    for (const status of ["canceled", "failed"] as const) {
      putQueued(`u4-${status}`, { status });
      const updated = mutateStoryScenes(storyId, {
        op: "update",
        sceneId: "sc1",
        patch: { prompt: "retry prompt" },
      });
      expect(updated?.scenes?.[0]?.prompt).toBe("retry prompt");
    }
  });

  it("an explicit empty settings object clears overrides; an absent key preserves them", () => {
    putQueued("u5", { settings: { aspect: "9:16" } });
    let updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { settings: {} },
    });
    expect(updated?.scenes?.[0]?.settings).toBeUndefined();

    putQueued("u6", { settings: { aspect: "9:16" } });
    updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { prompt: "same overrides" },
    });
    expect(updated?.scenes?.[0]?.settings).toEqual({ aspect: "9:16" });
  });

  it("clamps the prompt to the configured budget", () => {
    putQueued("u7");
    updateProviderConfig({ promptMaxChars: 100 }); // min clamp floor
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "sc1",
      patch: { prompt: "x".repeat(150) },
    });
    expect(updated?.scenes?.[0]?.prompt).toBe("x".repeat(100));
    updateProviderConfig({ promptMaxChars: 5000 });
  });
});

describe("keyframe substage", () => {
  function anchorWorld() {
    putCharacterRepository({
      id: "ch_kf",
      name: "Mara",
      spec: { ...DEFAULT_CHARACTER_SPEC, age: 30 },
      identity: { front: "front_mara.png" },
      createdAt: 1,
      updatedAt: 1,
    });
    putLocationRepository({
      id: "loc_kf",
      name: "Rooftop bar",
      description: "neon rooftop",
      ref: "loc_plate.png",
      createdAt: 1,
      updatedAt: 1,
    });
    putStory(
      story("s_kf", [
        scene("sc1", { kind: "video", state: { locationId: "loc_kf" } }),
      ], {
        meta: { continuity: true, running: false, characterIds: ["ch_kf"] },
        world: { baseSeed: 424242, locationIds: ["loc_kf"] },
      }),
    );
  }

  it("anchors a video scene with a k_ keyframe image job first", async () => {
    anchorWorld();
    await startStoryRun("s_kf");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("k_s_kf:sc1");
    expect(enqueued.jobs[0].kind).toBe("image");
    expect(enqueued.jobs[0].modelId).toBe("sogni:qwen_image_edit_2511");
    // References: first cast front, location plate (interleaved priority).
    expect(enqueued.body.referenceImageRefs).toEqual(["front_mara.png", "loc_plate.png"]);
    // Seed derives from the world base + scene + attempt 0.
    expect(enqueued.body.seed).toBeTypeOf("number");
    const sc1 = current().scenes![0];
    expect(sc1.status).toBe("generating");
    expect(sc1.progress?.stage).toBe("keyframe");
  });

  it("animates from the keyframe ref once it is absorbed", async () => {
    anchorWorld();
    await startStoryRun("s_kf");
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1" ? { ...s, keyframeRef: "kf_still.png" } : s,
      ),
    });
    enqueued.jobs = [];
    await advanceSceneAfterKeyframe(storyId, "sc1");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s_kf:sc1");
    expect(enqueued.jobs[0].kind).toBe("video");
    // The keyframe outranks the (absent) predecessor end frame.
    expect(enqueued.body.startImageRef).toBe("kf_still.png");
  });

  it("a manual start frame skips the keyframe entirely", async () => {
    anchorWorld();
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1" ? { ...s, startImageRef: "manual.png" } : s,
      ),
    });
    await startStoryRun("s_kf");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s_kf:sc1");
    expect(enqueued.body.startImageRef).toBe("manual.png");
  });

  it("consistency OFF renders the video directly", async () => {
    anchorWorld();
    updateProviderConfig({ sceneConsistency: false });
    await startStoryRun("s_kf");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s_kf:sc1");
    expect(enqueued.body.referenceImageRefs).toBeUndefined();
    updateProviderConfig({ sceneConsistency: true });
  });

  it("image-kind scenes never keyframe", async () => {
    anchorWorld();
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1" ? { ...s, kind: "image" as const } : s,
      ),
    });
    await startStoryRun("s_kf");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s_kf:sc1");
    expect(enqueued.jobs[0].kind).toBe("image");
    expect(enqueued.body.referenceImageRefs).toBeUndefined();
  });

  it("requeue drops the keyframe and gate attempts but keeps the seed", async () => {
    anchorWorld();
    await startStoryRun("s_kf");
    const seeded = current().scenes![0].seed;
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1"
          ? { ...s, keyframeRef: "old_kf.png", score: { identity: 0.2, outfit: 0.2, location: 0.2 }, attempts: 2 }
          : s,
      ),
    });
    patchStoryRepository(storyId, { meta: { ...(current().meta ?? {}), running: false } });
    // absorb flip left the scene generating; requeue only takes settled scenes.
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1" ? { ...s, status: "failed" as const } : s,
      ),
    });
    await requeueStoryScene(storyId, "sc1");
    const sc1 = current().scenes![0];
    expect(sc1.keyframeRef).toBeUndefined();
    expect(sc1.score).toBeUndefined();
    expect(sc1.attempts).toBe(0);
    expect(sc1.seed).toBe(seeded);
  });

  it("the world mutation op persists the location pick", () => {
    anchorWorld();
    const updated = mutateStoryScenes(storyId, { op: "world", world: { baseSeed: 1, locationIds: [] } });
    expect(updated?.world?.locationIds).toEqual([]);
  });

  it("free-text locations resolve against the world at run start", async () => {
    anchorWorld();
    patchStoryRepository(storyId, {
      scenes: (current().scenes ?? []).map((s) =>
        s.id === "sc1" ? { ...s, state: { locationText: "rooftop" } } : s,
      ),
    });
    await startStoryRun("s_kf");
    expect(current().scenes![0].state?.locationId).toBe("loc_kf");
  });
});
