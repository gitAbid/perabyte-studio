import type { AspectKey, ResolutionKey } from "./constants";

/* ------------------------------------------------------------------ */
/* Character spec                                                      */
/* ------------------------------------------------------------------ */

export type CharacterMode = "normal" | "uncensored";

/**
 * Everything the wizard collects. Selects store human-readable values that
 * are folded straight into the composed prompt, so there is one source of
 * truth per option and no separate label/prompt mapping to maintain.
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
  tattoos: boolean;
  piercings: boolean;
  facialHair: boolean;
  personality: string;
  pose: string;
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
  tattoos: false,
  piercings: false,
  facialHair: false,
  personality: "",
  pose: "",
  look: "",
};

/* ------------------------------------------------------------------ */
/* Option tables                                                       */
/* ------------------------------------------------------------------ */

export const GENDERS = ["Female", "Male", "Non-binary"] as const;

export const AGES = [
  "Young Adult (18–24)",
  "Adult (18+)",
  "Mature (40–59)",
  "Senior (60+)",
] as const;

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
  "Sharp cheekbones",
  "Soft rounded",
  "Dimpled smile",
] as const;

export const EXPRESSIONS = ["Neutral", "Warm smile", "Confident", "Serene", "Playful", "Serious"] as const;

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

export const OUTFITS = [
  "Casual",
  "Streetwear",
  "Business attire",
  "Elegant evening dress",
  "Sporty activewear",
  "Fantasy armor",
  "Cosplay costume",
  "Traditional attire",
] as const;

export const ACCESSORIES = [
  "None",
  "Glasses",
  "Statement jewelry",
  "Earrings",
  "Necklace",
  "Hat",
  "Scarf",
] as const;

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
  "Young Adult (18–24)": "young adult",
  "Adult (18+)": "adult",
  "Mature (40–59)": "middle-aged",
  "Senior (60+)": "senior",
};

/**
 * Fold every wizard choice into one descriptive prompt for the render
 * provider. The user's own prompt always leads; the attribute selections
 * read like a character sheet after it.
 */
export function composeCharacterPrompt(spec: CharacterSpec): string {
  const parts: string[] = [];

  const base = spec.prompt.trim();
  if (base) parts.push(base);

  const noun = GENDER_NOUN[spec.gender] ?? "person";
  const age = AGE_PROMPT[spec.age] ?? "adult";
  parts.push(`portrait of an ${age} ${noun}`);

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
  if (spec.height) parts.push(`${spec.height.replace(/\s*\(.*\)/, "")} tall`);

  parts.push(`wearing ${spec.outfit.toLowerCase()}`);
  if (spec.accessories && spec.accessories !== "None")
    parts.push(`with ${spec.accessories.toLowerCase()}`);

  if (spec.tattoos) parts.push("visible tattoos");
  if (spec.piercings) parts.push("piercings");
  if (spec.facialHair) parts.push("facial hair");

  if (spec.personality.trim()) parts.push(`vibe of someone who is ${spec.personality.trim()}`);
  if (spec.pose.trim()) parts.push(spec.pose.trim());

  const look = lookById(spec.look);
  if (look) parts.push(look.prompt);

  return parts
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/**
 * Mode shapes how the request is sent, not what it is allowed to depict:
 * Normal Mode uses the provider's prompt auto-enhancement (it rewrites the
 * prompt for quality), Uncensored Mode sends the description exactly as
 * composed for full creative control. Content policy is enforced upstream
 * by the provider in both modes.
 */
export function characterGenerationSettings(spec: CharacterSpec) {
  return {
    kind: "image" as const,
    aspect: spec.aspect,
    resolution: spec.resolution,
    style: spec.style,
    count: 4,
    enhance: spec.mode === "normal",
    negativePrompt: "",
    seed: "",
    duration: "5s" as const,
  };
}
