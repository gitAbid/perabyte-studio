import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { ModelDescriptor } from "@/lib/domain/models";
import {
  setRegistryForTests,
  type ProviderRegistry,
} from "@/lib/providers/registry";
import type { GeneratedArtifact, ImageProvider } from "@/lib/providers/types";
import { runGeneration } from "@/lib/services/generation.service";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

const model: ModelDescriptor = {
  id: "fake:url-only",
  providerId: "fake",
  kind: "image",
  model: "url-only",
  label: "Fake",
};

function body(): Record<string, unknown> {
  return {
    kind: "image",
    prompt: "a lighthouse",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    count: 1,
    modelId: "fake:url-only",
  };
}

function fakeImageProvider(artifact: GeneratedArtifact): ProviderRegistry {
  const provider: ImageProvider = {
    id: "fake",
    label: "Fake",
    isConfigured: () => true,
    listImageModels: () => [model],
    generateImage: async () => [artifact],
  };
  return {
    listModels: (kind) => (kind === "image" ? [model] : []),
    defaultModel: (kind) => (kind === "image" ? model : ({} as ModelDescriptor)),
    resolve: (id) => (id === model.id ? { provider, model } : null),
    findAnywhere: (id) => (id === model.id ? { provider, model } : null),
  };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), "perabyte-gen-"));
  process.env.MEDIA_CACHE_DIR = cacheDir;
  resetStudioEnvForTests();
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.MEDIA_CACHE_DIR;
  resetStudioEnvForTests();
  setRegistryForTests(null);
  vi.unstubAllGlobals();
});

describe("runGeneration persistence", () => {
  it("downloads url-only artifacts from non-proxy hosts into the media cache", async () => {
    // Regression: an apikey-fan response that returns `url` instead of b64
    // used to hand the raw (expiring, cross-origin) provider URL to the
    // browser, which cannot display or re-fetch it later.
    setRegistryForTests(
      fakeImageProvider({ bytes: null, url: "https://cdn.example/x.png", ext: "png", seed: 1 }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(PNG_BYTES), { status: 200 })),
    );

    const response = await runGeneration(body());

    expect(response.media[0]?.url.startsWith("/api/media?f=")).toBe(true);
    expect(response.media[0]?.mime).toBe("image/png");
  });

  it("keeps pollinations URLs on the deterministic proxy path (no download)", async () => {
    setRegistryForTests(
      fakeImageProvider({
        bytes: null,
        url: "https://image.pollinations.ai/prompt/x?width=1280",
        ext: "jpg",
        seed: 2,
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await runGeneration(body());

    expect(response.media[0]?.url).toContain("image.pollinations.ai");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
