import { describe, expect, it } from "vitest";
import {
  MODERATION_CONFIDENCE_THRESHOLD,
  effectiveSensitive,
  isModerationVerdict,
  mediaRefFromSrc,
  parseVerdictReply,
} from "@/lib/domain/moderation";

const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";

describe("parseVerdictReply", () => {
  it("parses a clean verdict", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: true, category: "nudity", confidence: 0.9, reason: "exposed breasts" }),
      MODEL,
    );
    expect(verdict).toMatchObject({ sensitive: true, category: "nudity", confidence: 0.9 });
    expect(verdict?.model).toBe(MODEL);
    expect(verdict?.uncertain).toBeUndefined();
  });

  it("parses fenced and prose-wrapped JSON", () => {
    const fenced = "```json\n{\"sensitive\":false,\"category\":null,\"confidence\":0.8,\"reason\":\"clothed\"}\n```";
    expect(parseVerdictReply(fenced, MODEL)?.sensitive).toBe(false);
    const prose = 'Sure! {"sensitive":false,"category":null,"confidence":0.8,"reason":"clothed"} hope that helps';
    expect(parseVerdictReply(prose, MODEL)?.reason).toBe("clothed");
  });

  it("returns null for junk, missing fields, or bad confidence", () => {
    expect(parseVerdictReply("not json at all", MODEL)).toBeNull();
    expect(parseVerdictReply('{"confidence":0.9,"reason":"x"}', MODEL)).toBeNull(); // no sensitive
    expect(parseVerdictReply('{"sensitive":true,"confidence":"high","reason":"x"}', MODEL)).toBeNull();
    expect(parseVerdictReply('{"sensitive":true,"reason":"x"}', MODEL)).toBeNull(); // no confidence
  });

  it("clamps confidence and trims long reasons", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: true, category: "weird", confidence: 1.5, reason: "r".repeat(500) }),
      MODEL,
    );
    expect(verdict?.confidence).toBe(1);
    expect(verdict?.category).toBeNull(); // unknown category → null
    expect(verdict?.reason).toHaveLength(200);
  });

  it("flags the gray zone below the confidence threshold", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: false, category: null, confidence: 0.3, reason: "unsure" }),
      MODEL,
    );
    expect(verdict?.uncertain).toBe(true);
    expect(MODERATION_CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});

describe("isModerationVerdict", () => {
  it("accepts verdicts and rejects junk when loading from disk", () => {
    const good = parseVerdictReply('{"sensitive":true,"category":null,"confidence":0.9,"reason":"x"}', MODEL);
    expect(isModerationVerdict(good)).toBe(true);
    expect(isModerationVerdict({ sensitive: "yes" })).toBe(false);
    expect(isModerationVerdict(null)).toBe(false);
  });
});

describe("effectiveSensitive", () => {
  it("lets a confident verdict override the static flag both ways", () => {
    const sensitive = { sensitive: true, category: "nudity" as const, confidence: 0.9, reason: "", model: MODEL, createdAt: 1 };
    const safe = { ...sensitive, sensitive: false };
    expect(effectiveSensitive(false, sensitive)).toBe(true);
    expect(effectiveSensitive(true, safe)).toBe(false);
  });

  it("keeps the static flag when there is no verdict or it is uncertain", () => {
    expect(effectiveSensitive(true, null)).toBe(true);
    expect(effectiveSensitive(false, undefined)).toBe(false);
    const gray = { sensitive: false, category: null, confidence: 0.3, reason: "", model: MODEL, createdAt: 1, uncertain: true };
    expect(effectiveSensitive(true, gray)).toBe(true);
    expect(effectiveSensitive(false, gray)).toBe(false);
  });
});

describe("mediaRefFromSrc", () => {
  const REF = "a".repeat(64);

  it("extracts the cache ref from served media srcs", () => {
    expect(mediaRefFromSrc(`/api/media?f=${REF}.png`)).toBe(`${REF}.png`);
    expect(mediaRefFromSrc(`/api/media?download=1&f=${REF}.jpg`)).toBe(`${REF}.jpg`);
  });

  it("returns null for provider URLs, public assets, and non-refs", () => {
    expect(mediaRefFromSrc("/api/media?u=https%3A%2F%2Fimage.pollinations.ai%2Fx")).toBeNull();
    expect(mediaRefFromSrc("/demo/hero.png")).toBeNull();
    expect(mediaRefFromSrc("/api/media?f=not-a-ref.png")).toBeNull();
    expect(mediaRefFromSrc(null)).toBeNull();
  });
});
