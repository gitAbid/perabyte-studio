import { describe, expect, it } from "vitest";
import { LORA_PRESETS, matchLoraPreset, type LoraPreset } from "./lora-presets";

const NSFW_IDS = new Set(["krea2-aberrant", "krea2-mystic-x", "krea2-realism-engine"]);
const BYPASS_IDS = new Set(["krea2-filter-bypass-2", "krea2-filter-bypass-3"]);
const BODY_SLIDER_IDS = new Set([
  "krea2-breast",
  "krea2-chest-firmness",
  "krea2-nipple-projection",
  "krea2-hourglass-figure",
]);

function byId(id: string): LoraPreset {
  const preset = LORA_PRESETS.find((p) => p.id === id);
  expect(preset, `missing preset ${id}`).toBeDefined();
  return preset!;
}

function ids(preset: LoraPreset): string[] {
  return preset.loras.map((entry) => entry.loraId);
}

describe("LORA_PRESETS table", () => {
  it("has unique ids and well-formed selections", () => {
    const allIds = LORA_PRESETS.map((p) => p.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const preset of LORA_PRESETS) {
      expect(preset.loras.length).toBeGreaterThan(0);
      expect(new Set(ids(preset)).size).toBe(preset.loras.length);
      for (const entry of preset.loras) {
        expect(entry.loraId).toMatch(/^krea2-/);
        expect(Number.isFinite(entry.strength)).toBe(true);
        expect(entry.strength).not.toBe(0);
      }
    }
  });

  it("mature-gates nsfw adapters and filter-bypass; SFW looks stay untagged", () => {
    for (const preset of LORA_PRESETS) {
      const touchesNsfw = preset.loras.some((l) => NSFW_IDS.has(l.loraId));
      const touchesBypass = preset.loras.some((l) => BYPASS_IDS.has(l.loraId));
      if (touchesNsfw || touchesBypass) {
        expect(preset.mature).toBe(true);
      } else {
        expect(preset.mature).not.toBe(true);
      }
    }
  });

  it("does not bake body-shape sliders into any preset", () => {
    for (const preset of LORA_PRESETS) {
      expect(preset.loras.some((l) => BODY_SLIDER_IDS.has(l.loraId))).toBe(false);
    }
  });

  it("ships the uncensored mature looks in display order", () => {
    expect(LORA_PRESETS.filter((p) => p.mature).map((p) => p.id)).toEqual([
      "uncensored",
      "uncensored-strong",
      "unlock",
      "engine-realism",
      "mystic",
      "candid-adult",
      "raw-amateur",
      "glamour-nude",
      "wet-look",
      "aberrant",
    ]);
  });

  it("Uncensored pairs filter-bypass-2 with mystic-x under 1", () => {
    const preset = byId("uncensored");
    expect(preset.label).toBe("Uncensored");
    expect(preset.loras).toEqual([
      { loraId: "krea2-filter-bypass-2", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
    ]);
  });

  it("Uncensored Strong uses the 3-vector bypass", () => {
    expect(byId("uncensored-strong").loras).toEqual([
      { loraId: "krea2-filter-bypass-3", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
    ]);
  });

  it("Unlock is bypass-only and still mature-gated", () => {
    const preset = byId("unlock");
    expect(preset.mature).toBe(true);
    expect(preset.loras).toEqual([{ loraId: "krea2-filter-bypass-2", strength: 2 }]);
  });

  it("Engine Realism pairs realism-engine with bypass, not krea2-realism", () => {
    const preset = byId("engine-realism");
    expect(ids(preset)).toEqual(["krea2-realism-engine", "krea2-filter-bypass-2"]);
    expect(ids(preset)).not.toContain("krea2-realism");
    expect(preset.loras[0].strength).toBe(0.8);
    expect(preset.loras[1].strength).toBe(2);
  });

  it("Mystic stays a pure adult LoRA at 1", () => {
    expect(byId("mystic").loras).toEqual([{ loraId: "krea2-mystic-x", strength: 1 }]);
  });

  it("Aberrant is body-horror, not an adult finetune", () => {
    const preset = byId("aberrant");
    expect(preset.hint.toLowerCase()).toMatch(/horror|grit|industrial/);
    expect(ids(preset)).toContain("krea2-aberrant");
    expect(ids(preset)).not.toContain("krea2-mystic-x");
  });
});

describe("matchLoraPreset", () => {
  it("matches on ids, order, and exact strengths", () => {
    const preset = LORA_PRESETS.find((p) => p.id === "golden-hour")!;
    expect(matchLoraPreset(preset.loras)?.id).toBe("golden-hour");
    const reordered = [...preset.loras].reverse();
    expect(matchLoraPreset(reordered)).toBeUndefined();
    const tweaked = preset.loras.map((l) => ({ ...l, strength: l.strength + 0.1 }));
    expect(matchLoraPreset(tweaked)).toBeUndefined();
  });

  it("empty and unknown selections match nothing", () => {
    expect(matchLoraPreset([])).toBeUndefined();
    expect(matchLoraPreset([{ loraId: "krea2-zoom", strength: 1 }])).toBeUndefined();
  });
});
