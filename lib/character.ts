import type { AspectKey, ResolutionKey } from "./constants";

/* ------------------------------------------------------------------ */
/* Character spec                                                      */
/* ------------------------------------------------------------------ */

export type CharacterMode = "normal" | "uncensored";

/**
 * Everything the wizard collects. Selects store human-readable values that
 * are folded straight into the composed prompt, so there is one source of
 * truth per option and no separate label/prompt mapping to maintain.
 *
 * Characters are strictly adults (18+) in both modes. Regular Mode locks
 * clothing on and NSFW off; Uncensored Mode unlocks the adult creative
 * options and an NSFW intensity slider.
 */
export interface CharacterSpec {
  // Step 1 — Character Details
  mode: CharacterMode;
  prompt: string;
  aspect: AspectKey;
  resolution: ResolutionKey;
  style: string;

  // Step 2 — Appearance
  gender: string;
  age: string;
  bodyType: string;
  skinTone: string;
  faceShape: string;
  facialFeatures: string;
  expression: string;
  hairColor: string;
  hairStyle: string;
  eyeColor: string;
  eyeShape: string;
  outfit: string;
  accessories: string;

  // Step 3 — Advanced Settings
  height: string;
  weight: string;
  build: string;
  bodyDetails: string;
  pose: string;
  violence: string;
  tattoos: boolean;
  piercings: boolean;
  facialHair: boolean;
  personality: string;
  sceneNotes: string;
  /** Uncensored-only. Regular Mode always stores "None". */
  nudity: string;
  /** Uncensored-only. Regular Mode always stores "None". */
  sexualContent: string;
  /** Uncensored-only, 0–5. Regular Mode is locked at 0. */
  nsfwLevel: number;
  /** Id of a look preset from the inspiration grid, or "" when untouched. */
  look: string;
}

export const DEFAULT_CHARACTER_SPEC: CharacterSpec = {
  mode: "normal",
  prompt: "",
  aspect: "9:16",
  resolution: "1080p",
  style: "Realistic",

  gender: "Female",
  age: "Adult (18+)",
  bodyType: "Slim",
  skinTone: "medium",
  faceShape: "Oval",
  facialFeatures: "Natural",
  expression: "Neutral",
  hairColor: "Black",
  hairStyle: "Long & Straight",
  eyeColor: "Brown",
  eyeShape: "Almond",
  outfit: "Casual",
  accessories: "None",

  height: `5'6" (168 cm)`,
  weight: "55 kg",
  build: "Slim",
  bodyDetails: "Normal proportions",
  pose: "Portrait",
  violence: "None",
  tattoos: false,
  piercings: false,
  facialHair: false,
  personality: "",
  sceneNotes: "",
  nudity: "None",
  sexualContent: "None",
  nsfwLevel: 0,
  look: "",
};

/* ------------------------------------------------------------------ */
/* Shared option tables                                                */
/* ------------------------------------------------------------------ */

/**
 * Style presets offered by the character studio. Every key must exist in
 * IMAGE_STYLES — the render API validates style names against that table.
 */
export const CHARACTER_STYLES = [
  "Realistic",
  "Anime",
  "Semi-Realistic",
  "3D Render",
  "South Asian",
] as const;

/** Characters are strictly adults: every option is 18+ by definition. */
export const AGES = [
  "Adult (18+)",
  "Young Adult (18–24)",
  "Adult (25–39)",
  "Mature (40–59)",
  "Senior (60+)",
] as const;

export const GENDERS = ["Female", "Male", "Non-binary"] as const;

export const BODY_TYPES = ["Slim", "Athletic", "Average", "Curvy", "Plus-size"] as const;

export const SKIN_TONES = [
  { id: "porcelain", hex: "#f6e0d2", prompt: "porcelain" },
  { id: "light", hex: "#f0cfae", prompt: "light" },
  { id: "medium", hex: "#e0ac82", prompt: "medium tan" },
  { id: "olive", hex: "#c68a5e", prompt: "olive" },
  { id: "brown", hex: "#9c6644", prompt: "brown" },
  { id: "deep", hex: "#6f4a2f", prompt: "deep brown" },
] as const;

export const FACE_SHAPES = ["Oval", "Round", "Square", "Heart", "Diamond", "Long"] as const;

export const FACIAL_FEATURES = [
  "Natural",
  "Freckled",
  "Mole",
  "Scar",
  "Birthmark",
  "Sharp cheekbones",
  "Soft rounded",
  "Dimpled smile",
] as const;

export const HAIR_COLORS = [
  "Black",
  "Dark Brown",
  "Chestnut Brown",
  "Blonde",
  "Auburn",
  "Red",
  "Silver Grey",
  "Pastel Pink",
] as const;

export const HAIR_STYLES = [
  "Long & Straight",
  "Long & Wavy",
  "Curly",
  "Shoulder Bob",
  "Pixie Cut",
  "Ponytail",
  "Braided",
  "Elegant Updo",
  "Buzz Cut",
] as const;

export const EYE_COLORS = ["Brown", "Hazel", "Blue", "Green", "Grey", "Amber", "Dark"] as const;

export const EYE_SHAPES = ["Almond", "Round", "Hooded", "Monolid", "Upturned"] as const;

export const HEIGHTS = [
  `5'0" (152 cm)`,
  `5'3" (160 cm)`,
  `5'6" (168 cm)`,
  `5'9" (175 cm)`,
  `6'0" (183 cm)`,
  `6'3" (190 cm)`,
] as const;

export const WEIGHTS = ["45 kg", "55 kg", "65 kg", "75 kg", "85 kg", "95 kg"] as const;

export const BUILDS = ["Slim", "Athletic", "Average", "Muscular", "Curvy", "Plus-size"] as const;

/* ------------------------------------------------------------------ */
/* Regular Mode                                                        */
/* ------------------------------------------------------------------ */

export const EXPRESSIONS_REGULAR = [
  "Neutral",
  "Happy",
  "Serious",
  "Smiling",
  "Confident",
  "Thoughtful",
  "Graceful",
] as const;

export const OUTFITS_REGULAR = [
  "Casual",
  "Formal",
  "Fantasy armor",
  "Sportswear",
  "Uniform (adult)",
  "Traditional",
  "Modern streetwear",
  "Business attire",
] as const;

export const OUTFITS_SUBCONTINENT_REGULAR = [
  "Saree",
  "Salwar Kameez",
  "Lehenga",
  "Kurta-Pajama",
  "Sherwani",
  "Dhoti",
  "Anarkali",
  "Indo-Western",
  "Ghagra Choli",
  "Pathani suit",
] as const;

export const ACCESSORIES_REGULAR = [
  "None",
  "Glasses",
  "Jewelry",
  "Hats",
  "Bags",
  "Weapons (non-gore)",
] as const;

export const ACCESSORIES_SUBCONTINENT_REGULAR = [
  "Bindi",
  "Maang Tikka",
  "Jhumka earrings",
  "Nose ring (nath)",
  "Bangles",
  "Anklets",
  "Dupatta",
  "Turban",
  "Mangalsutra",
] as const;

export const BODY_DETAILS_REGULAR = [
  "Normal proportions",
  "Athletic",
  "Slim",
  "Curvy (clothed)",
  "South Asian features",
] as const;

export const POSES_REGULAR = [
  "Standing",
  "Sitting",
  "Walking",
  "Portrait",
  "Action",
  "Relaxed",
  "Dynamic",
  "Classical dance pose",
] as const;

export const VIOLENCE_REGULAR = ["None", "Light scratches", "Minor bruises"] as const;

/* ------------------------------------------------------------------ */
/* Uncensored Mode                                                     */
/* ------------------------------------------------------------------ */

export const EXPRESSIONS_UNCENSORED = [
  "Neutral",
  "Happy",
  "Seductive",
  "Aroused",
  "Moaning",
  "Ecstatic",
  "Dominant",
  "Submissive",
  "Coy",
] as const;

export const OUTFITS_UNCENSORED = [
  "Fully clothed",
  "Partially clothed",
  "Lingerie",
  "Underwear only",
  "Nude",
  "Transparent clothing",
  "Micro bikini",
  "Latex",
  "Bondage gear",
  "Fetish outfits",
] as const;

export const OUTFITS_SUBCONTINENT_UNCENSORED = [
  "Saree (draped / slipped)",
  "Blouse only",
  "Lehenga (open)",
  "Transparent saree",
  "Wet saree",
  "Ghagra (revealing)",
  "Traditional lingerie fusion",
  "Indo-Western lingerie",
  "Nude with jewelry only",
] as const;

export const ACCESSORIES_UNCENSORED = [
  "None",
  "Lingerie",
  "Collars",
  "Restraints",
  "Toys",
  "Body jewelry",
  "Piercings",
  "Tattoos (explicit)",
] as const;

export const ACCESSORIES_SUBCONTINENT_UNCENSORED = [
  "Bindi",
  "Maang Tikka",
  "Jhumka",
  "Nose ring",
  "Heavy bangles",
  "Anklets",
  "Waist chain (kamarbandh)",
  "Toe rings",
  "Traditional jewelry with nude body",
  "Mehndi patterns",
] as const;

export const BODY_DETAILS_UNCENSORED = [
  "Normal proportions",
  "South Asian body features",
  "Enhanced proportions",
  "Detailed breasts",
  "Detailed genitals",
  "Detailed ass",
  "Wet skin",
  "Sweat",
  "Body fluids",
] as const;

export const POSES_UNCENSORED = [
  "Standing",
  "Sitting",
  "Lying down",
  "Arched back",
  "On all fours",
  "Spreading",
  "Sexual positions",
  "Dynamic action",
  "Submissive",
  "Dominant",
  "Classical dance (erotic interpretation)",
] as const;

export const VIOLENCE_UNCENSORED = ["None", "Mild", "Moderate", "Heavy", "Extreme"] as const;

export const NUDITY = ["None", "Topless", "Bottomless", "Full nude", "Partial nude"] as const;

export const SEXUAL_CONTENT = [
  "None",
  "Suggestive",
  "Soft erotic",
  "Explicit sexual",
  "Fetish acts",
] as const;

export const NSFW_LEVELS = [
  { value: 0, label: "Safe", hint: "Fully clothed / safe" },
  { value: 1, label: "Suggestive", hint: "Suggestive / revealing" },
  { value: 2, label: "Lingerie", hint: "Lingerie / partial nude" },
  { value: 3, label: "Nude", hint: "Full nude" },
  { value: 4, label: "Explicit", hint: "Explicit sexual" },
  { value: 5, label: "Extreme", hint: "Extreme / fetish / hardcore" },
] as const;

export const NSFW_LEVEL_MAX = 5;

/* ------------------------------------------------------------------ */
/* Mode helpers                                                        */
/* ------------------------------------------------------------------ */

export interface OptionGroup {
  label: string;
  options: readonly string[];
}

export function clothingGroups(mode: CharacterMode): OptionGroup[] {
  return mode === "uncensored"
    ? [
        { label: "Clothing", options: OUTFITS_UNCENSORED },
        { label: "Subcontinent", options: OUTFITS_SUBCONTINENT_UNCENSORED },
      ]
    : [
        { label: "Clothing", options: OUTFITS_REGULAR },
        { label: "Subcontinent", options: OUTFITS_SUBCONTINENT_REGULAR },
      ];
}

export function accessoryGroups(mode: CharacterMode): OptionGroup[] {
  return mode === "uncensored"
    ? [
        { label: "Accessories", options: ACCESSORIES_UNCENSORED },
        { label: "Subcontinent", options: ACCESSORIES_SUBCONTINENT_UNCENSORED },
      ]
    : [
        { label: "Accessories", options: ACCESSORIES_REGULAR },
        { label: "Subcontinent", options: ACCESSORIES_SUBCONTINENT_REGULAR },
      ];
}

export function expressionOptions(mode: CharacterMode): readonly string[] {
  return mode === "uncensored" ? EXPRESSIONS_UNCENSORED : EXPRESSIONS_REGULAR;
}

export function poseOptions(mode: CharacterMode): readonly string[] {
  return mode === "uncensored" ? POSES_UNCENSORED : POSES_REGULAR;
}

export function bodyDetailOptions(mode: CharacterMode): readonly string[] {
  return mode === "uncensored" ? BODY_DETAILS_UNCENSORED : BODY_DETAILS_REGULAR;
}

export function violenceOptions(mode: CharacterMode): readonly string[] {
  return mode === "uncensored" ? VIOLENCE_UNCENSORED : VIOLENCE_REGULAR;
}

export interface CharacterTemplate {
  id: string;
  label: string;
  text: string;
}

export const PERSONALITY_TEMPLATES_REGULAR: CharacterTemplate[] = [
  {
    id: "scholar",
    label: "The Scholar",
    text: "Curious and patient. Collects vintage books, asks careful questions, and would rather listen than perform.",
  },
  {
    id: "athlete",
    label: "The Athlete",
    text: "Competitive and disciplined. An early-morning runner who treats every day like training.",
  },
  {
    id: "artist",
    label: "The Artist",
    text: "Quiet and observant. Sketches strangers in cafés and notices colour before conversation.",
  },
  {
    id: "diplomat",
    label: "The Diplomat",
    text: "Warm, measured, and hard to rattle. Loves classical music and keeps confidences.",
  },
  {
    id: "explorer",
    label: "The Explorer",
    text: "Restless and optimistic. Always planning the next trip and packing light.",
  },
  {
    id: "host",
    label: "The Host",
    text: "Graceful and hospitable. Proud of family traditions, cooks for friends, never lets a guest leave hungry.",
  },
];

export const PERSONALITY_TEMPLATES_UNCENSORED: CharacterTemplate[] = [
  {
    id: "temptress",
    label: "The Temptress",
    text: "Confident and teasing. Enjoys being watched, sets the pace, and never asks twice.",
  },
  {
    id: "dominant",
    label: "The Dominant",
    text: "Calm and commanding. Speaks softly, expects obedience, and rewards those who listen.",
  },
  {
    id: "submissive",
    label: "The Submissive",
    text: "Shy, eager to please, blushing easily. Follows a lead and waits to be told what happens next.",
  },
  {
    id: "exhibitionist",
    label: "The Exhibitionist",
    text: "Bold and uninhibited. Likes the risk of being seen and dresses (or undresses) for an audience.",
  },
  {
    id: "romantic",
    label: "The Romantic",
    text: "Slow and intimate. Whispers instead of shouting, lingers on skin, and treats desire like a ritual.",
  },
  {
    id: "forbidden",
    label: "The Forbidden",
    text: "Secretive and intense. Meets after hours, keeps the lights low, and never talks about it after.",
  },
];

export const SCENE_NOTE_TEMPLATES_REGULAR: CharacterTemplate[] = [
  {
    id: "rooftop",
    label: "Rooftop café",
    text: "Rooftop café at golden hour, city skyline behind, warm wind, a half-finished cup of chai.",
  },
  {
    id: "library",
    label: "Library aisle",
    text: "Quiet library aisle, afternoon light through tall windows, dust motes, a book held open at the chest.",
  },
  {
    id: "rain-street",
    label: "Rainy street",
    text: "Rain-washed street at dusk, neon reflections on wet stone, walking under a dark umbrella.",
  },
  {
    id: "courtyard",
    label: "Temple courtyard",
    text: "Temple courtyard at dusk, marigold petals on stone, incense smoke, a dupatta lifting in the breeze.",
  },
  {
    id: "studio",
    label: "Portrait studio",
    text: "Clean studio portrait, softbox lighting, seamless grey backdrop, editorial stillness.",
  },
  {
    id: "overlook",
    label: "Mountain overlook",
    text: "Mountain trail overlook, wind in the hair, distant peaks, late-afternoon sun.",
  },
];

export const SCENE_NOTE_TEMPLATES_UNCENSORED: CharacterTemplate[] = [
  {
    id: "hotel",
    label: "Hotel suite",
    text: "Dim hotel suite, rumpled sheets, city lights through sheer curtains, jewellery on the nightstand.",
  },
  {
    id: "steam",
    label: "Steamed bath",
    text: "Candlelit bathroom, steam on the mirror, wet tile, skin still glistening from the shower.",
  },
  {
    id: "balcony",
    label: "Night balcony",
    text: "Private balcony at night, city below, barely dressed, a glass in one hand.",
  },
  {
    id: "silk",
    label: "Silk bedroom",
    text: "Silk-draped bedroom, one warm lamp, jewellery on the dresser, the rest of the clothes on the floor.",
  },
  {
    id: "after-hours",
    label: "After hours",
    text: "Locked office after midnight, desk lamp, blinds half-drawn, the rest of the building empty.",
  },
  {
    id: "wet-terrace",
    label: "Wet terrace",
    text: "Rain-soaked terrace, fabric clinging, thunder in the distance, no one else outside.",
  },
];

export function personalityTemplates(mode: CharacterMode): CharacterTemplate[] {
  return mode === "uncensored"
    ? PERSONALITY_TEMPLATES_UNCENSORED
    : PERSONALITY_TEMPLATES_REGULAR;
}

export function sceneNoteTemplates(mode: CharacterMode): CharacterTemplate[] {
  return mode === "uncensored"
    ? SCENE_NOTE_TEMPLATES_UNCENSORED
    : SCENE_NOTE_TEMPLATES_REGULAR;
}

function flatten(groups: OptionGroup[]): string[] {
  return groups.flatMap((group) => [...group.options]);
}

function clampOption(value: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(value) ? value : fallback;
}

/**
 * When the user switches Regular ⇄ Uncensored, drop any selection that is
 * not legal in the destination mode so the composed prompt cannot leak
 * locked options (e.g. a Regular render never inherits Uncensored clothing).
 */
export function sanitizeSpecForMode(spec: CharacterSpec, mode: CharacterMode): CharacterSpec {
  const next: CharacterSpec = { ...spec, mode };
  next.outfit = clampOption(next.outfit, flatten(clothingGroups(mode)), mode === "uncensored" ? "Fully clothed" : "Casual");
  next.accessories = clampOption(next.accessories, flatten(accessoryGroups(mode)), "None");
  next.expression = clampOption(next.expression, expressionOptions(mode), "Neutral");
  next.pose = clampOption(next.pose, poseOptions(mode), mode === "uncensored" ? "Standing" : "Portrait");
  next.bodyDetails = clampOption(
    next.bodyDetails,
    bodyDetailOptions(mode),
    "Normal proportions",
  );
  next.violence = clampOption(next.violence, violenceOptions(mode), "None");

  if (mode === "normal") {
    next.nudity = "None";
    next.sexualContent = "None";
    next.nsfwLevel = 0;
    if (PERSONALITY_TEMPLATES_UNCENSORED.some((t) => t.text === next.personality)) {
      next.personality = "";
    }
    if (SCENE_NOTE_TEMPLATES_UNCENSORED.some((t) => t.text === next.sceneNotes)) {
      next.sceneNotes = "";
    }
  } else {
    next.nudity = clampOption(next.nudity, NUDITY, "None");
    next.sexualContent = clampOption(next.sexualContent, SEXUAL_CONTENT, "None");
    next.nsfwLevel = Math.min(NSFW_LEVEL_MAX, Math.max(0, Math.trunc(next.nsfwLevel) || 0));
  }

  return next;
}

/* ------------------------------------------------------------------ */
/* Look presets — the inspiration grid on the Appearance step          */
/* ------------------------------------------------------------------ */

export interface LookPreset {
  id: string;
  label: string;
  src: string;
  prompt: string;
}

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: "editorial",
    label: "Editorial",
    src: "/character/look-editorial.jpg",
    prompt: "editorial fashion look with polished styling",
  },
  {
    id: "natural",
    label: "Natural",
    src: "/character/look-natural.jpg",
    prompt: "natural, minimal-makeup everyday look",
  },
  {
    id: "golden",
    label: "Golden Hour",
    src: "/character/look-golden.jpg",
    prompt: "warm golden-hour glow with soft backlight",
  },
  {
    id: "urban",
    label: "Urban",
    src: "/character/look-urban.jpg",
    prompt: "modern urban look with city energy",
  },
  {
    id: "studio",
    label: "Studio",
    src: "/character/look-studio.jpg",
    prompt: "clean studio portrait with softbox lighting",
  },
  {
    id: "moody",
    label: "Moody",
    src: "/character/look-moody.jpg",
    prompt: "moody cinematic look with dramatic shadows",
  },
];

export function lookById(id: string): LookPreset | undefined {
  return LOOK_PRESETS.find((look) => look.id === id);
}

/* ------------------------------------------------------------------ */
/* Prompt composition                                                  */
/* ------------------------------------------------------------------ */

const GENDER_NOUN: Record<string, string> = {
  Female: "woman",
  Male: "man",
  "Non-binary": "person",
};

const AGE_PROMPT: Record<string, string> = {
  "Adult (18+)": "adult",
  "Young Adult (18–24)": "young adult",
  "Adult (25–39)": "adult",
  "Mature (40–59)": "middle-aged adult",
  "Senior (60+)": "senior adult",
};

const NSFW_LEVEL_PROMPT: Record<number, string> = {
  0: "fully clothed, safe for work",
  1: "suggestive, revealing clothing",
  2: "lingerie, partial nude",
  3: "full nude",
  4: "explicit sexual content",
  5: "extreme fetish, hardcore",
};

const NUDE_OUTFITS = new Set([
  "Nude",
  "Nude with jewelry only",
]);

/**
 * Fold every wizard choice into one descriptive prompt for the render
 * provider. The user's own prompt always leads; the attribute selections
 * read like a character sheet after it. Characters are always framed as
 * adults — age options contain no minors and "adult" is stated explicitly.
 */
export function composeCharacterPrompt(spec: CharacterSpec): string {
  const parts: string[] = [];
  const uncensored = spec.mode === "uncensored";

  const base = spec.prompt.trim();
  if (base) parts.push(base);

  const noun = GENDER_NOUN[spec.gender] ?? "person";
  const age = AGE_PROMPT[spec.age] ?? "adult";
  parts.push(`portrait of an adult ${age} ${noun}, 18+`);

  const tone = SKIN_TONES.find((t) => t.id === spec.skinTone);
  if (tone) parts.push(`${tone.prompt} skin`);

  if (spec.faceShape && spec.faceShape !== "Oval") parts.push(`${spec.faceShape.toLowerCase()} face shape`);
  if (spec.facialFeatures && spec.facialFeatures !== "Natural")
    parts.push(spec.facialFeatures.toLowerCase());
  if (spec.expression && spec.expression !== "Neutral")
    parts.push(`${spec.expression.toLowerCase()} expression`);

  parts.push(`${spec.eyeShape.toLowerCase()} ${spec.eyeColor.toLowerCase()} eyes`);
  parts.push(`${spec.hairColor.toLowerCase()} hair, ${spec.hairStyle.toLowerCase()}`);

  if (spec.bodyType && spec.bodyType !== "Average") parts.push(`${spec.bodyType.toLowerCase()} body`);
  if (spec.build && spec.build !== "Average") parts.push(`${spec.build.toLowerCase()} build`);
  if (spec.bodyDetails && spec.bodyDetails !== "Normal proportions")
    parts.push(spec.bodyDetails.toLowerCase());
  if (spec.height) parts.push(`${spec.height.replace(/\s*\(.*\)/, "")} tall`);

  if (uncensored) {
    const level = NSFW_LEVELS.find((item) => item.value === spec.nsfwLevel);
    if (level) parts.push(`NSFW level ${level.value} (${NSFW_LEVEL_PROMPT[level.value]})`);
    if (spec.nudity && spec.nudity !== "None") parts.push(spec.nudity.toLowerCase());
    if (spec.sexualContent && spec.sexualContent !== "None")
      parts.push(spec.sexualContent.toLowerCase());

    if (NUDE_OUTFITS.has(spec.outfit) || spec.nudity === "Full nude") {
      parts.push("nude");
      if (spec.outfit === "Nude with jewelry only") parts.push("wearing jewelry only");
    } else if (spec.outfit && spec.outfit !== "Fully clothed") {
      parts.push(`wearing ${spec.outfit.toLowerCase()}`);
    } else if (spec.nsfwLevel === 0) {
      parts.push("wearing fully clothed outfit");
    }
  } else {
    parts.push(`wearing ${spec.outfit.toLowerCase()}, fully clothed`);
  }

  if (spec.accessories && spec.accessories !== "None")
    parts.push(`with ${spec.accessories.toLowerCase()}`);

  if (spec.pose) parts.push(`${spec.pose.toLowerCase()} pose`);
  if (spec.violence && spec.violence !== "None") parts.push(spec.violence.toLowerCase());
  if (spec.tattoos) parts.push("visible tattoos");
  if (spec.piercings) parts.push("piercings");
  if (spec.facialHair) parts.push("facial hair");

  if (spec.personality.trim()) parts.push(`vibe of someone who is ${spec.personality.trim()}`);
  if (spec.sceneNotes.trim()) parts.push(spec.sceneNotes.trim());

  const look = lookById(spec.look);
  if (look) parts.push(look.prompt);

  return parts
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** Blocks sexual content outright — applied in Regular Mode. */
const NSFW_NEGATIVE =
  "nsfw, nude, nudity, topless, bottomless, sexual, explicit, erotic, lingerie, fetish, suggestive, underwear, underage, minor, child, teen";

/** Uncensored Mode still never waives protection of minors. */
const MINOR_NEGATIVE = "underage, minor, child, teen, under 18";

/**
 * Mode shapes how the request is sent:
 * - Regular Mode: safety checker on, prompt auto-enhancement, NSFW locked at 0,
 *   negative prompt blocks all NSFW terms.
 * - Uncensored Mode: safety checker off, prompt sent as composed, NSFW slider
 *   0–5, negative prompt only blocks underage terms. Content is tagged
 *   Uncensored in History.
 */
export function characterGenerationSettings(spec: CharacterSpec, modelId?: string) {
  const uncensored = spec.mode === "uncensored";
  return {
    kind: "image" as const,
    aspect: spec.aspect,
    resolution: spec.resolution,
    style: spec.style,
    count: 4,
    enhance: !uncensored,
    safe: !uncensored,
    negativePrompt: uncensored ? MINOR_NEGATIVE : NSFW_NEGATIVE,
    seed: "",
    duration: "5s" as const,
    ...(modelId ? { modelId } : {}),
  };
}
