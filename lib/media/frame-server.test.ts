import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  deriveEndFrameRefServerSide,
  extractLastFrameRefServerSide,
  refFromMediaUrl,
} from "@/lib/media/frame-server";
import { setMediaRepositoryForTests, getMediaRepository } from "@/lib/repositories/media.repository";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frame-server-"));
  process.env.MEDIA_CACHE_DIR = tmp;
  resetStudioEnvForTests();
});

afterEach(() => {
  delete process.env.MEDIA_CACHE_DIR;
  resetStudioEnvForTests();
  setMediaRepositoryForTests(null);
});

describe("refFromMediaUrl", () => {
  it("parses the bare cache ref out of media urls", () => {
    expect(refFromMediaUrl("/api/media?f=abc.png")).toBe("abc.png");
    expect(refFromMediaUrl("https://x.test/api/media?f=abc.jpg&download=1")).toBe("abc.jpg");
    expect(refFromMediaUrl("https://cdn.test/plain.png")).toBeNull();
    expect(refFromMediaUrl(null)).toBeNull();
  });
});

describe("extractLastFrameRefServerSide", () => {
  it("grabs the last frame of a real video via ffmpeg", () => {
    if (!hasFfmpeg()) return; // ffmpeg not installed — degrade paths cover this
    // 1s test clip, 250px, faststart so the moov sits up front.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "frame-ffmpeg-"));
    const clip = path.join(work, "clip.mp4");
    execFileSync("ffmpeg", [
      "-f", "lavfi", "-i", "color=c=blue:s=250x250:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", clip,
    ]);
    const stored = getMediaRepository().put(fs.readFileSync(clip), "mp4");
    return Promise.resolve(stored).then(async ({ ref }) => {
      const frameRef = await extractLastFrameRefServerSide(`/api/media?f=${ref}`);
      expect(frameRef).toMatch(/\.jpg$/);
      const frame = await getMediaRepository().get(frameRef);
      expect(frame?.bytes.length).toBeGreaterThan(0);
      fs.rmSync(work, { recursive: true, force: true });
    });
  }, 30_000);

  it("degrades to a rejection when ffmpeg is missing", async () => {
    await expect(
      extractLastFrameRefServerSide("/api/media?f=whatever.mp4", {
        ffmpegPath: "/nonexistent/ffmpeg",
      }),
    ).rejects.toThrow();
  });

  it("rejects non-cached media urls", async () => {
    await expect(
      extractLastFrameRefServerSide("https://cdn.test/plain.png"),
    ).rejects.toThrow(/not a cached media url/);
  });
});

describe("deriveEndFrameRefServerSide", () => {
  it("prefers the provider's end-frame export", async () => {
    const ref = await deriveEndFrameRefServerSide(
      { url: "/api/media?f=video.mp4", endFrameUrl: "/api/media?f=export.png" },
      "video",
    );
    expect(ref).toBe("export.png");
  });

  it("uses the image itself for image scenes", async () => {
    const ref = await deriveEndFrameRefServerSide(
      { url: "/api/media?f=scene.png" },
      "image",
    );
    expect(ref).toBe("scene.png");
  });

  it("returns null for videos without an export when ffmpeg is missing", async () => {
    const ref = await deriveEndFrameRefServerSide(
      { url: "/api/media?f=video.mp4" },
      "video",
      { ffmpegPath: "/nonexistent/ffmpeg" },
    );
    expect(ref).toBeNull(); // prompt-only chaining, as the client backfill did
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
