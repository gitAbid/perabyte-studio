import { describe, expect, it } from "vitest";
import { checkContinuity, continuityCheckEntries, recomputeAffected, summarizeContinuity } from "./continuity";
import type { CanonRevision, CharacterState, EnvironmentState } from "./contracts";
import { ProductionApplicationError } from "./errors";
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
function shotFixture(castBindings: Array<{ characterId: string; canonRevisionId: string; wardrobe: string }>, locationRevisionId = "env-rev-1") {
  return {
    version: 1 as const, id: "shotrev-1", shotId: "shot_1", storyRevisionId: "story-1", beatIds: ["beat_1"], order: 0,
    visualIntent: "A lantern fox steps into the clearing.", motionIntent: "slow push in", castBindings,
    locationRevisionId, propRevisionIds: [], styleRevisionId: "look", framing: "wide" as const, targetFrames: 48,
    continuation: null, sceneId: null as string | null, contentHash: sha("shotrev-1"), createdAt: 1,
  };
}
function anchorFixture() {
  return { version: 1 as const, id: "anchor-1", shotRevisionId: "shotrev-1", assetId: "anchor-asset-1", inputsHash: sha("anchor-1"), jobId: "job-1", visionAssessment: null, receiptId: null, createdAt: 1 };
}
interface InputOverrides {
  characters?: CharacterState[];
  environment?: EnvironmentState | null;
  anchor?: ReturnType<typeof anchorFixture> | null;
  castBindings?: Array<{ characterId: string; canonRevisionId: string; wardrobe: string }>;
  shotLocationRevisionId?: string;
}
function inputFixture(overrides: InputOverrides = {}) {
  const sceneRev = canonFixture("char-scene-rev", "luna", "Luna, a lantern fox with amber eyes");
  const shotRev = canonFixture("char-shot-rev", "luna", "Luna, a lantern fox with amber eyes");
  const envRev = canonFixture("env-rev-1", "clearing", "A moonlit forest clearing", "environment");
  return {
    sceneRev, shotRev, envRev,
    input: {
      shot: shotFixture(overrides.castBindings ?? [{ characterId: "luna", canonRevisionId: "char-scene-rev", wardrobe: "grey hoodie" }], overrides.shotLocationRevisionId ?? "env-rev-1"),
      sceneStates: {
        characters: overrides.characters ?? [characterState("char-scene-rev", { outfit: "navy trench coat" })],
        environment: overrides.environment === undefined ? environmentState("env-rev-1", { zone: "clearing", lighting: "moonlight", timeOfDay: "night" }) : overrides.environment,
      },
      characterRevisions: [sceneRev, shotRev, envRev],
      environmentRevision: envRev,
      anchor: overrides.anchor === undefined ? anchorFixture() : overrides.anchor,
    },
  };
}
const findingOf = (result: ReturnType<typeof checkContinuity>, aspect: string) =>
  result.findings.find((candidate) => candidate.aspect === aspect)!;

describe("continuity engine (spec 11 core checks)", () => {
  it("detects an outfit mismatch from structured state, not prompt substring parsing", () => {
    const { input } = inputFixture();
    const result = checkContinuity(input);
    const outfit = findingOf(result, "outfit");
    expect(outfit.status).toBe("warn");
    expect(outfit.note).toContain('navy trench coat');
    expect(outfit.note).toContain('grey hoodie');
  });

  it("passes outfit when scene state and shot wardrobe agree (wording-insensitive)", () => {
    const { input } = inputFixture({ castBindings: [{ characterId: "luna", canonRevisionId: "char-scene-rev", wardrobe: "  NAVY   Trench Coat " }] });
    expect(findingOf(checkContinuity(input), "outfit").status).toBe("pass");
  });

  it("marks identity pass/warn/fail from anchor bindings versus scene states", () => {
    const matching = inputFixture();
    expect(findingOf(checkContinuity(matching.input), "identity").status).toBe("pass");

    const uncast = inputFixture({ castBindings: [] });
    const uncastResult = checkContinuity(uncast.input);
    expect(findingOf(uncastResult, "identity").status).toBe("fail");
    expect(findingOf(uncastResult, "outfit").status).toBe("not_checked");

    // Different revision of the same entity bound on the shot → stale-look warn.
    const stale = inputFixture();
    stale.input.shot = shotFixture([{ characterId: "luna", canonRevisionId: "char-other-rev", wardrobe: "grey hoodie" }]);
    stale.input.characterRevisions = [...stale.input.characterRevisions, canonFixture("char-other-rev", "luna", "Luna, a lantern fox with amber eyes")];
    expect(findingOf(checkContinuity(stale.input), "identity").status).toBe("warn");
  });

  it("answers honestly not_checked when nothing can be compared", () => {
    const noAnchor = inputFixture({ anchor: null });
    expect(findingOf(checkContinuity(noAnchor.input), "identity").status).toBe("not_checked");
    const noStates = inputFixture({ characters: [], environment: null });
    const result = checkContinuity(noStates.input);
    for (const aspect of ["identity", "outfit", "environment", "lighting"]) {
      expect(findingOf(result, aspect).status).toBe("not_checked");
    }
  });

  it("keeps environment and lighting advisory-strict on pins and missing context", () => {
    const staleEnv = inputFixture({ environment: environmentState("env-old-rev", { lighting: "moonlight" }), shotLocationRevisionId: "env-old-rev" });
    staleEnv.input.characterRevisions = [...staleEnv.input.characterRevisions, canonFixture("env-old-rev", "clearing", "old clearing", "environment")];
    const env = findingOf(checkContinuity(staleEnv.input), "environment");
    expect(env.status).toBe("warn");
    expect(env.note).toContain("env-old-rev");

    const unset = inputFixture({ environment: environmentState("env-rev-1") });
    const unsetResult = checkContinuity(unset.input);
    expect(findingOf(unsetResult, "lighting").status).toBe("warn");
    expect(findingOf(unsetResult, "environment").status).toBe("warn");

    const set = inputFixture();
    const setResult = checkContinuity(set.input);
    expect(findingOf(setResult, "environment").status).toBe("pass");
    expect(findingOf(setResult, "lighting").status).toBe("pass");
  });

  it("aggregates the worst status and never approves anything (advisory only)", () => {
    const { input } = inputFixture({ castBindings: [] });
    const result = checkContinuity(input);
    expect(result.status).toBe("fail");
    expect(result).not.toHaveProperty("approved");
    const unchecked = inputFixture({ characters: [], environment: null });
    const counts = summarizeContinuity([result, checkContinuity(unchecked.input)]);
    expect(counts).toMatchObject({ fail: 1, notChecked: 1, pass: 0, warn: 0 });
  });

  it("fails closed on input-shape violations", () => {
    expect(() => checkContinuity({} as never)).toThrow(ProductionApplicationError);
  });
});

describe("report projection + affected-only recompute (spec 11 §8/§9)", () => {
  function projectionFixture() {
    const first = inputFixture();
    const second = inputFixture();
    second.input.shot = { ...second.input.shot, id: "shotrev-2", shotId: "shot_2", order: 1, sceneId: "scene-2" };
    const scene = { version: 1 as const, id: "scene-1", projectId: "proj-1", storyRevisionId: "story-1", order: 0, title: "The clearing", action: "Fox enters.", dialogue: [], durationTargetMs: null, characterStates: first.input.sceneStates.characters, environmentState: first.input.sceneStates.environment, contentHash: sha("scene-1"), createdAt: 1 };
    const scene2 = { ...scene, id: "scene-2", order: 1, title: "The follow", contentHash: sha("scene-2") };
    const shots = [
      { shotRevision: { ...first.input.shot, sceneId: "scene-1" }, selectedAnchor: first.input.anchor ?? null, selectedTake: { id: "take-1" } },
      { shotRevision: second.input.shot, selectedAnchor: second.input.anchor ?? null, selectedTake: { id: "take-2" } },
    ];
    return { first, second, model: { shots, scenes: [scene, scene2], canonRevisions: first.input.characterRevisions } };
  }

  it("joins shots to ordered scenes (scene-major, sceneless last, 1-based numbers)", () => {
    const { model } = projectionFixture();
    const entries = continuityCheckEntries(model);
    expect(entries.map((entry) => [entry.sceneNumber, entry.shotId])).toEqual([[1, "shot_1"], [2, "shot_2"]]);
    const orphanModel = { ...model, shots: [...model.shots, { shotRevision: { ...model.shots[0]!.shotRevision, id: "shotrev-3", shotId: "shot_3", order: 9, sceneId: null }, selectedAnchor: null, selectedTake: null }] };
    const withOrphan = continuityCheckEntries(orphanModel);
    expect(withOrphan[2]).toMatchObject({ sceneNumber: null, sceneId: null, shotId: "shot_3" });
    expect(withOrphan[2]!.input.sceneStates.characters).toEqual([]);
  });

  it("recomputes only shots of changed scenes and preserves cached results by reference", () => {
    const { first, model } = projectionFixture();
    const entries = continuityCheckEntries(model);
    const previous = new Map(entries.map((entry) => [entry.shotId, checkContinuity(entry.input)]));
    const changedSceneIds = new Set(["scene-2"]);
    const next = recomputeAffected(previous, { sceneIds: changedSceneIds }, entries);
    expect(next.get("shot_1")).toBe(previous.get("shot_1"));
    expect(next.get("shot_2")).not.toBe(previous.get("shot_2"));
    expect(next.get("shot_2")).toEqual(checkContinuity(entries[1]!.input));
    // Deleted shots drop; new shots compute fresh.
    const grown = recomputeAffected(previous, { sceneIds: new Set() }, entries.slice(0, 1));
    expect(grown.has("shot_2")).toBe(false);
    expect(grown.get("shot_1")).toBe(previous.get("shot_1"));
    expect(first.input.shot.castBindings).toHaveLength(1);
  });
});
