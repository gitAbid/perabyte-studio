import { describe, expect, it } from "vitest";
import { isVideoSource } from "@/lib/renderer";

describe("isVideoSource", () => {
  it("detects cached mp4 refs", () => {
    // Real shape: the ref (with its .mp4) rides the query string.
    expect(isVideoSource(`/api/media?f=${"a".repeat(64)}.mp4`)).toBe(true);
    expect(isVideoSource(`/api/media?f=${"a".repeat(64)}.MP4&download=1`)).toBe(true);
    expect(isVideoSource("https://cdn.example/video.mp4?token=x")).toBe(true);
  });

  it("treats images and keyframe urls as non-video", () => {
    expect(
      isVideoSource("https://image.pollinations.ai/prompt/x?width=1280&model=flux"),
    ).toBe(false);
    expect(isVideoSource("/api/media?f=" + "a".repeat(64) + ".png")).toBe(false);
    expect(isVideoSource(null)).toBe(false);
    expect(isVideoSource("")).toBe(false);
  });
});
