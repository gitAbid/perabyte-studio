import { describe, expect, it, vi } from "vitest";
import { createProductionModelsHandler } from "./http-routes";
import {
  PRODUCTION_MODEL_BASELINE, PRODUCTION_MODEL_DEFAULTS, isProductionTakeModelId,
  productionModelOptions, type ProductionCatalogEntry, type ProductionModelKind,
} from "./sogni-h3";

describe("production model baseline + pure filter/merge", () => {
  it("pins the accepted pilot baselines and defaults", () => {
    expect(PRODUCTION_MODEL_BASELINE.anchor).toEqual(["flux1-schnell-fp8"]);
    expect(PRODUCTION_MODEL_BASELINE.take).toEqual(["minimax-h3-fl2va-fp8_i2v_turbo", "minimax-h3-fl2va-fp8_i2v"]);
    expect(PRODUCTION_MODEL_DEFAULTS.anchor).toBe(PRODUCTION_MODEL_BASELINE.anchor[0]);
    expect(PRODUCTION_MODEL_DEFAULTS.take).toBe(PRODUCTION_MODEL_BASELINE.take[0]);
  });

  it("classifies only FL2VA i2v / i2v_turbo ids as production takes", () => {
    expect(isProductionTakeModelId("minimax-h3-fl2va-fp8_i2v")).toBe(true);
    expect(isProductionTakeModelId("minimax-h3-fl2va-fp8_i2v_turbo")).toBe(true);
    expect(isProductionTakeModelId("minimax-h3-fastvideo-int8_i2v_turbo")).toBe(true);
    // H3 FL2VA mode but not an i2v-endpoint variant, or a different H3 family.
    expect(isProductionTakeModelId("minimax-h3-fl2va-fp8_i2v_t2v")).toBe(false);
    expect(isProductionTakeModelId("minimax-h3-fl2va-fp8_t2v")).toBe(false);
    expect(isProductionTakeModelId("minimax-h3-fl2va-fp8_flf2v")).toBe(false);
    expect(isProductionTakeModelId("minimax-h3-ref2va-fp8_r2v")).toBe(false);
    expect(isProductionTakeModelId("flux1-schnell-fp8")).toBe(false);
    expect(isProductionTakeModelId("totally-unknown-model")).toBe(false);
  });

  it("anchors: keeps catalog entries, appends the baseline, dedupes by id with catalog labels winning", () => {
    const catalog: ProductionCatalogEntry[] = [
      { id: "flux1-schnell-fp8", label: "FLUX.1 Schnell" },
      { id: "krea2_turbo_fp8_scaled", label: "Krea 2 Turbo" },
    ];
    expect(productionModelOptions("anchor", catalog)).toEqual([
      { id: "flux1-schnell-fp8", label: "FLUX.1 Schnell", mode: "image" },
      { id: "krea2_turbo_fp8_scaled", label: "Krea 2 Turbo", mode: "image" },
    ]);
    // Empty catalog -> exactly the baseline, in baseline order, label = id.
    expect(productionModelOptions("anchor", [])).toEqual([{ id: "flux1-schnell-fp8", label: "flux1-schnell-fp8", mode: "image" }]);
    // A duplicate catalog id never yields two options; an empty label falls back to the id.
    expect(productionModelOptions("anchor", [{ id: "a", label: "" }, { id: "a", label: "b" }])).toEqual([
      { id: "flux1-schnell-fp8", label: "flux1-schnell-fp8", mode: "image" },
      { id: "a", label: "a", mode: "image" },
    ]);
  });

  it("takes: filters the catalog to i2v-only FL2VA entries with the friendly mode suffix", () => {
    const catalog: ProductionCatalogEntry[] = [
      { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "MiniMax H3 i2v Turbo" },
      { id: "minimax-h3-fl2va-fp8_t2v", label: "MiniMax H3 t2v" },
      { id: "minimax-h3-fl2va-fp8_flf2v", label: "MiniMax H3 flf2v" },
      { id: "minimax-h3-ref2va-fp8_r2v", label: "MiniMax H3 r2v" },
      { id: "wan_v2.2-14b-fp8_i2v_lightx2v", label: "WAN 2.2 i2v" },
      { id: "flux1-schnell-fp8", label: "FLUX.1 Schnell" },
    ];
    // Baseline ids keep baseline order (catalog wins for the label); catalog-only extras follow.
    expect(productionModelOptions("take", catalog)).toEqual([
      { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "MiniMax H3 i2v Turbo — image-to-video", mode: "image-to-video" },
      { id: "minimax-h3-fl2va-fp8_i2v", label: "minimax-h3-fl2va-fp8_i2v — image-to-video", mode: "image-to-video" },
    ]);
    // Offline determinism: no catalog at all still yields the accepted take baseline.
    expect(productionModelOptions("take", [])).toEqual([
      { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "minimax-h3-fl2va-fp8_i2v_turbo — image-to-video", mode: "image-to-video" },
      { id: "minimax-h3-fl2va-fp8_i2v", label: "minimax-h3-fl2va-fp8_i2v — image-to-video", mode: "image-to-video" },
    ]);
    // A catalog entry for a baseline id wins for the label and keeps a single option.
    expect(productionModelOptions("take", [{ id: "minimax-h3-fl2va-fp8_i2v", label: "MiniMax H3 i2v" }])).toEqual([
      { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "minimax-h3-fl2va-fp8_i2v_turbo — image-to-video", mode: "image-to-video" },
      { id: "minimax-h3-fl2va-fp8_i2v", label: "MiniMax H3 i2v — image-to-video", mode: "image-to-video" },
    ]);
  });
});

type Loader = Parameters<typeof createProductionModelsHandler>[0];

describe("production models route handler", () => {
  const handler = (loader: Loader) => createProductionModelsHandler(loader);

  it("serves anchor models from the image catalog merged with the baseline", async () => {
    const loader = vi.fn((_kind: "image" | "video"): ProductionCatalogEntry[] => [
      { id: "krea2_turbo_fp8_scaled", label: "Krea 2 Turbo" },
    ]);
    const response = await handler(loader)(new Request("http://localhost/api/production/models?kind=anchor"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { provider: { id: string; label: string }; models: Array<{ id: string; label: string; mode: string }> };
    expect(body.provider).toEqual({ id: "sogni", label: "Sogni AI" });
    expect(body.models).toEqual([
      { id: "flux1-schnell-fp8", label: "flux1-schnell-fp8", mode: "image" },
      { id: "krea2_turbo_fp8_scaled", label: "Krea 2 Turbo", mode: "image" },
    ]);
    expect(loader).toHaveBeenCalledWith("image");
  });

  it("serves take models filtered to production i2v entries from the video catalog", async () => {
    const loader = vi.fn((_kind: "image" | "video"): ProductionCatalogEntry[] => [
      { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "MiniMax H3 i2v Turbo" },
      { id: "minimax-h3-fl2va-fp8_t2v", label: "MiniMax H3 t2v" },
      { id: "wan_v2.2-14b-fp8_i2v_lightx2v", label: "WAN 2.2 i2v" },
    ]);
    const response = await handler(loader)(new Request("http://localhost/api/production/models?kind=take"));
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<{ id: string; label: string; mode: string }> };
    expect(body.models.map((model) => model.id)).toEqual(["minimax-h3-fl2va-fp8_i2v_turbo", "minimax-h3-fl2va-fp8_i2v"]);
    expect(body.models[0]).toMatchObject({ label: "MiniMax H3 i2v Turbo — image-to-video", mode: "image-to-video" });
    expect(loader).toHaveBeenCalledWith("video");
  });

  it("falls back to the baseline-only response when the catalog service fails", async () => {
    const loader = vi.fn((_kind: "image" | "video"): ProductionCatalogEntry[] => { throw new Error("catalog offline"); });
    for (const kind of ProductionModelKinds) {
      const response = await handler(loader)(new Request(`http://localhost/api/production/models?kind=${kind}`));
      expect(response.status).toBe(200);
      const body = await response.json() as { models: Array<{ id: string }> };
      expect(body.models.map((model) => model.id)).toEqual([...PRODUCTION_MODEL_BASELINE[kind]]);
    }
  });

  it("rejects invalid or missing kinds and unknown query parameters with INVALID_INPUT", async () => {
    const loader = vi.fn((_kind: "image" | "video"): ProductionCatalogEntry[] => []);
    for (const url of [
      "http://localhost/api/production/models?kind=nonsense",
      "http://localhost/api/production/models?kind=",
      "http://localhost/api/production/models",
      "http://localhost/api/production/models?kind=anchor&other=1",
    ]) {
      const response = await handler(loader)(new Request(url));
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string }; requestId: string };
      expect(body.error.code).toBe("INVALID_INPUT");
      expect(typeof body.requestId).toBe("string");
    }
    expect(loader).not.toHaveBeenCalled();
  });
});

const ProductionModelKinds: ProductionModelKind[] = ["anchor", "take"];
