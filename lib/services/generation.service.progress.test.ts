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
): { registry: ProviderRegistry; seen: ProviderProgress[][] } {
  const seen: ProviderProgress[][] = [];
  const provider: ImageProvider = {
    id: "fake",
    label: "Fake",
    isConfigured: () => true,
    listImageModels: () => [model],
    generateImage: async (_request, _model, ctx: ProviderContext) => {
      const sink: ProviderProgress[] = [];
      seen.push(sink);
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
    registry: {
      listModels: (kind) => (kind === "image" ? [model] : []),
      defaultModel: (kind) => (kind === "image" ? model : ({} as ModelDescriptor)),
      resolve: (id) => (id === model.id ? { provider, model } : null),
      findAnywhere: (id) => (id === model.id ? { provider, model } : null),
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
});
