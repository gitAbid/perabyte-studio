import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioEnv } from "@/lib/config/env";
import { logger } from "@/lib/logging/logger";

/**
 * Content-addressed media cache. Provider payloads that arrive as bytes
 * (b64 images, downloaded mp4s) are stored here and served from our own
 * origin via `/api/media?f=<ref>`, so the app never depends on short-lived
 * provider URLs.
 *
 * The `MediaRepository` interface exists so a durable backend (Vercel Blob,
 * S3) can replace the disk implementation later without touching callers.
 */
export interface StoredMedia {
  /** File name inside the cache: `<sha256>.<ext>`. */
  ref: string;
  contentType: string;
  bytes: Buffer;
}

export interface MediaRepository {
  put(bytes: Buffer, ext?: string): Promise<StoredMedia>;
  get(ref: string): Promise<StoredMedia | null>;
}

const log = logger.child({ module: "media-repository" });

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
};

/** Sniff the file type from magic bytes so refs match their real payload. */
export function sniff(bytes: Buffer): { ext: string; contentType: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return { ext: "mp4", contentType: "video/mp4" };
  }
  return null;
}

export function isValidMediaRef(ref: string): boolean {
  return /^[0-9a-f]{64}\.(png|jpe?g|webp|gif|mp4)$/.test(ref);
}

export function contentTypeForRef(ref: string): string {
  const ext = ref.split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function cacheDir(): string {
  const dir = getStudioEnv().mediaCacheDir;
  // The cache dir is runtime-configured; keep the bundler from tracing the
  // whole project because of it.
  return path.isAbsolute(dir)
    ? dir
    : path.join(/*turbopackIgnore: true*/ process.cwd(), dir);
}

class DiskMediaRepository implements MediaRepository {
  async put(bytes: Buffer, ext?: string): Promise<StoredMedia> {
    const sniffed = sniff(bytes);
    const resolvedExt = (ext && CONTENT_TYPES[ext] ? ext : null) ?? sniffed?.ext;
    if (!resolvedExt) {
      // Unknown payloads are still cached (served octet-stream) so a render
      // is never lost to a format we did not recognise.
      log.warn("stored media with unknown content type", { size: bytes.length });
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const ref = `${hash}.${resolvedExt ?? "bin"}`;
    const file = path.join(/*turbopackIgnore: true*/ cacheDir(), ref);

    try {
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(file, bytes);
    } catch (error) {
      // A full disk or a read-only FS must not fail the generation itself —
      // callers fall back to serving the provider URL when a ref is missing.
      log.error("media cache write failed", { error, ref });
    }
    return {
      ref,
      contentType: CONTENT_TYPES[resolvedExt ?? ""] ?? "application/octet-stream",
      bytes,
    };
  }

  async get(ref: string): Promise<StoredMedia | null> {
    if (!isValidMediaRef(ref)) return null;
    try {
      const bytes = await readFile(path.join(cacheDir(), ref));
      return { ref, contentType: contentTypeForRef(ref), bytes };
    } catch {
      return null;
    }
  }
}

let repository: MediaRepository | null = null;

export function getMediaRepository(): MediaRepository {
  repository ??= new DiskMediaRepository();
  return repository;
}

/** Test hook: inject a fake repository. */
export function setMediaRepositoryForTests(fake: MediaRepository | null): void {
  repository = fake;
}
