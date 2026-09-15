import { describe, expect, it } from "vitest";
import {
  clampStrength,
  groupLorasByCategory,
  lorasForModel,
  snapLorasForModel,
  visibleLoras,
} from "./lora-options";
import type { LoraOption } from "@/lib/providers/sogni/lora-catalog";

function entry(overrides: Partial<LoraOption>): LoraOption {
  return {
    loraId: "test-lora",
    name: "Test LoRA",
    description: "",
    category: "lighting",
    modelIds: ["krea2_turbo_fp8_scaled"],
    nsfw: false,
    sexual: false,
    min: -5,
    max: 5,
    default: 1,
    step: 0.1,
    recommendedMin: -2,
    recommendedMax: 2,
    ...overrides,
  };
}

const CATALOG: LoraOption[] = [
  entry({ loraId: "krea2-warm-light", name: "Warm Light", modelIds: ["krea2_turbo_fp8_scaled", "dark_beast_krea2_fp8"] }),
  entry({ loraId: "h3-better-motion", name: "Better Motion", category: "popular-community-fine-tunes", modelIds: ["minimax-h3-fl2va-fp8_t2v"] }),
  entry({ loraId: "krea2-mystic-x", name: "Mystic X", nsfw: true, sexual: true, modelIds: ["krea2_turbo_fp8_scaled"] }),
];

describe("lorasForModel", () => {
  it("returns only entries whose modelIds include the model", () => {
    const ids = lorasForModel(CATALOG, "krea2_turbo_fp8_scaled").map((e) => e.loraId);
    expect(ids).toEqual(["krea2-warm-light", "krea2-mystic-x"]);
  });

  it("returns nothing for a model with no LoRAs", () => {
    expect(lorasForModel(CATALOG, "wan_v2.2-14b-fp8_t2v_lightx2v")).toEqual([]);
  });
});

describe("visibleLoras", () => {
  it("hides nsfw/sexual entries behind the Uncensored gate", () => {
    expect(visibleLoras(CATALOG, false).map((e) => e.loraId)).toEqual([
      "krea2-warm-light",
      "h3-better-motion",
    ]);
  });

  it("shows everything when Uncensored Mode is on", () => {
    expect(visibleLoras(CATALOG, true)).toHaveLength(3);
  });
});

describe("groupLorasByCategory", () => {
  it("follows the known category order and titles unknown ones last", () => {
    const groups = groupLorasByCategory([
      entry({ loraId: "a", category: "zz-custom" }),
      entry({ loraId: "b", category: "character" }),
      entry({ loraId: "c", category: "lighting" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["character", "lighting", "zz-custom"]);
    expect(groups[2].label).toBe("Zz Custom");
  });
});

describe("clampStrength", () => {
  it("clamps into the entry's own band and rescues NaN to the default", () => {
    expect(clampStrength(CATALOG[0], 9)).toBe(5);
    expect(clampStrength(CATALOG[0], -99)).toBe(-5);
    expect(clampStrength(CATALOG[0], Number.NaN)).toBe(1);
  });
});

describe("snapLorasForModel", () => {
  it("keeps valid selections in order and drops ones the new model rejects", () => {
    const selection = [
      { loraId: "krea2-warm-light", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 1 },
    ];
    expect(snapLorasForModel(selection, CATALOG, "dark_beast_krea2_fp8")).toEqual([
      { loraId: "krea2-warm-light", strength: 2 },
    ]);
  });

  it("re-clamps strengths into the new entry context", () => {
    const narrow = [entry({ loraId: "krea2-warm-light", min: -1, max: 1, default: 0 })];
    expect(snapLorasForModel([{ loraId: "krea2-warm-light", strength: 4 }], narrow, "krea2_turbo_fp8_scaled")).toEqual([
      { loraId: "krea2-warm-light", strength: 1 },
    ]);
  });

  it("drops ids missing from the catalog entirely and honours the cap", () => {
    const selection = [
      { loraId: "ghost-lora", strength: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({ loraId: `lora-${i}`, strength: 1 })),
    ];
    const wide = Array.from({ length: 10 }, (_, i) =>
      entry({ loraId: `lora-${i}` }),
    );
    const snapped = snapLorasForModel(selection, wide, "krea2_turbo_fp8_scaled");
    expect(snapped).toHaveLength(8);
    expect(snapped.map((s) => s.loraId)).not.toContain("ghost-lora");
  });
});
