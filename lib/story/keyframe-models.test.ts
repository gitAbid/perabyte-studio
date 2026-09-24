import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";
import { setProvidersForTests } from "@/lib/providers/registry";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { listImageModelDescriptors } from "@/lib/story/keyframe-models";

/**
 * A stand-in for a provider adapter exposing image models (the sogni shape —
 * context-capable edit models among them) plus a video-kind hidden model to
 * prove the filter. The registry under test is the REAL app registry: the
 * provider-enabled gate comes from provider-config, exactly as in production.
 */
function fakeProvider(options: {
  id: string;
  configured: boolean;
  imageModels: ModelDescriptor[];
}): ImageProvider & VideoProvider {
  return {
    id: options.id,
    label: options.id,
    isConfigured: () => options.configured,
    listImageModels: () => options.imageModels,
    generateImage: async () => [],
    listVideoModels: () => [],
    generateVideo: async () => [],
  };
}

const SOGNI_LIKE: ModelDescriptor[] = [
  {
    id: buildModelId("sogni", "qwen-image-edit"),
    providerId: "sogni",
    kind: "image",
    model: "qwen-image-edit",
    label: "Qwen Edit",
    contextImages: { min: 0, max: 3 },
  },
  {
    id: buildModelId("sogni", "krea2_turbo_fp8_scaled"),
    providerId: "sogni",
    kind: "image",
    model: "krea2_turbo_fp8_scaled",
    label: "Krea Turbo",
  },
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyframe-models-"));
  setProviderConfigPathForTests(path.join(dir, "settings.json"));
  setProvidersForTests([
    fakeProvider({ id: "sogni", configured: true, imageModels: SOGNI_LIKE }),
    // A video-kind descriptor rides the hidden list in production; here it
    // proves the kind filter even when a provider lists it as an image slot.
    fakeProvider({
      id: "custom",
      configured: true,
      imageModels: [
        {
          id: buildModelId("custom", "some-video-workflow"),
          providerId: "custom",
          kind: "video",
          model: "some-video-workflow",
          label: "Video workflow",
        },
      ],
    }),
  ]);
});

afterEach(() => {
  setProvidersForTests(null);
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
});

describe("listImageModelDescriptors", () => {
  it("returns the enabled providers' image descriptors with sogni's set included", () => {
    const models = listImageModelDescriptors();
    expect(models.map((m) => m.id)).toEqual([
      "sogni:qwen-image-edit",
      "sogni:krea2_turbo_fp8_scaled",
    ]);
    expect(models[0].contextImages).toEqual({ min: 0, max: 3 });
  });

  it("drops descriptors that are not image-kind (hidden video capability models)", () => {
    // The "custom" provider only exposes a video-kind descriptor.
    expect(listImageModelDescriptors().some((m) => m.providerId === "custom")).toBe(false);
  });

  it("hides a disabled provider's models", () => {
    updateProviderConfig({ providers: { sogni: { enabled: false } } });
    expect(listImageModelDescriptors()).toEqual([]);
  });

  it("hides individually disabled models", () => {
    updateProviderConfig({
      providers: { sogni: { disabledModels: ["sogni:qwen-image-edit"] } },
    });
    expect(listImageModelDescriptors().map((m) => m.id)).toEqual([
      "sogni:krea2_turbo_fp8_scaled",
    ]);
  });
});
