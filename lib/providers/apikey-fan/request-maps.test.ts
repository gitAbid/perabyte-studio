import { describe, expect, it } from "vitest";
import type { FrameImage } from "@/lib/domain/models";
import {
  APIKEY_FAN_IMAGE_MODELS,
  APIKEY_FAN_VIDEO_MODELS,
  MAX_VIDEO_SECONDS,
  foldNegativePrompt,
  frameToDataUri,
  toImageEditsPayload,
  toImagePayload,
  toVideoPayload,
} from "@/lib/providers/apikey-fan/request-maps";

describe("foldNegativePrompt", () => {
  it("appends an avoidance clause when a negative prompt exists", () => {
    expect(foldNegativePrompt("a mountain lake", "blurry, watermark")).toBe(
      "a mountain lake. Avoid: blurry, watermark.",
    );
  });

  it("leaves the prompt untouched without a negative", () => {
    expect(foldNegativePrompt("a mountain lake", "")).toBe("a mountain lake");
    expect(foldNegativePrompt("a mountain lake", "   ")).toBe("a mountain lake");
  });
});

describe("toImagePayload", () => {
  it("maps aspect and resolution onto image_config with b64 output", () => {
    const { payload } = toImagePayload("grok-imagine-image-2.0", {
      prompt: "a portrait",
      count: 2,
      aspect: "9:16",
      resolution: "1080p",
    });
    expect(payload).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "a portrait",
      n: 2,
      response_format: "b64_json",
      image_config: { aspect_ratio: "9:16", resolution: "1k" },
    });
  });

  it("maps 1440p and 4K onto the 2k tier", () => {
    for (const resolution of ["1440p", "4K"] as const) {
      const { payload } = toImagePayload("m", {
        prompt: "p",
        count: 1,
        aspect: "16:9",
        resolution,
      });
      expect((payload.image_config as Record<string, unknown>).resolution).toBe("2k");
    }
  });

  it("clamps the variant count into the provider's range", () => {
    const { payload } = toImagePayload("m", {
      prompt: "p",
      count: 99,
      aspect: "1:1",
      resolution: "720p",
    });
    expect(payload.n).toBe(10);
  });

  it("keeps a fallback payload without image_config for strict providers", () => {
    const { fallbackPayload } = toImagePayload("m", {
      prompt: "p",
      count: 1,
      aspect: "16:9",
      resolution: "1080p",
    });
    expect(fallbackPayload).not.toHaveProperty("image_config");
    expect(fallbackPayload.response_format).toBe("b64_json");
  });
});

describe("toVideoPayload", () => {
  it("carries the duration and model", () => {
    expect(
      toVideoPayload("grok-imagine-video-1.5", { prompt: "waves", durationSeconds: 8 }),
    ).toEqual({ model: "grok-imagine-video-1.5", prompt: "waves", duration: 8 });
  });

  it("clamps durations to the provider cap", () => {
    const payload = toVideoPayload("m", { prompt: "p", durationSeconds: 60 });
    expect(payload.duration).toBe(MAX_VIDEO_SECONDS);
    expect(toVideoPayload("m", { prompt: "p", durationSeconds: 0 }).duration).toBe(1);
  });
});

describe("model catalogs", () => {
  it("exposes the verified Grok model ids with provider-qualified app ids", () => {
    expect(APIKEY_FAN_IMAGE_MODELS.map((m) => m.model)).toEqual([
      "grok-imagine-image-2.0",
      "grok-imagine-image-quality",
      "grok-imagine-image",
    ]);
    expect(APIKEY_FAN_VIDEO_MODELS.map((m) => m.model)).toEqual([
      "grok-imagine-video-1.5",
      "grok-imagine-video",
    ]);
    for (const model of [...APIKEY_FAN_IMAGE_MODELS, ...APIKEY_FAN_VIDEO_MODELS]) {
      expect(model.id.startsWith("apikey-fan:")).toBe(true);
    }
  });
});

describe("frame capability flags", () => {
  it("advertises start-frame capability on every grok model", () => {
    for (const model of [...APIKEY_FAN_IMAGE_MODELS, ...APIKEY_FAN_VIDEO_MODELS]) {
      expect(model.frameInput).toEqual({ start: true, end: false });
      expect(model.i2vModelId).toBeUndefined(); // same model takes frames
    }
  });
});

describe("continuity frame payloads", () => {
  const FRAME: FrameImage = { bytes: Buffer.from("abc"), contentType: "image/png" };

  it("video payload embeds the start frame as a data URI", () => {
    const payload = toVideoPayload("grok-imagine-video", {
      prompt: "p", durationSeconds: 5, image: FRAME,
    });
    expect(payload.image).toEqual({
      url: `data:image/png;base64,${FRAME.bytes.toString("base64")}`,
    });
  });

  it("video payload omits image when absent", () => {
    expect(
      toVideoPayload("grok-imagine-video", { prompt: "p", durationSeconds: 5 }).image,
    ).toBeUndefined();
  });

  it("edits payload references the source image", () => {
    const payload = toImageEditsPayload("grok-imagine-image-2.0", {
      prompt: "p", image: FRAME, count: 1,
    });
    expect(payload.image).toEqual({
      url: `data:image/png;base64,${FRAME.bytes.toString("base64")}`,
      type: "image_url",
    });
    expect(payload.n).toBe(1);
  });

  it("frameToDataUri builds a mime-correct data URI", () => {
    expect(frameToDataUri({ bytes: Buffer.from("x"), contentType: "image/webp" })).toBe(
      `data:image/webp;base64,${Buffer.from("x").toString("base64")}`,
    );
  });
});
