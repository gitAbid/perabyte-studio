import type { CharacterRow } from "@/lib/repositories/character-row";
import type { LocationRow } from "@/lib/repositories/location-row";
import type { Asset } from "@/lib/types";

export interface StoryCanonViolation {
  field: string;
  id: string;
  message: string;
  sceneId?: string;
}

/** Validate only explicit entity references. Legacy prose-only stories remain valid. */
export function validateStoryCanon(
  story: Asset,
  characters: readonly CharacterRow[],
  locations: readonly LocationRow[],
): StoryCanonViolation[] {
  const violations: StoryCanonViolation[] = [];
  const characterIds = new Set(characters.map((character) => character.id));
  const locationIds = new Set(locations.map((location) => location.id));
  const rawCast = story.meta?.characterIds;
  const declaredCast = Array.isArray(rawCast)
    ? rawCast.filter((id): id is string => typeof id === "string")
    : null;

  for (const id of declaredCast ?? []) {
    if (!characterIds.has(id)) {
      violations.push({
        field: "meta.characterIds",
        id,
        message: `Story cast character “${id}” no longer exists. Remove it or restore the character before generating.`,
      });
    }
  }

  for (const id of story.world?.locationIds ?? []) {
    if (!locationIds.has(id)) {
      violations.push({
        field: "world.locationIds",
        id,
        message: `Story location “${id}” no longer exists. Remove it or restore the location before generating.`,
      });
    }
  }

  for (const scene of story.scenes ?? []) {
    const sceneCharacters = scene.state?.characters ?? [];
    const effectiveCast = sceneCharacters.length
      ? sceneCharacters.map((entry) => entry.id)
      : declaredCast ?? [];
    if (effectiveCast.length > 3) {
      violations.push({
        field: `scenes.${scene.id}.state.characters`,
        id: String(effectiveCast.length),
        sceneId: scene.id,
        message: `Scene “${scene.id}” has ${effectiveCast.length} characters, but the current renderer supports at most 3 per shot. Split the scene into multiple shots before generating.`,
      });
    }
    for (const entry of sceneCharacters) {
      if (!characterIds.has(entry.id)) {
        violations.push({
          field: `scenes.${scene.id}.state.characters`,
          id: entry.id,
          sceneId: scene.id,
          message: `Scene “${scene.id}” references missing character “${entry.id}”. Remove it or restore the character before generating.`,
        });
      } else if (declaredCast && !declaredCast.includes(entry.id)) {
        violations.push({
          field: `scenes.${scene.id}.state.characters`,
          id: entry.id,
          sceneId: scene.id,
          message: `Scene “${scene.id}” uses character “${entry.id}” outside the declared story cast. Add it to the story cast before generating.`,
        });
      }
    }
    const id = scene.state?.locationId;
    if (id && !locationIds.has(id)) {
      violations.push({
        field: `scenes.${scene.id}.state.locationId`,
        id,
        sceneId: scene.id,
        message: `Scene “${scene.id}” references missing location “${id}”. Remove it or restore the location before generating.`,
      });
    }
  }
  return violations;
}
