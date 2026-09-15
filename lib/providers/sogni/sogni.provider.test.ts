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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let configDir = "";

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
        created.push({ params: params as unknown as Record<string, unknown>, completion });
        return Promise.resolve({
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
  process.env.SOGNI_API_KEY = "test-sogni-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  setSogniClientForTests(null);
  delete process.env.SOGNI_API_KEY;
  delete process.env.SOGNI_APP_ID;
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  resetStudioEnvForTests();
  if (configDir) {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {}
  }
  vi.useRealTimers();
});

describe("sogni provider", () => {
  it("reports itself unconfigured without SOGNI_API_KEY", () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    expect(sogniProvider.isConfigured()).toBe(false);
  });

  it("lists curated models only when configured", () => {
    expect(sogniProvider.listImageModels().length).toBe(4);
    expect(sogniProvider.listVideoModels().length).toBe(3);
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

  it("streams submitted + rendering progress, deduplicated and clamped", async () => {
    const { client, progressListeners } = fakeClient(
      new Promise<string[]>((resolve) =>
        setTimeout(() => resolve(["https://cdn.sogni.ai/a.png"]), 10),
      ),
    );
    setSogniClientForTests(client);

    const ticks: ProviderProgress[] = [];
    const pending = sogniProvider.generateImage(imageRequest(), imageModel, {
      logger,
      onProgress: (progress) => ticks.push(progress),
    });
    await vi.waitFor(() => expect(progressListeners.length).toBe(1));

    progressListeners[0](37.2);
    progressListeners[0](37.2); // duplicate percent — dropped
    progressListeners[0](140); // clamped to 100
    await pending;

    expect(ticks[0]).toEqual({
      stage: "submitted",
      message: "Sogni AI accepted the render — waiting for a free GPU…",
    });
    expect(ticks).toContainEqual({
      stage: "rendering",
      message: "Sogni AI is rendering — 37%",
      percent: 37,
    });
    expect(ticks).toContainEqual({
      stage: "rendering",
      message: "Sogni AI is rendering — 100%",
      percent: 100,
    });
    expect(ticks.filter((tick) => tick.message.includes("37%"))).toHaveLength(1);
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

  it("surfaces a retryable timeout when the project never completes", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(new Promise<string[]>(() => {}));
    setSogniClientForTests(client);

    const pending = sogniProvider.generateImage(imageRequest(), imageModel, { logger });
    const assertion = expect(pending).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(imageDeadlineMs() + 1);
    await assertion;
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
