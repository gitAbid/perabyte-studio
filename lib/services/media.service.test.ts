import { afterEach, describe, expect, it } from "vitest";
import { MediaUploadError, storeImageUpload } from "@/lib/services/media.service";
import { setMediaRepositoryForTests } from "@/lib/repositories/media.repository";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-png"),
]);

afterEach(() => setMediaRepositoryForTests(null));

describe("storeImageUpload", () => {
  it("stores an image and returns ref + url", async () => {
    const result = await storeImageUpload(PNG);
    expect(result.ref).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(result.url).toBe(`/api/media?f=${result.ref}`);
    expect(result.contentType).toBe("image/png");
  });

  it("rejects non-images", async () => {
    await expect(storeImageUpload(Buffer.from("not an image"))).rejects.toMatchObject({
      name: "MediaUploadError",
      status: 400,
    });
  });

  it("rejects empty payloads", async () => {
    await expect(storeImageUpload(Buffer.alloc(0))).rejects.toBeInstanceOf(MediaUploadError);
  });

  it("rejects payloads over 10 MB", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(storeImageUpload(big)).rejects.toMatchObject({ status: 413 });
  });
});
