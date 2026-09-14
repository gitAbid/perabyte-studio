import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  contentTypeForRef,
  getMediaRepository,
  isValidMediaRef,
  setMediaRepositoryForTests,
} from "@/lib/repositories/media.repository";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perabyte-media-"));
  process.env.MEDIA_CACHE_DIR = dir;
  resetStudioEnvForTests();
  setMediaRepositoryForTests(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MEDIA_CACHE_DIR;
  resetStudioEnvForTests();
  setMediaRepositoryForTests(null);
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const MP4_BYTES = Buffer.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

describe("media repository", () => {
  it("sniffs png, jpeg and mp4 from magic bytes", async () => {
    const repository = getMediaRepository();
    const png = await repository.put(PNG_BYTES);
    const jpeg = await repository.put(JPEG_BYTES);
    const mp4 = await repository.put(MP4_BYTES);
    expect(png.contentType).toBe("image/png");
    expect(jpeg.contentType).toBe("image/jpeg");
    expect(mp4.contentType).toBe("video/mp4");
  });

  it("is content-addressed: identical bytes share one ref", async () => {
    const repository = getMediaRepository();
    const first = await repository.put(PNG_BYTES);
    const second = await repository.put(PNG_BYTES);
    expect(second.ref).toBe(first.ref);
  });

  it("round-trips bytes through get()", async () => {
    const repository = getMediaRepository();
    const stored = await repository.put(MP4_BYTES);
    const loaded = await repository.get(stored.ref);
    expect(loaded?.bytes.equals(MP4_BYTES)).toBe(true);
    expect(loaded?.contentType).toBe("video/mp4");
  });

  it("rejects malformed refs", () => {
    expect(isValidMediaRef("../etc/passwd")).toBe(false);
    expect(isValidMediaRef("deadbeef.png")).toBe(false); // not a sha256
    expect(isValidMediaRef("a".repeat(64) + ".png")).toBe(true);
  });

  it("returns null for cache misses", async () => {
    const repository = getMediaRepository();
    const missing = "b".repeat(64) + ".png";
    expect(await repository.get(missing)).toBeNull();
    expect(contentTypeForRef(missing)).toBe("image/png");
  });
});
