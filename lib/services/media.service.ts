import { getMediaRepository, sniff } from "@/lib/repositories/media.repository";

/**
 * Client uploads for continuity/reference frames. Images only — videos are
 * produced by providers, never uploaded. Frames ride the content-addressed
 * media cache so a scene request references a cheap ref instead of bytes.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class MediaUploadError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status = 400, retryable = false) {
    super(message);
    this.name = "MediaUploadError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface StoredUpload {
  ref: string;
  url: string;
  contentType: string;
}

export async function storeImageUpload(bytes: Buffer): Promise<StoredUpload> {
  if (bytes.length === 0) {
    throw new MediaUploadError("That file is empty. Choose an image and try again.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new MediaUploadError("Images are limited to 10 MB. Choose a smaller file.", 413);
  }
  const type = sniff(bytes);
  if (!type || !type.contentType.startsWith("image/") || type.ext === "gif") {
    throw new MediaUploadError("Only PNG, JPEG or WebP images can be used as frames.");
  }
  const stored = await getMediaRepository().put(bytes, type.ext);
  return { ref: stored.ref, url: `/api/media?f=${stored.ref}`, contentType: stored.contentType };
}
