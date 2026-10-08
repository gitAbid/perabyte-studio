import { describe, expect, it } from "vitest";
import { PRODUCTION_MODEL_BASELINE, PRODUCTION_MODEL_DEFAULTS, productionModelOptions } from "@/lib/providers/production/sogni-h3";
import {
  baselineProductionModelOptions, parseProductionModelsPayload,
  type ProductionModelOptionView,
} from "@/components/production/storyboard";

describe("storyboard production model dropdown view model", () => {
  it("falls back to exactly the production baseline options when the route is unavailable", () => {
    expect(baselineProductionModelOptions("anchor")).toEqual(productionModelOptions("anchor", []));
    expect(baselineProductionModelOptions("take")).toEqual(productionModelOptions("take", []));
    expect(baselineProductionModelOptions("take").map((model) => model.id)).toEqual([...PRODUCTION_MODEL_BASELINE.take]);
    expect(baselineProductionModelOptions("take")[0]).toEqual({
      id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "minimax-h3-fl2va-fp8_i2v_turbo — image-to-video", mode: "image-to-video",
    });
    expect(baselineProductionModelOptions("anchor")[0]).toEqual({ id: "flux1-schnell-fp8", label: "flux1-schnell-fp8", mode: "image" });
  });

  it("preselects the accepted defaults and keeps them first in the baseline", () => {
    for (const kind of ["anchor", "take"] as const) {
      expect(PRODUCTION_MODEL_DEFAULTS[kind]).toBe(baselineProductionModelOptions(kind)[0].id);
    }
  });

  it("parses a well-formed route payload and refuses anything else (caller falls back to baseline)", () => {
    const payload = {
      provider: { id: "sogni", label: "Sogni" },
      models: [
        { id: "flux1-schnell-fp8", label: "FLUX.1 Schnell", mode: "image" },
        { id: "minimax-h3-fl2va-fp8_i2v_turbo", label: "MiniMax H3 i2v Turbo — image-to-video", mode: "image-to-video" },
      ],
    } satisfies { provider: { id: string; label: string }; models: ProductionModelOptionView[] };
    expect(parseProductionModelsPayload(payload)).toEqual<ProductionModelOptionView[] | null>(payload.models);

    for (const broken of [
      null,
      {},
      { provider: { id: "sogni", label: "Sogni" } },
      { provider: { id: "sogni", label: "Sogni" }, models: "nope" },
      { provider: { id: "sogni", label: "Sogni" }, models: [{ id: "m", label: "M", mode: "audio-to-video" }] },
      { provider: { id: "sogni", label: "Sogni" }, models: [{ id: "m", mode: "image" }] },
      { provider: { id: "sogni", label: "Sogni" }, models: [], surprise: 1 },
    ]) {
      expect(parseProductionModelsPayload(broken)).toBeNull();
    }
  });
});
