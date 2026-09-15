import { describe, expect, it, vi } from "vitest";
import { createStoryRunner, type StoryRunnerDeps } from "@/lib/story/runner";
import type { Asset, StoryScene } from "@/lib/types";

function scene(partial: Partial<StoryScene> & { id: string }): StoryScene {
  return { prompt: "p", url: null, status: "queued", kind: "image", ...partial };
}

function story(scenes: StoryScene[], meta: Record<string, unknown> = {}): Asset {
  return {
    id: "story1",
    kind: "story",
    title: "t",
    prompt: "p",
    url: "",
    variants: [],
    settings: {
      kind: "image", aspect: "16:9", resolution: "1080p", style: "Realistic",
      duration: "5s", count: 1, seed: "", negativePrompt: "", enhance: true, safe: true,
    },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta,
  } as unknown as Asset;
}

function makeDeps() {
  const assets = new Map<string, Asset>();
  const deps = {
    assets,
    getStory: (id: string) => assets.get(id),
    updateStoryScenes: (id: string, updater: (scenes: StoryScene[]) => StoryScene[]) => {
      const asset = assets.get(id);
      if (asset?.scenes) assets.set(id, { ...asset, scenes: updater(asset.scenes) });
    },
    requestGeneration: vi.fn(async () => ({
      requestId: "r", status: "completed", kind: "image", elapsedMs: 1,
      media: [{ id: "m", url: "/api/media?f=new.png", width: 8, height: 8, seed: 1 }],
    })),
    uploadFrameRef: vi.fn(async () => "new.png"),
    extractLastFrame: vi.fn(async () => new Blob(["frame"], { type: "image/jpeg" })),
    refFromMediaUrl: (url: string | null | undefined) =>
      url ? (new URL(url, "http://x.invalid").searchParams.get("f")) : null,
    onNotice: vi.fn(),
  };
  return deps as typeof deps & StoryRunnerDeps;
}

describe("story runner scheduling", () => {
  it("renders continuation scenes sequentially with chained start refs", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "completed", url: "/api/media?f=a.png" }),
      scene({ id: "s2" }),
      scene({ id: "s3" }),
    ], { continuity: true }));

    runner.start("story1");

    // s1 is pre-completed (no provider call); s2 and s3 generate.
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
    const scenes = deps.assets.get("story1")!.scenes!;
    expect(scenes.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);
    // s2 chained off s1's backfilled image frame; s3 chained off s2's end frame.
    const calls = deps.requestGeneration.mock.calls as unknown as [
      { startImageRef?: string },
    ][];
    expect(calls[0][0].startImageRef).toBe("a.png");
    expect(calls[1][0].startImageRef).toBe("new.png");
  });

  it("renders independent scenes in parallel when continuity is off", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" }), scene({ id: "s2" })], { continuity: false }));

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
    // No frame refs when continuity is off.
    expect(deps.requestGeneration).toHaveBeenCalledWith(expect.not.objectContaining({ startImageRef: expect.anything() }));
  });

  it("parallelizes conversion clips that carry explicit start refs", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "c1", kind: "video", startImageRef: "a.png", endImageRef: "b.png" }),
      scene({ id: "c2", kind: "video", startImageRef: "b.png", endImageRef: "c.png" }),
    ], { continuity: true }));

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
  });

  it("marks dependents waiting when a predecessor fails and resumes on retry", async () => {
    const deps = makeDeps();
    deps.requestGeneration = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        requestId: "r", status: "completed", kind: "image", elapsedMs: 1,
        media: [{ id: "m", url: "/api/media?f=b1.png", width: 8, height: 8, seed: 1 }],
      })
      .mockResolvedValue({
        requestId: "r", status: "completed", kind: "image", elapsedMs: 1,
        media: [{ id: "m", url: "/api/media?f=b2.png", width: 8, height: 8, seed: 1 }],
      }) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" }), scene({ id: "s2" })], { continuity: true }));

    runner.start("story1");

    await vi.waitFor(() => {
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes[0].status).toBe("failed");
      expect(scenes[1].status).toBe("queued"); // waiting, not failed
    });
    expect(deps.onNotice).toHaveBeenCalledWith("boom", "error");

    runner.start("story1"); // user retries — s1 re-runs, then s2 chains
    await vi.waitFor(() => {
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes.map((s) => s.status)).toEqual(["completed", "completed"]);
    });
  });

  it("cancel aborts in-flight work and requeues generating scenes", async () => {
    const deps = makeDeps();
    deps.requestGeneration = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" })], { continuity: true }));

    runner.start("story1");
    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("generating"));

    runner.cancel("story1");

    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("queued"));
  });

  it("rehydrate flips orphaned generating scenes back to queued", () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1", status: "generating" })]));

    runner.rehydrate(["story1"]);

    expect(deps.assets.get("story1")!.scenes![0].status).toBe("queued");
  });

  it("rehydrate resumes a story that was mid-run", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1", status: "generating" })], { running: true }));

    runner.rehydrate(["story1"]);

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
  });

  it("uses the exact provider-exported end frame when present", async () => {
    const deps = makeDeps();
    deps.requestGeneration = vi.fn(async () => ({
      requestId: "r", status: "completed", kind: "video", elapsedMs: 1,
      media: [{ id: "m", url: "/api/media?f=clip.mp4", width: 8, height: 8, seed: 1, endFrameUrl: "/api/media?f=exact.png" }],
    })) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", kind: "video" }),
      scene({ id: "s2", kind: "video" }),
    ], { continuity: true }));

    runner.start("story1");

    await vi.waitFor(() => {
      expect(deps.assets.get("story1")!.scenes![1].status).toBe("completed");
    });
    // Chained off the exact exported frame, no canvas extraction needed.
    expect(deps.extractLastFrame).not.toHaveBeenCalled();
    expect(deps.uploadFrameRef).not.toHaveBeenCalled();
    expect(deps.requestGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({ startImageRef: "exact.png" }),
    );
  });

  it("skips chaining when extraction fails but the story continues", async () => {
    const deps = makeDeps();
    deps.extractLastFrame = vi.fn(async () => {
      throw new Error("no canvas");
    }) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", kind: "video" }),
      scene({ id: "s2", kind: "video" }),
    ], { continuity: true }));

    runner.start("story1");

    await vi.waitFor(() => {
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes.map((s) => s.status)).toEqual(["completed", "completed"]);
    });
    expect(deps.requestGeneration).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ startImageRef: expect.anything() }),
    );
    expect(deps.onNotice).toHaveBeenCalledWith(
      "Couldn't read the last frame — continuing without it.",
    );
  });
});

describe("story runner character reuse", () => {
  it("prepends the attached character's anchor to every scene prompt", async () => {
    const deps = makeDeps();
    deps.getCharacter = vi.fn((id: string) =>
      id === "ch_1"
        ? {
            id: "ch_1",
            name: "Maya",
            spec: {
              prompt: "A warrior queen",
              style: "Realistic",
              gender: "Female",
              age: 25,
              ethnicity: "Not specified",
              country: "Not specified",
              skinTone: "medium",
              faceShape: "Oval",
              facialFeatures: "Natural",
              expression: "Neutral",
              hairColor: "Black",
              hairStyle: "Braided",
              eyeColor: "Brown",
              eyeShape: "Almond",
              outfit: "Fantasy armor",
              accessories: "None",
              build: "Athletic",
              bodyDetails: "Normal proportions",
              tattoos: false,
              piercings: false,
              facialHair: false,
              personality: "",
              nsfwLevel: 0,
              look: "",
            },
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined,
    ) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1", prompt: "walking through rain" })], {
      continuity: true,
      characterId: "ch_1",
    }));

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
    const calls = deps.requestGeneration.mock.calls as unknown as [{ prompt: string }][];
    expect(calls[0][0].prompt.startsWith("portrait of an adult")).toBe(true);
    expect(calls[0][0].prompt).toContain("fantasy armor");
    expect(calls[0][0].prompt.endsWith("walking through rain")).toBe(true);
  });

  it("clamps an adult character to the safe anchor when the story renders safe", async () => {
    const deps = makeDeps();
    deps.getCharacter = vi.fn(() => ({
      id: "ch_2",
      name: "Adult character",
      spec: {
        prompt: "",
        style: "Realistic",
        gender: "Female",
        age: 25,
        ethnicity: "Not specified",
        country: "Not specified",
        skinTone: "medium",
        faceShape: "Oval",
        facialFeatures: "Natural",
        expression: "Neutral",
        hairColor: "Black",
        hairStyle: "Braided",
        eyeColor: "Brown",
        eyeShape: "Almond",
        outfit: "Nude",
        accessories: "None",
        build: "Slim",
        bodyDetails: "Normal proportions",
        tattoos: false,
        piercings: false,
        facialHair: false,
        personality: "",
        nsfwLevel: 3,
        look: "",
      },
      createdAt: 0,
      updatedAt: 0,
    })) as never;
    const runner = createStoryRunner(deps);
    // safe: true ⇒ the uncensored gate is off for this story.
    deps.assets.set("story1", story([scene({ id: "s1" })], { characterId: "ch_2" }));

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
    const calls = deps.requestGeneration.mock.calls as unknown as [{ prompt: string }][];
    expect(calls[0][0].prompt).not.toMatch(/nude|nsfw/i);
    expect(calls[0][0].prompt).toContain("fully clothed");
  });

  it("keeps scene prompts untouched when the story has no character", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1", prompt: "a quiet cafe" })], {
      characterId: "ch_missing",
    }));

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
    const calls = deps.requestGeneration.mock.calls as unknown as [{ prompt: string }][];
    expect(calls[0][0].prompt).toBe("a quiet cafe");
  });
});

describe("story queue controls", () => {
  /** A request mock that resolves every scene except the given prompt, which
   * hangs until its abort signal fires. */
  function mockWithHang(deps: ReturnType<typeof makeDeps>, hangPrompt: string) {
    deps.requestGeneration = vi.fn((input: { prompt?: string; signal?: AbortSignal }) => {
      if (input.prompt === hangPrompt) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }) as never;
      }
      return Promise.resolve({
        requestId: "r",
        status: "completed",
        kind: "image",
        elapsedMs: 1,
        media: [
          { id: "m", url: `/api/media?f=${input.prompt}.png`, width: 8, height: 8, seed: 1 },
        ],
      }) as never;
    }) as never;
  }

  it("never schedules a scene without a prompt", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set(
      "story1",
      story([scene({ id: "s1" }), scene({ id: "s2", prompt: "   " })], { continuity: false }),
    );

    runner.start("story1");

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
    expect(deps.assets.get("story1")!.scenes![1].status).toBe("queued");
  });

  it("cancelScene skips one scene and the queue continues with the next", async () => {
    const deps = makeDeps();
    mockWithHang(deps, "hold");
    const runner = createStoryRunner(deps);
    deps.assets.set(
      "story1",
      story(
        [scene({ id: "s1", prompt: "hold" }), scene({ id: "s2", prompt: "go" })],
        { continuity: false },
      ),
    );

    runner.start("story1");
    await vi.waitFor(() =>
      expect(deps.assets.get("story1")!.scenes!.map((s) => s.status)).toEqual([
        "generating",
        "queued",
      ]),
    );

    runner.cancelScene("story1", "s1");

    await vi.waitFor(() =>
      expect(deps.assets.get("story1")!.scenes!.map((s) => s.status)).toEqual([
        "canceled",
        "completed",
      ]),
    );
  });

  it("cancelScene on a queued scene flips it to canceled without generating", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set(
      "story1",
      story(
        [scene({ id: "s1", status: "completed", url: "/api/media?f=a.png" }), scene({ id: "s2" })],
        { continuity: true },
      ),
    );

    runner.cancelScene("story1", "s2");

    expect(deps.assets.get("story1")!.scenes![1].status).toBe("canceled");
    expect(deps.requestGeneration).not.toHaveBeenCalled();
  });

  it("a canceled middle scene is transparent to the chain — its successor chains across it", async () => {
    const deps = makeDeps();
    mockWithHang(deps, "p");
    const runner = createStoryRunner(deps);
    deps.assets.set(
      "story1",
      story(
        [
          scene({ id: "s1", status: "completed", url: "/api/media?f=a.png" }),
          scene({ id: "s2" }),
          scene({ id: "s3" }),
        ],
        { continuity: true },
      ),
    );

    runner.start("story1");
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));

    runner.cancelScene("story1", "s2"); // skip the in-flight middle scene

    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
    const calls = deps.requestGeneration.mock.calls as unknown as [
      { startImageRef?: string },
    ][];
    // s3 continues from s1's frame, skipping the canceled s2 entirely.
    expect(calls[1][0].startImageRef).toBe("a.png");
    expect(deps.assets.get("story1")!.scenes!.map((s) => s.status)).toEqual([
      "completed",
      "canceled",
      "generating",
    ]);
  });

  it("removeScene drops a queued scene without starting anything; the chain skips it on Generate", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set(
      "story1",
      story(
        [
          scene({ id: "s1", status: "completed", url: "/api/media?f=a.png" }),
          scene({ id: "s2" }),
          scene({ id: "s3" }),
        ],
        { continuity: true },
      ),
    );

    runner.removeScene("story1", "s2");

    expect(deps.assets.get("story1")!.scenes!.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(deps.requestGeneration).not.toHaveBeenCalled();

    runner.start("story1");
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));
    const calls = deps.requestGeneration.mock.calls as unknown as [
      { startImageRef?: string },
    ][];
    // s3 now chains straight from s1's frame.
    expect(calls[0][0].startImageRef).toBe("a.png");
  });

  it("Generate re-queues canceled scenes for a fresh run", async () => {
    const deps = makeDeps();
    let calls = 0;
    deps.requestGeneration = vi.fn((input: { prompt?: string; signal?: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }) as never;
      }
      return Promise.resolve({
        requestId: "r",
        status: "completed",
        kind: "image",
        elapsedMs: 1,
        media: [{ id: "m", url: "/api/media?f=done.png", width: 8, height: 8, seed: 1 }],
      }) as never;
    }) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" })], { continuity: true }));

    runner.start("story1");
    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("generating"));
    runner.cancelScene("story1", "s1");
    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("canceled"));

    runner.start("story1"); // Generate again — the canceled scene re-runs
    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("completed"));
    expect(deps.requestGeneration).toHaveBeenCalledTimes(2);
  });

  it("rehydrate leaves a paused queue alone — only stories that were running resume", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" })], { running: false }));

    runner.rehydrate(["story1"]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.requestGeneration).not.toHaveBeenCalled();
    expect(deps.assets.get("story1")!.scenes![0].status).toBe("queued");
  });
});
