import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import { createRegistry } from "@/lib/providers/registry";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";

function fakeProvider(options: {
  id: string;
  configured: boolean;
  imageModels?: ModelDescriptor[];
  videoModels?: ModelDescriptor[];
}): ImageProvider & VideoProvider {
  const imageModels = options.imageModels ?? [];
  const videoModels = options.videoModels ?? [];
  return {
    id: options.id,
    label: options.id,
    isConfigured: () => options.configured,
    listImageModels: () => imageModels,
    generateImage: async () => [],
    listVideoModels: () => videoModels,
    generateVideo: async () => [],
  };
}

const grok = fakeProvider({
  id: "apikey-fan",
  configured: true,
  imageModels: [
    {
      id: buildModelId("apikey-fan", "grok-imagine-image-2.0"),
      providerId: "apikey-fan",
      kind: "image",
      model: "grok-imagine-image-2.0",
      label: "Grok Imagine 2.0",
    },
  ],
  videoModels: [
    {
      id: buildModelId("apikey-fan", "grok-imagine-video-1.5"),
      providerId: "apikey-fan",
      kind: "video",
      model: "grok-imagine-video-1.5",
      label: "Grok Video 1.5",
    },
  ],
});

const flux = fakeProvider({
  id: "pollinations",
  configured: true,
  imageModels: [
    {
      id: buildModelId("pollinations", "flux"),
      providerId: "pollinations",
      kind: "image",
      model: "flux",
      label: "Flux",
    },
  ],
  videoModels: [
    {
      id: buildModelId("pollinations", "flux-keyframe"),
      providerId: "pollinations",
      kind: "video",
      model: "flux",
      label: "Flux keyframe",
    },
  ],
});

describe("provider registry", () => {
  it("lists configured models with keyed providers first", () => {
    const registry = createRegistry([grok, flux]);
    expect(registry.listModels("image").map((m) => m.id)).toEqual([
      "apikey-fan:grok-imagine-image-2.0",
      "pollinations:flux",
    ]);
  });

  it("falls back to the keyless provider when the key is absent", () => {
    const offlineGrok = fakeProvider({ id: "apikey-fan", configured: false });
    const registry = createRegistry([
      offlineGrok,
      fakeProvider({
        id: "pollinations",
        configured: true,
        imageModels: [
          {
            id: "pollinations:flux",
            providerId: "pollinations",
            kind: "image",
            model: "flux",
            label: "Flux",
          },
        ],
        videoModels: [
          {
            id: "pollinations:flux-keyframe",
            providerId: "pollinations",
            kind: "video",
            model: "flux",
            label: "Flux keyframe",
          },
        ],
      }),
    ]);
    expect(registry.listModels("image").map((m) => m.id)).toEqual(["pollinations:flux"]);
    expect(registry.defaultModel("video").id).toBe("pollinations:flux-keyframe");
  });

  it("resolves a model id across both capability lists", () => {
    const registry = createRegistry([grok, flux]);
    expect(registry.resolve("apikey-fan:grok-imagine-video-1.5")?.model.kind).toBe("video");
    expect(registry.resolve("apikey-fan:grok-imagine-image-2.0")?.model.kind).toBe("image");
  });

  it("distinguishes unconfigured providers from unknown models", () => {
    const offline = fakeProvider({
      id: "apikey-fan",
      configured: false,
      imageModels: [
        {
          id: "apikey-fan:grok-imagine-image-2.0",
          providerId: "apikey-fan",
          kind: "image",
          model: "grok-imagine-image-2.0",
          label: "Grok",
        },
      ],
    });
    const registry = createRegistry([offline]);
    expect(registry.resolve("apikey-fan:grok-imagine-image-2.0")).toBeNull();
    expect(registry.findAnywhere("apikey-fan:grok-imagine-image-2.0")?.provider.id).toBe(
      "apikey-fan",
    );
    expect(registry.findAnywhere("nope:model")).toBeNull();
  });

  it("resolves hidden models without listing them", () => {
    const hidden: ModelDescriptor = {
      id: "sogni:wan_v2.2-14b-fp8_i2v_lightx2v",
      providerId: "sogni",
      kind: "video",
      model: "wan_v2.2-14b-fp8_i2v_lightx2v",
      label: "WAN 2.2 i2v",
      frameInput: { start: true, end: false },
    };
    const provider = fakeProvider({ id: "sogni", configured: true });
    (provider as { listHiddenModels: () => ModelDescriptor[] }).listHiddenModels = () => [hidden];
    const registry = createRegistry([provider]);

    expect(registry.listModels("video")).toEqual([]);
    expect(registry.listAllModels("video").map((m) => m.id)).toEqual([hidden.id]);
    expect(registry.findAnywhere(hidden.id)?.model.model).toBe(hidden.model);
    expect(registry.resolve(hidden.id)?.model.model).toBe(hidden.model);
  });
});
