import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  frameCapability,
  getSogniCatalog,
  i2vSiblingId,
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

  it("prefers curated labels and claims, else leaves models unclaimed", () => {
    const images = toDescriptors(LIVE_CATALOG, "image");
    const krea = images.find((m) => m.model === "krea2_turbo_fp8_scaled")!;
    const flux = images.find((m) => m.model === "flux1-dev-fp8")!;
    expect(krea.label).toBe("Krea 2 Turbo");
    expect(krea.hint).toBe("premium credits");
    expect(krea.tier).toBe("recommended");
    expect(krea.useCase).toBeTruthy();
    expect(flux.label).toBe("Flux Dev");
    expect(flux.hint).toBeUndefined(); // no regex-guessed hints
    expect(flux.tier).toBeUndefined();
    expect(flux.useCase).toBeUndefined();
  });

  it("excludes audio/reference/utility workflows the studio cannot drive", () => {
    const descriptors = toDescriptors(
      [
        model({ id: "ltx23-22b-fp8_a2v_dev", name: "LTX A2V", media: "video" }),
        model({ id: "minimax-h3-fastvideo-int8_flfa2v_turbo", name: "FLFA2V", media: "video" }),
        model({ id: "minimax-h3-ref2va-fp8_r2v", name: "MiniMax R2V", media: "video" }),
        model({ id: "happyhorse-1.1-r2v", name: "HappyHorse R2V", media: "video" }),
        model({ id: "birefnet_image_background_removal_fp16", name: "BiRefNet", media: "image" }),
        model({ id: "seedance-2-0", name: "Seedance 2.0", media: "video" }),
      ],
      "video",
    );
    expect(descriptors.map((m) => m.model)).toEqual(["seedance-2-0"]);
  });

  it("stamps recommended-first ordering before alphabetical tail", () => {
    const descriptors = toDescriptors(
      [
        model({ id: "aardvark_model", name: "Aardvark", media: "image" }),
        model({ id: "krea2_turbo_fp8_scaled", name: "Krea 2 Turbo", media: "image" }),
        model({ id: "krea2_turbo_v2_int8", name: "Krea 2 Turbo v2", media: "image" }),
      ],
      "image",
    );
    const tiers = descriptors.map((m) => (m.tier === "recommended" ? "rec" : "tail"));
    expect(tiers).toEqual(["rec", "rec", "tail"]);
  });

  it("derives a readable label when the API name is missing", () => {
    const [derived] = toDescriptors(
      [model({ id: "some_new_model_v2_fp8", name: "  " })],
      "image",
    );
    expect(derived.label).toBe("Some new model v2");
  });

  it("marks provider-workflow video families as styleless", () => {
    const videos = toDescriptors(
      [
        model({ id: "seedance-2-5", name: "Seedance 2.5", media: "video" }),
        model({ id: "happyhorse-1.1-t2v", name: "HappyHorse 1.1", media: "video" }),
        model({ id: "wan3.0-video", name: "Wan 3.0", media: "video" }),
        // Curated entry carries its static flag through the live mapping.
        model({ id: "seedance-2-0-mini", name: "Seedance 2.0 Mini", media: "video" }),
      ],
      "video",
    );
    const byId = new Map(videos.map((v) => [v.model, v.stylesSupported]));
    expect(byId.get("seedance-2-5")).toBe(false);
    expect(byId.get("happyhorse-1.1-t2v")).toBe(false);
    expect(byId.get("seedance-2-0-mini")).toBe(false);
    expect(byId.get("wan3.0-video")).toBe(true);
  });

  it("groups closed commercial models as sensored, diffusion models as uncensored", () => {
    const images = toDescriptors(
      [
        model({ id: "gpt-image-2.5", name: "GPT Image 2.5", media: "image" }),
        model({ id: "flux1-dev-fp8", name: "Flux Dev", media: "image" }),
      ],
      "image",
    );
    const byId = new Map(images.map((m) => [m.model, m.uncensored]));
    expect(byId.get("gpt-image-2.5")).toBe(false);
    expect(byId.get("flux1-dev-fp8")).toBe(true);
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

describe("frame capability rules", () => {
  it("marks ltx23 i2v as start+end (keyframe interpolation)", () => {
    expect(frameCapability("ltx23-22b-fp8_i2v_distilled")).toEqual({ start: true, end: true });
  });

  it("marks minimax h3 i2v as start+end", () => {
    expect(frameCapability("minimax-h3-fl2va-fp8_i2v")).toEqual({ start: true, end: true });
  });

  it("marks flf2v as start+end", () => {
    expect(frameCapability("minimax-h3-fl2va-fp8_flf2v")).toEqual({ start: true, end: true });
  });

  it("marks seedance 2.5 as start+end and 2.0 as start-only", () => {
    expect(frameCapability("seedance-2-5")).toEqual({ start: true, end: true });
    expect(frameCapability("seedance-2-0-mini")).toEqual({ start: true, end: false });
  });

  it("leaves t2v-only families prompt-only", () => {
    expect(frameCapability("wan_v2.2-14b-fp8_t2v_lightx2v")).toBeUndefined();
    expect(frameCapability("ltx25-22b-int8_t2v_distilled")).toBeUndefined();
    expect(frameCapability("happyhorse-1.1-t2v")).toBeUndefined();
  });

  it("rewrites t2v to i2v within the family", () => {
    expect(i2vSiblingId("wan_v2.2-14b-fp8_t2v_lightx2v")).toBe("wan_v2.2-14b-fp8_i2v_lightx2v");
    expect(i2vSiblingId("ltx25-22b-int8_t2v_distilled")).toBe("ltx25-22b-int8_i2v_distilled");
  });

  it("rewrites dashed vendor t2v ids to their i2v sibling too", () => {
    expect(i2vSiblingId("happyhorse-1.1-t2v")).toBe("happyhorse-1.1-i2v");
  });

  it("returns null for models without a t2v workflow suffix", () => {
    expect(i2vSiblingId("seedance-2-0-mini")).toBeNull();
    expect(i2vSiblingId("ltx23-22b-fp8_i2v_dev")).toBeNull();
  });
});

describe("hidden frame models", () => {
  it("links t2v models to registered i2v siblings and hides frame models", async () => {
    setCatalogFetcherForTests(async () => LIVE_CATALOG);
    await warmSogniCatalog();
    const catalog = getSogniCatalog();

    const wan = catalog.videos.find((m) => m.model === "wan_v2.2-14b-fp8_t2v_lightx2v");
    expect(wan?.i2vModelId).toBe("sogni:wan_v2.2-14b-fp8_i2v_lightx2v");
    expect(wan?.frameInput).toBeUndefined(); // t2v itself stays prompt-only

    // i2v/flf2v are registered but never listed in the picker
    expect(catalog.videos.some((m) => m.model.includes("_i2v"))).toBe(false);
    expect(catalog.videos.some((m) => m.model.includes("_flf2v"))).toBe(false);
    expect(catalog.hidden.map((m) => m.model)).toContain("wan_v2.2-14b-fp8_i2v_lightx2v");
    expect(catalog.hidden.every((m) => m.frameInput?.start)).toBe(true);

    // every Sogni image model takes a startingImage
    expect(catalog.images.every((m) => m.frameInput?.start === true)).toBe(true);
  });

  it("exposes hidden models through the provider for the registry", async () => {
    setCatalogFetcherForTests(async () => LIVE_CATALOG);
    await warmSogniCatalog();
    const hidden = sogniProvider.listHiddenModels?.() ?? [];
    expect(hidden.map((m) => m.model)).toContain("wan_v2.2-14b-fp8_i2v_lightx2v");
  });

  it("keeps curated cold-start hidden siblings before any refresh", () => {
    const catalog = getSogniCatalog();
    expect(catalog.hidden.map((m) => m.model)).toEqual(
      expect.arrayContaining([
        "wan_v2.2-14b-fp8_i2v_lightx2v",
        "ltx25-22b-int8_i2v_distilled",
      ]),
    );
  });
});
