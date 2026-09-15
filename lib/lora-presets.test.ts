import { describe, expect, it } from "vitest";
import { LORA_PRESETS, matchLoraPreset } from "./lora-presets";

describe("LORA_PRESETS table", () => {
  it("has unique ids and well-formed selections", () => {
    const ids = LORA_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of LORA_PRESETS) {
      expect(preset.loras.length).toBeGreaterThan(0);
      expect(new Set(preset.loras.map((l) => l.loraId)).size).toBe(preset.loras.length);
      for (const entry of preset.loras) {
        expect(entry.loraId).toMatch(/^krea2-/);
        expect(Number.isFinite(entry.strength)).toBe(true);
        expect(entry.strength).not.toBe(0); // 0 = disabled; leave it out instead
      }
    }
  });

  it("marks only mature presets that carry nsfw/sexual-flagged adapters", () => {
    // Cross-checked against the live catalog (2026-09-15): only these four
    // Krea 2 LoRAs carry the nsfw/sexual flags.
    const NSFW_IDS = new Set([
      "krea2-aberrant",
      "krea2-mystic-x",
      "krea2-realism-engine",
    ]);
    for (const preset of LORA_PRESETS) {
      const touchesNsfw = preset.loras.some((l) => NSFW_IDS.has(l.loraId));
      expect(preset.mature === true).toBe(touchesNsfw);
    }
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
