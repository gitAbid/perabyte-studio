import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { FrameImage, ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { getMediaRepository, setMediaRepositoryForTests } from "@/lib/repositories/media.repository";
import {
  setRegistryForTests,
  type ProviderRegistry,
} from "@/lib/providers/registry";
import type { GeneratedArtifact, ImageProvider, VideoProvider } from "@/lib/providers/types";
import { runGeneration } from "@/lib/services/generation.service";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

/** Structurally plausible mp4: ftyp box + moov index + mdat payload. */
const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), // size + "ftyp"
  Buffer.from("isomiso2", "latin1"),
  Buffer.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76]), // size + "moov"
  Buffer.from("mdat-payload-padding-to-clear-the-32-byte-floor", "latin1"),
]);

const received: NormalizedGenerationRequest[] = [];

const t2vModel: ModelDescriptor = {
  id: "sogni:fake_t2v",
  providerId: "sogni",
  kind: "video",
  model: "fake_t2v",
  label: "Fake t2v",
  i2vModelId: "sogni:fake_i2v",
};

const i2vModel: ModelDescriptor = {
  id: "sogni:fake_i2v",
  providerId: "sogni",
  kind: "video",
  model: "fake_i2v",
  label: "Fake i2v",
  frameInput: { start: true, end: true },
};

const startOnlyModel: ModelDescriptor = {
  id: "sogni:fake_startonly",
  providerId: "sogni",
  kind: "video",
  model: "fake_startonly",
  label: "Fake start-only",
  frameInput: { start: true, end: false },
};

function fakeVideoProvider(models: ModelDescriptor[]): ProviderRegistry {
  const provider: ImageProvider & VideoProvider = {
    id: "sogni",
    label: "Sogni",
    isConfigured: () => true,
    listImageModels: () => [],
    async generateImage() {
      return [] as GeneratedArtifact[];
    },
    listVideoModels: () => models,
    async generateVideo(request: NormalizedGenerationRequest) {
      received.push(request);
      return [{ bytes: null, url: "https://cdn.example/x.mp4", ext: "mp4", seed: 1 }];
    },
  };
  return {
    listModels: () => models,
    listAllModels: () => models,
    defaultModel: () => models[0],
    resolve: (id) => {
      const model = models.find((m) => m.id === id);
      return model ? { provider, model } : null;
    },
    findAnywhere: (id) => {
      const model = models.find((m) => m.id === id);
      return model ? { provider, model } : null;
    },
  };
}

function body(refs: Record<string, string>, modelId?: string): Record<string, unknown> {
  return {
    kind: "video",
    prompt: "a fox trots through the meadow",
    aspect: "16:9",
    resolution: "1080p",
    style: "Cinematic",
    count: 1,
    modelId: modelId ?? "sogni:fake_t2v",
    ...refs,
  };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), "perabyte-frames-"));
  process.env.MEDIA_CACHE_DIR = cacheDir;
  resetStudioEnvForTests();
  received.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(MP4_BYTES), { status: 200 })),
  );
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.MEDIA_CACHE_DIR;
  resetStudioEnvForTests();
  setRegistryForTests(null);
  setMediaRepositoryForTests(null);
  vi.unstubAllGlobals();
});

async function putFrame(): Promise<string> {
  const stored = await getMediaRepository().put(PNG_BYTES, "png");
  return stored.ref;
}

describe("runGeneration continuity frames", () => {
  it("rejects malformed frame refs", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    await expect(runGeneration(body({ startImageRef: "../escape.png" }))).rejects.toMatchObject({
      field: "startImage",
      status: 400,
    });
  });

  it("rejects mp4 refs as frames", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    const mp4Ref = `${"b".repeat(64)}.mp4`;
    await expect(runGeneration(body({ startImageRef: mp4Ref }))).rejects.toMatchObject({
      field: "startImage",
      status: 400,
    });
  });

  it("400s when the start ref is missing from the cache", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    await expect(
      runGeneration(body({ startImageRef: `${"a".repeat(64)}.png` })),
    ).rejects.toMatchObject({
      field: "startImage",
      message: expect.stringContaining("Continuity frame missing"),
    });
  });

  it("swaps to the i2v sibling and reports the effective model", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    const ref = await putFrame();

    const response = await runGeneration(body({ startImageRef: ref }));

    expect(response.effectiveModelId).toBe("sogni:fake_i2v");
    expect(response.effectiveModelLabel).toBe("Fake i2v");
    expect(response.frameUsed).toBe(true);
    const frame: FrameImage | undefined = received[0]?.startImage;
    expect(frame?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(frame?.contentType).toBe("image/png");
  });

  it("keeps the model when it already takes frames", async () => {
    setRegistryForTests(fakeVideoProvider([startOnlyModel]));
    const ref = await putFrame();

    const response = await runGeneration(body({ startImageRef: ref }, "sogni:fake_startonly"));

    expect(response.effectiveModelId).toBeUndefined();
    expect(response.frameUsed).toBe(true);
    expect(received[0]?.startImage).toBeDefined();
  });

  it("drops frames (frameUsed false) when no capable model exists", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel])); // no sibling registered
    const ref = await putFrame();

    const response = await runGeneration(body({ startImageRef: ref }));

    expect(response.frameUsed).toBe(false);
    expect(response.effectiveModelId).toBeUndefined();
    expect(received[0]?.startImage).toBeUndefined();
  });

  it("drops the end frame when the model cannot condition on it", async () => {
    setRegistryForTests(fakeVideoProvider([startOnlyModel]));
    const ref = await putFrame();

    const response = await runGeneration(
      body({ startImageRef: ref, endImageRef: ref }, "sogni:fake_startonly"),
    );

    expect(response.frameUsed).toBe(true);
    expect(received[0]?.startImage).toBeDefined();
    expect(received[0]?.endImage).toBeUndefined();
  });

  it("passes both frames to an end-capable model", async () => {
    setRegistryForTests(fakeVideoProvider([i2vModel]));
    const ref = await putFrame();

    const response = await runGeneration(
      body({ startImageRef: ref, endImageRef: ref }, "sogni:fake_i2v"),
    );

    expect(response.frameUsed).toBe(true);
    expect(received[0]?.startImage).toBeDefined();
    expect(received[0]?.endImage).toBeDefined();
  });
});
