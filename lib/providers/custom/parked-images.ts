import type { GeneratedArtifact } from "@/lib/providers/types";

/**
 * In-memory parking spot for completed synchronous image jobs. A custom
 * provider's image call resolves "at submit" like apikey-fan's; the
 * artifacts wait here for the executor's first poll. The map lives at module
 * level so a Settings save rebuilding adapter instances never loses parked
 * renders (video needs none of this — its refs are provider-side ids).
 */

const IMAGE_REF_PREFIX = "cimg_";

const parkedImages = new Map<string, GeneratedArtifact[]>();

export function newImageRef(providerId: string): string {
  return `${IMAGE_REF_PREFIX}${providerId}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function parkImage(ref: string, artifacts: GeneratedArtifact[]): void {
  parkedImages.set(ref, artifacts);
}

export function takeParkedImage(ref: string): GeneratedArtifact[] | null {
  const parked = parkedImages.get(ref);
  if (!parked) return null;
  parkedImages.delete(ref);
  return parked;
}
