import { describe, expect, it } from "vitest";
import {
  SOGNI_IMAGE_MODELS,
  SOGNI_VIDEO_MODELS,
  sogniCuratedLabel,
  sogniModelMeta,
} from "@/lib/providers/sogni/model-meta";

describe("sogni model meta", () => {
  it("curates a small recommended set: 4 image + 4 video models", () => {
    expect(SOGNI_IMAGE_MODELS.filter((m) => m.tier === "recommended")).toHaveLength(4);
    expect(SOGNI_VIDEO_MODELS.filter((m) => m.tier === "recommended")).toHaveLength(4);
  });

  it("resolves exact curated ids with their claims", () => {
    const meta = sogniModelMeta("krea2_turbo_fp8_scaled");
    expect(meta?.tier).toBe("recommended");
    expect(meta?.label).toBe("Krea 2 Turbo");
    expect(meta?.useCase).toBeTruthy();
    expect(meta?.costTier).toBe("credits");
  });

  it("inherits family placement for new quant/step variants via prefix", () => {
    const variant = sogniModelMeta("krea2_turbo_v2_int8");
    expect(variant?.tier).toBe("recommended");

    const seedanceFast = sogniModelMeta("seedance-2-0-fast");
    expect(seedanceFast?.tier).toBe("recommended");
    expect(seedanceFast?.stylesSupported).toBe(false);
  });

  it("prefers the longest matching prefix (mini over its family base)", () => {
    expect(sogniModelMeta("seedance-2-0-mini")?.hint).toBe("fast");
    expect(sogniModelMeta("seedance-2-0-fast")?.hint).toBe("cinematic");
  });

  it("returns null for unknown models — no guessed claims", () => {
    expect(sogniModelMeta("some_brand_new_model_fp8")).toBeNull();
  });

  it("curates the edit/identity families as reference-edit models, never recommended", () => {
    const gpt = sogniModelMeta("gpt-image-2.5-flare");
    expect(gpt?.useCase).toBe("reference edit");
    // maxContextImages: 16 on the live catalog.
    expect(gpt?.contextImages).toEqual({ min: 0, max: 16 });
    expect(gpt?.tier).toBeUndefined();

    // requiresContextImage families cap at 3 (SDK doc: qwen edit ≤3); the
    // whole family inherits via prefix, including lightning/alpha variants.
    expect(sogniModelMeta("qwen_image_edit_2511_lightning")?.contextImages).toEqual({
      min: 1,
      max: 3,
    });
    expect(sogniModelMeta("krea2_identity_edit_v1_2_dark_beast")?.contextImages).toEqual({
      min: 1,
      max: 3,
    });
    expect(sogniModelMeta("qwen_image_edit_2511_fp8")?.tier).toBeUndefined();
  });

  it("carries contextImages through the cold-start descriptors", () => {
    const edit = SOGNI_IMAGE_MODELS.find((m) => m.model === "qwen_image_edit_2511_fp8");
    expect(edit?.contextImages).toEqual({ min: 1, max: 3 });
    const classic = SOGNI_IMAGE_MODELS.find((m) => m.model === "krea2_turbo_fp8_scaled");
    expect(classic?.contextImages).toBeUndefined();
  });

  it("gives the curated label only to verbatim ids — variants keep their API name", () => {
    expect(sogniCuratedLabel("krea2_turbo_fp8_scaled")).toBe("Krea 2 Turbo");
    expect(sogniCuratedLabel("seedance-2-0-fast")).toBeNull();
    expect(sogniCuratedLabel("wan_v2.2-14b-fp8_t2v")).toBeNull();
  });

  it("curated seedance entries stay styleless (guard against curated-flag override)", () => {
    const byId = new Map(SOGNI_VIDEO_MODELS.map((m) => [m.model, m]));
    expect(byId.get("seedance-2-0")?.stylesSupported).toBe(false);
    expect(byId.get("seedance-2-0-mini")?.stylesSupported).toBe(false);
  });

  it("links cold-start t2v picks to their registered i2v sibling", () => {
    const byId = new Map(SOGNI_VIDEO_MODELS.map((m) => [m.model, m]));
    expect(byId.get("wan_v2.2-14b-fp8_t2v_lightx2v")?.i2vModelId).toBe(
      "sogni:wan_v2.2-14b-fp8_i2v_lightx2v",
    );
    expect(byId.get("ltx25-22b-int8_t2v_distilled")?.i2vModelId).toBe(
      "sogni:ltx25-22b-int8_i2v_distilled",
    );
  });

  it("leaves self-chaining picks (Seedance) without a sibling link", () => {
    const byId = new Map(SOGNI_VIDEO_MODELS.map((m) => [m.model, m]));
    expect(byId.get("seedance-2-0")?.i2vModelId).toBeUndefined();
    expect(byId.get("seedance-2-0-mini")?.i2vModelId).toBeUndefined();
  });
});
