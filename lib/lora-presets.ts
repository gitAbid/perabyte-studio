import type { LoraSelection } from "@/lib/types";

/**
 * Curated LoRA presets — one-click looks over the phase-1 picker plumbing.
 * A preset is pure data: selecting it just writes `settings.loras`; the
 * service's existing validation (unknown-id strip, nsfw gate under
 * Uncensored-off, model capability) applies unchanged.
 *
 * Ids reference Sogni's live `/v1/loras/comfy` catalog (Krea 2 image family).
 * A Sogni-side rename degrades gracefully: the entry is stripped end-to-end
 * and the preset renders minus that adapter.
 *
 * Mature group is Uncensored-Mode only. It includes nsfw/sexual-flagged
 * adapters AND filter-bypass (unflagged, but it is the actual unlock for
 * adult prompt follow). Body-shape sliders stay in the picker, never here.
 */

export interface LoraPreset {
  id: string;
  label: string;
  hint: string;
  loras: LoraSelection[];
  /** Visible (and applicable) only under Uncensored Mode. */
  mature?: boolean;
}

export const LORA_PRESETS: LoraPreset[] = [
  {
    id: "candid-editorial",
    label: "Candid Editorial",
    hint: "Unposed magazine-photo feel",
    loras: [
      { loraId: "krea2-candid", strength: 3 },
      { loraId: "krea2-detail-enhancer", strength: 1 },
    ],
  },
  {
    id: "golden-hour",
    label: "Golden Hour",
    hint: "Warm, glowing late-day light",
    loras: [
      { loraId: "krea2-warm-light", strength: 2 },
      { loraId: "krea2-afterlight", strength: 0.8 },
    ],
  },
  {
    id: "hyper-detail",
    label: "Hyper Detail",
    hint: "Crisp textures, busy scenes",
    loras: [
      { loraId: "krea2-detail-enhancer", strength: 2 },
      { loraId: "krea2-skin-detail", strength: 2 },
      { loraId: "krea2-scene-complexity", strength: 1.5 },
    ],
  },
  {
    id: "analog-film",
    label: "Analog Film",
    hint: "Lo-fi grain, vintage color",
    loras: [
      { loraId: "krea2-amateur", strength: 1.5 },
      { loraId: "krea2-purple-grainy", strength: 1 },
      { loraId: "krea2-afterlight", strength: -0.6 },
    ],
  },
  {
    id: "photoreal",
    label: "Photoreal",
    hint: "Grounded, camera-true realism",
    loras: [
      { loraId: "krea2-realism", strength: 1.5 },
      { loraId: "krea2-detail-enhancer", strength: 1 },
    ],
  },
  {
    id: "soft-portrait",
    label: "Soft Portrait",
    hint: "Flattering skin, gentle light",
    loras: [
      { loraId: "krea2-skin-detail", strength: -2 },
      { loraId: "krea2-afterlight", strength: 0.6 },
    ],
  },
  {
    id: "glamour",
    label: "Glamour",
    hint: "Polished, stylized beauty",
    loras: [
      { loraId: "krea2-bloomgirls", strength: 0.8 },
      { loraId: "krea2-detail-enhancer", strength: 1 },
    ],
  },
  // --- mature: Uncensored Mode only ---
  {
    id: "uncensored",
    label: "Uncensored",
    hint: "Follow adult prompts, drop sanitized face",
    mature: true,
    loras: [
      { loraId: "krea2-filter-bypass-2", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
    ],
  },
  {
    id: "uncensored-strong",
    label: "Uncensored Strong",
    hint: "Heavier bypass when 2-vector still sanitizes",
    mature: true,
    loras: [
      { loraId: "krea2-filter-bypass-3", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
    ],
  },
  {
    id: "unlock",
    label: "Unlock",
    hint: "Prompt adherence + artistic nudity, no adult finetune",
    mature: true,
    loras: [{ loraId: "krea2-filter-bypass-2", strength: 2 }],
  },
  {
    id: "engine-realism",
    label: "Engine Realism",
    hint: "Uncensored photoreal, mature knowledge",
    mature: true,
    loras: [
      { loraId: "krea2-realism-engine", strength: 0.8 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
  {
    id: "mystic",
    label: "Mystic",
    hint: "All-round adult LoRA (keep ≤ 1)",
    mature: true,
    loras: [{ loraId: "krea2-mystic-x", strength: 1 }],
  },
  {
    id: "candid-adult",
    label: "Candid Adult",
    hint: "Unposed, magazine-photo adult look",
    mature: true,
    loras: [
      { loraId: "krea2-candid", strength: 3 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
  {
    id: "raw-amateur",
    label: "Raw Amateur",
    hint: "Lo-fi snapshot, adult prompt follow",
    mature: true,
    loras: [
      { loraId: "krea2-amateur", strength: 1.5 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
  {
    id: "glamour-nude",
    label: "Glamour Nude",
    hint: "Polished influencer look, adult knowledge",
    mature: true,
    loras: [
      { loraId: "krea2-bloomgirls", strength: 0.8 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
  {
    id: "wet-look",
    label: "Wet Look",
    hint: "Damp skin, hair, and clothes",
    mature: true,
    loras: [
      { loraId: "krea2-wetness", strength: 2 },
      { loraId: "krea2-mystic-x", strength: 0.8 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
  {
    id: "aberrant",
    label: "Aberrant",
    hint: "Industrial body-horror grit",
    mature: true,
    loras: [
      { loraId: "krea2-aberrant", strength: 0.75 },
      { loraId: "krea2-filter-bypass-2", strength: 2 },
    ],
  },
];

/**
 * Which preset (if any) the current selection equals — exact ids, order, and
 * strengths. Derived, never stored, so hand-tweaks naturally read as
 * `undefined` (Custom) and there is no state to drift.
 */
export function matchLoraPreset(
  selection: readonly LoraSelection[],
  presets: readonly LoraPreset[] = LORA_PRESETS,
): LoraPreset | undefined {
  if (!selection.length) return undefined;
  return presets.find(
    (preset) =>
      preset.loras.length === selection.length &&
      preset.loras.every(
        (entry, i) =>
          selection[i].loraId === entry.loraId && selection[i].strength === entry.strength,
      ),
  );
}
