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
  composeSceneWithCharacters,
  MAX_SCENE_CHARACTERS,
  SHEET_CHAIN_LEAD,
  SHEET_VIEWS,
  characterSheetSettings,
  composeSheetPrompt,
  expressionOptions,
  personalityTemplates,
  sanitizeSpec,
  sheetViewById,
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

describe("composeSceneWithCharacters", () => {
  it("returns the scene untouched with an empty cast", () => {
    expect(composeSceneWithCharacters("a cafe scene", [], false)).toBe("a cafe scene");
    expect(composeSceneWithCharacters("a cafe scene", [null], false)).toBe("a cafe scene");
  });

  it("delegates to the single-character anchor for one entry", () => {
    const composed = composeSceneWithCharacters(
      "running through rain",
      [DEFAULT_CHARACTER_SPEC],
      false,
    );
    expect(composed).toBe(composeSceneWithCharacter("running through rain", DEFAULT_CHARACTER_SPEC, false));
    expect(composed.startsWith("portrait of an adult")).toBe(true);
  });

  it("labels each cast member so the model keeps subjects distinct", () => {
    const a = { ...DEFAULT_CHARACTER_SPEC, hairColor: "Black" };
    const b = { ...DEFAULT_CHARACTER_SPEC, hairColor: "Blonde" };
    const composed = composeSceneWithCharacters("sharing coffee", [a, b], false);
    expect(composed).toContain("Scene with two characters.");
    expect(composed).toMatch(/First: an adult 25-year-old/);
    expect(composed).toContain("Second: an adult");
    expect(composed).toContain("black hair");
    expect(composed).toContain("blonde hair");
    expect(composed.endsWith("sharing coffee")).toBe(true);
    // No singular "portrait of" lead when the cast has more than one person.
    expect(composed).not.toContain("portrait of");
  });

  it("sanitizes every member against the gate", () => {
    const composed = composeSceneWithCharacters(
      "a cafe scene",
      [uncensoredSpec, uncensoredSpec],
      false,
    );
    expect(composed).not.toMatch(/nude|seductive|nsfw/i);
    expect(composed).toContain("fully clothed");
  });

  it("caps the cast and tolerates null entries", () => {
    const three = Array.from({ length: 3 }, () => DEFAULT_CHARACTER_SPEC);
    const capped = composeSceneWithCharacters(
      "one scene",
      [...three, DEFAULT_CHARACTER_SPEC, null, undefined],
      false,
    );
    const labels = ["First:", "Second:", "Third:"].filter((label) =>
      capped.includes(label),
    );
    expect(labels).toHaveLength(MAX_SCENE_CHARACTERS);
    expect(capped).toContain("Scene with three characters.");
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
    expect(settings).not.toHaveProperty("loras");
  });

  it("carries LoRA selections through when present", () => {
    const loras = [{ loraId: "mystic-x", strength: 80 }];
    const settings = characterGenerationSettings(
      DEFAULT_CHARACTER_SPEC,
      { aspect: "9:16", resolution: "1080p", loras },
      true,
    );
    expect(settings.loras).toEqual(loras);
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
/* ------------------------------------------------------------------ */
/* Freeform (Simple mode) identity                                     */
/* ------------------------------------------------------------------ */

describe("freeform specs", () => {
  const freeform: CharacterSpec = {
    ...DEFAULT_CHARACTER_SPEC,
    freeform: true,
    prompt: "A teal-haired courier with a chrome helmet",
  };

  it("renders the raw prompt alone — no defaulted anchor fields", () => {
    const composed = composeCharacterPrompt(freeform);
    expect(composed).toBe("A teal-haired courier with a chrome helmet");
    expect(composed).not.toContain("25-year-old");
    expect(composed).not.toContain("portrait of");
  });

  it("uses the prompt as the reuse anchor so scenes keep the identity", () => {
    const scene = composeSceneWithCharacter("walking through a market", freeform, true);
    expect(scene).toBe("A teal-haired courier with a chrome helmet, walking through a market");
  });

  it("labels freeform members in multi-character scenes", () => {
    const second: CharacterSpec = {
      ...DEFAULT_CHARACTER_SPEC,
      prompt: "A broad-shouldered blacksmith",
    };
    const scene = composeSceneWithCharacters("a workshop", [freeform, second], true);
    expect(scene).toContain("First: A teal-haired courier with a chrome helmet");
    expect(scene).toContain("Second: an adult 25-year-old woman");
  });

  it("composes to empty when the freeform prompt is empty (render is gated on a prompt)", () => {
    expect(composeCharacterPrompt({ ...freeform, prompt: "  " })).toBe("");
  });

  it("passes freeform through sanitizeSpec untouched", () => {
    expect(sanitizeSpec(freeform, false).freeform).toBe(true);
    expect(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC }, true).freeform).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Character sheet views                                               */
/* ------------------------------------------------------------------ */

describe("character sheet", () => {
  it("has six ordered views with Full Front first as the identity base", () => {
    expect(SHEET_VIEWS.map((view) => view.id)).toEqual([
      "front",
      "back",
      "face",
      "chest",
      "hip",
      "butt",
    ]);
    expect(SHEET_VIEWS[0].kind).toBe("full");
    expect(SHEET_VIEWS.slice(1).every((view) => view.framing.length > 0)).toBe(true);
  });

  it("composes identity + framing for an unchained view", () => {
    const prompt = composeSheetPrompt(DEFAULT_CHARACTER_SPEC, SHEET_VIEWS[0], false);
    expect(prompt).toContain("portrait of an adult 25-year-old woman");
    expect(prompt).toContain("full body character design sheet, standing front view");
    expect(prompt).not.toContain(SHEET_CHAIN_LEAD);
  });

  it("leads chained views with the reference instruction", () => {
    const prompt = composeSheetPrompt(DEFAULT_CHARACTER_SPEC, sheetViewById("face")!, true);
    expect(prompt.startsWith(`${SHEET_CHAIN_LEAD}, `)).toBe(true);
    expect(prompt).toContain("close-up portrait of the face");
  });

  it("uses the raw prompt for freeform characters", () => {
    const spec = { ...DEFAULT_CHARACTER_SPEC, freeform: true, prompt: "A punk drummer" };
    expect(composeSheetPrompt(spec, sheetViewById("hip")!, false)).toContain("A punk drummer");
    expect(composeSheetPrompt(spec, sheetViewById("hip")!, false)).not.toContain("25-year-old");
  });

  it("renders one image per view, square for close-ups", () => {
    const front = characterSheetSettings(
      DEFAULT_CHARACTER_SPEC,
      sheetViewById("front")!,
      { aspect: "4:5", resolution: "720p" },
      true,
    );
    expect(front.count).toBe(1);
    expect(front.aspect).toBe("4:5");
    expect(front.kind).toBe("image");

    const face = characterSheetSettings(
      DEFAULT_CHARACTER_SPEC,
      sheetViewById("face")!,
      { aspect: "4:5", resolution: "720p" },
      true,
    );
    expect(face.count).toBe(1);
    expect(face.aspect).toBe("1:1");
  });

  it("follows the gate for sheet views exactly like the single render", () => {
    const safe = characterSheetSettings(
      DEFAULT_CHARACTER_SPEC,
      sheetViewById("butt")!,
      { aspect: "9:16", resolution: "720p" },
      false,
    );
    expect(safe.safe).toBe(true);
    expect(safe.negativePrompt).toContain("nsfw");

    const uncensored = characterSheetSettings(
      DEFAULT_CHARACTER_SPEC,
      sheetViewById("butt")!,
      { aspect: "9:16", resolution: "720p" },
      true,
    );
    expect(uncensored.safe).toBe(false);
  });

  it("keeps LoRA selections on sheet views", () => {
    const loras = [{ loraId: "mystic-x", strength: 80 }];
    const settings = characterSheetSettings(
      DEFAULT_CHARACTER_SPEC,
      sheetViewById("front")!,
      { aspect: "9:16", resolution: "720p", loras },
      true,
    );
    expect(settings.loras).toEqual(loras);
  });
});
