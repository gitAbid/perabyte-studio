import { DEFAULT_CHARACTER_SPEC, sanitizeSpec, type CharacterSpec } from "@/lib/character";

/** Persisted saved-character row. The client mirror (`lib/character-store.ts`)
 * re-exports this type as `SavedCharacter` so consumers keep the old name. */
export interface CharacterRow {
  id: string;
  name: string;
  spec: CharacterSpec;
  /** Media ref / URL of the current poster image. */
  thumbnail?: string;
  /** Lineage: set when this record was saved as a variation of another. */
  parentId?: string;
  favorite?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Shape check for a character row coming off disk or the wire, mirroring
 * `parseAssetRow`: required-field validation only, unknown extra fields pass
 * through, and the spec is re-sanitized (fills missing fields from defaults,
 * clamps age; `uncensored: true` preserves stored adult options — the gate is
 * a client setting, not a storage property). Returns null for anything that
 * would break consumers.
 */
export function parseCharacterRow(raw: unknown): CharacterRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string") return null;
  if (!r.spec || typeof r.spec !== "object") return null;
  if (typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") return null;
  const row = r as unknown as CharacterRow;
  row.spec = sanitizeSpec(
    { ...DEFAULT_CHARACTER_SPEC, ...row.spec } as CharacterSpec,
    true,
  );
  if (typeof row.favorite !== "boolean") delete row.favorite;
  if (row.tags !== undefined && !isStringArray(row.tags)) delete row.tags;
  if (row.thumbnail !== undefined && typeof row.thumbnail !== "string") delete row.thumbnail;
  if (row.parentId !== undefined && !row.parentId) delete row.parentId;
  return row;
}

export function parseCharacterRows(raw: unknown): CharacterRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseCharacterRow).filter((r): r is CharacterRow => r !== null);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string");
}
