import type { AspectKey, ResolutionKey } from "./constants";
import type { LoraSelection } from "./types";

/* ------------------------------------------------------------------ */
/* Character spec                                                      */
/* ------------------------------------------------------------------ */

/**
 * Everything the wizard collects — identity only. Scene and render knobs
 * (aspect, resolution, pose, scene notes…) live at generation time, so one
 * saved character can be dropped into any Solo scene or Story frame.
 * Selects store human-readable values that are folded straight into the
 * composed prompt, so there is one source of truth per option.
 *
 * Characters are strictly adults (18+). Adult options (revealing outfits,
 * adult expressions, NSFW level) exist in the merged option tables but are
 * gated by the global Uncensored Mode switch in Settings — the same single
 * gate Solo and Story already use.
 */
export interface CharacterSpec {
  // Step 1 — Character
  prompt: string;
  style: string;

  // Step 2 — Appearance
  gender: string;
  /** Exact age in years (AGE_MIN–AGE_MAX). Characters are always adults. */
  age: number;
  /** From ETHNICITIES. "Not specified" is never folded into the prompt. */
  ethnicity: string;
  /** From COUNTRIES. "Not specified" is never folded into the prompt. */
  country: string;
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
  build: string;

  // Step 3 — Advanced
  bodyDetails: string;
  tattoos: boolean;
  piercings: boolean;
  facialHair: boolean;
  personality: string;
  /** 0–5. Forced to 0 while the global Uncensored Mode gate is off. */
  nsfwLevel: number;
  /** Id of a look preset from the inspiration grid, or "" when untouched. */
  look: string;
}

export const DEFAULT_CHARACTER_SPEC: CharacterSpec = {
  prompt: "",
  style: "Realistic",

  gender: "Female",
  age: 25,
  ethnicity: "Not specified",
  country: "Not specified",
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
  build: "Slim",

  bodyDetails: "Normal proportions",
  tattoos: false,
  piercings: false,
  facialHair: false,
  personality: "",
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

/** Characters are strictly adults: the age slider spans adult years only. */
export const AGE_MIN = 18;
export const AGE_MAX = 80;
const DEFAULT_AGE = 25;

/** Keep a value a whole adult year, whatever a stale form or store hands in. */
export function clampAge(age: number): number {
  const n = Math.trunc(Number(age));
  if (!Number.isFinite(n)) return DEFAULT_AGE;
  return Math.min(AGE_MAX, Math.max(AGE_MIN, n));
}

/** Coarse bucket for the current age, shown as a hint under the slider. */
export function ageBucketLabel(age: number): string {
  if (age < 25) return "Young adult (18–24)";
  if (age < 40) return "Adult (25–39)";
  if (age < 60) return "Mature (40–59)";
  return "Senior (60+)";
}

export const GENDERS = ["Female", "Male", "Non-binary"] as const;

export const BUILDS = ["Slim", "Athletic", "Average", "Muscular", "Curvy", "Plus-size"] as const;

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

export const ETHNICITIES = [
  "Not specified",
  "South Asian",
  "East Asian",
  "Southeast Asian",
  "Middle Eastern",
  "Central Asian",
  "White / European",
  "Black / African",
  "Afro-Caribbean",
  "Latino / Hispanic",
  "Mixed",
  "Pacific Islander",
  "Indigenous",
] as const;

export const COUNTRIES = [
  "Not specified",
  "Afghanistan",
  "Albania",
  "Algeria",
  "Andorra",
  "Angola",
  "Antigua and Barbuda",
  "Argentina",
  "Armenia",
  "Australia",
  "Austria",
  "Azerbaijan",
  "Bahamas",
  "Bahrain",
  "Bangladesh",
  "Barbados",
  "Belarus",
  "Belgium",
  "Belize",
  "Benin",
  "Bhutan",
  "Bolivia",
  "Bosnia and Herzegovina",
  "Botswana",
  "Brazil",
  "Brunei",
  "Bulgaria",
  "Burkina Faso",
  "Burundi",
  "Cabo Verde",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Central African Republic",
  "Chad",
  "Chile",
  "China",
  "Colombia",
  "Comoros",
  "Congo (Republic)",
  "Congo (Democratic Republic)",
  "Costa Rica",
  "Côte d'Ivoire",
  "Croatia",
  "Cuba",
  "Cyprus",
  "Czechia",
  "Denmark",
  "Djibouti",
  "Dominica",
  "Dominican Republic",
  "Ecuador",
  "Egypt",
  "El Salvador",
  "Equatorial Guinea",
  "Eritrea",
  "Estonia",
  "Eswatini",
  "Ethiopia",
  "Fiji",
  "Finland",
  "France",
  "Gabon",
  "Gambia",
  "Georgia",
  "Germany",
  "Ghana",
  "Greece",
  "Grenada",
  "Guatemala",
  "Guinea",
  "Guinea-Bissau",
  "Guyana",
  "Haiti",
  "Honduras",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Jamaica",
  "Japan",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Kiribati",
  "Korea (North)",
  "Korea (South)",
  "Kosovo",
  "Kuwait",
  "Kyrgyzstan",
  "Laos",
  "Latvia",
  "Lebanon",
  "Lesotho",
  "Liberia",
  "Libya",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Madagascar",
  "Malawi",
  "Malaysia",
  "Maldives",
  "Mali",
  "Malta",
  "Marshall Islands",
  "Mauritania",
  "Mauritius",
  "Mexico",
  "Micronesia",
  "Moldova",
  "Monaco",
  "Mongolia",
  "Montenegro",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nauru",
  "Nepal",
  "Netherlands",
  "New Zealand",
  "Nicaragua",
  "Niger",
  "Nigeria",
  "North Macedonia",
  "Norway",
  "Oman",
  "Pakistan",
  "Palau",
  "Palestine",
  "Panama",
  "Papua New Guinea",
  "Paraguay",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Qatar",
  "Romania",
  "Russia",
  "Rwanda",
  "Saint Kitts and Nevis",
  "Saint Lucia",
  "Saint Vincent and the Grenadines",
  "Samoa",
  "San Marino",
  "Sao Tome and Principe",
  "Saudi Arabia",
  "Senegal",
  "Serbia",
  "Seychelles",
  "Sierra Leone",
  "Singapore",
  "Slovakia",
  "Slovenia",
  "Solomon Islands",
  "Somalia",
  "South Africa",
  "South Sudan",
  "Spain",
  "Sri Lanka",
  "Sudan",
  "Suriname",
  "Sweden",
  "Switzerland",
  "Syria",
  "Taiwan",
  "Tajikistan",
  "Tanzania",
  "Thailand",
  "Timor-Leste",
  "Togo",
  "Tonga",
  "Trinidad and Tobago",
  "Tunisia",
  "Turkey",
  "Turkmenistan",
  "Tuvalu",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Uruguay",
  "Uzbekistan",
  "Vanuatu",
  "Vatican City",
  "Venezuela",
  "Vietnam",
  "Yemen",
  "Zambia",
  "Zimbabwe",
] as const;

/* ------------------------------------------------------------------ */
/* Merged option tables — everyday options always, adult options       */
/* only while the global Uncensored Mode gate is on.                   */
/* ------------------------------------------------------------------ */

const EVERYDAY_OUTFITS = [
  "Casual",
  "Formal",
  "Fantasy armor",
  "Sportswear",
  "Uniform (adult)",
  "Traditional",
  "Modern streetwear",
  "Business attire",
] as const;

const ADULT_OUTFITS = [
  "Partially clothed",
  "Lingerie",
  "Underwear only",
  "Transparent clothing",
  "Micro bikini",
  "Latex",
  "Bondage gear",
  "Fetish outfits",
  "Nude",
] as const;

const SUBCONTINENT_OUTFITS = [
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

const SUBCONTINENT_ADULT_OUTFITS = [
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

const EVERYDAY_ACCESSORIES = [
  "None",
  "Glasses",
  "Jewelry",
  "Hats",
  "Bags",
  "Weapons (non-gore)",
] as const;

const ADULT_ACCESSORIES = [
  "Collars",
  "Restraints",
  "Toys",
  "Body jewelry",
  "Piercings",
  "Tattoos (explicit)",
] as const;

const SUBCONTINENT_ACCESSORIES = [
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

const SUBCONTINENT_ADULT_ACCESSORIES = [
  "Jhumka",
  "Nose ring",
  "Heavy bangles",
  "Waist chain (kamarbandh)",
  "Toe rings",
  "Traditional jewelry with nude body",
  "Mehndi patterns",
] as const;

const SAFE_EXPRESSIONS = [
  "Neutral",
  "Happy",
  "Serious",
  "Smiling",
  "Confident",
  "Thoughtful",
  "Graceful",
] as const;

const ADULT_EXPRESSIONS = [
  "Seductive",
  "Aroused",
  "Moaning",
  "Ecstatic",
  "Dominant",
  "Submissive",
  "Coy",
] as const;

const SAFE_BODY_DETAILS = [
  "Normal proportions",
  "Athletic",
  "Slim",
  "Curvy (clothed)",
  "South Asian features",
] as const;

const ADULT_BODY_DETAILS = [
  "South Asian body features",
  "Enhanced proportions",
  "Detailed breasts",
  "Detailed genitals",
  "Detailed ass",
  "Wet skin",
  "Sweat",
  "Body fluids",
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
/* Gated option accessors                                              */
/* ------------------------------------------------------------------ */

export interface OptionGroup {
  label: string;
  options: readonly string[];
}

export function clothingGroups(uncensored: boolean): OptionGroup[] {
  return [
    { label: "Clothing", options: EVERYDAY_OUTFITS },
    ...(uncensored ? [{ label: "Adult (18+)", options: ADULT_OUTFITS }] : []),
    { label: "Subcontinent", options: SUBCONTINENT_OUTFITS },
    ...(uncensored ? [{ label: "Subcontinent (18+)", options: SUBCONTINENT_ADULT_OUTFITS }] : []),
  ];
}

export function accessoryGroups(uncensored: boolean): OptionGroup[] {
  return [
    { label: "Accessories", options: EVERYDAY_ACCESSORIES },
    ...(uncensored ? [{ label: "Adult (18+)", options: ADULT_ACCESSORIES }] : []),
    { label: "Subcontinent", options: SUBCONTINENT_ACCESSORIES },
    ...(uncensored ? [{ label: "Subcontinent (18+)", options: SUBCONTINENT_ADULT_ACCESSORIES }] : []),
  ];
}

export function expressionOptions(uncensored: boolean): readonly string[] {
  return uncensored ? [...SAFE_EXPRESSIONS, ...ADULT_EXPRESSIONS] : SAFE_EXPRESSIONS;
}

export function bodyDetailOptions(uncensored: boolean): readonly string[] {
  return uncensored ? [...SAFE_BODY_DETAILS, ...ADULT_BODY_DETAILS] : SAFE_BODY_DETAILS;
}

export interface CharacterTemplate {
  id: string;
  label: string;
  text: string;
}

export const PERSONALITY_TEMPLATES_SAFE: CharacterTemplate[] = [
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

export const PERSONALITY_TEMPLATES_ADULT: CharacterTemplate[] = [
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

export function personalityTemplates(uncensored: boolean): CharacterTemplate[] {
  return uncensored
    ? [...PERSONALITY_TEMPLATES_SAFE, ...PERSONALITY_TEMPLATES_ADULT]
    : PERSONALITY_TEMPLATES_SAFE;
}

function flatten(groups: OptionGroup[]): string[] {
  return groups.flatMap((group) => [...group.options]);
}

function clampOption(value: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Clamp a spec to what the current gate allows: while Uncensored Mode is off,
 * any adult selection falls back to its safe equivalent and NSFW locks at 0.
 * Used when the gate changes under a loaded spec and before reusing a saved
 * character in a safe scene.
 */
export function sanitizeSpec(spec: CharacterSpec, uncensored: boolean): CharacterSpec {
  const next: CharacterSpec = { ...spec };
  next.age = clampAge(next.age);
  next.outfit = clampOption(next.outfit, flatten(clothingGroups(uncensored)), "Casual");
  next.accessories = clampOption(next.accessories, flatten(accessoryGroups(uncensored)), "None");
  next.expression = clampOption(next.expression, expressionOptions(uncensored), "Neutral");
  next.bodyDetails = clampOption(
    next.bodyDetails,
    bodyDetailOptions(uncensored),
    "Normal proportions",
  );

  if (!uncensored) {
    next.nsfwLevel = 0;
    if (PERSONALITY_TEMPLATES_ADULT.some((t) => t.text === next.personality)) {
      next.personality = "";
    }
  } else {
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
 * The character-identity text: who this person is, what they look like and
 * wear. Composed from the spec alone — no scene, pose or render settings —
 * so the same anchor keeps the character consistent wherever it is reused.
 */
export function composeCharacterAnchor(spec: CharacterSpec): string {
  return `portrait of ${composeAnchorBody(spec)}`;
}

/** The anchor without its "portrait of" lead — the reusable half that
 * multi-character scenes label per person ("First: …; Second: …"). */
function composeAnchorBody(spec: CharacterSpec): string {
  const parts: string[] = [];

  const noun = GENDER_NOUN[spec.gender] ?? "person";
  const age = clampAge(spec.age);
  const ethnicity =
    spec.ethnicity && spec.ethnicity !== "Not specified"
      ? ` ${spec.ethnicity.toLowerCase()}`
      : "";
  const origin =
    spec.country && spec.country !== "Not specified" ? ` from ${spec.country}` : "";
  parts.push(`an adult ${age}-year-old${ethnicity} ${noun}${origin}, 18+`);

  const tone = SKIN_TONES.find((t) => t.id === spec.skinTone);
  if (tone) parts.push(`${tone.prompt} skin`);

  if (spec.faceShape && spec.faceShape !== "Oval")
    parts.push(`${spec.faceShape.toLowerCase()} face shape`);
  if (spec.facialFeatures && spec.facialFeatures !== "Natural")
    parts.push(spec.facialFeatures.toLowerCase());
  if (spec.expression && spec.expression !== "Neutral")
    parts.push(`${spec.expression.toLowerCase()} expression`);

  parts.push(`${spec.eyeShape.toLowerCase()} ${spec.eyeColor.toLowerCase()} eyes`);
  parts.push(`${spec.hairColor.toLowerCase()} hair, ${spec.hairStyle.toLowerCase()}`);

  if (spec.build && spec.build !== "Average") parts.push(`${spec.build.toLowerCase()} build`);
  if (spec.bodyDetails && spec.bodyDetails !== "Normal proportions")
    parts.push(spec.bodyDetails.toLowerCase());

  if (spec.nsfwLevel > 0) {
    const level = NSFW_LEVELS.find((item) => item.value === spec.nsfwLevel);
    if (level) parts.push(`NSFW level ${level.value} (${NSFW_LEVEL_PROMPT[level.value]})`);
  }

  if (NUDE_OUTFITS.has(spec.outfit)) {
    parts.push("nude");
    if (spec.outfit === "Nude with jewelry only") parts.push("wearing jewelry only");
  } else if (spec.outfit) {
    parts.push(`wearing ${spec.outfit.toLowerCase()}${spec.nsfwLevel === 0 ? ", fully clothed" : ""}`);
  }

  if (spec.accessories && spec.accessories !== "None")
    parts.push(`with ${spec.accessories.toLowerCase()}`);

  if (spec.tattoos) parts.push("visible tattoos");
  if (spec.piercings) parts.push("piercings");
  if (spec.facialHair) parts.push("facial hair");

  if (spec.personality.trim()) parts.push(`vibe of someone who is ${spec.personality.trim()}`);

  const look = lookById(spec.look);
  if (look) parts.push(look.prompt);

  return parts
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/**
 * Fold the wizard choices into one descriptive prompt for the character
 * render: the user's own prompt leads, the identity anchor follows.
 */
export function composeCharacterPrompt(spec: CharacterSpec): string {
  const base = spec.prompt.trim();
  const anchor = composeCharacterAnchor(spec);
  return base ? `${base}, ${anchor}` : anchor;
}

/**
 * Reuse path for Solo scenes and Story frames: the saved character's
 * sanitized anchor leads, the user's scene prompt follows. With `uncensored`
 * off, an adult character is clamped to its safe equivalent first, so adult
 * wording can never leak into a safe render.
 */
export function composeSceneWithCharacter(
  scenePrompt: string,
  spec: CharacterSpec | null,
  uncensored: boolean,
): string {
  const scene = scenePrompt.trim();
  if (!spec) return scene;
  const anchor = composeCharacterAnchor(sanitizeSpec(spec, uncensored));
  return scene ? `${anchor}, ${scene}` : anchor;
}

/**
 * Text-only identity is where image models are weakest, and it degrades fast
 * as subjects pile up — three already reads as mush on most models.
 */
export const MAX_SCENE_CHARACTERS = 3;

const ORDINALS = ["First", "Second", "Third"] as const;
const COUNT_WORDS = ["", "one", "two", "three"] as const;

/**
 * Multi-character reuse path: each saved character's sanitized identity is
 * labeled per person ("First: …; Second: …") instead of merged into one
 * singular "portrait of …" anchor, so the model keeps the subjects distinct.
 * Order follows the caller's array; entries the user deselected arrive as
 * already-filtered input, nulls are tolerated and dropped.
 */
export function composeSceneWithCharacters(
  scenePrompt: string,
  specs: readonly (CharacterSpec | null | undefined)[],
  uncensored: boolean,
): string {
  const scene = scenePrompt.trim();
  const cast = specs
    .filter((spec): spec is CharacterSpec => Boolean(spec))
    .slice(0, MAX_SCENE_CHARACTERS);
  if (cast.length === 0) return scene;
  if (cast.length === 1) return composeSceneWithCharacter(scene, cast[0], uncensored);

  const bodies = cast.map(
    (spec) => composeAnchorBody(sanitizeSpec(spec, uncensored)),
  );
  const lead = `Scene with ${COUNT_WORDS[cast.length]} characters.`;
  const people = bodies
    .map((body, index) => `${ORDINALS[index]}: ${body}`)
    .join(". ");
  return scene ? `${lead} ${people}. ${scene}` : `${lead} ${people}`;
}

/** Blocks sexual content outright — applied while Uncensored Mode is off. */
const NSFW_NEGATIVE =
  "nsfw, nude, nudity, topless, bottomless, sexual, explicit, erotic, lingerie, fetish, suggestive, underwear, underage, minor, child, teen";

/** Uncensored Mode still never waives protection of minors. */
const MINOR_NEGATIVE = "underage, minor, child, teen, under 18";

export interface CharacterRenderParams {
  aspect: AspectKey;
  resolution: ResolutionKey;
  modelId?: string;
  /** LoRA adapters for the render — generation-time styling, never part of
   * the character identity. The server drops entries the model rejects. */
  loras?: LoraSelection[];
}

/**
 * How a character render is sent: safety, enhancement and the negative
 * prompt follow the global Uncensored Mode gate; aspect, resolution and the
 * model are generation-time choices, not part of the character identity.
 */
export function characterGenerationSettings(
  spec: CharacterSpec,
  params: CharacterRenderParams,
  uncensored: boolean,
) {
  return {
    kind: "image" as const,
    aspect: params.aspect,
    resolution: params.resolution,
    style: spec.style,
    count: 4,
    enhance: !uncensored,
    safe: !uncensored,
    negativePrompt: uncensored ? MINOR_NEGATIVE : NSFW_NEGATIVE,
    seed: "",
    duration: "5s" as const,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.loras?.length ? { loras: params.loras } : {}),
  };
}
