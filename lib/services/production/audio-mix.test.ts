import { describe, expect, it } from "vitest";
import { deriveSpeechPlanRows, mixApprovalReadiness, stampSpeechCue } from "./audio-mix";
import type { AudioCue, StoryBeat, StoryRevision } from "../../production/contracts";
import type { VoicesStoreV1 } from "../../voices/read-model";
import { hashCanonicalJson } from "../../production/hash";

const sha = (seed: string) => hashCanonicalJson({ fixture: seed });

const voices: VoicesStoreV1 = {
  version: 1,
  voices: [{ id: "voice-1", name: " narrator-voice", origin: "vault", mime: "audio/wav", byteSize: 1000, durationSeconds: 3, rightsStatus: "creator_attested", source: "studio", importedAt: 1 }],
  bindings: { "char-luna": { voiceId: "voice-1", locked: true, boundAt: 5 } },
};

const beats: StoryBeat[] = [
  { id: "beat-2", action: "The fox follows.", narration: "", dialogue: [{ characterId: "char-luna", text: "Hello, clearing." }], order: 1 },
  { id: "beat-1", action: "Opening.", narration: "A lantern fox steps out.", dialogue: [], order: 0 },
];
const story = { id: "story-1", beats } as Pick<StoryRevision, "id" | "beats">;

function cueFixture(scriptSegmentId: string, overrides: Partial<AudioCue> = {}): AudioCue {
  return {
    id: `cue-${scriptSegmentId}`, assetId: "asset-1", sourceStartSample: 0, sourceEndSample: 48_000,
    timelineStartSample: 0, gainDb: 0, role: "narration", scriptSegmentId, sourceText: null,
    sourceRights: "creator_attested", ...overrides,
  };
}

describe("speech plan derivation (spec 12 / M4-3)", () => {
  it("derives one row per dialogue line and narration beat, in beat order", () => {
    const rows = deriveSpeechPlanRows({ storyRevision: story, cues: [], voices });
    expect(rows.map((row) => [row.rowKey, row.role])).toEqual([["beat-1", "narration"], ["beat-2", "dialogue"]]);
    expect(rows[0]!.filled).toBe(false);
    expect(rows[1]!.characterId).toBe("char-luna");
  });

  it("binds the character's locked voice and stamps delivery from the cue", () => {
    const rows = deriveSpeechPlanRows({ storyRevision: story, cues: [cueFixture("beat-2", { role: "dialogue", delivery: "whisper", voiceId: "voice-1" })], voices });
    const dialogue = rows[1]!;
    expect(dialogue.voice?.id).toBe("voice-1");
    expect(dialogue.voiceLocked).toBe(true);
    expect(dialogue.delivery).toBe("whisper");
    expect(dialogue.filled).toBe(true);
    expect(rows[0]!.delivery).toBe("auto");
  });

  it("produces one row per dialogue line in a multi-line beat with distinct keys", () => {
    const multi: StoryBeat[] = [{ id: "beat-9", action: "", narration: "", dialogue: [{ characterId: "char-luna", text: "One." }, { characterId: "char-luna", text: "Two." }], order: 0 }];
    const rows = deriveSpeechPlanRows({ storyRevision: { id: "story-1", beats: multi }, cues: [], voices });
    expect(rows.map((row) => row.rowKey)).toEqual(["beat-9", "beat-9#d1"]);
  });
});

describe("mix approval readiness", () => {
  it("gates on unfilled rows and unknown rights, and approves when every row has attributed audio", () => {
    const empty = mixApprovalReadiness(deriveSpeechPlanRows({ storyRevision: story, cues: [], voices }));
    expect(empty.approvable).toBe(false);
    expect(empty.missingRowKeys).toEqual(["beat-1", "beat-2"]);

    const ready = mixApprovalReadiness(deriveSpeechPlanRows({
      storyRevision: story,
      cues: [cueFixture("beat-1"), cueFixture("beat-2", { role: "dialogue" })],
      voices,
    }));
    expect(ready.approvable).toBe(true);

    const unknown = mixApprovalReadiness(deriveSpeechPlanRows({
      storyRevision: story,
      cues: [cueFixture("beat-1", { sourceRights: "unknown" }), cueFixture("beat-2", { role: "dialogue" })],
      voices,
    }));
    expect(unknown.approvable).toBe(false);
    expect(unknown.unknownRightsRowKeys).toEqual(["beat-1"]);
  });
});

describe("delivery re-render scope (single-line stamp)", () => {
  it("re-stamps only the affected line's cue and preserves every other cue by reference", () => {
    const a = cueFixture("beat-1");
    const b = cueFixture("beat-2", { role: "dialogue" });
    const next = stampSpeechCue([a, b], "beat-2", { delivery: "scared", voiceId: "voice-1" });
    expect(next[0]).toBe(a);
    expect(next[1]).toEqual({ ...b, delivery: "scared", voiceId: "voice-1" });
    expect(next[1]).not.toBe(b);
  });
});
