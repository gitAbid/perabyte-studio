import { describe, expect, it } from "vitest";
import { checkContinuity } from "./continuity";
import { REPAIR_LINE_MAX_CHARS, REPAIR_NOTE_MAX_CHARS, repairGuidance } from "./continuity-guidance";
import type { CanonRevision, CharacterState, EnvironmentState } from "./contracts";
import { hashCanonicalJson } from "./hash";

const sha = (seed: string) => hashCanonicalJson({ fixture: seed });

function canonFixture(id: string, entityId: string, description: string, entityKind: CanonRevision["entityKind"] = "character"): CanonRevision {
  return { version: 1, id, entityId, entityKind, revision: 1, description, attributes: {}, referenceAssetIds: [], contentHash: sha(id), createdAt: 1 };
}
function characterState(characterCanonRevisionId: string, overrides: Partial<CharacterState> = {}): CharacterState {
  return { accessories: [], carriedObjects: [], condition: [], characterCanonRevisionId, ...overrides };
}
function environmentState(environmentCanonRevisionId: string, overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return { persistentProps: [], environmentCanonRevisionId, ...overrides };
}
function sourceFixture(overrides: {
  castBindings?: Array<{ characterId: string; canonRevisionId: string; wardrobe: string }>;
  characters?: CharacterState[];
  environment?: EnvironmentState | null;
  anchor?: { version: 1; id: string; shotRevisionId: string; assetId: string; inputsHash: string; jobId: string; visionAssessment: null; receiptId: null; createdAt: number } | null;
  sceneNumber?: number | null;
  sceneTitle?: string | null;
  selectedTakeId?: string | null;
} = {}) {
  const sceneRev = canonFixture("char-scene-rev", "luna", "Luna, a lantern fox with amber eyes");
  const envRev = canonFixture("env-rev-1", "clearing", "A moonlit forest clearing", "environment");
  const input = {
    shot: {
      version: 1 as const, id: "shotrev-1", shotId: "shot_1", storyRevisionId: "story-1", beatIds: ["beat_1"], order: 0, sceneId: "scene-1",
      visualIntent: "A lantern fox steps into the clearing.", motionIntent: "slow push in",
      castBindings: overrides.castBindings ?? [{ characterId: "luna", canonRevisionId: "char-scene-rev", wardrobe: "grey hoodie" }],
      locationRevisionId: "env-rev-1", propRevisionIds: [], styleRevisionId: "look", framing: "wide" as const, targetFrames: 48,
      continuation: null, contentHash: sha("shotrev-1"), createdAt: 1,
    },
    sceneStates: {
      characters: overrides.characters ?? [characterState("char-scene-rev", { outfit: "navy trench coat" })],
      environment: overrides.environment === undefined ? environmentState("env-rev-1", { zone: "clearing", lighting: "moonlight", timeOfDay: "night" }) : overrides.environment,
    },
    characterRevisions: [sceneRev, envRev],
    environmentRevision: envRev,
    anchor: overrides.anchor === undefined ? { version: 1 as const, id: "anchor-1", shotRevisionId: "shotrev-1", assetId: "anchor-asset-1", inputsHash: sha("anchor-1"), jobId: "job-1", visionAssessment: null, receiptId: null, createdAt: 1 } : overrides.anchor,
  };
  return {
    shotId: "shot_1",
    input,
    result: checkContinuity(input),
    sceneNumber: overrides.sceneNumber !== undefined ? overrides.sceneNumber : 1,
    sceneTitle: overrides.sceneTitle !== undefined ? overrides.sceneTitle : "The clearing",
    selectedTakeId: overrides.selectedTakeId !== undefined ? overrides.selectedTakeId : "take-1",
  };
}

describe("repair guidance (spec 11 §9)", () => {
  it("emits one guidance per failing finding with the exact artifact prefix and the structured mismatch", () => {
    const source = sourceFixture();
    const guidance = repairGuidance(source);
    const outfit = guidance.find((repair) => repair.aspect === "outfit")!;
    expect(outfit).toBeDefined();
    expect(outfit.line).toContain("Scene 01 · Shot shot_1 · Take take-1 — ");
    expect(outfit.line).toContain('navy trench coat');
    expect(outfit.line).toContain('grey hoodie');
    expect(outfit.note).toContain('navy trench coat');
  });

  it("produces no guidance for passing or not_checked findings", () => {
    const passing = sourceFixture({ castBindings: [{ characterId: "luna", canonRevisionId: "char-scene-rev", wardrobe: "navy trench coat" }] });
    expect(repairGuidance(passing)).toEqual([]);
    const dark = sourceFixture({ anchor: null, characters: [], environment: null });
    expect(repairGuidance(dark)).toEqual([]);
  });

  it("routes an uncast scene character to the cast-first repair, not a bare re-roll", () => {
    const uncast = sourceFixture({ castBindings: [] });
    const identity = repairGuidance(uncast).find((repair) => repair.aspect === "identity")!;
    expect(identity).toBeDefined();
    expect(identity.line).toContain("not cast in this shot");
    expect(identity.line).toContain("re-roll alone cannot add a missing character");
  });

  it("names the environment and lighting repair from the structured state", () => {
    const stale = sourceFixture({ environment: environmentState("env-old-rev", { lighting: "moonlight" }) });
    const lines = repairGuidance(stale).map((repair) => repair.line).join(" ");
    expect(lines).toContain("Re-pin the scene environment");
    expect(lines).toContain("moonlit forest clearing");

    const dark = sourceFixture({ environment: environmentState("env-rev-1") });
    const lighting = repairGuidance(dark).find((repair) => repair.aspect === "lighting")!;
    expect(lighting.line).toContain("time of day and lighting");
  });

  it("is deterministic and respects the line/note caps", () => {
    const source = sourceFixture();
    const first = repairGuidance(source);
    expect(repairGuidance(source)).toEqual(first);
    for (const repair of first) {
      expect(repair.line.length).toBeLessThanOrEqual(REPAIR_LINE_MAX_CHARS);
      expect(repair.note.length).toBeLessThanOrEqual(REPAIR_NOTE_MAX_CHARS);
    }
  });

  it("labels scenes without a number by title and drops the take segment when none is selected", () => {
    const noTake = sourceFixture({ selectedTakeId: null, sceneNumber: null, sceneTitle: "The clearing at dusk" });
    const guidance = repairGuidance(noTake);
    for (const repair of guidance) {
      expect(repair.line).toContain('Scene "The clearing at dusk"');
      expect(repair.line).not.toContain("Take ");
    }
  });
});
