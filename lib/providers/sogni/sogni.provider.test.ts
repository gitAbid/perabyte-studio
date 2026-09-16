import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { logger } from "@/lib/logging/logger";
import type { NormalizedGenerationRequest } from "@/lib/domain/models";
import { ProviderError, type ProviderProgress } from "@/lib/providers/types";
import { setSogniClientForTests, type SogniClient } from "@/lib/providers/sogni/client";
import {
  imageDeadlineMs,
  sogniProvider,
  videoDeadlineMs,
} from "@/lib/providers/sogni/sogni.provider";
import { SOGNI_IMAGE_MODELS, SOGNI_VIDEO_MODELS } from "@/lib/providers/sogni/request-maps";
import type { SogniVideoParams } from "@/lib/providers/sogni/request-maps";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import {
  listPendingRenders,
  resetPendingRendersForTests,
  setPendingRendersPathForTests,
} from "@/lib/repositories/pending-renders.repository";
import {
  setMediaRepositoryForTests,
  type MediaRepository,
} from "@/lib/repositories/media.repository";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let configDir = "";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const mediaFake: MediaRepository = {
  put: async (bytes, ext) => ({
    ref: `fake.${ext ?? "bin"}`,
    contentType: ext === "mp4" ? "video/mp4" : "image/png",
    bytes,
  }),
  get: async () => null,
  stat: async () => null,
  list: async () => [],
  delete: async () => undefined,
};

const imageModel = SOGNI_IMAGE_MODELS[0];
const videoModel = SOGNI_VIDEO_MODELS[0];

function imageRequest(overrides: Partial<NormalizedGenerationRequest> = {}) {
  return {
    kind: "image" as const,
    prompt: "a fox",
    negativePrompt: "",
    aspect: "16:9" as const,
    resolution: "1080p" as const,
    durationSeconds: 0,
    count: 1,
    seed: 42,
    safe: true,
    enhance: false,
    ...overrides,
  };
}

function videoRequest(overrides: Partial<NormalizedGenerationRequest> = {}) {
  return imageRequest({ kind: "video", durationSeconds: 5, ...overrides });
}

interface CapturedCreate {
  params: Record<string, unknown>;
  completion: Promise<string[]>;
}

function fakeClient(completion: Promise<string[]>) {
  const created: CapturedCreate[] = [];
  const progressListeners: ((percent: number) => void)[] = [];
  const client: SogniClient = {
    projects: {
      create(params) {
        const id = `proj_${created.length}`;
        created.push({ params: params as unknown as Record<string, unknown>, completion });
        return Promise.resolve({
          id,
          waitForCompletion: () => completion,
          on: (
            event: "progress" | "jobCompleted",
            listener:
              | ((percent: number) => void)
              | ((job: { lastFrameUrl?: string }) => void),
          ) => {
            if (event === "progress") progressListeners.push(listener as (percent: number) => void);
          },
        });
      },
      getAvailableModels: async () => [],
    },
  };
  return { client, created, progressListeners };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "sogni-provider-test-"));
  setProviderConfigPathForTests(join(configDir, "settings.json"));
  resetProviderConfigForTests();
  setPendingRendersPathForTests(join(configDir, "pending.json"));
  resetPendingRendersForTests();
  setMediaRepositoryForTests(mediaFake);
  process.env.SOGNI_API_KEY = "test-sogni-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  setSogniClientForTests(null);
  delete process.env.SOGNI_API_KEY;
  delete process.env.SOGNI_APP_ID;
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  setPendingRendersPathForTests(null);
  resetPendingRendersForTests();
  setMediaRepositoryForTests(null);
  resetStudioEnvForTests();
  if (configDir) {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {}
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sogni provider", () => {
  it("reports itself unconfigured without SOGNI_API_KEY", () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    expect(sogniProvider.isConfigured()).toBe(false);
  });

  it("lists curated models only when configured", () => {
    expect(sogniProvider.listImageModels().length).toBe(4);
    expect(sogniProvider.listVideoModels().length).toBe(4); // + curated Seedance 2.0
  });

  it("maps completed project URLs to artifacts", async () => {
    const { client, created } = fakeClient(
      Promise.resolve(["https://cdn.sogni.ai/a.png", "https://cdn.sogni.ai/b.png"]),
    );
    setSogniClientForTests(client);

    const artifacts = await sogniProvider.generateImage(
      imageRequest({ count: 2 }),
      imageModel,
      { logger },
    );

    expect(created).toHaveLength(1);
    expect(created[0].params.modelId).toBe("krea2_turbo_fp8_scaled");
    expect(created[0].params.numberOfMedia).toBe(2);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ bytes: null, url: "https://cdn.sogni.ai/a.png", ext: "png" });
    expect(artifacts.map((a) => a.seed)).toEqual([42, 43]);
  });

  it("keeps the NSFW filter aligned with the safe flag", async () => {
    const { client, created } = fakeClient(Promise.resolve(["https://cdn.sogni.ai/a.png"]));
    setSogniClientForTests(client);

    await sogniProvider.generateImage(imageRequest({ safe: false }), imageModel, { logger });
    expect(created[0].params.disableNSFWFilter).toBe(true);

    await sogniProvider.generateImage(imageRequest({ safe: true }), imageModel, { logger });
    expect(created[1].params.disableNSFWFilter).toBe(false);
  });

  it("keeps the studio in sync by polling the project's live state", async () => {
    vi.useFakeTimers();
    const completion = new Promise<string[]>(() => {});
    const project = {
      id: "proj_readout",
      waitForCompletion: () => completion,
      on: () => undefined,
      status: "queued" as const,
      queueStatus: "waiting" as const,
      estimatedStartAt: new Date(Date.now() + 5 * 60_000),
    };
    setSogniClientForTests({
      projects: { create: async () => project, getAvailableModels: async () => [] },
    });

    const ticks: ProviderProgress[] = [];
    sogniProvider.generateVideo(videoRequest(), videoModel, {
      logger,
      onProgress: (progress) => ticks.push(progress),
    });

    await vi.advanceTimersByTimeAsync(2_100); // one readout tick
    expect(ticks.at(-1)?.stage).toBe("submitted");
    expect(ticks.at(-1)?.message).toContain("Queued on Sogni AI");

    // A worker picks the project up: state flips to processing with progress.
    Object.assign(project, {
      status: "processing",
      progress: 45.4,
      estimatedStartAt: undefined,
      eta: new Date(Date.now() + 2 * 60_000),
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(ticks.at(-1)).toMatchObject({ stage: "rendering", percent: 45 });
    expect(ticks.at(-1)?.message).toContain("45%");
    expect(ticks.at(-1)?.message).toContain("about 2 min left");

    // Unchanged state is suppressed — no tick spam while nothing moves.
    const count = ticks.length;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(ticks.length).toBe(count);
  });

  it("fails loudly and non-retryably when unconfigured", async () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();

    const error = await sogniProvider
      .generateImage(imageRequest(), imageModel, { logger })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).field).toBe("model");
  });

  it("maps project failure to a retryable ProviderError", async () => {
    const { client } = fakeClient(Promise.reject(new Error("worker ran out of memory")));
    setSogniClientForTests(client);

    const error = await sogniProvider
      .generateVideo(videoRequest(), videoModel, { logger })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).status).toBe(502);
    expect((error as ProviderError).message).toContain("worker ran out of memory");
  });

  it("times out retryably at the deadline without detaching", async () => {
    vi.useFakeTimers();
    const completion = new Promise<string[]>(() => {});
    setSogniClientForTests(fakeClient(completion).client);

    const pending = sogniProvider.generateImage(imageRequest(), imageModel, { logger });
    const assertion = expect(pending).rejects.toMatchObject({
      retryable: true,
      status: 504,
      message: expect.stringContaining("time limit"),
    });
    await vi.advanceTimersByTimeAsync(imageDeadlineMs() + 2_100);
    await assertion;

    // No detached registry — the durable job engine superseded it.
    expect(listPendingRenders()).toHaveLength(0);
  });

  it("exposes submit/poll: ref on submit, artifacts on settle", async () => {
    let resolveCompletion: (urls: string[]) => void = () => {};
    const completion = new Promise<string[]>((resolve) => {
      resolveCompletion = resolve;
    });
    const fake = fakeClient(completion);
    // The remote lookup (restart path) reports the project still processing.
    (fake.client.projects as { get?: unknown }).get = async () => ({
      status: "processing",
    });
    setSogniClientForTests(fake.client);

    const { ref } = await sogniProvider.submitJob(imageRequest({ count: 2 }), imageModel, {
      logger,
    });
    expect(ref).toBe("proj_0"); // first create in this fresh fake

    const running = await sogniProvider.pollJob(ref, imageRequest({ count: 2 }), imageModel, {
      logger,
    });
    expect(running.status).toBe("running");

    resolveCompletion(["https://cdn.sogni.ai/a.png", "https://cdn.sogni.ai/b.png"]);
    await vi.waitFor(() => {});
    await new Promise((r) => setImmediate(r));
    const done = await sogniProvider.pollJob(ref, imageRequest({ count: 2 }), imageModel, {
      logger,
    });
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.artifacts.map((a) => a.seed)).toEqual([42, 43]);
    }

    // Terminal poll consumes the continuation; a later poll re-attaches
    // remotely (the project is gone from this process's memory).
    const again = await sogniProvider.pollJob(ref, imageRequest({ count: 2 }), imageModel, {
      logger,
    });
    expect(again.status).toBe("running");
  });

  it("re-attaches a project after a restart via the server-side lookup", async () => {
    setSogniClientForTests({
      projects: {
        create: async () => {
          throw new Error("should not create for a re-attach");
        },
        getAvailableModels: async () => [],
        get: async (id: string) => ({
          status: "completed",
          workerJobs: [{ resultUrl: "https://cdn.sogni.ai/late.png" }],
        }),
      },
    });

    const done = await sogniProvider.pollJob("proj_lost", imageRequest(), imageModel, {
      logger,
    });
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.artifacts[0]).toMatchObject({
        url: "https://cdn.sogni.ai/late.png",
        ext: "png",
        seed: 42,
      });
    }
  });

  it("aborts promptly when the caller cancels", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(new Promise<string[]>(() => {}));
    setSogniClientForTests(client);
    const controller = new AbortController();

    const pending = sogniProvider.generateImage(imageRequest(), imageModel, {
      logger,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(imageDeadlineMs()).toBeLessThan(videoDeadlineMs());
  });

  it("derives its deadlines from the configured render timeouts", () => {
    updateProviderConfig({ renderTimeouts: { image: 120, video: 300 } });
    resetStudioEnvForTests();
    // Budget minus the 1-minute download headroom.
    expect(imageDeadlineMs()).toBe(60_000);
    expect(videoDeadlineMs()).toBe(240_000);
  });

  it("maps video completions to mp4 artifacts", async () => {
    const { client, created } = fakeClient(Promise.resolve(["https://cdn.sogni.ai/v.mp4"]));
    setSogniClientForTests(client);

    const artifacts = await sogniProvider.generateVideo(videoRequest(), videoModel, {
      logger,
    });

    expect(created[0].params.type).toBe("video");
    expect((created[0].params as unknown as SogniVideoParams).duration).toBe(5);
    expect(artifacts[0]).toMatchObject({ url: "https://cdn.sogni.ai/v.mp4", ext: "mp4", seed: 42 });
  });
});

describe("continuity frames + last frame export", () => {
  const FRAME = Buffer.from("frame-bytes");

  function frameAwareClient(
    completion: Promise<string[]>,
    onWait?: () => void,
  ) {
    const created: { params: Record<string, unknown>; project: Record<string, unknown> }[] = [];
    let jobListener: ((job: { lastFrameUrl?: string }) => void) | null = null;
    const client: SogniClient = {
      projects: {
        create(params) {
          const project = {
            id: `proj_${created.length}`,
            // The provider registers its jobCompleted listener before calling
            // waitForCompletion — fire the hook there, like the SDK order.
            waitForCompletion: () => {
              onWait?.();
              return completion;
            },
            on: (event: string, listener: (arg: never) => void) => {
              if (event === "jobCompleted") {
                jobListener = listener as (job: { lastFrameUrl?: string }) => void;
              }
            },
          };
          created.push({ params: params as unknown as Record<string, unknown>, project });
          return Promise.resolve(project as never);
        },
        getAvailableModels: async () => [],
      },
    };
    return {
      client,
      created,
      emitJobCompleted(job: { lastFrameUrl?: string }) {
        jobListener?.(job);
      },
    };
  }

  it("sends referenceImage when a start frame is present", async () => {
    const fake = frameAwareClient(Promise.resolve(["https://cdn.test/v.mp4"]));
    setSogniClientForTests(fake.client);

    await sogniProvider.generateVideo(
      videoRequest({ startImage: { bytes: FRAME, contentType: "image/png" } }),
      videoModel,
      { logger },
    );

    expect(fake.created[0]?.params.referenceImage).toBe(FRAME);
  });

  it("sends both frames when start and end are present", async () => {
    const fake = frameAwareClient(Promise.resolve(["https://cdn.test/v.mp4"]));
    setSogniClientForTests(fake.client);

    await sogniProvider.generateVideo(
      videoRequest({
        startImage: { bytes: FRAME, contentType: "image/png" },
        endImage: { bytes: FRAME, contentType: "image/png" },
      }),
      videoModel,
      { logger },
    );

    expect(fake.created[0]?.params.referenceImage).toBe(FRAME);
    expect(fake.created[0]?.params.referenceImageEnd).toBe(FRAME);
  });

  it("attaches the exported last frame to the first artifact", async () => {
    const fake = frameAwareClient(Promise.resolve(["https://cdn.test/v.mp4"]), () =>
      fake.emitJobCompleted({ lastFrameUrl: "https://cdn.test/last.png" }),
    );
    setSogniClientForTests(fake.client);

    const artifacts = await sogniProvider.generateVideo(
      videoRequest(),
      SOGNI_VIDEO_MODELS.find((m) => m.model.startsWith("seedance")) ?? videoModel,
      { logger },
    );

    expect(artifacts[0]?.companionFrameUrl).toBe("https://cdn.test/last.png");
  });
});
