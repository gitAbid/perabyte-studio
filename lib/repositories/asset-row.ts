import type { Asset, StoryScene } from "@/lib/types";

/**
 * Minimal shape check for an asset row coming off disk or the wire. Field
 * presence is validated, unknown extra fields pass through — the record
 * shape evolves faster than persisted files, and the UI tolerates extras.
 * Returns null for anything that would break consumers (id/kind/type-level
 * invariants).
 */
export function parseAssetRow(raw: unknown): Asset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (r.kind !== "image" && r.kind !== "video" && r.kind !== "story") return null;
  if (typeof r.title !== "string" || typeof r.prompt !== "string") return null;
  if (typeof r.url !== "string" || !Array.isArray(r.variants)) return null;
  if (!r.settings || typeof r.settings !== "object") return null;
  if (typeof r.createdAt !== "number" || typeof r.favorite !== "boolean") return null;
  if (typeof r.mode !== "string") return null;
  const asset = r as unknown as Asset;
  if (asset.scenes !== undefined) {
    if (!Array.isArray(asset.scenes)) return null;
    const scenesOk = asset.scenes.every(
      (s): s is StoryScene =>
        !!s &&
        typeof s === "object" &&
        typeof (s as StoryScene).id === "string" &&
        typeof (s as StoryScene).prompt === "string" &&
        ((s as StoryScene).url === null || typeof (s as StoryScene).url === "string"),
    );
    if (!scenesOk) return null;
  }
  return asset;
}

export function parseAssetRows(raw: unknown): Asset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseAssetRow).filter((a): a is Asset => a !== null);
}
