import type { ModelOption } from "@/lib/model-catalog";

/**
 * Picker-shaped option (structurally compatible with PillSelect's PillOption)
 * and the pure split shared by the composer pill and the conversion dialog:
 * curated "Recommended" rows pinned on top, everything else grouped by
 * provider in a collapsed tail.
 */

export interface ModelPickerOption {
  value: string;
  label: string;
  hint?: string;
  description?: string;
  badges?: string[];
  group?: string;
}

export interface ModelPickerSections {
  recommended: ModelPickerOption[];
  /** Provider-grouped tail options; empty when nothing is recommended. */
  tail: ModelPickerOption[];
  /** Disclosure label for the tail ("" when the tail renders inline). */
  tailLabel: string;
}

export function modelBadges(model: ModelOption): string[] {
  const badges: string[] = [];
  if (model.uncensored === false) badges.push("Sensored");
  if (model.costTier === "free") badges.push("Free");
  if (model.stylesSupported === false) badges.push("No styles");
  if (model.frameInput?.start) badges.push("Start frame");
  if (model.loraCapable) badges.push("LoRA");
  return badges;
}

export function modelPickerSections(models: ModelOption[]): ModelPickerSections {
  const recommended = models
    .filter((model) => model.tier === "recommended")
    .map((model) => toOption(model));
  const tail = models.filter((model) => model.tier !== "recommended");

  if (recommended.length === 0) {
    // No curated entries configured — render everything inline, no tail.
    return { recommended: tail.map((model) => toOption(model)), tail: [], tailLabel: "" };
  }

  const byProvider = new Map<string, ModelPickerOption[]>();
  for (const model of tail) {
    const group = model.providerLabel;
    if (!byProvider.has(group)) byProvider.set(group, []);
    byProvider.get(group)!.push(toOption(model, group));
  }
  return {
    recommended,
    tail: [...byProvider.values()].flat(),
    tailLabel: `Show all ${tail.length} more model${tail.length === 1 ? "" : "s"}`,
  };
}

function toOption(model: ModelOption, group?: string): ModelPickerOption {
  const badges = modelBadges(model);
  // The qualifier rides the description line — the label line carries only
  // label + badges, which keeps rows readable at dropdown width.
  const description = model.useCase
    ? model.hint
      ? `${model.useCase} · ${model.hint}`
      : model.useCase
    : model.hint;
  return {
    value: model.id,
    label: model.label,
    ...(description ? { description } : {}),
    ...(group ? { group } : {}),
    ...(badges.length ? { badges } : {}),
  };
}
