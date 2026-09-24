import type { ModelDescriptor } from "@/lib/domain/models";
import { getGenerationRegistry } from "@/lib/providers/registry";

/**
 * Server-side image-model pool for the keyframe rung. The strategy resolver
 * (lib/story/keyframe.ts) picks from these; the registry already gates the
 * list down to CONFIGURED and ENABLED providers (provider-config enabled
 * flags + per-model disabled lists), including custom providers' image
 * models. Hidden capability models are included but video-kind descriptors
 * among them are filtered out — a keyframe is always an image render.
 */
export function listImageModelDescriptors(): ModelDescriptor[] {
  return getGenerationRegistry()
    .listAllModels("image")
    .filter((model) => model.kind === "image");
}
