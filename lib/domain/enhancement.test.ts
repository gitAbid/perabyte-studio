import { describe, expect, it } from "vitest";
import { PROMPT_MAX } from "@/lib/constants";
import {
  deterministicEnhancement,
  enhancementInstruction,
  hasTimeOfDayMention,
  sanitizeEnhancedText,
  timeOfDayFromDate,
} from "@/lib/domain/enhancement";

describe("timeOfDayFromDate", () => {
  it("buckets the local clock into lighting moods", () => {
    const at = (h: number) => new Date(2026, 8, 15, h, 30);
    expect(timeOfDayFromDate(at(6))).toBe("dawn");
    expect(timeOfDayFromDate(at(9))).toBe("morning");
    expect(timeOfDayFromDate(at(14))).toBe("afternoon");
    expect(timeOfDayFromDate(at(18))).toBe("golden hour");
    expect(timeOfDayFromDate(at(20))).toBe("evening");
    expect(timeOfDayFromDate(at(23))).toBe("night");
    expect(timeOfDayFromDate(at(3))).toBe("night");
  });
});

describe("hasTimeOfDayMention", () => {
  it("detects prompts that already set a time", () => {
    expect(hasTimeOfDayMention("a lake at sunset")).toBe(true);
    expect(hasTimeOfDayMention("Neon streets under moonlight")).toBe(true);
    expect(hasTimeOfDayMention("a serene mountain landscape")).toBe(false);
  });
});

describe("enhancementInstruction", () => {
  const prompt = "a serene mountain landscape";

  it("always keeps the subject and the reply-only rule", () => {
    const instruction = enhancementInstruction(prompt, { kind: "image" });
    expect(instruction).toContain(prompt);
    expect(instruction).toContain("no quotes");
  });

  it("includes the style rule only for known, supported presets", () => {
    const withStyle = enhancementInstruction(prompt, {
      kind: "image",
      style: "Cinematic",
      stylesSupported: true,
    });
    expect(withStyle).toContain('"Cinematic"');
    expect(withStyle).toContain("cinematic lighting");

    const unknown = enhancementInstruction(prompt, {
      kind: "image",
      style: "Nonexistent",
      stylesSupported: true,
    });
    expect(unknown).not.toContain('"Nonexistent"');

    const unsupported = enhancementInstruction(prompt, {
      kind: "image",
      style: "Cinematic",
      stylesSupported: false,
    });
    expect(unsupported).not.toContain('"Cinematic"');
  });

  it("uses the video style table for video kind", () => {
    const instruction = enhancementInstruction(prompt, {
      kind: "video",
      style: "Drone",
      stylesSupported: true,
    });
    expect(instruction).toContain("aerial drone shot");
  });

  it("frames story position and clip length", () => {
    const instruction = enhancementInstruction(prompt, {
      kind: "video",
      duration: "10s",
      sceneIndex: 2,
      sceneCount: 4,
    });
    expect(instruction).toContain("scene 2 of a 4-scene story");
    expect(instruction).toContain("10s");
    expect(instruction).toContain("camera movement");
  });

  it("suggests local-time lighting only when the prompt lacks a time", () => {
    const evening = enhancementInstruction(prompt, {
      kind: "image",
      timeOfDay: "evening",
    });
    expect(evening).toContain("evening");

    const alreadyTimed = enhancementInstruction("a beach at sunset", {
      kind: "image",
      timeOfDay: "evening",
    });
    expect(alreadyTimed).not.toContain("local time of day");
  });

  it("passes the negative prompt as an exclusion rule", () => {
    const instruction = enhancementInstruction(prompt, {
      kind: "image",
      negativePrompt: "blurry, watermark",
    });
    expect(instruction).toContain("Avoid anything related to: blurry, watermark");
  });

  it("keeps adult intent when uncensored and skips NSFW negatives", () => {
    const instruction = enhancementInstruction(
      "a nude woman in lingerie, explicit sexual pose",
      {
        kind: "image",
        uncensored: true,
        negativePrompt: "nsfw, nude, blurry, watermark",
      },
    );
    expect(instruction).toContain("Do not sanitize or moralize");
    expect(instruction).toContain("keep adult and explicit content");
    expect(instruction).not.toContain("Avoid anything related to: nsfw");
    expect(instruction).toContain("Avoid anything related to: blurry, watermark");
  });

  it("does not add the uncensored clause in regular mode", () => {
    const instruction = enhancementInstruction("a nude woman", {
      kind: "image",
      uncensored: false,
    });
    expect(instruction).not.toContain("Do not sanitize or moralize");
  });
});

describe("sanitizeEnhancedText", () => {
  it("strips quotes, fences and labels", () => {
    expect(sanitizeEnhancedText('"A rich mountain scene."', "a mountain")).toBe(
      "A rich mountain scene.",
    );
    expect(
      sanitizeEnhancedText("```\nA rich mountain scene.\n```", "a mountain"),
    ).toBe("A rich mountain scene.");
    expect(
      sanitizeEnhancedText("Prompt: A rich mountain scene.", "a mountain"),
    ).toBe("A rich mountain scene.");
  });

  it("collapses multi-line replies into one prompt block", () => {
    expect(sanitizeEnhancedText("Line one,\nLine two.", "a mountain")).toBe(
      "Line one, Line two.",
    );
  });

  it("rejects empty replies and refusals", () => {
    expect(sanitizeEnhancedText("   ", "a mountain")).toBeNull();
    expect(sanitizeEnhancedText("I'm sorry, I cannot help.", "a mountain")).toBeNull();
  });

  it("rejects a reply that just echoes the original", () => {
    expect(sanitizeEnhancedText("A serene mountain landscape", "A serene mountain landscape")).toBeNull();
  });

  it("caps runaway replies at the prompt limit", () => {
    const huge = "x".repeat(3000);
    const result = sanitizeEnhancedText(huge, "a mountain", 1000);
    expect(result).not.toBeNull();
    expect((result as string).length).toBeLessThanOrEqual(1000);
  });

  it("defaults the cap to the studio prompt budget and lets the context override it", () => {
    const instruction = enhancementInstruction("a mountain", {
      kind: "image",
      maxChars: 2400,
    });
    expect(instruction).toContain("under 2400 characters");
    const huge = "x".repeat(3000);
    const result = sanitizeEnhancedText(huge, "a mountain");
    expect(result).not.toBeNull();
    expect((result as string).length).toBeLessThanOrEqual(PROMPT_MAX);
  });
});

describe("deterministicEnhancement", () => {
  it("uses the canonical style descriptor for known presets", () => {
    const result = deterministicEnhancement("a quiet harbor", {
      kind: "image",
      style: "South Asian",
      stylesSupported: true,
    });
    expect(result).toContain("south asian aesthetic");
  });

  it("adds a lighting clause fitting the local time", () => {
    const result = deterministicEnhancement("a quiet harbor", {
      kind: "image",
      timeOfDay: "evening",
    });
    expect(result).toContain("warm dusk light");
  });

  it("skips the lighting clause when the prompt sets its own time", () => {
    const result = deterministicEnhancement("a quiet harbor at midnight", {
      kind: "image",
      timeOfDay: "morning",
    });
    expect(result).not.toContain("light");
  });

  it("is idempotent — enhancing twice changes nothing", () => {
    const ctx = { kind: "image" as const, style: "Anime", stylesSupported: true };
    const once = deterministicEnhancement("a quiet harbor", ctx);
    const twice = deterministicEnhancement(once, ctx);
    expect(twice).toBe(once);
  });

  it("ignores style entirely for styleless models", () => {
    const result = deterministicEnhancement("a quiet harbor", {
      kind: "image",
      style: "Anime",
      stylesSupported: false,
    });
    expect(result).toContain("highly detailed, balanced composition");
    expect(result).not.toContain("anime");
  });
});
