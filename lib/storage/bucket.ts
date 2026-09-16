import type { MediaRepository } from "@/lib/repositories/media.repository";
import { getMediaRepository } from "@/lib/repositories/media.repository";

/**
 * Storage abstraction for render binaries (the durable-jobs spec's
 * "storage bucket"). The disk-backed, content-addressed media cache is the
 * first implementation; an S3/R2 bucket can replace it later without
 * touching callers — the `/api/media?f=<ref>` serving contract stays
 * byte-identical.
 */
export type StorageBucket = MediaRepository;

export function getBucket(): StorageBucket {
  return getMediaRepository();
}
