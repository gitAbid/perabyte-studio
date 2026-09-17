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
 * Segment a draft into scene prompts. A line containing only `---` is an
 * explicit divider the author placed: each section becomes one scene
 * verbatim, whatever its length — re-splitting an authored scene is never
 * our call, the renderer's hard ceiling is the only limit. With no dividers
 * the draft packs character-wise into ≤PROMPT_MAX scenes.
 */
export function segmentDraftIntoScenes(draft: string): string[] {
  const trimmed = draft.trim();
  if (!trimmed) return [];
  if (!/^\s*---\s*$/m.test(trimmed)) return breakIntoScenePromptChunks(trimmed);
  return trimmed
    .split(/^\s*---\s*$/m)
    .map((section) => section.trim())
    .filter(Boolean);
}

/**
 * Losslessly pack a scene description into ≤max-character prompt chunks at
 * sentence boundaries; a single sentence longer than max is hard-cut rather
 * than dropped. This — not truncation — is how an over-length scene stays
 * inside the render-side PROMPT_MAX budget.
 */
export function breakIntoScenePromptChunks(text: string, max = PROMPT_MAX): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];
  const sentences = trimmed.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    let piece = sentence;
    while (piece.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    if (!piece) continue;
    if (current.length + piece.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

/**
 * Recommended scene count for a draft: roughly one scene per
 * `charsPerScene` characters of prose (the render-side prompt budget).
 * Returns null when the chosen count already covers the draft.
 */
export function suggestSceneCount(
  draft: string,
  sceneCount: number,
  charsPerScene = 1000,
): number | null {
  const length = draft.trim().length;
  if (!length) return null;
  const needed = Math.ceil(length / charsPerScene);
  if (needed <= sceneCount) return null;
  return Math.min(needed, WRITER_MAX_SCENES);
}

/**
 * Extract `{title, scenes}` from a model reply. Tolerates code fences,
 * surrounding chatter and empty scene strings; over-length scenes are
 * subdivided into ≤PROMPT_MAX chunks and over-count replies are kept —
 * scene count is a guide, never a content cap. Returns null when nothing
 * usable survives.
 */
export function extractStoryScenes(raw: string): {
  title: string;
  scenes: string[];
} | null {
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
    .flatMap((s) => breakIntoScenePromptChunks(s))
    .filter(Boolean);
  if (!scenes.length) return null;

  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim().slice(0, 80)
      : "Untitled story";
  return { title, scenes };
}
