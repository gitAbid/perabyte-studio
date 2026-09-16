import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { getBucket, type StorageBucket } from "@/lib/storage/bucket";

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bucket-"));
  previous = process.env.MEDIA_CACHE_DIR;
  process.env.MEDIA_CACHE_DIR = tmp;
  resetStudioEnvForTests();
});

afterEach(() => {
  if (previous === undefined) delete process.env.MEDIA_CACHE_DIR;
  else process.env.MEDIA_CACHE_DIR = previous;
  resetStudioEnvForTests();
});

/** Bytes that sniff as a PNG so the cache keeps its real extension. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("hello bucket"),
]);

describe("storage bucket", () => {
  it("round-trips bytes through the content-addressed cache", async () => {
    const bucket: StorageBucket = getBucket();
    const stored = await bucket.put(PNG_BYTES);
    expect(stored.ref).toMatch(/\.png$/);
    expect(stored.contentType).toBe("image/png");
    const fetched = await bucket.get(stored.ref);
    expect(fetched?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(fetched?.ref).toBe(stored.ref);
  });

  it("stats, lists and deletes stored refs", async () => {
    const bucket: StorageBucket = getBucket();
    const stored = await bucket.put(PNG_BYTES);

    const stat = await bucket.stat(stored.ref);
    expect(stat?.size).toBe(PNG_BYTES.length);
    expect(stat?.contentType).toBe("image/png");

    const listed = await bucket.list();
    expect(listed.map((e) => e.ref)).toContain(stored.ref);

    await bucket.delete(stored.ref);
    expect(await bucket.get(stored.ref)).toBeNull();
    expect(await bucket.stat(stored.ref)).toBeNull();
  });

  it("delete is a no-op for unknown refs and stat/list tolerate an empty cache", async () => {
    const bucket: StorageBucket = getBucket();
    expect(await bucket.stat("missing.txt")).toBeNull();
    expect(await bucket.list()).toEqual([]);
    await expect(bucket.delete("missing.txt")).resolves.toBeUndefined();
  });
});
