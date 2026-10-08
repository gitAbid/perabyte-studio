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

const editModel: ModelDescriptor = {
  id: "sogni:fake_edit",
  providerId: "sogni",
  kind: "image",
  model: "fake_edit",
  label: "Fake edit",
  contextImages: { min: 1, max: 2 },
};

function fakeVideoProvider(models: ModelDescriptor[], options: { frameDropped?: boolean } = {}): ProviderRegistry {
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
      return [{ bytes: null, url: "https://cdn.example/x.mp4", ext: "mp4", seed: 1,
        ...(options.frameDropped ? { frameDropped: true } : {}) }];
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

function body(refs: Record<string, unknown>, modelId?: string): Record<string, unknown> {
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
  it("strict policy rejects an unsupported start frame before provider invocation", async () => {
    const provider = fakeVideoProvider([t2vModel]);
    setRegistryForTests(provider);
    const ref = await putFrame();

    await expect(runGeneration(body({ startImageRef: ref, referencePolicy: "strict" })))
      .rejects.toMatchObject({ field: "startImage" });
    expect(received).toHaveLength(0);
  });

  it("strict policy rejects an unconfigured frame-swapped provider before loading the render", async () => {
    const base = fakeVideoProvider([t2vModel, i2vModel]);
    const resolve = base.resolve;
    setRegistryForTests({
      ...base,
      resolve: (id) => {
        const found = resolve(id);
        return found?.model.id === i2vModel.id
          ? { ...found, provider: { ...found.provider, isConfigured: () => false } }
          : found;
      },
    });
    const ref = await putFrame();

    await expect(runGeneration(body({ startImageRef: ref, referencePolicy: "strict" })))
      .rejects.toMatchObject({ field: "model", message: "The frame-capable model is not configured." });
    expect(received).toHaveLength(0);
  });

  it("strict policy uses a compatible and configured frame-swapped model", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    const ref = await putFrame();

    const response = await runGeneration(body({ startImageRef: ref, referencePolicy: "strict" }));

    expect(response.effectiveModelId).toBe(i2vModel.id);
    expect(received[0]?.startImage).toBeDefined();
  });

  it("strict policy rechecks context capability on the effective swapped model", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));
    const ref = await putFrame();

    await expect(runGeneration(body({
      startImageRef: ref,
      referenceImageRefs: [ref],
      referencePolicy: "strict",
    })))
      .rejects.toMatchObject({ field: "referenceImage" });
    expect(received).toHaveLength(0);
  });

  it("strict policy rejects a malformed start-frame reference", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, i2vModel]));

    await expect(runGeneration(body({ startImageRef: 42, referencePolicy: "strict" })))
      .rejects.toMatchObject({ field: "startImage" });
    expect(received).toHaveLength(0);
  });

  it("strict policy checks the requested render kind against the effective model", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));

    await expect(runGeneration(body({ kind: "video", referencePolicy: "strict" }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "model", message: "The selected model does not support this render type." });
    expect(received).toHaveLength(0);
  });

  it("strict policy rejects an unsupported end frame before provider invocation", async () => {
    setRegistryForTests(fakeVideoProvider([startOnlyModel]));
    const ref = await putFrame();

    await expect(runGeneration(body({ endImageRef: ref, referencePolicy: "strict" }, "sogni:fake_startonly")))
      .rejects.toMatchObject({ field: "endImage" });
    expect(received).toHaveLength(0);
  });

  it("strict policy rejects a provider-reported dropped start frame", async () => {
    setRegistryForTests(fakeVideoProvider([startOnlyModel], { frameDropped: true }));
    const ref = await putFrame();

    await expect(runGeneration(body({ startImageRef: ref, referencePolicy: "strict" }, "sogni:fake_startonly")))
      .rejects.toMatchObject({ field: "startImage", retryable: false });
  });

  it("attributes an output frame drop to the end frame when no start frame was requested", async () => {
    setRegistryForTests(fakeVideoProvider([i2vModel], { frameDropped: true }));
    const ref = await putFrame();

    await expect(runGeneration(body({ endImageRef: ref, referencePolicy: "strict" }, "sogni:fake_i2v")))
      .rejects.toMatchObject({ field: "endImage", retryable: false });
  });

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

describe("runGeneration reference images", () => {
  it("strict policy rejects unsupported and over-capacity context refs before provider invocation", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel, editModel]));
    const ref = await putFrame();

    await expect(runGeneration(body({ referencePolicy: "strict", referenceImageRefs: [ref] }, "sogni:fake_t2v")))
      .rejects.toMatchObject({ field: "referenceImage" });
    expect(received).toHaveLength(0);

    await expect(runGeneration(body({ kind: "image", referencePolicy: "strict", referenceImageRefs: [ref, ref, ref] }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referenceImage" });
    expect(received).toHaveLength(0);
  });

  it("counts a supported start frame toward strict context-image capacity", async () => {
    const startAndContextModel: ModelDescriptor = {
      ...editModel,
      frameInput: { start: true, end: false },
    };
    setRegistryForTests(fakeVideoProvider([startAndContextModel]));
    const ref = await putFrame();

    await expect(runGeneration(body({
      kind: "image",
      startImageRef: ref,
      referenceImageRefs: [ref, ref],
      referencePolicy: "strict",
    }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referenceImage" });
    expect(received).toHaveLength(0);
  });

  it("strict policy propagates unavailable cached context refs before provider invocation", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    const missing = `${"a".repeat(64)}.png`;

    await expect(runGeneration(body({ kind: "image", referencePolicy: "strict", referenceImageRefs: [missing] }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referenceImage", message: "That reference image is no longer cached." });
    expect(received).toHaveLength(0);
  });

  it("strict policy rejects malformed and over-limit context arrays", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    const ref = await putFrame();

    await expect(runGeneration(body({ kind: "image", referencePolicy: "strict", referenceImageRefs: [ref, 42] }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referenceImage" });
    await expect(runGeneration(body({ referencePolicy: "strict", referenceImageRefs: "not-an-array" }, "sogni:fake_t2v")))
      .rejects.toMatchObject({ field: "referenceImage" });
    await expect(runGeneration(body({ kind: "image", referencePolicy: "strict", referenceImageRefs: Array(17).fill(ref) }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referenceImage" });
    expect(received).toHaveLength(0);
  });

  it("rejects an unknown reference policy", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    await expect(runGeneration(body({ referencePolicy: "ignore" }, "sogni:fake_edit")))
      .rejects.toMatchObject({ field: "referencePolicy" });
    expect(received).toHaveLength(0);
  });

  it("rejects malformed reference refs", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    await expect(
      runGeneration(body({ referenceImageRefs: ["../escape.png"] }, "sogni:fake_edit")),
    ).rejects.toMatchObject({ field: "referenceImage", status: 400 });
  });

  it("rejects mp4 refs as reference images", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    const mp4Ref = `${"b".repeat(64)}.mp4`;
    await expect(
      runGeneration(body({ referenceImageRefs: [mp4Ref] }, "sogni:fake_edit")),
    ).rejects.toMatchObject({ field: "referenceImage", status: 400 });
  });

  it("loads every reference ref from the media cache in order", async () => {
    setRegistryForTests(fakeVideoProvider([editModel]));
    const refA = await putFrame();
    const refB = await putFrame();

    await runGeneration(body({ referenceImageRefs: [refA, refB] }, "sogni:fake_edit"));

    const refs = received[0]?.referenceImages;
    expect(refs).toHaveLength(2);
    expect(refs?.every((frame) => frame.bytes.equals(PNG_BYTES))).toBe(true);
    expect(refs?.every((frame) => frame.contentType === "image/png")).toBe(true);
  });

  it("caps references at the model's contextImages.max, keeping the first", async () => {
    setRegistryForTests(fakeVideoProvider([editModel])); // max: 2
    const ref = await putFrame();

    await runGeneration(body({ referenceImageRefs: [ref, ref, ref] }, "sogni:fake_edit"));

    expect(received[0]?.referenceImages).toHaveLength(2);
  });

  it("drops reference images entirely for models without contextImages", async () => {
    setRegistryForTests(fakeVideoProvider([t2vModel]));
    const ref = await putFrame();

    await runGeneration(body({ referenceImageRefs: [ref, ref] }, "sogni:fake_t2v"));

    expect(received[0]?.referenceImages).toBeUndefined();
  });
});
