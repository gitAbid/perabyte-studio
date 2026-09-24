import type { CharacterRow } from "@/lib/repositories/character-row";
import { parseCharacterRow } from "@/lib/repositories/character-row";
import {
  deleteCharactersRepository,
  getCharactersRepository,
  listCharactersRepository,
  patchCharacterRepository,
  putCharacterRepository,
} from "@/lib/repositories/characters.repository";

/**
 * Read/write model over the saved-characters store for /api/characters.
 * Writes re-validate through parseCharacterRow so a malformed payload
 * degrades to a rejected request instead of a poisoned file.
 */

/** All saved characters, most recently updated first. */
export function listCharacters(): CharacterRow[] {
  return listCharactersRepository().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getCharacter(id: string): CharacterRow | undefined {
  return getCharactersRepository(id);
}

/** Upsert one row (create or replace). Returns null for invalid rows. */
export function putCharacter(raw: unknown): CharacterRow | null {
  const row = parseCharacterRow(raw);
  if (!row) return null;
  return putCharacterRepository(row);
}

/** Merge a patch onto one row; bumps updatedAt. Null when the id is unknown. */
export function patchCharacter(
  id: string,
  patch: Record<string, unknown>,
): CharacterRow | null {
  const current = getCharactersRepository(id);
  if (!current) return null;
  // `identity: null` is the wire form of "clear" — JSON cannot carry
  // undefined, so the client sends null and we translate it here.
  const effective =
    patch.identity === null
      ? { ...patch, identity: undefined }
      : patch;
  const merged = parseCharacterRow({
    ...current,
    ...effective,
    id,
    updatedAt: Date.now(),
  });
  if (!merged) return null;
  return patchCharacterRepository(id, merged);
}

/** Delete by ids; returns the number actually removed. */
export function removeCharacters(ids: string[]): number {
  return deleteCharactersRepository(ids);
}
