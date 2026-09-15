import { describe, expect, it } from "vitest";
import type { FrameImage, NormalizedGenerationRequest } from "@/lib/domain/models";
import {
  PROVIDER_ID,
  SOGNI_IMAGE_MODELS,
  SOGNI_VIDEO_MODELS,
  toImageParams,
  toVideoParams,
} from "@/lib/providers/sogni/request-maps";

function imageRequest(overrides: Partial<NormalizedGenerationRequest> = {}) {
  return {
    kind: "image" as const,
    prompt: "a fox in a garden",
    negativePrompt: "",
    aspect: "16:9" as const,
    resolution: "1080p" as const,
    durationSeconds: 0,
    count: 1,
    seed: 42,
    safe: true,
    enhance: false,
    ...overrides,
  };
}

function videoRequest(overrides: Partial<NormalizedGenerationRequest> = {}) {
  return imageRequest({ kind: "video", durationSeconds: 5, ...overrides });
}

describe("sogni request maps", () => {
  it("exposes the curated model catalog", () => {
    expect(SOGNI_IMAGE_MODELS.map((m) => m.id)).toEqual([
      `${PROVIDER_ID}:krea2_turbo_fp8_scaled`,
      `${PROVIDER_ID}:flux1-schnell-fp8`,
      `${PROVIDER_ID}:z_image_turbo_bf16`,
      `${PROVIDER_ID}:chroma1-hd_fp8_scaled`,
    ]);
    expect(SOGNI_VIDEO_MODELS.map((m) => m.id)).toEqual([
      `${PROVIDER_ID}:wan_v2.2-14b-fp8_t2v_lightx2v`,
      `${PROVIDER_ID}:ltx25-22b-int8_t2v_distilled`,
      `${PROVIDER_ID}:seedance-2-0-mini`,
      `${PROVIDER_ID}:seedance-2-0`,
    ]);
  });

  describe("toImageParams", () => {
    it("maps the neutral request onto Sogni's project params", () => {
      const model = SOGNI_IMAGE_MODELS[0];
      const params = toImageParams(model.model, imageRequest({ count: 2, safe: false }));

      expect(params).toEqual({
        type: "image",
        modelId: "krea2_turbo_fp8_scaled",
        positivePrompt: "a fox in a garden",
        negativePrompt: undefined,
        numberOfMedia: 2,
        seed: 42,
        disableNSFWFilter: true,
        sizePreset: "custom",
        width: 1280,
        height: 720,
        outputFormat: "png",
      });
    });

    it("derives 8-aligned pixel sizes from aspect × resolution", () => {
      const model = SOGNI_IMAGE_MODELS[1];
      // 16:9 base 1280×720 at 0.75 scale → 960×540 → snapped to 960×544.
      const params = toImageParams(
        model.model,
        imageRequest({ resolution: "720p" }),
      );
      expect(params.width).toBe(960);
      expect(params.height).toBe(544);
      expect(params.width! % 8).toBe(0);
      expect(params.height! % 8).toBe(0);
    });

    it("clamps the seed into Uint32 range", () => {
      const model = SOGNI_IMAGE_MODELS[2];
      const params = toImageParams(model.model, imageRequest({ seed: 5_000_000_000 }));
      expect(params.seed).toBeGreaterThanOrEqual(0);
      expect(params.seed).toBeLessThanOrEqual(0xffffffff);
    });
  });

  describe("toVideoParams", () => {
    it("flags provider-workflow models as styleless", () => {
      const seedance = SOGNI_VIDEO_MODELS.find((m) => m.model === "seedance-2-0-mini");
      expect(seedance?.stylesSupported).toBe(false);
      const wan = SOGNI_VIDEO_MODELS.find((m) => m.model.startsWith("wan"));
      expect(wan?.stylesSupported).toBeUndefined();
    });

    it("passes the negative prompt through for models that accept one", () => {
      const model = SOGNI_VIDEO_MODELS[0];
      const params = toVideoParams(
        model.model,
        videoRequest({ negativePrompt: "blurry", aspect: "9:16" }),
      );
      expect(params.negativePrompt).toBe("blurry");
      expect(params.ratio).toBe("9:16");
      expect(params.duration).toBe(5);
      expect(params.outputFormat).toBe("mp4");
    });

    it("folds the negative prompt into the prompt for Seedance", () => {
      const model = SOGNI_VIDEO_MODELS[2];
      const params = toVideoParams(
        model.model,
        videoRequest({ prompt: "a slow pan", negativePrompt: "text overlay" }),
      );
      expect(params.negativePrompt).toBeUndefined();
      expect(params.positivePrompt).toContain("a slow pan");
      expect(params.positivePrompt).toContain("Avoid: text overlay");
    });

    it("clamps duration to each model family's range and maps aspect to ratios", () => {
      const wan = SOGNI_VIDEO_MODELS[0].model;
      expect(toVideoParams(wan, videoRequest({ durationSeconds: 0 })).duration).toBe(1);
      expect(toVideoParams(wan, videoRequest({ durationSeconds: 30 })).duration).toBe(10);

      const ltx = SOGNI_VIDEO_MODELS[1].model;
      expect(toVideoParams(ltx, videoRequest({ durationSeconds: 1 })).duration).toBe(2);
      expect(toVideoParams(ltx, videoRequest({ durationSeconds: 30 })).duration).toBe(20);

      const seedance = SOGNI_VIDEO_MODELS[2].model;
      expect(toVideoParams(seedance, videoRequest({ durationSeconds: 3 })).duration).toBe(4);

      expect(toVideoParams(wan, videoRequest({ aspect: "4:5" })).ratio).toBe("3:4");
      expect(toVideoParams(wan, videoRequest({ aspect: "3:2" })).ratio).toBe("4:3");
    });

    it("lifts a MiniMax H3 request to its 124-frame floor (regression: 5s was rejected)", () => {
      // Server rule: frames must land on `124 + n*17` at 24fps, so anything
      // under 124/24 ≈ 5.167s dies with "Video duration must greater or
      // equal 5.166…" / an off-grid frame count.
      const minimax = "minimax-h3-fl2va-fp8_t2v";
      const params = toVideoParams(minimax, videoRequest({ durationSeconds: 5 }));
      expect(params.duration).toBeCloseTo(124 / 24, 10);
      expect(toVideoParams(minimax, videoRequest({ durationSeconds: 20 })).duration).toBeCloseTo(
        362 / 24,
        10,
      );
    });

    it("clamps HappyHorse to its 3–15s window and Seedance 2.5 to 30s", () => {
      expect(toVideoParams("happyhorse-1.1-t2v", videoRequest({ durationSeconds: 2 })).duration).toBe(3);
      expect(toVideoParams("happyhorse-1.1-t2v", videoRequest({ durationSeconds: 20 })).duration).toBe(15);
      expect(toVideoParams("seedance-2-5", videoRequest({ durationSeconds: 40 })).duration).toBe(30);
    });

    it("folds the negative prompt for MiniMax H3 (no negative input)", () => {
      const params = toVideoParams(
        "minimax-h3-fl2va-fp8_t2v",
        videoRequest({ prompt: "a slow pan", negativePrompt: "text overlay" }),
      );
      expect(params.negativePrompt).toBeUndefined();
      expect(params.positivePrompt).toContain("Avoid: text overlay");
    });

    it("sends MiniMax H3 dimensions on the 32px grid within its pixel caps", () => {
      const params = toVideoParams(
        "minimax-h3-fl2va-fp8_t2v",
        videoRequest({ aspect: "16:9", resolution: "1080p" }),
      );
      expect(params.width).toBeDefined();
      expect(params.height).toBeDefined();
      expect(params.width! % 32).toBe(0);
      expect(params.height! % 32).toBe(0);
      expect(params.width! * params.height!).toBeLessThanOrEqual(1_032_192);
      expect(Math.max(params.width!, params.height!)).toBeLessThanOrEqual(1344);
      // Other families take no explicit dimensions.
      const wan = toVideoParams(
        SOGNI_VIDEO_MODELS[0].model,
        videoRequest({ aspect: "16:9", resolution: "1080p" }),
      );
      expect(wan.width).toBeUndefined();
      expect(wan.height).toBeUndefined();
    });
  });
});

describe("continuity frames", () => {
  const FRAME: FrameImage = { bytes: Buffer.from("frame-bytes"), contentType: "image/png" };

  it("video params carry referenceImage and referenceImageEnd", () => {
    const params = toVideoParams("wan_v2.2-14b-fp8_i2v_lightx2v", videoRequest({
      startImage: FRAME,
      endImage: FRAME,
    }));
    expect(params.referenceImage).toBe(FRAME.bytes);
    expect(params.referenceImageEnd).toBe(FRAME.bytes);
  });

  it("video params omit frames when absent", () => {
    const params = toVideoParams("wan_v2.2-14b-fp8_t2v_lightx2v", videoRequest());
    expect(params.referenceImage).toBeUndefined();
    expect(params.referenceImageEnd).toBeUndefined();
    expect(params.returnLastFrame).toBeUndefined();
  });

  it("seedance 2.5 asks for the exact last frame", () => {
    const params = toVideoParams("seedance-2-5", videoRequest());
    expect(params.returnLastFrame).toBe(true);
  });

  it("other models never set returnLastFrame", () => {
    expect(toVideoParams("ltx25-22b-int8_i2v_distilled", videoRequest()).returnLastFrame).toBeUndefined();
  });

  it("image params carry startingImage", () => {
    const params = toImageParams("krea2_turbo_fp8_scaled", imageRequest({ startImage: FRAME }));
    expect(params.startingImage).toBe(FRAME.bytes);
  });

  it("image params omit startingImage when absent", () => {
    expect(toImageParams("krea2_turbo_fp8_scaled", imageRequest()).startingImage).toBeUndefined();
  });
});

describe("lora adapters", () => {
  it("splits selections into positionally matched loras/loraStrengths", () => {
    const params = toImageParams(
      "krea2_turbo_fp8_scaled",
      imageRequest({
        loras: [
          { loraId: "krea2-detail-enhancer", strength: 2 },
          { loraId: "krea2-realism", strength: -1.5 },
        ],
      }),
    );
    expect(params.loras).toEqual(["krea2-detail-enhancer", "krea2-realism"]);
    expect(params.loraStrengths).toEqual([2, -1.5]);
  });

  it("slices to Sogni's 8-per-render cap", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      loraId: `lora-${i}`,
      strength: 1,
    }));
    const params = toImageParams("krea2_turbo_fp8_scaled", imageRequest({ loras: twelve }));
    expect(params.loras).toHaveLength(8);
    expect(params.loraStrengths).toHaveLength(8);
  });

  it("omits the fields when no selections ride the request", () => {
    const params = toImageParams("krea2_turbo_fp8_scaled", imageRequest());
    expect(params.loras).toBeUndefined();
    expect(params.loraStrengths).toBeUndefined();
  });

  it("video params carry them the same way (MiniMax H3 families)", () => {
    const params = toVideoParams(
      "minimax-h3-fl2va-fp8_t2v",
      videoRequest({ loras: [{ loraId: "h3-better-motion", strength: 0.6 }] }),
    );
    expect(params.loras).toEqual(["h3-better-motion"]);
    expect(params.loraStrengths).toEqual([0.6]);
  });
});
