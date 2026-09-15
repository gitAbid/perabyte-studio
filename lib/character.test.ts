import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARACTER_SPEC,
  accessoryGroups,
  ageBucketLabel,
  bodyDetailOptions,
  characterGenerationSettings,
  clampAge,
  clothingGroups,
  composeCharacterAnchor,
  composeCharacterPrompt,
  composeSceneWithCharacter,
  expressionOptions,
  personalityTemplates,
  sanitizeSpec,
  type CharacterSpec,
} from "@/lib/character";

const uncensoredSpec: CharacterSpec = {
  ...DEFAULT_CHARACTER_SPEC,
  nsfwLevel: 3,
  outfit: "Nude",
  expression: "Seductive",
  personality: "Shy, eager to please, blushing easily. Follows a lead and waits to be told what happens next.",
};

describe("age helpers", () => {
  it("clamps ages into the adult band", () => {
    expect(clampAge(25)).toBe(25);
    expect(clampAge(12)).toBe(18);
    expect(clampAge(99)).toBe(80);
    expect(clampAge(Number.NaN)).toBe(25);
    expect(clampAge("30" as unknown as number)).toBe(30);
  });

  it("labels coarse age buckets", () => {
    expect(ageBucketLabel(18)).toBe("Young adult (18–24)");
    expect(ageBucketLabel(30)).toBe("Adult (25–39)");
    expect(ageBucketLabel(45)).toBe("Mature (40–59)");
    expect(ageBucketLabel(70)).toBe("Senior (60+)");
  });
});

describe("merged option tables", () => {
  it("hides adult groups while the gate is off and shows them when on", () => {
    const safe = clothingGroups(false).flatMap((g) => g.options);
    const adult = clothingGroups(true).flatMap((g) => g.options);
    expect(safe).not.toContain("Lingerie");
    expect(adult).toContain("Lingerie");
    expect(adult).toContain("Casual");
  });

  it("gates expressions, body details, accessories and personality templates", () => {
    expect(expressionOptions(false)).not.toContain("Seductive");
    expect(expressionOptions(true)).toContain("Seductive");
    expect(bodyDetailOptions(false)).not.toContain("Wet skin");
    expect(bodyDetailOptions(true)).toContain("Wet skin");
    const safeAccessories = accessoryGroups(false).flatMap((g) => g.options);
    const adultAccessories = accessoryGroups(true).flatMap((g) => g.options);
    expect(safeAccessories).not.toContain("Restraints");
    expect(adultAccessories).toContain("Restraints");
    expect(personalityTemplates(true)).toHaveLength(12);
    expect(personalityTemplates(false)).toHaveLength(6);
  });
});

describe("sanitizeSpec", () => {
  it("clamps adult selections to safe equivalents when the gate is off", () => {
    const safe = sanitizeSpec(uncensoredSpec, false);
    expect(safe.nsfwLevel).toBe(0);
    expect(safe.outfit).toBe("Casual");
    expect(safe.expression).toBe("Neutral");
    expect(safe.personality).toBe("");
  });

  it("keeps adult selections when the gate is on", () => {
    const kept = sanitizeSpec(uncensoredSpec, true);
    expect(kept.nsfwLevel).toBe(3);
    expect(kept.outfit).toBe("Nude");
    expect(kept.expression).toBe("Seductive");
  });

  it("clamps an out-of-range nsfwLevel", () => {
    expect(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, nsfwLevel: 9 }, true).nsfwLevel).toBe(5);
    expect(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, nsfwLevel: -2 }, true).nsfwLevel).toBe(0);
  });

  it("repairs a stale or invalid age", () => {
    expect(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, age: 9 }, true).age).toBe(18);
    expect(
      sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, age: Number.NaN }, true).age,
    ).toBe(25);
  });
});

describe("composeCharacterAnchor", () => {
  it("always frames the character as an adult with an exact age", () => {
    const anchor = composeCharacterAnchor(DEFAULT_CHARACTER_SPEC);
    expect(anchor).toContain("adult 25-year-old woman");
    expect(anchor).toContain("18+");
  });

  it("folds ethnicity and country in only when specified", () => {
    const anchor = composeCharacterAnchor({
      ...DEFAULT_CHARACTER_SPEC,
      ethnicity: "South Asian",
      country: "Bangladesh",
    });
    expect(anchor).toContain("south asian");
    expect(anchor).toContain("from Bangladesh");

    const unspecified = composeCharacterAnchor(DEFAULT_CHARACTER_SPEC);
    expect(unspecified).not.toContain("from");
    expect(unspecified).not.toContain("south asian");
  });

  it("includes identity attributes and outfit", () => {
    const anchor = composeCharacterAnchor({
      ...DEFAULT_CHARACTER_SPEC,
      hairColor: "Auburn",
      hairStyle: "Ponytail",
      build: "Athletic",
      outfit: "Formal",
    });
    expect(anchor).toContain("auburn hair");
    expect(anchor).toContain("wearing formal, fully clothed");
    expect(anchor).toContain("athletic build");
  });

  it("emits nude phrasing for nude outfits and NSFW wording only above level 0", () => {
    const nude = composeCharacterAnchor({ ...uncensoredSpec, personality: "" });
    expect(nude).toContain("nude");
    expect(nude).toContain("NSFW level 3");
    const safe = composeCharacterAnchor(DEFAULT_CHARACTER_SPEC);
    expect(safe).not.toContain("NSFW level");
    expect(safe).toContain("fully clothed");
  });

  it("is stable and does not mention scene or render settings", () => {
    const anchor = composeCharacterAnchor(uncensoredSpec);
    expect(anchor).not.toMatch(/1080|720|aspect|pose|scene|violence/i);
    expect(composeCharacterAnchor(uncensoredSpec)).toBe(anchor);
  });
});

describe("composeCharacterPrompt", () => {
  it("leads with the user prompt and appends the anchor", () => {
    const prompt = composeCharacterPrompt({
      ...DEFAULT_CHARACTER_SPEC,
      prompt: "A warrior queen",
    });
    expect(prompt.startsWith("A warrior queen, ")).toBe(true);
    expect(prompt).toContain("portrait of an adult");
  });

  it("is the anchor alone when the user prompt is empty", () => {
    expect(composeCharacterPrompt(DEFAULT_CHARACTER_SPEC)).toBe(
      composeCharacterAnchor(DEFAULT_CHARACTER_SPEC),
    );
  });
});

describe("composeSceneWithCharacter", () => {
  it("returns the scene untouched without a character", () => {
    expect(composeSceneWithCharacter("a cafe scene", null, false)).toBe("a cafe scene");
  });

  it("prepends a sanitized anchor to the scene prompt", () => {
    const composed = composeSceneWithCharacter("running through rain", uncensoredSpec, true);
    expect(composed.startsWith("portrait of an adult")).toBe(true);
    expect(composed).toContain("nude");
    expect(composed.endsWith("running through rain")).toBe(true);
  });

  it("never leaks adult wording into a safe render", () => {
    const composed = composeSceneWithCharacter("a cafe scene", uncensoredSpec, false);
    expect(composed).not.toMatch(/nude|seductive|lingerie|nsfw/i);
    expect(composed).toContain("a cafe scene");
    expect(composed).toContain("fully clothed");
  });

  it("trims the scene prompt", () => {
    expect(composeSceneWithCharacter("  spaced  ", null, false)).toBe("spaced");
  });
});

describe("characterGenerationSettings", () => {
  it("takes aspect, resolution and model from the params", () => {
    const settings = characterGenerationSettings(
      DEFAULT_CHARACTER_SPEC,
      { aspect: "16:9", resolution: "720p", modelId: "test:model" },
      false,
    );
    expect(settings.aspect).toBe("16:9");
    expect(settings.resolution).toBe("720p");
    expect(settings.modelId).toBe("test:model");
    expect(settings.kind).toBe("image");
    expect(settings.count).toBe(4);
  });

  it("follows the gate for safety, enhancement and the negative prompt", () => {
    const safe = characterGenerationSettings(DEFAULT_CHARACTER_SPEC, { aspect: "9:16", resolution: "1080p" }, false);
    expect(safe.safe).toBe(true);
    expect(safe.enhance).toBe(true);
    expect(safe.negativePrompt).toContain("nude");

    const uncensored = characterGenerationSettings(DEFAULT_CHARACTER_SPEC, { aspect: "9:16", resolution: "1080p" }, true);
    expect(uncensored.safe).toBe(false);
    expect(uncensored.enhance).toBe(false);
    expect(uncensored.negativePrompt).toContain("underage");
    expect(uncensored.negativePrompt).not.toContain("nude,");
  });
});