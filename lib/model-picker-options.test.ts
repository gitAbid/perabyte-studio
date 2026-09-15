import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/lib/model-catalog";
import { modelBadges, modelPickerSections } from "@/lib/model-picker-options";

function option(overrides: Partial<ModelOption>): ModelOption {
  return {
    id: "sogni:x",
    kind: "image",
    model: "x",
    label: "X",
    providerId: "sogni",
    providerLabel: "Sogni AI",
    ...overrides,
  };
}

describe("model picker sections", () => {
  const models: ModelOption[] = [
    option({
      id: "sogni:krea2_turbo_fp8_scaled",
      model: "krea2_turbo_fp8_scaled",
      label: "Krea 2 Turbo",
      tier: "recommended",
      useCase: "Flagship",
      hint: "premium credits",
    }),
    option({
      id: "pollinations:flux",
      providerId: "pollinations",
      providerLabel: "Pollinations",
      model: "flux",
      label: "Flux",
      tier: "recommended",
      costTier: "free",
    }),
    option({ id: "sogni:flux1-dev-fp8", model: "flux1-dev-fp8", label: "Flux Dev" }),
    option({
      id: "sogni:gpt-image-2",
      model: "gpt-image-2",
      label: "GPT Image 2",
      uncensored: false,
    }),
    option({
      id: "pollinations:flux2",
      providerId: "pollinations",
      providerLabel: "Pollinations",
      model: "flux2",
      label: "Flux 2",
    }),
  ];

  it("splits recommended from a provider-grouped tail", () => {
    const sections = modelPickerSections(models);
    expect(sections.recommended.map((o) => o.label)).toEqual(["Krea 2 Turbo", "Flux"]);
    expect(sections.tailLabel).toBe("Show all 3 more models");
    const groups = [...new Set(sections.tail.map((o) => o.group))];
    expect(groups).toEqual(["Sogni AI", "Pollinations"]); // first-appearance order
  });

  it("carries hint/description and never duplicates the provider into the hint", () => {
    const sections = modelPickerSections(models);
    const krea = sections.recommended[0];
    expect(krea.hint).toBe("premium credits");
    expect(krea.description).toBe("Flagship");
    expect(krea.hint).not.toContain("Sogni");
  });

  it("builds capability badges", () => {
    const badges = modelBadges(
      option({
        uncensored: false,
        costTier: "free",
        stylesSupported: false,
        frameInput: { start: true, end: false },
        loraCapable: true,
      }),
    );
    expect(badges).toEqual(["Sensored", "Free", "No styles", "Start frame", "LoRA"]);
    expect(modelBadges(option({}))).toEqual([]);
  });

  it("collapses into a flat list when nothing is recommended", () => {
    const sections = modelPickerSections([models[2]]);
    expect(sections.recommended.map((o) => o.label)).toEqual(["Flux Dev"]);
    expect(sections.tail).toEqual([]);
    expect(sections.tailLabel).toBe("");
  });
});
