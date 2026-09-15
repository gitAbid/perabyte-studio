import { describe, expect, it } from "vitest";
import { isVideoScene, isVideoSource } from "@/lib/renderer";

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

describe("isVideoScene", () => {
  it("trusts a real video mime over the URL shape", () => {
    expect(isVideoScene({ url: "/api/media?f=abc.mp4", mime: "video/mp4" })).toBe(
      true,
    );
  });

  it("trusts an image mime even when the URL ends in .mp4", () => {
    expect(isVideoScene({ url: "/api/media?f=abc.mp4", mime: "image/png" })).toBe(
      false,
    );
  });

  it("falls back to the .mp4 URL sniff for legacy scenes without mime", () => {
    expect(isVideoScene({ url: "/api/media?f=abc.mp4" })).toBe(true);
    expect(isVideoScene({ url: "https://image.pollinations.ai/prompt/afox" })).toBe(
      false,
    );
  });
});
