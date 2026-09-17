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
  getStoriesRepository,
  patchStoryRepository,
  putStoryRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import { setJobsPathForTests, type JobRecord } from "@/lib/repositories/jobs.repository";
import {
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
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
  enqueued.jobs = [];
  enqueued.body = {};
  failEnqueueWith = null;
});

describe("server story runner", () => {
  it("start resets failed/canceled scenes, snapshots prompts/settings, enqueues the first runnable", async () => {
    // A completed scene is NOT re-rendered by Generate (per-scene re-run
    // handles that) — same semantics as the client runner's start().
    putStory(story("s1", [
      scene("sc1", { status: "completed", url: "/api/media?f=a.png" }),
      scene("sc2", { status: "failed", error: "old" }),
    ]));
    const result = await startStoryRun("s1", {
      settingsPatch: { modelId: "sogni:krea2_turbo_fp8_scaled", safe: false },
      runPrompts: { sc1: "composed one", sc2: "composed two" },
    });

    expect(result.meta?.running).toBe(true);
    expect(sceneStatus("sc1")).toBe("completed");
    // Flip-then-enqueue: the scene shows generating the moment its job is
    // queued (no await between, so a concurrent advance can't double-fire).
    expect(sceneStatus("sc2")).toBe("generating");
    expect(enqueued.jobs).toHaveLength(1);
    expect(enqueued.jobs[0].clientTag).toBe("s1:sc2");
    expect(enqueued.body.prompt).toBe("composed two"); // snapshot wins
    expect(enqueued.body.modelId).toBe("sogni:krea2_turbo_fp8_scaled");
    expect(enqueued.body.safe).toBe(false);
    expect(current().settings.modelId).toBe("sogni:krea2_turbo_fp8_scaled");
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
        runPrompt: "composed prompt",
      },
    });
    const sc1 = updated?.scenes?.[0];
    expect(sc1?.prompt).toBe("new prompt");
    expect(sc1?.kind).toBe("video");
    expect(sc1?.settings).toEqual({ aspect: "9:16" });
    expect(sc1?.startImageRef).toBe("ref-start");
    expect(sc1?.endImageRef).toBeUndefined();
    expect(sc1?.runPrompt).toBe("composed prompt");
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
