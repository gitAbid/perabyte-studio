import {
  PROMPT_MAX,
  WRITER_TONES,
  type GenerationKind,
  type WriterToneKey,
} from "@/lib/constants";

/**
 * Story Writer domain (pure): request validation, instruction builders and the
 * scene-split extractor. No I/O — the service layers engines and retries on top.
 */

export const WRITER_IDEA_MAX = 2000;
export const WRITER_DRAFT_MAX = 20_000;
export const WRITER_INSTRUCTION_MAX = 500;
export const WRITER_MIN_SCENES = 1;
export const WRITER_MAX_SCENES = 12;
export const WRITER_DEFAULT_SCENES = 5;

export interface WriterBrief {
  idea: string;
  sceneCount: number;
  tone: WriterToneKey | null;
  characterNames: string[];
  uncensored: boolean;
}

export class WriterValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "WriterValidationError";
    this.field = field;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Trim a required text field; reject empty or over-length input outright. */
function requiredText(value: unknown, max: number, field: string, empty: string, tooLong: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new WriterValidationError(empty, field);
  if (trimmed.length > max) throw new WriterValidationError(tooLong, field);
  return trimmed;
}

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function parseWriteBody(body: Record<string, unknown>): WriterBrief {
  const brief = (body.brief ?? {}) as Record<string, unknown>;
  const idea = requiredText(
    brief.idea,
    WRITER_IDEA_MAX,
    "idea",
    "Describe your story idea first.",
    `Your story idea is too long — keep it under ${WRITER_IDEA_MAX} characters.`,
  );
  const tone =
    typeof brief.tone === "string" && brief.tone in WRITER_TONES && brief.tone !== "none"
      ? (brief.tone as WriterToneKey)
      : null;
  return {
    idea,
    sceneCount: clampInt(brief.sceneCount, WRITER_MIN_SCENES, WRITER_MAX_SCENES, WRITER_DEFAULT_SCENES),
    tone,
    characterNames: cleanNames(brief.characterNames),
    uncensored: brief.uncensored === true,
  };
}

export interface EnhanceRequest {
  draft: string;
  instruction: string;
}

export function parseEnhanceBody(body: Record<string, unknown>): EnhanceRequest {
  const draft = requiredText(
    body.draft,
    WRITER_DRAFT_MAX,
    "draft",
    "Write or generate a draft first.",
    "Your draft is too long — trim it before enhancing.",
  );
  const instruction = requiredText(
    body.instruction,
    WRITER_INSTRUCTION_MAX,
    "instruction",
    "Tell the writer what to change.",
    "Your instruction is too long — keep it short.",
  );
  return { draft, instruction };
}

export interface SplitRequest {
  draft: string;
  sceneCount: number;
  characterNames: string[];
  /** What the scenes will render as. Anything but "video" parses as "image". */
  kind: GenerationKind;
}

export function parseSplitBody(body: Record<string, unknown>): SplitRequest {
  const draft = requiredText(
    body.draft,
    WRITER_DRAFT_MAX,
    "draft",
    "Write or generate a draft first.",
    "Your draft is too long — trim it before splitting.",
  );
  return {
    draft,
    sceneCount: clampInt(
      body.sceneCount,
      WRITER_MIN_SCENES,
      WRITER_MAX_SCENES,
      WRITER_DEFAULT_SCENES,
    ),
    characterNames: cleanNames(body.characterNames),
    kind: body.kind === "video" ? "video" : "image",
  };
}

/* ------------------------------ instructions ------------------------------ */

export function writeStoryInstruction(brief: WriterBrief): string {
  const parts = [
    `Write a short narrative story based on this idea: ${brief.idea}.`,
    `Structure it in roughly ${brief.sceneCount} distinct beats/paragraphs.`,
  ];
  if (brief.tone) parts.push(`Tone: ${brief.tone}.`);
  if (brief.characterNames.length) {
    parts.push(`Recurring characters (use these names): ${brief.characterNames.join(", ")}.`);
  }
  if (brief.uncensored) {
    parts.push("Do not sanitize or moralize; write the scene as imagined.");
  }
  parts.push("Reply with the story prose only — no titles, no commentary.");
  return parts.join(" ");
}

export function enhanceDraftInstruction(draft: string, instruction: string): string {
  return [
    `Rewrite the story below following this instruction: ${instruction}`,
    "Keep the same voice and characters unless told otherwise. Reply with the rewritten story only.",
    "---",
    draft,
  ].join("\n");
}

const SCENE_PROMPT_RULES = [
  "Each scene string must be a self-contained visual generation prompt: describe the shot, the characters (by name and look), the setting, mood and camera.",
  "No scene references earlier scenes ('as before', 'the same room') — each must stand alone.",
];

/** One extra rule so video scenes prompt like short clips, not stills. */
const VIDEO_SCENE_RULE =
  "Each scene is a short video clip: describe motion, camera movement and continuous action within a single ~5-second beat.";

export function splitScenesInstruction(
  draft: string,
  sceneCount: number,
  characterNames: string[],
  kind: GenerationKind = "image",
): string {
  const cast = characterNames.length
    ? ` Recurring characters: ${characterNames.join(", ")}.`
    : "";
  return [
    `Split the story below into exactly ${sceneCount} scenes.`,
    ...SCENE_PROMPT_RULES,
    ...(kind === "video" ? [VIDEO_SCENE_RULE] : []),
    `Reply ONLY with JSON: {"title": "short story title", "scenes": ["scene 1 prompt", …]} with ${sceneCount} scene strings.${cast}`,
    "---",
    draft,
  ].join("\n");
}

export const STRICT_SPLIT_SUFFIX =
  "Your previous reply was not usable. Reply ONLY with the JSON object — no fences, no prose before or after.";

/* ---------------------------- scene extraction ---------------------------- */

/** Cut an over-length scene prompt at the last sentence end that fits. */
export function clampScenePrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PROMPT_MAX) return trimmed;
  const slice = trimmed.slice(0, PROMPT_MAX);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("…"));
  if (lastStop > PROMPT_MAX * 0.5) return slice.slice(0, lastStop + 1);
  return slice;
}

/**
 * Extract `{title, scenes}` from a model reply. Tolerates code fences,
 * surrounding chatter, empty scene strings and over-count replies; each scene
 * is clamped to PROMPT_MAX. Returns null when nothing usable survives.
 */
export function extractStoryScenes(
  raw: string,
  expectedCount?: number,
): { title: string; scenes: string[] } | null {
  if (!raw) return null;
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.scenes)) return null;

  const scenes = record.scenes
    .filter((s): s is string => typeof s === "string")
    .map((s) => clampScenePrompt(s))
    .filter(Boolean);
  if (!scenes.length) return null;

  const limited =
    expectedCount && expectedCount > 0 ? scenes.slice(0, expectedCount) : scenes;
  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim().slice(0, 80)
      : "Untitled story";
  return { title, scenes: limited };
}
