import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  getSogniCatalog,
  setCatalogFetcherForTests,
  toDescriptors,
  warmSogniCatalog,
} from "@/lib/providers/sogni/catalog";
import type { SogniAvailableModel } from "@/lib/providers/sogni/client";
import { sogniProvider } from "@/lib/providers/sogni/sogni.provider";

function model(overrides: Partial<SogniAvailableModel>): SogniAvailableModel {
  return { id: "x", name: "", workerCount: 4, media: "image", ...overrides };
}

const LIVE_CATALOG: SogniAvailableModel[] = [
  model({ id: "krea2_turbo_fp8_scaled", name: "Krea 2 Turbo", media: "image" }),
  model({ id: "qwen_image_edit_2511_fp8", name: "Qwen Image Edit", media: "image" }),
  model({ id: "sam3_image_segment_bf16", name: "SAM3 Segment", media: "image" }),
  model({ id: "flux1-dev-fp8", name: "Flux Dev", media: "image" }),
  model({ id: "gpt-image-2", name: "GPT Image 2", workerCount: 0, media: "image" }),
  model({ id: "wan_v2.2-14b-fp8_t2v_lightx2v", name: "WAN 2.2", media: "video" }),
  model({ id: "wan_v2.2-14b-fp8_i2v_lightx2v", name: "WAN 2.2 I2V", media: "video" }),
  model({ id: "flashvsr_v1.1_tiny_long_bf16", name: "FlashVSR Upscale", media: "video" }),
  model({ id: "qwen3.6-35b-a3b-gguf-iq4xs", name: "Qwen LLM", media: "audio" }),
];

beforeEach(() => {
  process.env.SOGNI_API_KEY = "test-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  setCatalogFetcherForTests(null);
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

describe("sogni catalog", () => {
  it("falls back to the curated catalog before any refresh", () => {
    const catalog = getSogniCatalog();
    expect(catalog.images.map((m) => m.model)).toContain("krea2_turbo_fp8_scaled");
    expect(catalog.videos.map((m) => m.model)).toContain("wan_v2.2-14b-fp8_t2v_lightx2v");
  });

  it("keeps prompt-driven models and drops edit/segment/upscale/i2v/offline ones", () => {
    const images = toDescriptors(LIVE_CATALOG, "image");
    const videos = toDescriptors(LIVE_CATALOG, "video");

    expect(images.map((m) => m.model)).toEqual(["krea2_turbo_fp8_scaled", "flux1-dev-fp8"]);
    expect(videos.map((m) => m.model)).toEqual(["wan_v2.2-14b-fp8_t2v_lightx2v"]);
  });

  it("prefers curated labels and hints, else uses the API name", () => {
    const [krea, flux] = toDescriptors(LIVE_CATALOG, "image");
    expect(krea.label).toBe("Krea 2 Turbo");
    expect(krea.hint).toBe("Sogni · spark credits");
    expect(flux.label).toBe("Flux Dev");
    expect(flux.hint).toBe("Sogni · standard");
  });

  it("derives a readable label when the API name is missing", () => {
    const [derived] = toDescriptors(
      [model({ id: "some_new_model_v2_fp8", name: "  " })],
      "image",
    );
    expect(derived.label).toBe("Some new model v2");
  });

  it("refreshes in the background and the provider serves the warmed list", async () => {
    setCatalogFetcherForTests(async () => LIVE_CATALOG);
    await warmSogniCatalog();

    const imageIds = sogniProvider.listImageModels().map((m) => m.model);
    expect(imageIds).toContain("flux1-dev-fp8");
    expect(imageIds).not.toContain("sam3_image_segment_bf16");
    expect(sogniProvider.listVideoModels().map((m) => m.model)).toContain(
      "wan_v2.2-14b-fp8_t2v_lightx2v",
    );
  });

  it("keeps the curated catalog when the refresh fails", async () => {
    // setCatalogFetcherForTests resets the cache, so this warm really fetches.
    setCatalogFetcherForTests(async () => {
      throw new Error("sogni down");
    });
    await warmSogniCatalog();
    expect(getSogniCatalog().images.map((m) => m.model)).toContain("krea2_turbo_fp8_scaled");
  });

  it("never blanks the catalog on an empty API answer", async () => {
    setCatalogFetcherForTests(async () => []);
    await warmSogniCatalog();
    expect(getSogniCatalog().images.map((m) => m.model)).toContain("krea2_turbo_fp8_scaled");
  });
});
