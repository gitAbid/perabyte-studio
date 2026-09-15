import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { ModelDescriptor } from "@/lib/domain/models";
import {
  setRegistryForTests,
  type ProviderRegistry,
} from "@/lib/providers/registry";
import type { NormalizedGenerationRequest } from "@/lib/domain/models";
import type {
  GeneratedArtifact,
  ImageProvider,
  ProviderContext,
  ProviderProgress,
} from "@/lib/providers/types";
import { runGeneration } from "@/lib/services/generation.service";

const model: ModelDescriptor = {
  id: "fake:progress",
  providerId: "fake",
  kind: "image",
  model: "progress",
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
    modelId: "fake:progress",
  };
}

/**
 * Registry whose provider emits two progress ticks before resolving — the
 * shape Sogni reports through the SDK's project events.
 */
function fakeProgressProvider(
  ticks: ProviderProgress[],
  modelOverride?: Partial<ModelDescriptor>,
): { registry: ProviderRegistry; seen: ProviderProgress[][]; requests: NormalizedGenerationRequest[] } {
  const seen: ProviderProgress[][] = [];
  const requests: NormalizedGenerationRequest[] = [];
  const resolvedModel: ModelDescriptor = { ...model, ...modelOverride };
  const provider: ImageProvider = {
    id: "fake",
    label: "Fake",
    isConfigured: () => true,
    listImageModels: () => [resolvedModel],
    generateImage: async (request, _model, ctx: ProviderContext) => {
      const sink: ProviderProgress[] = [];
      seen.push(sink);
      requests.push(request);
      for (const tick of ticks) {
        ctx.onProgress?.(tick);
        sink.push(tick);
      }
      const artifact: GeneratedArtifact = {
        bytes: Buffer.from("pretend-png"),
        url: null,
        ext: "png",
        seed: 1,
      };
      return [artifact];
    },
  };
  return {
    seen,
    requests,
    registry: {
      listModels: (kind) => (kind === "image" ? [resolvedModel] : []),
      defaultModel: (kind) => (kind === "image" ? resolvedModel : ({} as ModelDescriptor)),
      resolve: (id) => (id === resolvedModel.id ? { provider, model: resolvedModel } : null),
      findAnywhere: (id) =>
        id === resolvedModel.id ? { provider, model: resolvedModel } : null,
    },
  };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), "perabyte-gen-progress-"));
  process.env.MEDIA_CACHE_DIR = cacheDir;
  resetStudioEnvForTests();
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.MEDIA_CACHE_DIR;
  resetStudioEnvForTests();
  setRegistryForTests(null);
});

describe("runGeneration progress forwarding", () => {
  it("streams provider ticks plus the service's own stages", async () => {
    const { registry } = fakeProgressProvider([
      { stage: "submitted", message: "accepted" },
      { stage: "rendering", message: "rendering 42%", percent: 42 },
    ]);
    setRegistryForTests(registry);

    const received: ProviderProgress[] = [];
    const response = await runGeneration(body(), {
      onProgress: (progress) => received.push(progress),
    });

    expect(response.status).toBe("completed");
    expect(received).toEqual([
      { stage: "submitted", message: "accepted" },
      { stage: "rendering", message: "rendering 42%", percent: 42 },
      { stage: "downloading", message: "Finalising your render…" },
    ]);
  });

  it("works without a progress sink", async () => {
    const { registry } = fakeProgressProvider([{ stage: "rendering", message: "x" }]);
    setRegistryForTests(registry);

    const response = await runGeneration(body());
    expect(response.status).toBe("completed");
  });

  it("folds the style preset into the prompt for style-capable models", async () => {
    const { registry, requests } = fakeProgressProvider([]);
    setRegistryForTests(registry);

    await runGeneration(body());
    expect(requests[0].prompt).toContain("a lighthouse");
    expect(requests[0].prompt).toContain("photorealistic");
  });

  it("sends the raw prompt when the model doesn't support styles", async () => {
    const { registry, requests } = fakeProgressProvider([], { stylesSupported: false });
    setRegistryForTests(registry);

    await runGeneration(body());
    expect(requests[0].prompt).toBe("a lighthouse");
  });

  it("keeps sensored models safe even when uncensored mode is requested", async () => {
    const uncensoredBody = { ...body(), safe: false };
    const { registry, requests } = fakeProgressProvider([], { uncensored: false });
    setRegistryForTests(registry);

    await runGeneration(uncensoredBody);
    expect(requests[0].safe).toBe(true);

    const capable = fakeProgressProvider([], { uncensored: true });
    setRegistryForTests(capable.registry);
    await runGeneration(uncensoredBody);
    expect(capable.requests[0].safe).toBe(false);
  });
});
