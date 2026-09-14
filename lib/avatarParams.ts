import type { CharacterSpec } from "./character";
import { SKIN_TONES } from "./character";

/* ------------------------------------------------------------------ */
/* Live 3D avatar preview mapping                                      */
/*                                                                     */
/* Pure functions translating a CharacterSpec into render parameters   */
/* for the MakeHuman-based preview model (public/character/preview/    */
/* avatar.glb). Morph names refer to the shape keys baked by           */
/* scripts/generate_avatar_assets.py — see scripts/AVATAR_PIPELINE.md. */
/* ------------------------------------------------------------------ */

export type PreviewPoseId =
  | "standing"
  | "sitting"
  | "walking"
  | "portrait"
  | "action"
  | "relaxed"
  | "dynamic"
  | "dance"
  | "lying"
  | "arched"
  | "allfours"
  | "spreading"
  | "kneeling"
  | "dominant";

export type LookLightingId =
  | "editorial"
  | "natural"
  | "golden"
  | "urban"
  | "studio"
  | "moody";

export type MaterialTreatment = "standard" | "toon" | "clay";

export type Coverage = "full" | "partial" | "minimal" | "none";

export interface AvatarParams {
  skinHex: string;
  hairColorHex: string;
  /** GLB object name of the selected hair style, or null for bald. */
  hairMesh: string | null;
  /** Iris texture URL under /character/preview/eyes/. */
  eyeTexture: string;
  /** Morph target name → influence 0..1. */
  morphs: Record<string, number>;
  pose: PreviewPoseId;
  /** Garment mesh name in the GLB (null when body-only). */
  garmentMesh: string | null;
  garmentTint: string;
  garmentOpacity: number;
  garmentGloss: boolean;
  coverage: Coverage;
  /** Body is abstracted to a silhouette (non-explicit) — badge shown. */
  silhouetteOnly: boolean;
  shoes: boolean;
  hat: boolean;
  piercings: boolean;
  lighting: LookLightingId;
  material: MaterialTreatment;
  /** Non-visual selections surfaced as chips under the canvas. */
  notes: string[];
}

/* ------------------------------ colors ------------------------------ */

const HAIR_COLOR_HEX: Record<string, string> = {
  Black: "#221e1c",
  "Dark Brown": "#3c2a1c",
  "Chestnut Brown": "#6b4226",
  Blonde: "#dfc27a",
  Auburn: "#713a22",
  Red: "#a53a26",
  "Silver Grey": "#c9c9d1",
  "Pastel Pink": "#efb9d0",
};

const EYE_TEXTURE: Record<string, string> = {
  Brown: "/character/preview/eyes/brown_eye.png",
  Hazel: "/character/preview/eyes/brownlight_eye.png",
  Blue: "/character/preview/eyes/blue_eye.png",
  Green: "/character/preview/eyes/green_eye.png",
  Grey: "/character/preview/eyes/grey_eye.png",
  Amber: "/character/preview/eyes/brownlight_eye.png",
  Dark: "/character/preview/eyes/brown_eye.png",
};

function skinHex(id: string): string {
  return SKIN_TONES.find((tone) => tone.id === id)?.hex ?? "#e0ac82";
}

/* ------------------------------ morphs ------------------------------ */

/** Axis index (0..5) → signed influence; index 2/3 ≈ neutral midpoint. */
function axisInfluence(index: number): { down: number; up: number } {
  // 6 stops, neutral between 2 and 3.
  const t = index <= 2 ? (2 - index) / 2 : 0; // below neutral
  const u = index >= 3 ? (index - 3) / 2 : 0; // above neutral
  return { down: t, up: u };
}

const AGE_MORPHS: Record<string, Record<string, number>> = {
  "Adult (18+)": {},
  "Young Adult (18–24)": { m_age_young: 0.7 },
  "Adult (25–39)": { m_age_young: 0.25 },
  "Mature (40–59)": { m_age_old: 0.55 },
  "Senior (60+)": { m_age_old: 1 },
};

const FACE_SHAPE_MORPHS: Record<string, Record<string, number>> = {
  Oval: {},
  Round: { face_round: 1 },
  Square: { face_square: 1 },
  Heart: { face_heart: 1 },
  Diamond: { face_diamond: 1 },
  Long: { face_long: 1 },
};

const EYE_SHAPE_MORPHS: Record<string, Record<string, number>> = {
  Almond: {},
  Round: { eye_round__l: 1, eye_round__r: 1 },
  Hooded: { eye_hooded__l: 1, eye_hooded__r: 1 },
  Monolid: { eye_monolid__l: 1, eye_monolid__r: 1 },
  Upturned: { eye_upturned__l: 0.8, eye_upturned__r: 0.8 },
};

/** Composed mouth/brow/cheek weights per expression (both mode lists). */
const EXPRESSION_MORPHS: Record<string, Record<string, number>> = {
  Neutral: {},
  Happy: { expr_smile: 0.75, expr_cheeks__l: 0.6, expr_cheeks__r: 0.6 },
  Serious: { expr_mouth_down: 0.35 },
  Smiling: { expr_smile: 1, expr_cheeks__l: 0.85, expr_cheeks__r: 0.85 },
  Confident: { expr_smile: 0.45, expr_mouth_down: 0.15 },
  Thoughtful: { expr_mouth_down: 0.2, expr_cheeks__l: 0.2, expr_cheeks__r: 0.2 },
  Graceful: { expr_smile: 0.35 },
  Seductive: { expr_smile: 0.5, eye_hooded__l: 0.55, eye_hooded__r: 0.55 },
  Aroused: { expr_smile: 0.55, eye_hooded__l: 0.65, eye_hooded__r: 0.65, expr_cheeks__l: 0.4, expr_cheeks__r: 0.4 },
  Moaning: { expr_mouth_down: 0.45, eye_hooded__l: 0.7, eye_hooded__r: 0.7 },
  Ecstatic: { expr_smile: 0.9, eye_hooded__l: 0.75, eye_hooded__r: 0.75, expr_cheeks__l: 0.7, expr_cheeks__r: 0.7 },
  Dominant: { expr_smile: 0.3, expr_mouth_down: 0.3 },
  Submissive: { expr_smile: 0.4, eye_hooded__l: 0.45, eye_hooded__r: 0.45 },
  Coy: { expr_smile: 0.5, eye_hooded__l: 0.3, eye_hooded__r: 0.3 },
};

const BUILD_MORPHS: Record<string, Record<string, number>> = {
  Slim: { waist_thin: 0.5, m_muscle_down: 0.3, m_weight_down: 0.25 },
  Athletic: { m_muscle_up: 0.8, shoulder_wide: 0.3, waist_thin: 0.25 },
  Average: {},
  Muscular: { m_muscle_up: 1, shoulder_wide: 0.45, m_weight_up: 0.15 },
  Curvy: { hip_wide: 0.6, breast_up: 0.55, waist_thin: 0.3 },
  "Plus-size": { m_weight_up: 0.55, hip_wide: 0.45, waist_thick: 0.35 },
};

const BODY_TYPE_MORPHS: Record<string, Record<string, number>> = {
  Slim: { waist_thin: 0.4, m_muscle_down: 0.25 },
  Athletic: { m_muscle_up: 0.6, shoulder_wide: 0.2 },
  Average: {},
  Curvy: { hip_wide: 0.5, breast_up: 0.45 },
  "Plus-size": { m_weight_up: 0.45, hip_wide: 0.35 },
};

const HEIGHT_INDEX = [`5'0" (152 cm)`, `5'3" (160 cm)`, `5'6" (168 cm)`, `5'9" (175 cm)`, `6'0" (183 cm)`, `6'3" (190 cm)`];
const WEIGHT_INDEX = ["45 kg", "55 kg", "65 kg", "75 kg", "85 kg", "95 kg"];

function buildMorphs(spec: CharacterSpec): Record<string, number> {
  const morphs: Record<string, number> = {};

  const add = (extra: Record<string, number> | undefined) => {
    if (!extra) return;
    for (const [key, value] of Object.entries(extra)) {
      morphs[key] = Math.min(1, Math.max(0, (morphs[key] ?? 0) + value));
    }
  };

  if (spec.gender === "Female") add({ m_gender_f: 1 });
  else if (spec.gender === "Male") add({ m_gender_m: 1 });

  add(AGE_MORPHS[spec.age]);

  const height = axisInfluence(Math.max(0, HEIGHT_INDEX.indexOf(spec.height)));
  if (height.down) add({ m_height_down: height.down });
  if (height.up) add({ m_height_up: height.up });

  const weight = axisInfluence(Math.max(0, WEIGHT_INDEX.indexOf(spec.weight)));
  if (weight.down) add({ m_weight_down: weight.down * 0.8 });
  if (weight.up) add({ m_weight_up: weight.up * 0.8 });

  add(BODY_TYPE_MORPHS[spec.bodyType]);
  add(BUILD_MORPHS[spec.build]);
  add(FACE_SHAPE_MORPHS[spec.faceShape]);
  add(EYE_SHAPE_MORPHS[spec.eyeShape]);
  add(EXPRESSION_MORPHS[spec.expression]);

  // Female silhouettes read better with a base breast volume.
  if (spec.gender === "Female" && !("breast_up" in morphs)) add({ breast_up: 0.3 });

  // Relaxed eyelids: softens the wide-eyed socket look of the base face.
  if (!("eye_hooded__l" in morphs)) {
    morphs.eye_hooded__l = 0.45;
    morphs.eye_hooded__r = 0.45;
  }

  // Torso-volume morphs grow the skin past the static garment shells —
  // keep every body-volume influence inside what the inflated outfits cover.
  const VOLUME_CAP: Record<string, number> = {
    breast_up: 0.45,
    breast_down: 0.6,
    hip_wide: 0.5,
    hip_narrow: 0.6,
    waist_thin: 0.6,
    waist_thick: 0.5,
    m_weight_up: 0.5,
    m_weight_down: 0.6,
    m_muscle_up: 0.7,
    shoulder_wide: 0.3,
    buttocks_up: 0.45,
  };
  for (const [key, cap] of Object.entries(VOLUME_CAP)) {
    if (morphs[key] !== undefined) morphs[key] = Math.min(morphs[key], cap);
  }

  return morphs;
}

/* ------------------------------- hair ------------------------------- */

const HAIR_MESH: Record<string, string | null> = {
  "Long & Straight": "Hair__long01",
  "Long & Wavy": "Hair__long01",
  Curly: "Hair__afro01",
  "Shoulder Bob": "Hair__bob01",
  "Pixie Cut": "Hair__short02",
  Ponytail: "Hair__ponytail01",
  Braided: "Hair__braid01",
  "Elegant Updo": "Hair__short01",
  "Buzz Cut": "Hair__short04",
};

/* ------------------------------ outfits ----------------------------- */

interface Garment {
  mesh: string | null;
  tint: string;
  coverage?: Coverage;
  opacity?: number;
  gloss?: boolean;
  note?: string;
}

function casualFor(gender: string): string {
  return gender === "Male" ? "Clothes__male_casualsuit01" : "Clothes__female_casualsuit01";
}
function formalFor(gender: string): string {
  return gender === "Male" ? "Clothes__male_elegantsuit01" : "Clothes__female_elegantsuit01";
}

const REGULAR_OUTFITS: Record<string, Garment> = {
  Casual: { mesh: null, tint: "#7a8aa0" }, // mesh chosen per gender below
  Formal: { mesh: null, tint: "#2e3548" },
  "Fantasy armor": { mesh: "Clothes__male_worksuit01", tint: "#8d99ae", gloss: true, note: "armour look" },
  Sportswear: { mesh: "Clothes__female_sportsuit01", tint: "#d94f4f" },
  "Uniform (adult)": { mesh: "Clothes__male_worksuit01", tint: "#31435c" },
  Traditional: { mesh: null, tint: "#a3552e" },
  "Modern streetwear": { mesh: "Clothes__female_casualsuit02", tint: "#46506b" },
  "Business attire": { mesh: null, tint: "#232a3a" },
};

const SUBCONTINENT_REGULAR: Record<string, Garment> = {
  Saree: { mesh: "Clothes__female_elegantsuit01", tint: "#b3234b", note: "saree drape" },
  "Salwar Kameez": { mesh: "Clothes__female_casualsuit02", tint: "#3f7d5c", note: "kameez silhouette" },
  Lehenga: { mesh: "Clothes__female_elegantsuit01", tint: "#8b2f8b", note: "lehenga drape" },
  "Kurta-Pajama": { mesh: "Clothes__male_casualsuit02", tint: "#e8d9b0", note: "kurta silhouette" },
  Sherwani: { mesh: "Clothes__male_elegantsuit01", tint: "#c9a227", note: "sherwani silhouette" },
  Dhoti: { mesh: "Clothes__male_casualsuit02", tint: "#efe6cf", note: "dhoti silhouette" },
  Anarkali: { mesh: "Clothes__female_elegantsuit01", tint: "#276fbf", note: "anarkali flare" },
  "Indo-Western": { mesh: "Clothes__female_casualsuit02", tint: "#6c4b9e" },
  "Ghagra Choli": { mesh: "Clothes__female_elegantsuit01", tint: "#c96a1f", note: "ghagra drape" },
  "Pathani suit": { mesh: "Clothes__male_casualsuit02", tint: "#37474f", note: "pathani silhouette" },
};

const UNCENSORED_OUTFITS: Record<string, Garment> = {
  "Fully clothed": { mesh: null, tint: "#5c6a80" },
  "Partially clothed": { mesh: null, tint: "#5c6a80", coverage: "partial" },
  Lingerie: { mesh: null, tint: "#111111", coverage: "minimal" },
  "Underwear only": { mesh: null, tint: "#111111", coverage: "minimal" },
  Nude: { mesh: null, tint: "#111111", coverage: "none" },
  "Transparent clothing": { mesh: null, tint: "#d8c7e8", coverage: "partial", opacity: 0.55 },
  "Micro bikini": { mesh: null, tint: "#d94f8f", coverage: "minimal" },
  Latex: { mesh: "Clothes__male_worksuit01", tint: "#15151a", gloss: true },
  "Bondage gear": { mesh: "Clothes__male_worksuit01", tint: "#1a1a1a", gloss: true },
  "Fetish outfits": { mesh: "Clothes__male_worksuit01", tint: "#26141f", gloss: true },
};

const SUBCONTINENT_UNCENSORED: Record<string, Garment> = {
  "Saree (draped / slipped)": { mesh: "Clothes__female_elegantsuit01", tint: "#b3234b", opacity: 0.75, coverage: "partial" },
  "Blouse only": { mesh: "Clothes__female_casualsuit02", tint: "#8c2f39", coverage: "partial" },
  "Lehenga (open)": { mesh: "Clothes__female_elegantsuit01", tint: "#8b2f8b", coverage: "partial" },
  "Transparent saree": { mesh: "Clothes__female_elegantsuit01", tint: "#c27498", opacity: 0.5, coverage: "partial" },
  "Wet saree": { mesh: "Clothes__female_elegantsuit01", tint: "#9e3d63", opacity: 0.65, coverage: "partial", gloss: true },
  "Ghagra (revealing)": { mesh: "Clothes__female_elegantsuit01", tint: "#c96a1f", coverage: "partial" },
  "Traditional lingerie fusion": { mesh: null, tint: "#8c2f5f", coverage: "minimal" },
  "Indo-Western lingerie": { mesh: null, tint: "#5f2f8c", coverage: "minimal" },
  "Nude with jewelry only": { mesh: null, tint: "#c9a227", coverage: "none" },
};

function resolveGarment(spec: CharacterSpec): Garment {
  const all: Record<string, Garment> = {
    ...REGULAR_OUTFITS,
    ...SUBCONTINENT_REGULAR,
    ...UNCENSORED_OUTFITS,
    ...SUBCONTINENT_UNCENSORED,
  };
  const garment = { ...(all[spec.outfit] ?? { mesh: null, tint: "#7a8aa0" }) };

  // Garments with no explicit mesh pick by gender.
  if (garment.mesh === null && (garment.coverage ?? "full") === "full") {
    const isFormal =
      spec.outfit === "Formal" || spec.outfit === "Business attire" ||
      spec.outfit === "Traditional" || spec.outfit === "Fully clothed";
    garment.mesh = isFormal ? formalFor(spec.gender) : casualFor(spec.gender);
    // Male sportswear/streetwear fall back to a male-friendly cut.
    if (spec.gender === "Male" && spec.outfit === "Sportswear") garment.mesh = "Clothes__male_casualsuit02";
    if (spec.gender === "Male" && spec.outfit === "Modern streetwear") garment.mesh = "Clothes__male_casualsuit02";
  }
  return garment;
}

/* ------------------------------- poses ------------------------------ */

const REGULAR_POSES: Record<string, PreviewPoseId> = {
  Standing: "standing",
  Sitting: "sitting",
  Walking: "walking",
  Portrait: "portrait",
  Action: "action",
  Relaxed: "relaxed",
  Dynamic: "dynamic",
  "Classical dance pose": "dance",
};

const UNCENSORED_POSES: Record<string, PreviewPoseId> = {
  Standing: "standing",
  Sitting: "sitting",
  "Lying down": "lying",
  "Arched back": "arched",
  "On all fours": "allfours",
  Spreading: "spreading",
  "Sexual positions": "allfours",
  "Dynamic action": "dynamic",
  Submissive: "kneeling",
  Dominant: "dominant",
  "Classical dance (erotic interpretation)": "dance",
};

/* ------------------------------ looks ------------------------------- */

const LOOK_LIGHTING: Record<string, LookLightingId> = {
  editorial: "editorial",
  natural: "natural",
  golden: "golden",
  urban: "urban",
  studio: "studio",
  moody: "moody",
};

const STYLE_TREATMENT: Record<string, MaterialTreatment> = {
  Realistic: "standard",
  Anime: "toon",
  "Semi-Realistic": "standard",
  "3D Render": "clay",
  "South Asian": "standard",
};

/* ------------------------------ mapping ----------------------------- */

export function mapSpecToAvatar(spec: CharacterSpec): AvatarParams {
  const garment = resolveGarment(spec);
  const coverage = garment.coverage ?? "full";
  const poseTable = spec.mode === "uncensored" ? UNCENSORED_POSES : REGULAR_POSES;

  const notes: string[] = [];
  if (garment.note) notes.push(garment.note);
  if (spec.tattoos) notes.push("tattoos");
  if (spec.facialHair) notes.push("facial hair");
  if (spec.violence && spec.violence !== "None") notes.push(`${spec.violence.toLowerCase()} (final render only)`);
  if (spec.style === "Anime" || spec.style === "3D Render") notes.push(`${spec.style} shading`);
  if (spec.nsfwLevel >= 4) notes.push("explicit detail (final render only)");

  const showHat = spec.accessories === "Hats" || spec.accessories === "Turban";
  const silhouetteOnly = coverage === "none" || coverage === "minimal";

  return {
    skinHex: skinHex(spec.skinTone),
    hairColorHex: HAIR_COLOR_HEX[spec.hairColor] ?? "#2b2118",
    hairMesh: HAIR_MESH[spec.hairStyle] ?? "Hair__long01",
    eyeTexture: EYE_TEXTURE[spec.eyeColor] ?? EYE_TEXTURE.Brown,
    morphs: buildMorphs(spec),
    pose: poseTable[spec.pose] ?? "standing",
    garmentMesh: coverage === "full" || coverage === "partial" ? garment.mesh : null,
    garmentTint: garment.tint,
    garmentOpacity: garment.opacity ?? 1,
    garmentGloss: garment.gloss ?? false,
    coverage,
    silhouetteOnly,
    shoes: coverage === "full",
    hat: showHat,
    piercings: spec.piercings,
    lighting: LOOK_LIGHTING[spec.look] ?? "studio",
    material: STYLE_TREATMENT[spec.style] ?? "standard",
    notes,
  };
}
