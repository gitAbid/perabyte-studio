import {
  IMAGE_STYLES,
  PROMPT_MAX,
  VIDEO_STYLES,
  type GenerationKind,
} from "@/lib/constants";

/**
 * Context-aware prompt enhancement (domain layer, pure — safe on client and
 * server). The Enhance action rewrites the user's prompt considering the
 * current studio configuration: the media kind, the style preset when the
 * model supports one, the story-scene position, the clip duration, the frame
 * orientation, the user's local time of day and the negative prompt.
 *
 * Two engines share this vocabulary:
 * - the AI path sends `enhancementInstruction` to a text model;
 * - the deterministic path (`deterministicEnhancement`) is the offline
 *   fallback that still honours style + time of day without any network.
 */

export type TimeOfDay =
  | "dawn"
  | "morning"
  | "afternoon"
  | "golden hour"
  | "evening"
  | "night";

export const TIME_OF_DAYS: readonly TimeOfDay[] = [
  "dawn",
  "morning",
  "afternoon",
  "golden hour",
  "evening",
  "night",
];

/** Everything the enhancer may know about the current studio state. */
export interface EnhancementContext {
  kind: GenerationKind;
  /** Selected style preset; ignored when the model cannot honour styles. */
  style?: string | null;
  /** False for provider-workflow models that take only the raw prompt. */
  stylesSupported?: boolean;
  aspect?: string | null;
  /** Video clip length, e.g. "5s" — shapes how much motion to describe. */
  duration?: string | null;
  /** Story mode position: this composer prompt seeds scene `sceneIndex`. */
  sceneIndex?: number | null;
  sceneCount?: number | null;
  /** Client-local bucket; the server never assumes its own timezone. */
  timeOfDay?: TimeOfDay | null;
  /** Where this scene takes place (plan/location asset) — the rewrite keeps
   * the environment anchored instead of inventing a new one. */
  location?: string | null;
  /** One-line summary of the previous scene's state — continuity context. */
  priorScene?: string | null;
  negativePrompt?: string | null;
  /** Character budget the rewrite must fit (Settings → General). */
  maxChars?: number;
  /** Uncensored Mode — keep adult/explicit intent instead of rewriting toward SFW. */
  uncensored?: boolean;
}

/** Lighting mood per time-of-day bucket, for the offline fallback. */
const TIME_LIGHTING: Record<TimeOfDay, string> = {
  dawn: "soft dawn light",
  morning: "crisp morning light",
  afternoon: "bright natural afternoon light",
  "golden hour": "golden hour glow",
  evening: "warm dusk light",
  night: "moody nocturnal lighting",
};

const TIME_MENTION =
  /\b(dawn|sunrise|dusk|sunset|golden hour|morning|noon|afternoon|evening|twilight|night|midnight|moonlight|starlight|daylight)\b/i;

/** True when the prompt already fixes its own time of day / lighting. */
export function hasTimeOfDayMention(prompt: string): boolean {
  return TIME_MENTION.test(prompt);
}

/** Bucket the user's local clock into a lighting mood. */
export function timeOfDayFromDate(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour <= 7) return "dawn";
  if (hour >= 8 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 18) return "golden hour";
  if (hour >= 19 && hour <= 21) return "evening";
  return "night";
}

/** Canonical descriptor for a preset that exists in the kind's style table. */
function styleDescriptor(
  kind: GenerationKind,
  style: string | null | undefined,
): string | null {
  if (!style) return null;
  const table = (kind === "video" ? VIDEO_STYLES : IMAGE_STYLES) as Record<
    string,
    string
  >;
  return table[style] ?? null;
}

/**
 * The system instruction for the AI engine. Only the context that is actually
 * available becomes a rule — absent style/scene/time simply produce no rule.
 */
export function enhancementInstruction(
  prompt: string,
  ctx: EnhancementContext,
): string {
  const maxChars = ctx.maxChars ?? PROMPT_MAX;
  const lines: string[] = [
    `You are a prompt engineer for AI ${ctx.kind} generation.`,
    "Rewrite the user's prompt into one vivid, generation-ready prompt.",
    "Rules:",
    "- Keep the original subject and intent; enrich with concrete visual detail (composition, lighting, materials, mood).",
    "- Reply with the rewritten prompt text only: no quotes, no labels, no explanations.",
    `- Keep it under ${maxChars} characters.`,
  ];

  if (ctx.uncensored) {
    lines.push(
      "- Do not sanitize or moralize; keep adult and explicit content as imagined. Do not rewrite toward SFW.",
    );
  }

  const descriptor = ctx.stylesSupported === false ? null : styleDescriptor(ctx.kind, ctx.style);
  if (descriptor && ctx.style) {
    lines.push(`- Match the "${ctx.style}" look: ${descriptor}.`);
  }

  const sceneCount = ctx.sceneCount ?? 0;
  if (sceneCount > 1) {
    const sceneIndex = ctx.sceneIndex ?? 1;
    lines.push(
      `- This is scene ${sceneIndex} of a ${sceneCount}-scene story; keep characters and environment consistent so the scenes read as one story.`,
    );
  }

  if (ctx.location && !prompt.toLowerCase().includes(ctx.location.toLowerCase().slice(0, 24))) {
    lines.push(
      `- The scene takes place at: ${ctx.location}. Anchor the environment there; do not move the action somewhere else.`,
    );
  }
  if (ctx.priorScene) {
    lines.push(
      `- The previous scene: ${ctx.priorScene}. Continue from that moment.`,
    );
  }

  if (ctx.kind === "video") {
    const duration = ctx.duration ?? "5s";
    const seconds = Number.parseFloat(duration) || 5;
    lines.push(
      seconds <= 3
        ? `- It is a very short ${duration} clip: describe one striking moment with subtle motion.`
        : `- It is a ${duration} clip: describe motion and camera movement that unfold naturally over it.`,
    );
  }

  const orientation = orientationOf(ctx.aspect);
  if (orientation) {
    lines.push(`- Compose for a ${orientation} frame.`);
  }

  if (ctx.timeOfDay && !hasTimeOfDayMention(prompt)) {
    lines.push(
      `- The user's local time of day is ${ctx.timeOfDay}; suggest natural lighting that fits it, since the prompt does not set a time itself.`,
    );
  }

  const negative = exclusionTerms(ctx.negativePrompt, Boolean(ctx.uncensored));
  if (negative) {
    lines.push(`- Avoid anything related to: ${negative}.`);
  }

  lines.push("Prompt to rewrite:", prompt.trim());
  return lines.join("\n");
}

/** NSFW-avoidance terms that fight an uncensored rewrite. Quality terms stay. */
const NSFW_NEGATIVE_TERM =
  /^(nsfw|nude|nudity|topless|bottomless|sexual|explicit|erotic|lingerie|fetish|suggestive|underwear)$/i;

function exclusionTerms(
  negative: string | null | undefined,
  uncensored: boolean,
): string | null {
  const parts = (negative ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = uncensored
    ? parts.filter((part) => !NSFW_NEGATIVE_TERM.test(part))
    : parts;
  return kept.length ? kept.join(", ") : null;
}

function orientationOf(aspect: string | null | undefined): string | null {
  if (!aspect) return null;
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h) return null;
  if (w > h) return "landscape";
  if (h > w) return "portrait";
  return "square";
}

/**
 * Clean up a text-model reply into a usable prompt. Returns null when the
 * reply is empty, a refusal, or nothing but the original text re-stated.
 */
export function sanitizeEnhancedText(
  raw: string,
  original: string,
  maxChars: number = PROMPT_MAX,
): string | null {
  let text = raw.trim();
  // Code fences and wrapping quotes are decoration the model adds.
  text = text.replace(/^```[\w]*\n?|```$/g, "").trim();
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  text = text.replace(
    /^(enhanced prompt|rewritten prompt|prompt|output|result)\s*[:\-—]\s*/i,
    "",
  );
  text = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!text) return null;
  if (/^(sorry|i'm sorry|i am sorry|i cannot|i can't|as an ai)\b/i.test(text)) {
    return null;
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  if (text.toLowerCase() === original.trim().toLowerCase()) return null;
  return text;
}

/**
 * Offline enhancement: append style-true and time-aware clauses without any
 * network. Idempotent — clauses already present are never duplicated.
 */
export function deterministicEnhancement(
  prompt: string,
  ctx: EnhancementContext,
): string {
  const base = prompt.trim().replace(/[.,\s]+$/, "");
  if (!base) return prompt;

  const descriptor =
    ctx.stylesSupported === false ? null : styleDescriptor(ctx.kind, ctx.style);
  const timeClause =
    ctx.timeOfDay && !hasTimeOfDayMention(base) ? TIME_LIGHTING[ctx.timeOfDay] : null;
  const locationClause =
    ctx.location && !base.toLowerCase().includes(ctx.location.toLowerCase().slice(0, 24))
      ? `set in ${ctx.location}`
      : null;

  const extras = [
    descriptor ?? "highly detailed, balanced composition",
    timeClause,
    locationClause,
    "atmospheric depth, high resolution",
  ].filter((clause): clause is string => {
    if (!clause) return false;
    return !base.toLowerCase().includes(clause.split(",")[0].toLowerCase());
  });

  if (!extras.length) return prompt;
  return `${base}, ${extras.join(", ")}.`;
}
