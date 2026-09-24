/** Persisted saved-location row (`.studio/locations.json`). A location is a
 * reference-plate asset for story-scene consistency: the plate image is the
 * media-cache ref renders return to for the same place. */
export interface LocationRow {
  id: string;
  name: string;
  /** Prose establishing-shot description of the place. */
  description?: string;
  /** Media-cache ref (`<64hex>.<ext>`) of the reference plate image. */
  ref?: string;
  /** Free-text lighting mood. */
  lighting?: string;
  /** Free-text color palette. */
  palette?: string;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Shape check for a location row coming off disk or the wire, mirroring
 * `parseCharacterRow`: required-field validation only (id/name/timestamps),
 * optional fields are presence-only — kept when present, dropped when
 * wrongly typed — and unknown extra fields pass through. Returns null for
 * anything that would break consumers.
 */
export function parseLocationRow(raw: unknown): LocationRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string") return null;
  if (typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") return null;
  const row = r as unknown as LocationRow;
  if (typeof row.description !== "string") delete row.description;
  if (typeof row.ref !== "string") delete row.ref;
  if (typeof row.lighting !== "string") delete row.lighting;
  if (typeof row.palette !== "string") delete row.palette;
  if (typeof row.favorite !== "boolean") delete row.favorite;
  return row;
}

export function parseLocationRows(raw: unknown): LocationRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseLocationRow).filter((r): r is LocationRow => r !== null);
}
