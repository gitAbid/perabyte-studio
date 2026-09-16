/**
 * Content-aware 18+ moderation: the verdict contract, the vision-LLM
 * rubric, and the pure policy functions shared by the server service
 * (lib/services/moderation.service.ts) and the client mask hook
 * (lib/moderation-client.ts). No I/O in this module.
 */

/**
 * Gray zone: below this confidence the verdict is "uncertain" and the
 * static generation flag rules (spec §3). Persisted verdicts keep the
 * flag so the threshold can be retuned from real data later.
 */
export const MODERATION_CONFIDENCE_THRESHOLD = 0.5;

export type ModerationCategory = "nudity" | "sexual_activity" | "suggestive";

export const MODERATION_CATEGORIES: readonly ModerationCategory[] = [
  "nudity",
  "sexual_activity",
  "suggestive",
];

export interface ModerationVerdict {
  sensitive: boolean;
  category: ModerationCategory | null;
  /** The model's own certainty, clamped to 0..1. */
  confidence: number;
  /** Free text for logs only — never shown in the UI. */
  reason: string;
  /** Vision model that produced the verdict. */
  model: string;
  createdAt: number;
  /** True when confidence < MODERATION_CONFIDENCE_THRESHOLD. */
  uncertain?: boolean;
}

/** Where a mask decision came from. */
export type ModerationSource = "cache" | "ai" | "static";

/**
 * The classifier rubric. The gate is the "uncensored 18+" preview mask:
 * nudity and explicit sexual content blur; clothed (incl. swimwear /
 * lingerie / suggestive posing without nudity) stays open; violence and
 * gore are out of scope. Under-18 sexualization is the top-priority rule.
 */
export const MODERATION_SYSTEM_PROMPT = `You are a content classifier for an 18+ preview gate on AI-generated media. Decide whether the image must sit behind an 18+ blur before a user chooses to view it.

Sensitive (blur) when the image shows:
- visible nudity: exposed breasts, genitals, or buttocks presented sexually;
- explicit sexual activity, or a close simulation of it;
- erections, genital close-ups, masturbation;
- fetish or sex-toy depictions;
- any sexualized depiction of a person who appears to be under 18 — highest priority, no exceptions.

Cartoon, anime, painted and photoreal styles follow the same rules.

Safe (no blur) when: everyone relevant is clothed — including swimwear, lingerie, or suggestive posing without nudity — or there are no people at all. Artistic or non-sexual nudity is still sensitive: the gate is age-based, not taste-based.

Violence, gore and other non-sexual shock content are out of scope: never mark them sensitive.

Reply with JSON only — no prose, no code fences:
{"sensitive": <boolean>, "category": "nudity" | "sexual_activity" | "suggestive" | null, "confidence": <0..1>, "reason": "<=200 chars, for logs"}`;

export const MODERATION_USER_INSTRUCTION =
  "Classify this image for an 18+ content gate. Reply with JSON only.";

/** Pull the first JSON object out of a possibly fenced/prose-wrapped reply. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clamp01(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/** Parse + sanitize a vision reply; null = no usable verdict (static fallback). */
export function parseVerdictReply(
  raw: string,
  model: string,
): ModerationVerdict | null {
  const body = extractJsonObject(raw);
  if (!body) return null;
  if (typeof body.sensitive !== "boolean") return null;
  const confidence = clamp01(body.confidence);
  if (confidence === null) return null;
  const category =
    typeof body.category === "string" &&
    (MODERATION_CATEGORIES as readonly string[]).includes(body.category)
      ? (body.category as ModerationCategory)
      : null;
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  const uncertain = confidence < MODERATION_CONFIDENCE_THRESHOLD;
  return {
    sensitive: body.sensitive,
    category,
    confidence,
    reason,
    model,
    createdAt: Date.now(),
    ...(uncertain ? { uncertain: true } : {}),
  };
}

/** Shape guard for verdicts read back from disk. */
export function isModerationVerdict(value: unknown): value is ModerationVerdict {
  if (!value || typeof value !== "object") return false;
  const v = value as ModerationVerdict;
  return (
    typeof v.sensitive === "boolean" &&
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    typeof v.reason === "string" &&
    typeof v.model === "string" &&
    typeof v.createdAt === "number"
  );
}

/**
 * The mask decision for one frame: a confident verdict wins; an absent or
 * uncertain (gray-zone) verdict leaves the static generation flag in charge.
 */
export function effectiveSensitive(
  staticSensitive: boolean,
  verdict: ModerationVerdict | null | undefined,
): boolean {
  if (!verdict) return staticSensitive;
  if (verdict.uncertain || verdict.confidence < MODERATION_CONFIDENCE_THRESHOLD) {
    return staticSensitive;
  }
  return verdict.sensitive;
}

/** Cache refs look like `<64 hex chars>.<ext>` (see isValidMediaRef). */
const REF_LIKE = /^[0-9a-f]{64}\./;

/**
 * Media-cache ref from a served src (`/api/media?f=<ref>`); null when the
 * src is not one of our cache refs (provider fallbacks, /public assets).
 */
export function mediaRefFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const queryStart = src.indexOf("?");
  if (queryStart < 0) return null;
  const ref = new URLSearchParams(src.slice(queryStart + 1)).get("f");
  return ref && REF_LIKE.test(ref) ? ref : null;
}
