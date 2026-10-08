import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  Approval, CanonRevision, CharacterState, EnvironmentState, Scene, StoryBeat, StoryRevision,
} from "./contracts";
import {
  beatLabel, characterCanonRevisions, composeRevisionScriptText, deriveSceneDraftFromBeat,
  deriveSceneDraftFromScene, deriveStoryApprovalFacts, deriveStoryDiff, describeCharacterState,
  describeEnvironmentState, displayLabelForCanonRevision, environmentCanonRevisions,
  REVISION_INSTRUCTION_MARKER, REVISION_SCRIPT_TEXT_MAX_CHARS, sceneLabel, splitRevisionInstruction,
  summarizeBeat,
} from "./story-view-model";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");

const line = (characterId: string, text: string) => ({ characterId, text });
const beat = (id: string, order: number, action: string, narration: string, dialogue: StoryBeat["dialogue"] = []): StoryBeat =>
  ({ id, action, narration, dialogue, order });
const revision = (id: string, beats: StoryBeat[], overrides: Partial<StoryRevision> = {}): StoryRevision => ({
  version: 1,
  id,
  projectId: "project-1",
  parentRevisionId: null,
  scriptText: "Once upon a studio.",
  beats,
  canonRevisionIds: [],
  recommendedAt: null,
  contentHash: sha(`story-${id}`),
  createdAt: 1_000,
  ...overrides,
});
const canonRevision = (id: string, entityId: string, entityKind: CanonRevision["entityKind"]): CanonRevision => ({
  version: 1,
  id,
  entityId,
  entityKind,
  revision: 1,
  description: `Canon ${entityId}`,
  attributes: {},
  referenceAssetIds: [],
  contentHash: sha(`canon-${id}`),
  createdAt: 100,
});
const approval = (overrides: Partial<Approval>): Approval => ({
  version: 1,
  id: "approval-1",
  targetKind: "story",
  targetId: "story-1",
  targetHash: sha("story-story-1"),
  decision: "approved",
  actorId: "local-user",
  createdAt: 2_000,
  checklist: [{ id: "reviewed", passed: true, note: "Watched end to end." }],
  notes: "",
  advisoryAcknowledgements: [],
  ...overrides,
});

function composedText(input: { baseScript: string; instruction: string }): string {
  const result = composeRevisionScriptText(input);
  if (!result.ok) throw new Error(`composition should succeed, failed with: ${result.reason}`);
  return result.text;
}
function failureReason(input: { baseScript: string; instruction: string }): string {
  const result = composeRevisionScriptText(input);
  if (result.ok) throw new Error("composition should fail");
  return result.reason;
}

describe("story view model — conversational revise encoding", () => {
  it("composes base script plus instruction behind the visible marker and splits it back losslessly", () => {
    expect(REVISION_INSTRUCTION_MARKER).toBe("[revision request]");
    const text = composedText({ baseScript: "  Base story.  ", instruction: "  Make the ending shorter.  " });
    expect(text).toBe("Base story.\n\n[revision request]\nMake the ending shorter.");
    // The marker pattern is "\n<marker>\n", so the base slice keeps its own trailing newline.
    expect(splitRevisionInstruction(text)).toEqual({ baseScript: "Base story.\n", instruction: "Make the ending shorter." });
  });

  it("composes a bare instruction when there is no base script yet", () => {
    const text = composedText({ baseScript: "   ", instruction: "Write a storm scene." });
    expect(text).toBe("Write a storm scene.");
    expect(text).not.toContain(REVISION_INSTRUCTION_MARKER);
    expect(splitRevisionInstruction(text)).toEqual({ baseScript: "Write a storm scene.", instruction: null });
  });

  it("rejects an empty instruction before touching the size bound", () => {
    expect(failureReason({ baseScript: "Base", instruction: "   " })).toMatch(/Describe the change you want/);
  });

  it("enforces the shared scriptText character bound", () => {
    expect(failureReason({ baseScript: "", instruction: "x".repeat(REVISION_SCRIPT_TEXT_MAX_CHARS + 1) }))
      .toMatch(/above the 500,000-character bound/);
    expect(composedText({ baseScript: "", instruction: "x".repeat(REVISION_SCRIPT_TEXT_MAX_CHARS) }))
      .toBe("x".repeat(REVISION_SCRIPT_TEXT_MAX_CHARS));
  });

  it("splits plain script text without a marker and blanks after the marker back to no instruction", () => {
    expect(splitRevisionInstruction("Plain script, no marker.")).toEqual({ baseScript: "Plain script, no marker.", instruction: null });
    expect(splitRevisionInstruction("Base\n\n[revision request]\n   ")).toEqual({ baseScript: "Base\n", instruction: null });
  });

  it("splits on the LAST marker so a base script containing the marker round-trips", () => {
    const nested = "Earlier base\n\n[revision request]\nStill base\n\n[revision request]\nNewest instruction.";
    expect(splitRevisionInstruction(nested)).toEqual({
      baseScript: "Earlier base\n\n[revision request]\nStill base\n",
      instruction: "Newest instruction.",
    });
  });
});

describe("story view model — human-readable story diff", () => {
  it("reports added, changed, removed and unchanged beats, matched by id, with per-field detail", () => {
    const base = revision("story-base", [
      beat("b1", 0, "Ayo enters.", "Morning.", [line("char-ayo", "Hello.")]),
      beat("b2", 1, "Storm rolls in.", "Wind rises.", []),
      beat("b4", 3, "Deleted beat.", "", []),
    ]);
    const next = revision("story-next", [
      beat("b1", 0, "Ayo enters late.", "Morning.", [line("char-ayo", "Hello."), line("char-ayo", "Still here.")]),
      beat("b2", 1, "Storm rolls in.", "Wind rises.", []),
      beat("b3", 2, "Brand new beat.", "", []),
    ]);

    const diff = deriveStoryDiff(base, next);
    expect(diff.hasChanges).toBe(true);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.entries.map((entry) => entry.kind)).toEqual(["changed", "added", "removed"]);

    const changed = diff.entries[0];
    if (changed.kind !== "changed") throw new Error("expected a changed entry");
    expect(changed.beatId).toBe("b1");
    expect(changed.changedFields).toEqual(["action", "dialogue"]);
    expect(changed.before).toEqual(summarizeBeat(base.beats[0]));
    expect(changed.after).toEqual(summarizeBeat(next.beats[0]));

    const added = diff.entries[1];
    if (added.kind !== "added") throw new Error("expected an added entry");
    expect(added.beatId).toBe("b3");
    expect(added.after.action).toBe("Brand new beat.");

    const removed = diff.entries[2];
    if (removed.kind !== "removed") throw new Error("expected a removed entry");
    expect(removed.beatId).toBe("b4");
    expect(removed.before.action).toBe("Deleted beat.");
  });

  it("isolates a narration-only change and a dialogue reorder as exactly one changed field each", () => {
    const base = revision("story-base", [
      beat("b1", 0, "Action line.", "Quiet morning.", [line("char-ayo", "First."), line("char-ayo", "Second.")]),
    ]);
    const narrationOnly = revision("story-narration", [
      beat("b1", 0, "Action line.", "Loud morning.", [line("char-ayo", "First."), line("char-ayo", "Second.")]),
    ]);
    const dialogueReorder = revision("story-reorder", [
      beat("b1", 0, "Action line.", "Quiet morning.", [line("char-ayo", "Second."), line("char-ayo", "First.")]),
    ]);

    const narrationDiff = deriveStoryDiff(base, narrationOnly);
    const reorderDiff = deriveStoryDiff(base, dialogueReorder);
    if (narrationDiff.entries[0].kind !== "changed" || reorderDiff.entries[0].kind !== "changed") {
      throw new Error("expected changed entries");
    }
    expect(narrationDiff.entries[0].changedFields).toEqual(["narration"]);
    expect(reorderDiff.entries[0].changedFields).toEqual(["dialogue"]);
  });

  it("reports no changes for identical revisions", () => {
    const same = revision("story-same", [
      beat("b1", 0, "Action.", "Narration.", [line("char-ayo", "Line.")]),
      beat("b2", 1, "More action.", "", []),
    ]);
    const diff = deriveStoryDiff(same, { ...same, id: "story-again" });
    expect(diff).toEqual({ entries: [], unchangedCount: 2, hasChanges: false });
  });

  it("labels beats by position and first action line, and summarizes dialogue as speaker: text", () => {
    const multiline = beat("b7", 2, "First line\nsecond line", "");
    expect(beatLabel(multiline)).toBe("Beat 3 — “First line”");
    expect(summarizeBeat(beat("b8", 0, "A", "", [line("char-ayo", "Hello.")]))).toEqual({
      action: "A",
      narration: "",
      dialogue: ["char-ayo: Hello."],
    });
  });
});

describe("story view model — scene drafts with stable ids", () => {
  it("maps beat dialogue onto active character canon revisions, dedupes character states, and reports unmappable speakers", () => {
    const result = deriveSceneDraftFromBeat({
      sceneId: "scene-1",
      beat: beat("b1", 2, "Ayo enters the harbor.\nMore action.", "Fog everywhere.", [
        line("char-ayo", "Hello."),
        line("char-ghost", "Boo."),
        line("char-ayo", "Still here."),
      ]),
      order: 2,
      projectId: "project-1",
      storyRevisionId: "story-1",
      canonRevisions: [canonRevision("rev-ayo", "char-ayo", "character"), canonRevision("rev-harbor", "loc-harbor", "location")],
    });
    if (!result.ok) throw new Error(`draft derivation should succeed: ${result.reason}`);
    expect(result.draft).toEqual({
      id: "scene-1",
      projectId: "project-1",
      storyRevisionId: "story-1",
      order: 2,
      title: "Ayo enters the harbor.",
      action: "Ayo enters the harbor.\nMore action.\n\nFog everywhere.",
      dialogue: [
        { characterCanonRevisionId: "rev-ayo", text: "Hello." },
        { characterCanonRevisionId: "rev-ayo", text: "Still here." },
      ],
      durationTargetMs: null,
      characterStates: [{ characterCanonRevisionId: "rev-ayo", accessories: [], carriedObjects: [], condition: [] }],
      environmentState: null,
    });
    expect(result.unmappedSpeakers).toEqual([{ characterId: "char-ghost", text: "Boo." }]);
  });

  it("falls back to a positional title and an empty draft when the beat has no action or dialogue", () => {
    const result = deriveSceneDraftFromBeat({
      sceneId: "scene-9",
      beat: beat("b9", 2, "", "Just atmosphere."),
      order: 2,
      projectId: "project-1",
      storyRevisionId: null,
      canonRevisions: [],
    });
    if (!result.ok) throw new Error(`draft derivation should succeed: ${result.reason}`);
    expect(result.draft.title).toBe("Scene 3");
    expect(result.draft.action).toBe("\n\nJust atmosphere.");
    expect(result.draft.dialogue).toEqual([]);
    expect(result.draft.characterStates).toEqual([]);
    expect(result.draft.storyRevisionId).toBeNull();
    expect(result.unmappedSpeakers).toEqual([]);
  });

  it("derives a scene-shaped draft from an existing scene keeping every stored byte", () => {
    const scene: Scene = {
      version: 1,
      id: "scene-4",
      projectId: "project-1",
      storyRevisionId: "story-1",
      order: 3,
      title: "Sleeping Dragon",
      action: "The dragon sleeps.",
      dialogue: [{ characterCanonRevisionId: "rev-ayo", text: "Hi." }],
      durationTargetMs: 4_000,
      characterStates: [{ characterCanonRevisionId: "rev-ayo", accessories: ["a straw hat"], carriedObjects: [], condition: ["soaked"] }],
      environmentState: { environmentCanonRevisionId: "rev-harbor", zone: "the docks", persistentProps: ["crates"] },
      contentHash: sha("scene-4"),
      createdAt: 5_000,
    };
    const draft = deriveSceneDraftFromScene(scene);
    expect(draft).toEqual({
      id: "scene-4",
      projectId: "project-1",
      storyRevisionId: "story-1",
      order: 3,
      title: "Sleeping Dragon",
      action: "The dragon sleeps.",
      dialogue: [{ characterCanonRevisionId: "rev-ayo", text: "Hi." }],
      durationTargetMs: 4_000,
      characterStates: [{ characterCanonRevisionId: "rev-ayo", accessories: ["a straw hat"], carriedObjects: [], condition: ["soaked"] }],
      environmentState: { environmentCanonRevisionId: "rev-harbor", zone: "the docks", persistentProps: ["crates"] },
    });
    expect(draft).not.toBe(scene);
  });
});

describe("story view model — plain-language state summaries", () => {
  it("renders a fully populated character state as one readable line in contract order", () => {
    const state: CharacterState = {
      characterCanonRevisionId: "rev-ayo",
      outfit: "a rain coat",
      hairState: "braided",
      agePresentation: "adult",
      accessories: ["a straw hat", "a compass"],
      carriedObjects: ["a lantern"],
      condition: ["soaked"],
      notes: "Cheerful despite the rain.",
    };
    expect(describeCharacterState(state, "Ayo")).toBe(
      "Ayo — wearing a rain coat; hair: braided; looks adult; accessories: a straw hat, a compass; carrying a lantern; condition: soaked; Cheerful despite the rain.",
    );
  });

  it("says a bare character state stays on canon look", () => {
    const state: CharacterState = { characterCanonRevisionId: "rev-ayo", accessories: [], carriedObjects: [], condition: [] };
    expect(describeCharacterState(state, "Ayo")).toBe("Ayo — canon look, nothing added for this scene");
  });

  it("renders a fully populated environment state as one readable line in contract order", () => {
    const state: EnvironmentState = {
      environmentCanonRevisionId: "rev-harbor",
      zone: "the north docks",
      timeOfDay: "dawn",
      lighting: "overcast",
      weather: "foggy",
      persistentProps: ["crates", "rope"],
    };
    expect(describeEnvironmentState(state, "Harbor")).toBe(
      "Harbor — area: the north docks; dawn; lighting: overcast; weather: foggy; always present: crates, rope",
    );
  });

  it("says a bare environment state stays on canon look", () => {
    const state: EnvironmentState = { environmentCanonRevisionId: "rev-harbor", persistentProps: [] };
    expect(describeEnvironmentState(state, "Harbor")).toBe("Harbor — canon look, nothing added for this scene");
  });
});

describe("story view model — approval facts (C8)", () => {
  const story = revision("story-1", [beat("b1", 0, "Action.", "")]);

  it("returns plain draft facts when there is no story revision at all", () => {
    expect(deriveStoryApprovalFacts([approval({})], null)).toEqual({ state: "draft", latest: null, approvedCurrent: false });
  });

  it("derives approved only from an explicit approval bound to this revision's exact contentHash", () => {
    const facts = deriveStoryApprovalFacts([approval({})], story);
    expect(facts.state).toBe("approved");
    expect(facts.latest?.id).toBe("approval-1");
    expect(facts.approvedCurrent).toBe(true);
  });

  it("treats an approval for a different hash as superseded and fails safe", () => {
    const superseded = deriveStoryApprovalFacts([approval({ targetHash: sha("story-old") })], story);
    expect(superseded.state).toBe("draft");
    expect(superseded.latest?.id).toBe("approval-1");
    expect(superseded.approvedCurrent).toBe(false);

    const supersededButRecommended = deriveStoryApprovalFacts(
      [approval({ targetHash: sha("story-old") })],
      { ...story, recommendedAt: 3_000 },
    );
    expect(supersededButRecommended.state).toBe("recommended");
    expect(supersededButRecommended.approvedCurrent).toBe(false);
  });

  it("keeps a rejection ahead of any recommendation", () => {
    const rejected = deriveStoryApprovalFacts([approval({ decision: "rejected", checklist: [] })], story);
    expect(rejected.state).toBe("draft");
    expect(rejected.approvedCurrent).toBe(false);

    const rejectedWithRecommendation = deriveStoryApprovalFacts(
      [approval({ decision: "rejected", checklist: [] })],
      { ...story, recommendedAt: 3_000 },
    );
    expect(rejectedWithRecommendation.state).toBe("draft");
  });

  it("derives recommended from the recommendation marker alone and draft from nothing", () => {
    expect(deriveStoryApprovalFacts([], { ...story, recommendedAt: 3_000 }).state).toBe("recommended");
    expect(deriveStoryApprovalFacts([], story)).toEqual({ state: "draft", latest: null, approvedCurrent: false });
  });

  it("lets the newest approval by createdAt win, and ignores approvals aimed at other targets", () => {
    const olderApproved = approval({ id: "approval-older", createdAt: 1_000 });
    const newerRejected = approval({ id: "approval-newer", createdAt: 2_000, decision: "rejected", checklist: [] });
    const facts = deriveStoryApprovalFacts([olderApproved, newerRejected], story);
    expect(facts.latest?.id).toBe("approval-newer");
    expect(facts.state).toBe("draft");

    const otherStory = deriveStoryApprovalFacts([approval({ targetId: "story-2" })], story);
    expect(otherStory.latest).toBeNull();
    expect(otherStory.state).toBe("draft");

    const otherKind = deriveStoryApprovalFacts([approval({ targetKind: "animatic" })], story);
    expect(otherKind.latest).toBeNull();
    expect(otherKind.state).toBe("draft");
  });
});

describe("story view model — display helpers", () => {
  it("labels canon revisions by their leading name-like phrase and tolerates the id fallback", () => {
    expect(displayLabelForCanonRevision(canonRevision("rev-ayo", "char-ayo", "character"))).toBe("Canon char-ayo");
    const longLead = canonRevision("rev-long", "char-long", "character");
    expect(displayLabelForCanonRevision({ ...longLead, description: `${"x".repeat(80)}, rest` })).toBe(`${"x".repeat(57)}…`);
    expect(displayLabelForCanonRevision({ ...longLead, description: "   " })).toBe("char-long");
  });

  it("splits canon revisions into character and environment pins, tolerating legacy location rows", () => {
    const pins = [
      canonRevision("rev-ayo", "char-ayo", "character"),
      canonRevision("rev-harbor", "loc-harbor", "location"),
      canonRevision("rev-studio", "env-studio", "environment"),
      canonRevision("rev-prop", "prop-lantern", "prop"),
    ];
    expect(characterCanonRevisions(pins).map((revision) => revision.id)).toEqual(["rev-ayo"]);
    expect(environmentCanonRevisions(pins).map((revision) => revision.id)).toEqual(["rev-harbor", "rev-studio"]);
  });

  it("labels scenes by one-based position", () => {
    expect(sceneLabel({ order: 2, title: "Sleeping Dragon" })).toBe("Scene 3 — Sleeping Dragon");
  });
});
