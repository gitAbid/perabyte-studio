import type { CustomModelEntry, CustomModelKind } from "@/lib/repositories/provider-config.repository";
import type { DiscoveredModel } from "./types";

/**
 * Name-based kind guessing for discovered models. Relays' /models listings
 * rarely carry capability metadata, so the id is the best signal; the user
 * can override any guess in Settings.
 */

const VIDEO_PATTERN = /video|veo|sora|kling|hailuo|seedance|runway|pika/i;
const IMAGE_PATTERN =
  /image|imagen|flux|dall|sd3|sdxl|stable-diff|kolors|seedream|banana/i;
const TEXT_PATTERN =
  /gpt|grok|claude|gemini|qwen|llama|deepseek|mistral|sonnet|opus|haiku|embed|build/i;

export function classifyModelId(modelId: string): CustomModelKind {
  if (VIDEO_PATTERN.test(modelId)) return "video";
  if (IMAGE_PATTERN.test(modelId)) return "image";
  if (TEXT_PATTERN.test(modelId)) return "text";
  return "off";
}

/**
 * Maps a freshly discovered listing onto storable model entries. Confident
 * image/video guesses start enabled so a saved provider is immediately
 * usable; text and unclassifiable models wait for the user.
 */
export function guessEntry(discovered: DiscoveredModel[]): CustomModelEntry[] {
  return discovered.map((model) => {
    const kind = classifyModelId(model.model);
    return {
      model: model.model,
      ...(model.label ? { label: model.label } : {}),
      kind,
      enabled: kind === "image" || kind === "video",
    };
  });
}
