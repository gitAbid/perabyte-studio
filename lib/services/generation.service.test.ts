import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMPT_HARD_MAX } from "@/lib/constants";
import { logger } from "@/lib/logging/logger";
import { resetLoraCatalogCache } from "@/lib/providers/sogni/lora-catalog";
import {
  GenerationServiceError,
  resolveLoras,
  validateGenerationRequest,
} from "@/lib/services/generation.service";

function baseBody(): Record<string, unknown> {
  return {
    kind: "image",
    prompt: "a serene mountain lake",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    duration: "5s",
    count: 2,
  };
}

describe("validateGenerationRequest", () => {
  it("accepts a well-formed request and applies defaults", () => {
    const request = validateGenerationRequest(baseBody());
    expect(request.kind).toBe("image");
    expect(request.safe).toBe(true);
    expect(request.enhance).toBe(true);
    expect(request.modelId).toBeNull();
    expect(request.seed).toBeNull();
  });

  it("rejects an empty prompt with a field marker", () => {
    expect(() => validateGenerationRequest({ ...baseBody(), prompt: "  " })).toThrowError(
      GenerationServiceError,
    );
    try {
      validateGenerationRequest({ ...baseBody(), prompt: "" });
    } catch (error) {
      expect((error as GenerationServiceError).field).toBe("prompt");
    }
  });

  it("accepts an authored scene prompt past the 1000-char budget, up to the hard ceiling", () => {
    // Divider-authored story scenes are kept verbatim and may run past the
    // old PROMPT_MAX budget; the server only rejects truly oversized prompts.
    const overBudget = "x".repeat(1047);
    expect(() => validateGenerationRequest({ ...baseBody(), prompt: overBudget })).not.toThrow();
    const atCeiling = validateGenerationRequest({
      ...baseBody(),
      prompt: "x".repeat(PROMPT_HARD_MAX),
    });
    expect(atCeiling.rawPrompt.length).toBe(PROMPT_HARD_MAX);
  });

  it("rejects a prompt beyond the hard ceiling", () => {
    expect(() =>
      validateGenerationRequest({ ...baseBody(), prompt: "x".repeat(PROMPT_HARD_MAX + 1) }),
    ).toThrowError(/limited to/);
  });

  it("rejects unknown aspect ratios, resolutions and durations", () => {
    expect(() => validateGenerationRequest({ ...baseBody(), aspect: "21:9" })).toThrowError(
      GenerationServiceError,
    );
    expect(() =>
      validateGenerationRequest({ ...baseBody(), resolution: "8K" }),
    ).toThrowError(GenerationServiceError);
    expect(() => validateGenerationRequest({ ...baseBody(), duration: "30s" })).toThrowError(
      GenerationServiceError,
    );
  });

  it("clamps an unknown or stale style to the kind's default instead of failing", () => {
    // Garbage style falls back to the image default.
    expect(validateGenerationRequest({ ...baseBody(), style: "Nope" }).style).toBe("Realistic");
    // A stale image style must not fail a video render.
    expect(
      validateGenerationRequest({ ...baseBody(), kind: "video", style: "Realistic" }).style,
    ).toBe("Cinematic");
    // A video request without a style defaults to "Cinematic".
    expect(
      validateGenerationRequest({ ...baseBody(), kind: "video", style: undefined }).style,
    ).toBe("Cinematic");
  });

  it("clamps the variant count and parses string seeds", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      count: 99,
      seed: "4821",
    });
    expect(request.count).toBe(4);
    expect(request.seed).toBe(4821);
  });

  it("carries an explicit uncensored request as safe:false", () => {
    const request = validateGenerationRequest({ ...baseBody(), safe: false });
    expect(request.safe).toBe(false);
  });

  it("keeps a chosen model id", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      modelId: "apikey-fan:grok-imagine-image-2.0",
    });
    expect(request.modelId).toBe("apikey-fan:grok-imagine-image-2.0");
  });
});

describe("validateGenerationRequest — loras", () => {
  it("keeps well-formed selections in order", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      loras: [
        { loraId: "krea2-warm-light", strength: 2 },
        { loraId: "krea2-realism", strength: -1 },
      ],
    });
    expect(request.loras).toEqual([
      { loraId: "krea2-warm-light", strength: 2 },
      { loraId: "krea2-realism", strength: -1 },
    ]);
  });

  it("drops malformed entries instead of failing the render", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      loras: [
        { loraId: "krea2-warm-light", strength: 2 },
        null,
        "nope",
        { strength: 3 },
        { loraId: "krea2-realism", strength: "x" },
      ],
    });
    expect(request.loras).toEqual([
      { loraId: "krea2-warm-light", strength: 2 },
      { loraId: "krea2-realism", strength: 1 },
    ]);
  });

  it("clamps extreme strengths to the hard loader bounds", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      loras: [{ loraId: "krea2-warm-light", strength: 9000 }],
    });
    expect(request.loras[0].strength).toBe(100);
  });

  it("caps the stack at eight and de-duplicates ids (first position wins)", () => {
    const request = validateGenerationRequest({
      ...baseBody(),
      loras: [
        ...Array.from({ length: 10 }, (_, i) => ({ loraId: `lora-${i}`, strength: 1 })),
        { loraId: "lora-0", strength: 5 },
      ],
    });
    expect(request.loras).toHaveLength(8);
    expect(request.loras[0]).toEqual({ loraId: "lora-0", strength: 1 });
  });

  it("defaults to an empty list when loras is absent or not an array", () => {
    expect(validateGenerationRequest(baseBody()).loras).toEqual([]);
    expect(validateGenerationRequest({ ...baseBody(), loras: "warm" }).loras).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* resolveLoras — the pre-submit catalog gate                          */
/* ------------------------------------------------------------------ */

const GATE_FIXTURE = {
  status: "success",
  data: {
    loras: [
      {
        loraId: "krea2-mystic-x",
        name: "Mystic X",
        ui: { min: 0, max: 2, default: 1, step: 0.1, nsfw: true, sexual: true },
        modelIds: ["krea2_turbo_fp8_scaled"],
      },
      {
        loraId: "krea2-realism",
        name: "Realism",
        ui: { min: -2, max: 2, default: 1, step: 0.1, nsfw: false, sexual: false },
        modelIds: ["krea2_turbo_fp8_scaled"],
      },
      {
        loraId: "h3-mystic-xxx-v4",
        name: "H3 Mystic",
        ui: { min: 0, max: 1, default: 1, step: 0.1, nsfw: true, sexual: true },
        modelIds: ["minimax-h3-fl2va-fp8_i2v"],
      },
    ],
    models: ["krea2_turbo_fp8_scaled", "minimax-h3-fl2va-fp8_i2v"],
    constraints: { maxPerRequest: 8 },
  },
};

function mockCatalogFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(GATE_FIXTURE),
    }),
  );
}

describe("resolveLoras", () => {
  afterEach(() => {
    resetLoraCatalogCache();
    vi.unstubAllGlobals();
  });

  it("keeps nsfw adapters on an uncensored request (safe:false)", async () => {
    mockCatalogFetch();
    const kept = await resolveLoras(
      [
        { loraId: "krea2-mystic-x", strength: 0.8 },
        { loraId: "krea2-realism", strength: 1 },
      ],
      "krea2_turbo_fp8_scaled",
      false,
      logger,
    );
    expect(kept.map((l) => l.loraId)).toEqual(["krea2-mystic-x", "krea2-realism"]);
  });

  it("strips nsfw adapters from a sensored request (safe:true)", async () => {
    mockCatalogFetch();
    const kept = await resolveLoras(
      [
        { loraId: "krea2-mystic-x", strength: 0.8 },
        { loraId: "krea2-realism", strength: 1 },
      ],
      "krea2_turbo_fp8_scaled",
      true,
      logger,
    );
    expect(kept.map((l) => l.loraId)).toEqual(["krea2-realism"]);
  });

  it("strips adapters the model doesn't list regardless of the gate", async () => {
    mockCatalogFetch();
    const kept = await resolveLoras(
      [
        { loraId: "krea2-mystic-x", strength: 0.8 },
        { loraId: "h3-mystic-xxx-v4", strength: 1 },
      ],
      "krea2_turbo_fp8_scaled",
      false,
      logger,
    );
    expect(kept.map((l) => l.loraId)).toEqual(["krea2-mystic-x"]);
  });

  it("strips everything when the catalog is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const kept = await resolveLoras(
      [{ loraId: "krea2-realism", strength: 1 }],
      "krea2_turbo_fp8_scaled",
      false,
      logger,
    );
    expect(kept).toEqual([]);
  });
});
