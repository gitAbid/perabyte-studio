import { describe, expect, it } from 'vitest';
import { ProductionApplicationError } from "../../production/errors";
import { SpeechSegmentSchema, type SpeechSegment, type TextPlannerChunkOutput } from "../../production/proposals";
import type { TextGenerationRequest, TextProvider } from "../types";
import { buildTextChunkPrompt, planTextChunk, requireTextPlannerProvider, type PlannerCanonEntry, type TextPlannerChunkRequest } from "./text-planner";

const narration = (segmentId: string, text: string, sourceStart: number): SpeechSegment =>
  SpeechSegmentSchema.parse({ segmentId, kind: "narration", characterId: null, text, sourceStart, sourceEnd: sourceStart + text.length });

const segments = [narration("speech-1", "The clearing held its breath.", 0), narration("speech-2", "Then we run.", 30)];

const canon: PlannerCanonEntry[] = [
  { entityId: "pip", entityKind: "character", description: "A small fox with a lantern", referenceAssetIds: ["asset-1"] },
];

const request = (overrides: Partial<TextPlannerChunkRequest> = {}): TextPlannerChunkRequest => ({
  modelId: "planner-1", kind: "story", segments, canon, contextTokens: 100_000, maxOutputTokens: 8192, repair: null,
  ...overrides,
});

const validOutput: TextPlannerChunkOutput = {
  schemaVersion: 1,
  beats: segments.map((item) => ({
    id: `beat-${item.segmentId}`, speechSegmentId: item.segmentId, action: `Show ${item.segmentId}`, narration: item.text,
    dialogue: [], sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
  })),
};

function fakeProvider(options: { text?: (request: TextGenerationRequest) => string; calls?: TextGenerationRequest[] } = {}): TextProvider {
  return {
    id: "fake-text",
    label: "Fake text",
    isConfigured: () => true,
    listTextModels: () => [{ id: "planner-1", label: "Planner", provider: "fake-text", contextTokens: 100_000 }],
    generateText: async (generation) => {
      options.calls?.push(generation);
      return { text: options.text ? options.text(generation) : "", model: "planner-1", provider: "fake-text" };
    },
  };
}

describe("requireTextPlannerProvider", () => {
  it("accepts a structural TextProvider and rejects everything else", () => {
    expect(requireTextPlannerProvider(fakeProvider()).id).toBe("fake-text");
    expect(() => requireTextPlannerProvider(null)).toThrowError(ProductionApplicationError);
    expect(() => requireTextPlannerProvider({ listTextModels: () => [] })).toThrowError(ProductionApplicationError);
  });
});

describe("buildTextChunkPrompt", () => {
  it("composes a deterministic prompt containing only the provided canon and chunk speech", () => {
    const first = buildTextChunkPrompt(request());
    const second = buildTextChunkPrompt(request());
    expect(first.userPrompt).toBe(second.userPrompt);
    expect(first.systemPrompt).toContain("JSON");
    expect(first.userPrompt).toContain("speech-1");
    expect(first.userPrompt).toContain("beat-speech-1");
    expect(first.userPrompt).toContain("A small fox with a lantern");
    expect(first.userPrompt).toContain("asset-1");
    expect(first.userPrompt).toContain("sourceStart");
  });

  it("appends the previous raw output and structured errors on the single repair attempt", () => {
    const repaired = buildTextChunkPrompt(request({ repair: { previousRawText: '{"beats":[]}', errors: ["beats.0: required"] } }));
    expect(repaired.userPrompt).toContain('{\\"beats\\":[]}');
    expect(repaired.userPrompt).toContain("beats.0: required");
  });
});

describe("planTextChunk", () => {
  it("calls the provider with bounded generation settings and parses strict JSON output", async () => {
    const calls: TextGenerationRequest[] = [];
    const provider = fakeProvider({ calls, text: () => JSON.stringify(validOutput) });
    const result = await planTextChunk(provider, request());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelId).toBe("planner-1");
    expect(calls[0]!.temperature).toBe(0);
    expect(calls[0]!.maxTokens).toBe(8192);
  });

  it("caps maxTokens at the known model context limit", async () => {
    const calls: TextGenerationRequest[] = [];
    const provider = fakeProvider({ calls, text: () => JSON.stringify(validOutput) });
    await planTextChunk(provider, request({ contextTokens: 4_000, maxOutputTokens: 8192 }));
    expect(calls[0]!.maxTokens).toBe(4_000);
  });

  it("reports non-JSON and schema-invalid output as structured invalid_output", async () => {
    const notJson = await planTextChunk(fakeProvider({ text: () => "not json at all" }), request());
    expect(notJson).toMatchObject({ ok: false, reason: "invalid_output" });
    if (!notJson.ok && notJson.reason === "invalid_output") expect(notJson.errors.length).toBeGreaterThan(0);

    const extraField = await planTextChunk(fakeProvider({ text: () => JSON.stringify({ ...validOutput, stray: true }) }), request());
    expect(extraField).toMatchObject({ ok: false, reason: "invalid_output" });

    const missingBeats = await planTextChunk(fakeProvider({ text: () => JSON.stringify({ schemaVersion: 1 }) }), request());
    expect(missingBeats).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("rejects provider output that carries unpaired surrogates", async () => {
    const output = JSON.stringify({ schemaVersion: 1, beats: [{ ...validOutput.beats[0], action: "bad \uD800" }] });
    const result = await planTextChunk(fakeProvider({ text: () => output }), request());
    expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("fails visibly without calling the provider when the model context limit is unknown or exceeded", async () => {
    const calls: TextGenerationRequest[] = [];
    const provider = fakeProvider({ calls, text: () => JSON.stringify(validOutput) });
    const unknownLimit = await planTextChunk(provider, request({ contextTokens: 0 }));
    expect(unknownLimit).toMatchObject({ ok: false, reason: "model_limit" });
    const exceeded = await planTextChunk(provider, request({ contextTokens: 10 }));
    expect(exceeded).toMatchObject({ ok: false, reason: "model_limit" });
    expect(calls).toHaveLength(0);
  });
});
