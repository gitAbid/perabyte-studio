import { describe, expect, it } from "vitest";
import { buildEditIntentContext, editIntentToOp, parseEditIntent, type EditIntentContext } from "./edit-intents";

type ContextInput = Parameters<typeof buildEditIntentContext>[0];

const contextFixture = (overrides: Partial<ContextInput> = {}): EditIntentContext => {
  const input: ContextInput = {
    fps: 24,
    shotRows: [
      { shotRevisionId: "shot-rev-1", label: "Opening forest", durationMs: 2000, sourceDurationMs: 6000, disabled: false, soleEnabled: false, currentTakeId: "take-a1", takes: [{ id: "take-a1", label: "Take 1 · 144 frames" }, { id: "take-a2", label: "Take 2 · 120 frames" }] },
      { shotRevisionId: "shot-rev-2", label: "Luna enters", durationMs: 1500, sourceDurationMs: 4000, disabled: false, soleEnabled: false, currentTakeId: "take-b1", takes: [{ id: "take-b1", label: "Take 1 · 96 frames" }] },
      { shotRevisionId: "shot-rev-3", label: "The map", durationMs: 1000, sourceDurationMs: 3000, disabled: false, soleEnabled: false, currentTakeId: "take-c1", takes: [{ id: "take-c1", label: "Take 1 · 72 frames" }, { id: "take-c2", label: "Take 2 · 96 frames" }] },
      { shotRevisionId: "shot-rev-4", label: "River crossing", durationMs: 2500, sourceDurationMs: 5000, disabled: false, soleEnabled: false, currentTakeId: "take-d1", takes: [{ id: "take-d1", label: "Take 1 · 120 frames" }] },
      { shotRevisionId: "shot-rev-5", label: "Dawn reveal", durationMs: 3000, sourceDurationMs: 5000, disabled: false, soleEnabled: false, currentTakeId: "take-e1", takes: [{ id: "take-e1", label: "Take 1 · 120 frames" }] },
    ],
    characterNames: ["Luna", "Milo"],
    ...overrides,
  };
  return buildEditIntentContext(input);
};

const unsupportedIntent = (text: string, context: EditIntentContext = contextFixture()) =>
  parseEditIntent(text, context) as Extract<ReturnType<typeof parseEditIntent>, { kind: "unsupported" }>;

describe("parseEditIntent — spec 13 acceptance examples", () => {
  it("maps 'swap scenes 3 and 4' onto a reorder intent over the manifest shot order", () => {
    const intent = parseEditIntent("swap scenes 3 and 4", contextFixture());
    expect(intent).toMatchObject({ kind: "swap", firstOrdinal: 3, secondOrdinal: 4 });
    expect(editIntentToOp(intent)).toBeNull(); // reorder is a plan-revision edit, not a frozen C10 op
  });

  it("maps 'swap scene 3 with scene 4' and 'swap scenes 3 and 4' identically", () => {
    expect(parseEditIntent("swap scene 3 with scene 4", contextFixture())).toMatchObject({ kind: "swap", firstOrdinal: 3, secondOrdinal: 4 });
    expect(parseEditIntent("reverse scenes 3 and 4", contextFixture())).toMatchObject({ kind: "swap", firstOrdinal: 3, secondOrdinal: 4 });
  });

  it("routes 'make scene 2 more dramatic' to a retake direction with the scene ordinal and note", () => {
    const intent = parseEditIntent("make scene 2 more dramatic", contextFixture());
    expect(intent).toMatchObject({ kind: "retake_direction", sceneOrdinal: 2, note: "make scene 2 more dramatic" });
    expect(editIntentToOp(intent)).toBeNull();
  });

  it("routes 'make this scene more dramatic' to a retake direction without an ordinal", () => {
    expect(parseEditIntent("make this scene more dramatic", contextFixture())).toMatchObject({ kind: "retake_direction", sceneOrdinal: null });
  });

  it("routes 'Luna sounds scared here' to a delivery direction for Luna", () => {
    const intent = parseEditIntent("Luna sounds scared here", contextFixture());
    expect(intent).toMatchObject({ kind: "delivery_direction", characterName: "Luna", note: "Luna sounds scared here" });
    expect(editIntentToOp(intent)).toBeNull();
  });

  it("extracts an unknown capitalized subject as the delivery character", () => {
    const withoutCast = contextFixture({ characterNames: [] });
    expect(parseEditIntent("Rook sounds too cheerful", withoutCast)).toMatchObject({ kind: "delivery_direction", characterName: "Rook" });
  });

  it("keeps music phrasing out of the delivery router and points at the audio panel", () => {
    const intent = unsupportedIntent("cut to the music from 0:45");
    expect(intent.kind).toBe("unsupported");
    expect(intent.panel).toBe("audio");
    expect(intent.hint).toMatch(/audio workspace/i);
  });
});

describe("parseEditIntent — the five frozen C10 manifest ops", () => {
  it("trims seconds OFF a scene (reduce) with the duration before the reference", () => {
    const intent = parseEditIntent("trim 2 seconds off scene 5", contextFixture());
    expect(intent).toMatchObject({ kind: "retime", shotOrdinal: 5, shotRevisionId: "shot-rev-5", durationMs: 1000 });
    expect(editIntentToOp(intent)).toEqual({ kind: "retime", shotId: "shot-rev-5", durationMs: 1000 });
  });

  it("sets a scene to an absolute duration ('trim scene 2 to 1 second')", () => {
    expect(parseEditIntent("trim scene 2 to 1 second", contextFixture())).toMatchObject({ kind: "retime", shotOrdinal: 2, durationMs: 1000 });
  });

  it("extends a scene ('extend scene 1 by 2 seconds') and stays inside the pinned source length", () => {
    expect(parseEditIntent("extend scene 1 by 2 seconds", contextFixture())).toMatchObject({ kind: "retime", shotOrdinal: 1, durationMs: 4000 });
  });

  it("accepts a set-to duration without trim wording ('make scene 2 3 seconds')", () => {
    expect(parseEditIntent("make scene 2 3 seconds", contextFixture())).toMatchObject({ kind: "retime", shotOrdinal: 2, durationMs: 3000 });
  });

  it("snaps fractional retimes to the 24 fps frame grid", () => {
    expect(parseEditIntent("trim scene 3 to 1.1 seconds", contextFixture())).toMatchObject({ kind: "retime", durationMs: 1125 });
  });

  it("skips a scene", () => {
    const intent = parseEditIntent("skip scene 3", contextFixture());
    expect(intent).toMatchObject({ kind: "disable", shotOrdinal: 3, shotRevisionId: "shot-rev-3" });
    expect(editIntentToOp(intent)).toEqual({ kind: "disable", shotId: "shot-rev-3" });
  });

  it("repeats a scene", () => {
    expect(parseEditIntent("repeat scene 4", contextFixture())).toMatchObject({ kind: "duplicate", shotOrdinal: 4, shotRevisionId: "shot-rev-4" });
  });

  it("swaps the take of a scene by take number", () => {
    const intent = parseEditIntent("use take 2 for shot 3", contextFixture());
    expect(intent).toMatchObject({ kind: "replaceTake", shotOrdinal: 3, shotRevisionId: "shot-rev-3", takeId: "take-c2", takeLabel: "Take 2 · 96 frames" });
    expect(editIntentToOp(intent)).toEqual({ kind: "replaceTake", shotId: "shot-rev-3", takeId: "take-c2" });
  });

  it("accepts the compact 'scene 3 take 2' phrasing", () => {
    expect(parseEditIntent("scene 3 take 2", contextFixture())).toMatchObject({ kind: "replaceTake", takeId: "take-c2" });
  });
});

describe("parseEditIntent — ordinals", () => {
  it("resolves word ordinals against the 1-based manifest shot order", () => {
    expect(parseEditIntent("trim the second scene to 1 second", contextFixture())).toMatchObject({ kind: "retime", shotOrdinal: 2 });
  });

  it("accepts shot/clip nouns and # prefixes", () => {
    expect(parseEditIntent("skip shot #2", contextFixture())).toMatchObject({ kind: "disable", shotOrdinal: 2 });
    expect(parseEditIntent("repeat clip 4", contextFixture())).toMatchObject({ kind: "duplicate", shotOrdinal: 4 });
  });

  it("rejects ordinals past the end of the cut without guessing", () => {
    const intent = unsupportedIntent("skip scene 9");
    expect(intent.hint).toMatch(/5 scenes/);
    expect(unsupportedIntent("make scene 12 more dramatic").hint).toMatch(/5 scenes/);
  });
});

describe("parseEditIntent — honest failures", () => {
  it("answers an empty instruction with an example", () => {
    expect(unsupportedIntent("").hint).toMatch(/trim scene 2/i);
  });

  it("refuses to disable the only enabled scene", () => {
    const single = contextFixture({
      shotRows: [{ shotRevisionId: "shot-rev-1", label: "Only", durationMs: 2000, sourceDurationMs: 6000, disabled: false, soleEnabled: true, currentTakeId: "take-a1", takes: [] }],
    });
    expect(unsupportedIntent("skip scene 1", single).hint).toMatch(/only scene left/);
  });

  it("refuses retimes that would go below one frame or past the source footage", () => {
    expect(unsupportedIntent("trim scene 5 by 10 seconds").hint).toMatch(/125ms|0.125s/);
    expect(unsupportedIntent("extend scene 2 by 10 seconds").hint).toMatch(/4s of source footage/);
    expect(unsupportedIntent("trim scene 1 to 2 seconds").hint).toMatch(/already 2s/);
  });

  it("refuses unknown take numbers and no-op take swaps", () => {
    expect(unsupportedIntent("use take 5 for shot 3").hint).toMatch(/2 takes/);
    expect(unsupportedIntent("use take 1 for shot 3").hint).toMatch(/already uses/);
  });

  it("refuses self-swaps and scene-free swaps", () => {
    expect(unsupportedIntent("swap scenes 2 and 2").hint).toMatch(/same scene/);
    expect(unsupportedIntent("swap the scenes").hint).toMatch(/both scenes/);
  });

  it("answers unrecognized text with the capability list instead of guessing", () => {
    const intent = unsupportedIntent("make the whole film colorized");
    expect(intent.panel).toBeNull();
    expect(intent.hint).toMatch(/trim|skip|repeat/);
  });

  it("routes a duration without a scene to a naming hint", () => {
    expect(unsupportedIntent("trim to 2 seconds").hint).toMatch(/name the scene/i);
  });
});

describe("buildEditIntentContext", () => {
  it("numbers ordinals 1-based in array order and defaults character names to empty", () => {
    const context = buildEditIntentContext({
      fps: 24,
      shotRows: [
        { shotRevisionId: "a", label: null, durationMs: 1000, sourceDurationMs: null, disabled: false, soleEnabled: true, currentTakeId: "t", takes: [] },
        { shotRevisionId: "b", label: null, durationMs: 2000, sourceDurationMs: null, disabled: true, soleEnabled: false, currentTakeId: "t", takes: [] },
      ],
    });
    expect(context.shots.map((shot) => shot.ordinal)).toEqual([1, 2]);
    expect(context.characterNames).toEqual([]);
  });
});
