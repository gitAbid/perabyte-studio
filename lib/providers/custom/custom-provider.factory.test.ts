import { describe, expect, it, vi } from "vitest";
import { createCustomProvider } from "./custom-provider.factory";
import { newImageRef, parkImage, takeParkedImage } from "./parked-images";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import type { ProviderFormat } from "./formats/types";
import type {
  GeneratedArtifact,
  ModelDescriptor,
  NormalizedGenerationRequest,
  ProviderContext,
} from "@/lib/providers/types";
import { logger } from "@/lib/logging/logger";

const ctx = { logger } as ProviderContext;

function entry(overrides: Partial<CustomProviderEntry> = {}): CustomProviderEntry {
  return {
    id: "relay",
    label: "My Relay",
    format: "openai",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-x",
    enabled: true,
    models: [
      { model: "gpt-image-1", label: "GPT Image", kind: "image", enabled: true },
      { model: "sora-2", kind: "video", enabled: true },
      { model: "grok-4.5", kind: "text", enabled: true },
      { model: "hidden-image", kind: "image", enabled: false },
    ],
    ...overrides,
  };
}

function fakeFormat(overrides: Partial<ProviderFormat> = {}): ProviderFormat {
  return {
    id: "openai",
    label: "Fake",
    capabilities: { image: true, video: true, text: true },
    listModels: vi.fn(async () => []),
    ...overrides,
  };
}

function imageRequest(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  return {
    kind: "image",
    prompt: "p",
    negativePrompt: "",
    aspect: "16:9",
    resolution: "1080p",
    durationSeconds: 0,
    count: 1,
    seed: 1,
    safe: true,
    enhance: false,
    ...overrides,
  };
}

const imageModel: ModelDescriptor = {
  id: "relay:gpt-image-1",
  providerId: "relay",
  kind: "image",
  model: "gpt-image-1",
  label: "GPT Image",
};

const videoModel: ModelDescriptor = {
  id: "relay:sora-2",
  providerId: "relay",
  kind: "video",
  model: "sora-2",
  label: "sora-2",
};

function artifact(seed = 1): GeneratedArtifact {
  return { bytes: Buffer.from("x"), url: null, ext: "png", seed };
}

describe("createCustomProvider — descriptors and configuration", () => {
  it("maps enabled models of a kind to descriptors", () => {
    const provider = createCustomProvider(entry());
    const images = provider.listImageModels();
    expect(images.map((m) => m.id)).toEqual(["relay:gpt-image-1"]);
    expect(images[0]).toMatchObject({
      providerId: "relay",
      model: "gpt-image-1",
      label: "GPT Image",
      stylesSupported: true,
      costTier: "key-credits",
      frameInput: { start: true, end: false },
    });

    const videos = provider.listVideoModels();
    expect(videos.map((m) => m.id)).toEqual(["relay:sora-2"]);
    expect(videos[0].videoLimits).toEqual({
      duration: { min: 1, max: 15 },
      ratios: ["16:9", "9:16", "1:1", "4:5", "3:2"],
      resolutions: ["720p", "1080p", "1440p", "4K"],
    });
  });

  it("falls back to the model id as label", () => {
    const provider = createCustomProvider(entry());
    expect(provider.listVideoModels()[0].label).toBe("sora-2");
  });

  it("isConfigured requires enablement and a key except for keyless-capable formats", () => {
    expect(createCustomProvider(entry()).isConfigured()).toBe(true);
    expect(createCustomProvider(entry({ enabled: false })).isConfigured()).toBe(false);
    expect(createCustomProvider(entry({ apiKey: null })).isConfigured()).toBe(true);
    expect(createCustomProvider(entry({ format: "google", apiKey: null })).isConfigured()).toBe(false);
    expect(createCustomProvider(entry({ format: "anthropic", apiKey: null })).isConfigured()).toBe(false);
  });
});

describe("createCustomProvider — generation", () => {
  it("delegates image generation to the format", async () => {
    const generateImage = vi.fn(async () => [artifact(5)]);
    const provider = createCustomProvider(entry(), fakeFormat({ generateImage }));
    const artifacts = await provider.generateImage(imageRequest(), imageModel, ctx);
    expect(artifacts[0].seed).toBe(5);
    expect(generateImage).toHaveBeenCalledWith(expect.anything(), imageRequest(), imageModel, ctx);
  });

  it("rejects image generation when the format cannot do it", async () => {
    const provider = createCustomProvider(entry(), fakeFormat({ generateImage: undefined }));
    await expect(provider.generateImage(imageRequest(), imageModel, ctx)).rejects.toMatchObject({
      retryable: false,
      field: "model",
    });
  });

  it("rejects video generation when the format cannot do it", async () => {
    const provider = createCustomProvider(entry(), fakeFormat({ videoJobs: undefined }));
    await expect(
      provider.generateVideo(
        imageRequest({ kind: "video", durationSeconds: 5 }),
        videoModel,
        ctx,
      ),
    ).rejects.toMatchObject({ retryable: false, field: "model" });
  });

  it("parks sync image jobs and completes on the first poll", async () => {
    const provider = createCustomProvider(entry(), fakeFormat({ generateImage: async () => [artifact(9)] }));
    const { ref } = await provider.submitJob(imageRequest(), imageModel, ctx);
    expect(ref.startsWith("cimg_relay_")).toBe(true);

    const done = await provider.pollJob(ref, imageRequest(), imageModel, ctx);
    expect(done).toMatchObject({ status: "completed" });
    if (done.status === "completed") expect(done.artifacts[0].seed).toBe(9);

    const lost = await provider.pollJob(ref, imageRequest(), imageModel, ctx);
    expect(lost).toMatchObject({ status: "failed", retryable: true });

    const restarted = await provider.pollJob(newImageRef("relay"), imageRequest(), imageModel, ctx);
    expect(restarted).toMatchObject({ status: "failed", retryable: true });
  });

  it("parks survive adapter rebuilds (module-level map)", async () => {
    const generateImage = async () => [artifact(3)];
    const first = createCustomProvider(entry(), fakeFormat({ generateImage }));
    const { ref } = await first.submitJob(imageRequest(), imageModel, ctx);
    // A settings save rebuilds adapters; the new instance still finds the ref.
    const second = createCustomProvider(entry(), fakeFormat({ generateImage }));
    const done = await second.pollJob(ref, imageRequest(), imageModel, ctx);
    expect(done.status).toBe("completed");
  });

  it("delegates video jobs to the format pair", async () => {
    const submit = vi.fn(async () => ({ ref: "job-1" }));
    const poll = vi.fn(async (): Promise<import("@/lib/providers/types").JobPollResult> => ({
      status: "completed",
      artifacts: [{ bytes: Buffer.from("v"), url: null, ext: "mp4", seed: 2 }],
    }));
    const provider = createCustomProvider(
      entry(),
      fakeFormat({ videoJobs: vi.fn(() => ({ submit, poll })) }),
    );
    const { ref } = await provider.submitJob(
      imageRequest({ kind: "video", durationSeconds: 5 }),
      videoModel,
      ctx,
    );
    expect(ref).toBe("job-1");
    const done = await provider.pollJob(ref, imageRequest({ kind: "video" }), videoModel, ctx);
    expect(done.status).toBe("completed");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("generateVideo drives submit/poll to completion", async () => {
    const provider = createCustomProvider(
      entry(),
      fakeFormat({
        videoJobs: () => ({
          submit: async () => ({ ref: "job-2" }),
          poll: async () => ({
            status: "completed" as const,
            artifacts: [{ bytes: Buffer.from("v"), url: null, ext: "mp4", seed: 4 }],
          }),
        }),
      }),
    );
    const artifacts = await provider.generateVideo(
      imageRequest({ kind: "video", durationSeconds: 5 }),
      videoModel,
      ctx,
    );
    expect(artifacts[0].ext).toBe("mp4");
  });
});

describe("parked images", () => {
  it("takeParkedImage removes the entry", () => {
    const ref = newImageRef("x");
    parkImage(ref, [artifact(1)]);
    expect(takeParkedImage(ref)).toHaveLength(1);
    expect(takeParkedImage(ref)).toBeNull();
  });
});
