import type { Asset, StoryScene } from "@/lib/types";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { LocationRow } from "@/lib/repositories/location-row";
import type { ModelDescriptor } from "@/lib/domain/models";
import { composeCharacterAnchor } from "@/lib/character";
import type { GateExpectations } from "@/lib/services/keyframe-gate.service";

/**
 * Keyframe strategy (the provider fallback ladder). A scene needing an
 * anchored start gets a KEYFRAME still rendered first; animation then starts
 * from that still. Rungs, best available first:
 *  1. multi  — a context-capable edit model takes every reference at once
 *              (character fronts, location plate, previous end frame).
 *  2. single — an img2img model takes ONE reference (first cast front, else
 *              the location plate); the rest stay text-only.
 *  3. none   — nothing to anchor with (or the user's manual start frame
 *              wins): today's chained behavior, no keyframe rendered.
 */

export type KeyframeStrategy =
  | { rung: "multi"; modelId: string; refs: string[] }
  | { rung: "single"; modelId: string; startRef: string }
  | { rung: "none"; reason: string };

export interface KeyframeInput {
  story: Asset;
  scene: StoryScene;
  /** sceneId order of the cast for THIS scene (state.characters wins over
   * story order — the same order composeShot labels First/Second/Third). */
  cast: CharacterRow[];
  location?: LocationRow;
  /** The chain predecessor's derived last frame (soft continuity ref). */
  predecessorEndRef?: string;
  /** Image-kind model descriptors to pick from (any provider). */
  imageModels: ModelDescriptor[];
}

/** References by anchoring priority, interleaved so a small context cap
 * keeps one identity + place + continuity before extra angles: first cast
 * front, location plate, previous end frame, then remaining fronts. */
export function keyframeRefs(cast: CharacterRow[], location: LocationRow | undefined, predecessorEndRef?: string): string[] {
  const fronts = cast
    .map((c) => c.identity?.front)
    .filter((ref): ref is string => Boolean(ref));
  const [first, ...rest] = fronts;
  const refs = [
    ...(first ? [first] : []),
    ...(location?.ref ? [location.ref] : []),
    ...(predecessorEndRef ? [predecessorEndRef] : []),
    ...rest,
  ];
  // A ref may appear twice (e.g. the previous end frame IS the location
  // plate); duplicates waste a context slot.
  return [...new Set(refs)];
}

export function resolveKeyframeStrategy(input: KeyframeInput): KeyframeStrategy {
  const { scene, cast, location, predecessorEndRef, imageModels } = input;
  // The user's manual start frame outranks everything — no keyframe.
  if (scene.startImageRef) return { rung: "none", reason: "manual start frame" };

  const refs = keyframeRefs(cast, location, predecessorEndRef);
  if (!refs.length) return { rung: "none", reason: "no identity or location references" };

  const contextCapable = imageModels
    .filter((m) => m.contextImages && m.contextImages.max >= 1)
    // min 0 (optional context) preferred over min 1 (requires one) — both
    // work here since refs is non-empty, so just take the largest capacity.
    .sort((a, b) => (b.contextImages?.max ?? 0) - (a.contextImages?.max ?? 0));
  if (contextCapable.length) {
    const model = contextCapable[0];
    const max = model.contextImages?.max ?? 1;
    // Keep anchoring priority when trimming (Qwen ≤3: front, location, prev
    // end frame; GPT ≤16: everything).
    return { rung: "multi", modelId: model.id, refs: refs.slice(0, max) };
  }

  const startCapable = imageModels.find((m) => m.frameInput?.start);
  if (startCapable) {
    return { rung: "single", modelId: startCapable.id, startRef: refs[0] };
  }
  return { rung: "none", reason: "no context-capable or img2img image model" };
}

/** Text expectations the gate scores the rendered keyframe against. */
export function buildGateExpectations(
  scene: StoryScene,
  cast: CharacterRow[],
  location: LocationRow | undefined,
): GateExpectations | null {
  if (!cast.length && !location) return null;
  const outfits = new Map(
    (scene.state?.characters ?? [])
      .map((entry) => [entry.id, entry.outfit])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const identity = cast
    .map((c) => composeCharacterAnchor(c.spec))
    .filter(Boolean)
    .join(" / ");
  const sceneOutfits = cast
    .map((c) => outfits.get(c.id))
    .filter((outfit): outfit is string => Boolean(outfit))
    .join("; ");
  return {
    identity: identity || "the scene's described character(s)",
    ...(sceneOutfits ? { outfit: sceneOutfits } : {}),
    ...(location?.description || location?.name
      ? { location: [location?.name, location?.description].filter(Boolean).join(" — ") }
      : {}),
  };
}

/** Framing clause appended to the composed shot prompt for the keyframe. */
export const KEYFRAME_PROMPT_SUFFIX =
  "A single still frame of this exact scene — keep every person and place precisely as shown in the reference image(s), same faces, same outfits, same environment.";

export function keyframePrompt(shotPrompt: string): string {
  return `${shotPrompt} ${KEYFRAME_PROMPT_SUFFIX}`.trim();
}
