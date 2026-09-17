import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_SETTINGS, DEFAULT_VIDEO_SETTINGS } from "@/lib/constants";
import { createWriterStoryAsset } from "@/lib/writer-story";

const baseInput = {
  title: "The Chase",
  prose: "A courier runs through the rain.",
  scenes: ["wide shot of the courier", "close-up on the package"],
  characterIds: ["ch_1"],
};

describe("createWriterStoryAsset", () => {
  it("builds an image-kind story with the image defaults", () => {
    const asset = createWriterStoryAsset({ ...baseInput, kind: "image" });
    expect(asset.kind).toBe("story");
    expect(asset.title).toBe("The Chase");
    expect(asset.settings).toEqual(DEFAULT_IMAGE_SETTINGS);
    expect(asset.meta?.style).toBe(DEFAULT_IMAGE_SETTINGS.style);
    expect(asset.scenes).toHaveLength(2);
    for (const scene of asset.scenes ?? []) {
      expect(scene.kind).toBe("image");
      expect(scene.status).toBe("queued");
    }
  });

  it("builds a video-kind story with the video defaults and video scenes", () => {
    const asset = createWriterStoryAsset({ ...baseInput, kind: "video" });
    expect(asset.kind).toBe("story");
    expect(asset.settings).toEqual(DEFAULT_VIDEO_SETTINGS);
    expect(asset.meta?.style).toBe(DEFAULT_VIDEO_SETTINGS.style);
    expect(asset.scenes).toHaveLength(2);
    for (const scene of asset.scenes ?? []) {
      expect(scene.kind).toBe("video");
      expect(scene.status).toBe("queued");
    }
  });
});
