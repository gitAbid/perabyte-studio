import { ProductionApplicationError } from "../../production/errors";
import { type CanonEntityKind } from "../../production/contracts";
import {
  hasUnpairedSurrogates, TextPlannerChunkOutputSchema,
  type ProposalKind, type SpeechSegment, type TextPlannerChunkOutput,
} from "../../production/proposals";
import { isTextProvider, type TextProvider } from "../types";

/**
 * Narrow I02 text-planning adapter over the existing TextProvider port
 * (lib/providers/types.ts). The adapter composes prompts from server-parsed
 * speech and selected canon only, calls generateText once per attempt and
 * parses the untrusted reply as strict JSON. No fallback, no cost claims.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type PlannerCanonEntry = {
  entityId: string;
  entityKind: CanonEntityKind;
  description: string;
  referenceAssetIds: readonly string[];
};

export type TextPlannerChunkRequest = {
  modelId: string;
  kind: ProposalKind;
  segments: readonly SpeechSegment[];
  canon: readonly PlannerCanonEntry[];
  /** Known positive safe-integer context limit in tokens; unknown limits fail visibly. */
  contextTokens: number;
  maxOutputTokens?: number;
  repair?: { previousRawText: string; errors: readonly string[] } | null;
};

export type TextPlannerChunkResult =
  | { ok: true; output: TextPlannerChunkOutput; rawText: string }
  | { ok: false; reason: "model_limit"; message: string; rawText: null }
  | { ok: false; reason: "invalid_output"; errors: string[]; rawText: string | null };

export function requireTextPlannerProvider(provider: unknown): TextProvider {
  if (!isTextProvider(provider)) {
    throw new ProductionApplicationError("INVALID_INPUT", "Story proposal planning requires a TextProvider implementation with listTextModels and generateText");
  }
  return provider;
}

const PLANNER_SYSTEM_PROMPT = [
  "You are a deterministic story planning engine for a film studio.",
  "Return ONLY one strict JSON value matching the requested schema: no prose, no code fences, no extra fields.",
  "Never invent IDs, speakers, or speech. Reuse the provided segmentId, characterId, sourceStart and sourceEnd values exactly.",
  "Beat IDs must be exactly beat-<segmentId>.",
  "Dialogue text and narration-beat narration must match the provided speech text byte-for-byte.",
  "Shot proposals may only use characters and canon revision IDs from the provided canon whitelist.",
].join(" ");

export function buildTextChunkPrompt(request: TextPlannerChunkRequest): { systemPrompt: string; userPrompt: string } {
  const beatShape = {
    id: "beat-<segmentId>", speechSegmentId: "<segmentId>", action: "string",
    narration: "string (dialogue beats may use an empty string)",
    dialogue: [{ speechSegmentId: "<segmentId>", characterId: "<characterId>", text: "exact speech text", sourceStart: 0, sourceEnd: 0 }],
    sourceStart: 0, sourceEnd: 0,
  };
  const shotShape = {
    shotId: "string", beatIds: ["beat-<segmentId>"], visualIntent: "string", motionIntent: "string",
    castBindings: [{ characterId: "string", canonRevisionId: "string", wardrobe: "string" }],
    locationRevisionId: "string", propRevisionIds: ["string"], styleRevisionId: "string",
    framing: "extreme_wide|wide|medium_wide|medium|close|extreme_close", targetFrames: 124, continuation: null,
  };
  const payload = {
    task: request.kind === "storyboard"
      ? "Plan ordered story beats and shot inputs for the provided speech segments."
      : "Plan ordered story beats for the provided speech segments.",
    outputSchema: { schemaVersion: 1, beats: [beatShape], ...(request.kind === "storyboard" ? { shots: [shotShape] } : {}) },
    rules: [
      "One beat per speech segment, in the provided order.",
      "Copy speechSegmentId, characterId, text, sourceStart and sourceEnd exactly; never edit speech.",
      ...(request.kind === "storyboard"
        ? ["Every chunk requires shot inputs; every beat needs at least one covering shot; dialogue speakers must be cast in a covering shot."]
        : []),
      "Return beats for this chunk only.",
      ...(request.repair ? ["The previous attempt was invalid; return one corrected strict JSON value fixing every listed error."] : []),
    ],
    speechSegments: request.segments.map((item) => ({
      segmentId: item.segmentId, kind: item.kind, characterId: item.characterId, text: item.text,
      sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, beatId: `beat-${item.segmentId}`,
    })),
    canon: request.canon.map((entry) => ({
      entityId: entry.entityId, entityKind: entry.entityKind, description: entry.description,
      referenceAssetIds: [...entry.referenceAssetIds],
    })),
    ...(request.repair
      ? { previousAttempt: { rawOutput: request.repair.previousRawText, errors: [...request.repair.errors], instruction: "Return one corrected strict JSON value fixing every listed error." } }
      : {}),
  };
  return { systemPrompt: PLANNER_SYSTEM_PROMPT, userPrompt: JSON.stringify(payload) };
}

function parsePlannerRawText(rawText: string): TextPlannerChunkResult {
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "invalid_output", errors: ["Output is not a single strict JSON value"], rawText };
  }
  const parsed = TextPlannerChunkOutputSchema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.map(String).join(".") || "root"}: ${issue.message}`);
    return { ok: false, reason: "invalid_output", errors, rawText };
  }
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
  };
  if (strings(parsed.data).some(hasUnpairedSurrogates)) {
    return { ok: false, reason: "invalid_output", errors: ["Output contains an unpaired Unicode surrogate; boundary-splitting text is rejected"], rawText };
  }
  return { ok: true, output: parsed.data, rawText };
}

export async function planTextChunk(provider: TextProvider, request: TextPlannerChunkRequest): Promise<TextPlannerChunkResult> {
  requireTextPlannerProvider(provider);
  const contextTokens = request.contextTokens;
  if (!Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    return { ok: false, reason: "model_limit", message: `Model ${request.modelId} has no known context limit; refusing to plan`, rawText: null };
  }
  const { systemPrompt, userPrompt } = buildTextChunkPrompt(request);
  if (Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(userPrompt, "utf8") > contextTokens) {
    return { ok: false, reason: "model_limit", message: `Composed planning prompt exceeds the known context limit of model ${request.modelId} (${contextTokens} tokens)`, rawText: null };
  }
  const maxTokens = Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, contextTokens);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return { ok: false, reason: "model_limit", message: `Output token bound for model ${request.modelId} is not a positive safe integer`, rawText: null };
  }
  const generated = await provider.generateText({ systemPrompt, userPrompt, modelId: request.modelId, temperature: 0, maxTokens });
  return parsePlannerRawText(generated.text);
}
