import type { SceneScore } from "@/lib/types";

/**
 * Keyframe quality gate: the expectations contract, the vision-LLM rubric
 * and the pure reply-parsing shared by lib/services/keyframe-gate.service.ts.
 * No I/O in this module.
 */

/** At or above this on every dimension a keyframe passes the gate. */
export const GATE_PASS_THRESHOLD = 0.7;

/**
 * What the keyframe is judged against, composed by the caller from the
 * scene's world state. `identity` is required and non-empty (what the
 * character(s) should look like); outfit/location sharpen it when known.
 */
export interface GateExpectations {
  identity: string;
  outfit?: string;
  location?: string;
}

/** A parsed gate reply is exactly a SceneScore: clamped 0..1 per dimension. */
export type GateScore = SceneScore;

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

/**
 * Parse + sanitize a vision reply; null = no usable score (gate unavailable).
 * A model that judged only the person (no outfit/location in the reply) is
 * trusted for those dimensions too — they default to the identity score so
 * a terse reply can't fail the gate by omission.
 */
export function parseGateReply(raw: string): GateScore | null {
  const body = extractJsonObject(raw);
  if (!body) return null;
  const identity = clamp01(body.identity);
  if (identity === null) return null;
  const outfit = clamp01(body.outfit) ?? identity;
  const location = clamp01(body.location) ?? identity;
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim().slice(0, 300)
      : undefined;
  return { identity, outfit, location, ...(notes ? { notes } : {}) };
}

/** The strict rubric for one keyframe: expectations embedded, JSON-only reply. */
export function gateInstruction(expectations: GateExpectations): string {
  const outfit = expectations.outfit?.trim() ?? "";
  const location = expectations.location?.trim() ?? "";
  return [
    "You are judging one generated keyframe image for continuity against the story's text expectations.",
    "",
    "Score three dimensions, each a number from 0 to 1 (1 = exact match, 0 = complete mismatch):",
    `- "identity": do the person(s) in the frame match this description: "${expectations.identity}"`,
    outfit
      ? `- "outfit": do their clothes match: "${outfit}"`
      : '- "outfit": no outfit was specified for this scene, so score it 1',
    location
      ? `- "location": does the setting match: "${location}"`
      : '- "location": no location was specified for this scene, so score it 1',
    "",
    "A missing expectation can never fail the gate — that dimension is scored 1. Judge only what the image shows.",
    "",
    'Reply ONLY with JSON — no prose, no code fences:',
    '{"identity": <0-1, do the person(s) match the description>, "outfit": <0-1, do the clothes match>, "location": <0-1, does the setting match>, "notes": "<one short sentence>"}',
  ].join("\n");
}
