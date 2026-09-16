import type { LoraSelection } from "@/lib/types";
import type { LoraOption } from "@/lib/providers/sogni/lora-catalog";

/**
 * Pure LoRA-selection helpers shared by the composer UI and the model-switch
 * snap. No I/O — everything here takes the catalog as input so it stays
 * trivially testable.
 */

/** Catalog entries the given raw model id accepts (client-side join; the
 * catalog's `modelIds` is authoritative even when the server pre-filtered). */
export function lorasForModel(
  catalog: readonly LoraOption[],
  model: string,
): LoraOption[] {
  return catalog.filter((entry) => entry.modelIds.includes(model));
}

/** Entries visible under the current content gate: nsfw/sexual LoRAs require
 * Uncensored Mode (Sensitive Content Filter off). */
export function visibleLoras(
  entries: readonly LoraOption[],
  allowNsfw: boolean,
): LoraOption[] {
  return allowNsfw ? [...entries] : entries.filter((e) => !e.nsfw && !e.sexual);
}

/** Category display order for the picker; unknown categories follow. */
const CATEGORY_ORDER = [
  "character",
  "art-direction",
  "lighting",
  "detail-composition",
  "prompt-control",
  "popular-community-fine-tunes",
];

/** Group entries into ordered `[label, entries]` sections for the popover. */
export function groupLorasByCategory(
  entries: readonly LoraOption[],
): Array<{ category: string; label: string; entries: LoraOption[] }> {
  const byCategory = new Map<string, LoraOption[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const known = CATEGORY_ORDER.filter((c) => byCategory.has(c));
  const rest = [...byCategory.keys()]
    .filter((c) => !CATEGORY_ORDER.includes(c))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...rest].map((category) => ({
    category,
    label: category
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
    entries: byCategory.get(category) ?? [],
  }));
}

/** Clamp a slider value into one LoRA's valid band. */
export function clampStrength(entry: LoraOption, value: number): number {
  if (!Number.isFinite(value)) return entry.default;
  return Math.min(entry.max, Math.max(entry.min, value));
}

/**
 * Selections that survive a switch to `model`: entries the new model accepts,
 * order preserved, strengths re-clamped into each entry's band. Selections for
 * LoRAs the new model doesn't take are dropped silently — switching models
 * should never dead-end the artist with an unrenderable setup.
 */
export function snapLorasForModel(
  selection: readonly LoraSelection[],
  catalog: readonly LoraOption[],
  model: string,
  maxPerRequest = 8,
  allowNsfw = true,
): LoraSelection[] {
  const byId = new Map(catalog.map((entry) => [entry.loraId, entry]));
  const snapped: LoraSelection[] = [];
  for (const item of selection) {
    if (snapped.length >= maxPerRequest) break;
    const entry = byId.get(item.loraId);
    if (!entry || !entry.modelIds.includes(model)) continue;
    // Same gate the picker applies to the visible list — a selection must
    // never outlive the toggle that made it choosable.
    if (!allowNsfw && (entry.nsfw || entry.sexual)) continue;
    snapped.push({ loraId: item.loraId, strength: clampStrength(entry, item.strength) });
  }
  return snapped;
}
