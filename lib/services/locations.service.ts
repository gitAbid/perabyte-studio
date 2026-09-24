import type { LocationRow } from "@/lib/repositories/location-row";
import { parseLocationRow } from "@/lib/repositories/location-row";
import {
  deleteLocationsRepository,
  getLocationsRepository,
  listLocationsRepository,
  patchLocationRepository,
  putLocationRepository,
} from "@/lib/repositories/locations.repository";

/**
 * Read/write model over the saved-locations store for /api/locations.
 * Writes re-validate through parseLocationRow so a malformed payload
 * degrades to a rejected request instead of a poisoned file.
 */

/** All saved locations, most recently updated first. */
export function listLocations(): LocationRow[] {
  return listLocationsRepository().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLocation(id: string): LocationRow | undefined {
  return getLocationsRepository(id);
}

/** Upsert one row (create or replace). Returns null for invalid rows. */
export function putLocation(raw: unknown): LocationRow | null {
  const row = parseLocationRow(raw);
  if (!row) return null;
  return putLocationRepository(row);
}

/** Merge a patch onto one row; bumps updatedAt. Null when the id is unknown. */
export function patchLocation(
  id: string,
  patch: Record<string, unknown>,
): LocationRow | null {
  const current = getLocationsRepository(id);
  if (!current) return null;
  const merged = parseLocationRow({
    ...current,
    ...patch,
    id,
    updatedAt: Date.now(),
  });
  if (!merged) return null;
  return patchLocationRepository(id, merged);
}

/** Delete by ids; returns the number actually removed. */
export function removeLocations(ids: string[]): number {
  return deleteLocationsRepository(ids);
}
