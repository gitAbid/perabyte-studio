import { describe, expect, it } from "vitest";
import {
  ApprovalSchema, CanonRevisionSchema, CreateApprovalCommandSchema, CreateShotPlanCommandSchema,
  ShotPlanRevisionSchema, ShotRevisionSchema, StoryRevisionSchema,
  type Approval, type CanonRevision, type ProjectReadModel, type ShotRevision, type StoryRevision,
} from "./contracts";
import { APPROVAL_CHECKLISTS } from "./approval";
import {
  H3_FRAME_GRID, PLAN_DEFAULT_MOTION_INTENT, PLAN_DEFAULT_TARGET_FRAMES, PLAN_SHOT_FRAMINGS,
  deriveCreateShotPlanCommand, derivePlanCanonOptions, derivePlanDraftFromBeats, derivePlanDraftIssues,
  derivePlanSummaryRows, deriveReplanWarning, deriveRevisionApprovalCommand, framesSecondsHint,
  isLegalH3TargetFrames, parsePlanTargetFrames,
} from "@/components/production/plan-builder";
import {
  STORY_APPROVAL_CHECKLIST_VIEW, deriveStoryApprovalCommand, deriveStoryApprovalState,
} from "@/components/production/project-canon";

/* Fixtures are parsed through the accepted zod schemas so the tests cannot drift from the contracts. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const canonRevision = (overrides: Partial<CanonRevision> & Pick<CanonRevision, "id" | "entityId" | "entityKind" | "description">): CanonRevision =>
  CanonRevisionSchema.parse({
    version: 1, revision: 1, attributes: {}, referenceAssetIds: [], contentHash: SHA_A, createdAt: 1, ...overrides,
  });

const CHAR_AYO = canonRevision({ id: "canonchar_v1", entityId: "char_ayo", entityKind: "character", description: "Ayo, a young harbor pilot" });
const LOC_HARBOR = canonRevision({ id: "canonloc_v1", entityId: "loc_harbor", entityKind: "location", description: "A foggy harbor at dawn" });
const STYLE_BOOK = canonRevision({ id: "canonstyle_v1", entityId: "style_book", entityKind: "style", description: "Ink-and-water storybook style" });
const LOC_ROOFTOP = canonRevision({ id: "canonloc_v2", entityId: "loc_rooftop", entityKind: "location", description: "A windy rooftop at dusk" });
/** Pinned by the story but NOT currently selected — must never appear as a plan option. */
const LOC_UNSELECTED = canonRevision({ id: "canonloc_v0", entityId: "loc_harbor", entityKind: "location", description: "An older harbor revision" });

const story = (overrides: Partial<StoryRevision> = {}): StoryRevision =>
  StoryRevisionSchema.parse({
    version: 1, id: "story_v1", projectId: "proj_1", parentRevisionId: null,
    scriptText: "The harbor wakes.\n\nThe film closes.",
    beats: [
      { id: "beat_1", action: "The harbor wakes.", narration: "The narrator opens the film on a quiet harbor at dawn.", dialogue: [], order: 0 },
      {
        id: "beat_2", action: "Ayo boards the skiff.", narration: "Ayo steps aboard.", order: 1,
        dialogue: [{ characterId: "char_ayo", text: "Tide is turning." }],
      },
    ],
    canonRevisionIds: [CHAR_AYO.id, LOC_HARBOR.id, STYLE_BOOK.id],
    contentHash: SHA_A, createdAt: 1, ...overrides,
  });

const canonOptions = { characters: [CHAR_AYO], locations: [LOC_HARBOR], styles: [STYLE_BOOK] };
const issueCodes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

/* 1. H3 frame grid validation (legal = 124 + 17n, max 362) and duration hints */
describe("C19 H3 target-frame validation", () => {
  it("accepts exactly the 124 + 17n grid up to 362 frames and nothing else", () => {
    expect(H3_FRAME_GRID).toEqual({ baseFrames: 124, stepFrames: 17, maxFrames: 362 });
    for (let n = 0; n <= 14; n += 1) expect(isLegalH3TargetFrames(124 + 17 * n)).toBe(true);
    for (const illegal of [0, -17, 1, 123, 125, 141 - 1, 363, 100_000, 124.5]) {
      expect(isLegalH3TargetFrames(illegal)).toBe(false);
    }
  });

  it("derives integer-math seconds hints at 24 fps", () => {
    expect(framesSecondsHint(192)).toBe("≈ 8.000s at 24 fps");
    expect(framesSecondsHint(124)).toBe("≈ 5.166s at 24 fps");
    expect(framesSecondsHint(362)).toBe("≈ 15.083s at 24 fps");
  });

  it("parses positive safe-integer frame text within the 100000 contract bound", () => {
    expect(parsePlanTargetFrames("192")).toBe(192);
    expect(parsePlanTargetFrames("100000")).toBe(100_000);
    for (const text of ["", " ", "abc", "12.5", "0", "-4", "100001", "1e309"]) {
      expect(parsePlanTargetFrames(text)).toBeNull();
    }
  });
});

/* 2. Draft generation: one editable shot per story beat, in beat order */
describe("C19 draft derivation from story beats", () => {
  it("derives one shot per beat with the frozen prefills", () => {
    const drafts = derivePlanDraftFromBeats(story(), canonOptions);
    expect(drafts.map((draft) => draft.shotId)).toEqual(["shot_1", "shot_2"]);
    expect(drafts.map((draft) => draft.beatIds)).toEqual([["beat_1"], ["beat_2"]]);
    expect(drafts.map((draft) => draft.visualIntent)).toEqual(["The harbor wakes.", "Ayo boards the skiff."]);
    expect(drafts.every((draft) => draft.motionIntent === PLAN_DEFAULT_MOTION_INTENT)).toBe(true);
    expect(drafts.every((draft) => draft.framing === "medium")).toBe(true);
    expect(drafts.every((draft) => draft.targetFramesText === String(PLAN_DEFAULT_TARGET_FRAMES))).toBe(true);
    expect(PLAN_DEFAULT_TARGET_FRAMES).toBe(192);
    expect(isLegalH3TargetFrames(PLAN_DEFAULT_TARGET_FRAMES)).toBe(true);
    expect(drafts.every((draft) => draft.castBindings.length === 0)).toBe(true);
  });

  it("prefills location and style from the first story-pinned selected option and never from unpinned canon", () => {
    const drafts = derivePlanDraftFromBeats(story(), canonOptions);
    expect(drafts.map((draft) => draft.locationRevisionId)).toEqual(["canonloc_v1", "canonloc_v1"]);
    expect(drafts.map((draft) => draft.styleRevisionId)).toEqual(["canonstyle_v1", "canonstyle_v1"]);
    const empty = derivePlanDraftFromBeats(story(), { characters: [], locations: [], styles: [] });
    expect(empty.every((draft) => draft.locationRevisionId === "" && draft.styleRevisionId === "")).toBe(true);
  });

  it("exposes the six contract framings verbatim", () => {
    expect([...PLAN_SHOT_FRAMINGS]).toEqual(["extreme_wide", "wide", "medium_wide", "medium", "close", "extreme_close"]);
  });
});

/* 3. Canon options: story pins ∩ current selections, read-model order preserved */
describe("C19 plan canon options", () => {
  it("intersects story-pinned revisions with the current selections and keeps kinds apart", () => {
    const options = derivePlanCanonOptions(story(), [LOC_ROOFTOP, LOC_UNSELECTED, CHAR_AYO, STYLE_BOOK, LOC_HARBOR]);
    expect(options.characters.map((revision) => revision.id)).toEqual(["canonchar_v1"]);
    expect(options.locations.map((revision) => revision.id)).toEqual(["canonloc_v1"]);
    expect(options.styles.map((revision) => revision.id)).toEqual(["canonstyle_v1"]);
  });

  it("returns empty option groups when the story pins canon that is no longer selected", () => {
    const options = derivePlanCanonOptions(story(), [LOC_ROOFTOP]);
    expect(options.characters).toEqual([]);
    expect(options.locations).toEqual([]);
    expect(options.styles).toEqual([]);
  });
});

/* 4. Client-side draft issues (server remains the truth) */
describe("C19 draft issue derivation", () => {
  const withWardrobe = (drafts: ReturnType<typeof derivePlanDraftFromBeats>) =>
    drafts.map((draft) => ({
      ...draft,
      castBindings: draft.castBindings.map((binding) => ({ ...binding, wardrobe: binding.wardrobe === "" ? "Oilskin coat" : binding.wardrobe })),
    }));
  const tickCast = (drafts: ReturnType<typeof derivePlanDraftFromBeats>) =>
    drafts.map((draft, index) => (index === 1
      ? { ...draft, castBindings: [{ characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "Oilskin coat" }] }
      : draft));

  it("accepts the untouched defaults for a dialogue-free story with no issues", () => {
    const dialogueFree = story({
      beats: [
        { id: "beat_1", action: "The harbor wakes.", narration: "The narrator opens the film on a quiet harbor at dawn.", dialogue: [], order: 0 },
        { id: "beat_2", action: "The film closes.", narration: "The narrator closes the film over the water.", dialogue: [], order: 1 },
      ],
    });
    const drafts = derivePlanDraftFromBeats(dialogueFree, canonOptions);
    expect(derivePlanDraftIssues({ story: dialogueFree, drafts, options: canonOptions })).toEqual([]);
    // A story with dialogue legitimately leaves the defaults incomplete: the speaker is unbound.
    expect(issueCodes(derivePlanDraftIssues({ story: story(), drafts: derivePlanDraftFromBeats(story(), canonOptions), options: canonOptions })))
      .toContain("DIALOGUE_SPEAKER_UNBOUND");
  });

  it("flags blank intents, bad frames, duplicate shot ids and dropped beat coverage", () => {
    const drafts = derivePlanDraftFromBeats(story(), canonOptions);
    const broken = drafts.map((draft, index) =>
      index === 0
        ? { ...draft, shotId: "shot_2", visualIntent: "   ", targetFramesText: "0" }
        : { ...draft, beatIds: [] });
    const issues = derivePlanDraftIssues({ story: story(), drafts: broken, options: canonOptions });
    expect(issueCodes(issues)).toContain("VISUAL_INTENT_REQUIRED");
    expect(issueCodes(issues)).toContain("FRAMES_INVALID");
    expect(issueCodes(issues)).toContain("SHOT_ID_DUPLICATE");
    expect(issueCodes(issues)).toContain("SHOT_BEATS_REQUIRED");
    expect(issueCodes(issues)).toContain("BEAT_UNCOVERED");
  });

  it("rejects invalid shot ids, missing location/style and unbound wardrobe", () => {
    const drafts = derivePlanDraftFromBeats(story(), canonOptions).map((draft, index) =>
      index === 0 ? { ...draft, shotId: "bad id!", locationRevisionId: "", styleRevisionId: "" } : draft);
    const issues = derivePlanDraftIssues({ story: story(), drafts, options: canonOptions });
    expect(issueCodes(issues)).toContain("SHOT_ID_INVALID");
    expect(issueCodes(issues)).toContain("LOCATION_REQUIRED");
    expect(issueCodes(issues)).toContain("STYLE_REQUIRED");
    const withCast = tickCast(derivePlanDraftFromBeats(story(), canonOptions)).map((draft, index) =>
      index === 1 ? { ...draft, castBindings: [{ characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "  " }] } : draft);
    expect(issueCodes(derivePlanDraftIssues({ story: story(), drafts: withCast, options: canonOptions }))).toContain("WARDROBE_REQUIRED");
  });

  it("requires every dialogue speaker to appear in a covering shot and caps cast bindings at three", () => {
    const unbound = derivePlanDraftFromBeats(story(), canonOptions);
    expect(issueCodes(derivePlanDraftIssues({ story: story(), drafts: unbound, options: canonOptions }))).toContain("DIALOGUE_SPEAKER_UNBOUND");
    const bound = tickCast(unbound);
    expect(derivePlanDraftIssues({ story: story(), drafts: bound, options: canonOptions })).toEqual([]);
    const overLimit = bound.map((draft) => ({
      ...draft,
      castBindings: [
        { characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "a" },
        { characterId: "char_b", canonRevisionId: "canonchar_v2", wardrobe: "b" },
        { characterId: "char_c", canonRevisionId: "canonchar_v3", wardrobe: "c" },
        { characterId: "char_d", canonRevisionId: "canonchar_v4", wardrobe: "d" },
      ],
    }));
    expect(issueCodes(derivePlanDraftIssues({ story: story(), drafts: overLimit, options: canonOptions }))).toContain("CAST_LIMIT");
  });
});

/* 5. Create command plumbing (approvedStoryHash = story contentHash; schema-valid body) */
describe("C19 shot-plan create command derivation", () => {
  it("emits the exact POST /shot-plans body for valid drafts and null for broken drafts", () => {
    const drafts = derivePlanDraftFromBeats(story(), canonOptions).map((draft, index) =>
      index === 1 ? { ...draft, castBindings: [{ characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "Oilskin coat" }] } : draft);
    const command = deriveCreateShotPlanCommand({ projectId: "proj_1", story: story(), drafts });
    expect(command).not.toBeNull();
    expect(command?.projectId).toBe("proj_1");
    expect(command?.storyRevisionId).toBe("story_v1");
    expect(command?.approvedStoryHash).toBe(SHA_A);
    expect(command?.shots.map((shot) => shot.shotId)).toEqual(["shot_1", "shot_2"]);
    expect(command?.shots[1]?.castBindings).toEqual([{ characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "Oilskin coat" }]);
    expect(command?.shots.every((shot) => shot.propRevisionIds.length === 0 && shot.continuation === null)).toBe(true);
    expect(CreateShotPlanCommandSchema.safeParse(command).success).toBe(true);
    const broken = derivePlanDraftFromBeats(story(), canonOptions).map((draft) => ({ ...draft, visualIntent: "" }));
    expect(deriveCreateShotPlanCommand({ projectId: "proj_1", story: story(), drafts: broken })).toBeNull();
  });
});

/* 6. Shot-plan / animatic approval command plumbing */
describe("C19 revision approval commands (shotplan + animatic)", () => {
  const baseInput = (targetKind: "shotplan" | "animatic") => ({
    projectId: "proj_1",
    idempotencyKey: "key-1",
    targetKind,
    targetId: `${targetKind}_rev_1`,
    revisionHash: SHA_B,
    checklist: APPROVAL_CHECKLISTS[targetKind].map((id) => ({ id, passed: true, note: "checked" })),
    notes: "",
  });

  it("mirrors the accepted shotplan and animatic checklists verbatim in command order", () => {
    const planCommand = deriveRevisionApprovalCommand(baseInput("shotplan"));
    expect(planCommand?.command.targetKind).toBe("shotplan");
    expect(planCommand?.command.expectedHash).toBe(SHA_B);
    expect(planCommand?.command.checklist.map((item) => item.id)).toEqual([...APPROVAL_CHECKLISTS.shotplan]);
    expect(CreateApprovalCommandSchema.safeParse(planCommand?.command).success).toBe(true);
    const animaticCommand = deriveRevisionApprovalCommand(baseInput("animatic"));
    expect(animaticCommand?.command.targetKind).toBe("animatic");
    expect(animaticCommand?.command.checklist.map((item) => item.id)).toEqual([...APPROVAL_CHECKLISTS.animatic]);
    expect(CreateApprovalCommandSchema.safeParse(animaticCommand?.command).success).toBe(true);
  });

  it("refuses to emit a command until every required checklist item is ticked", () => {
    const unticked = baseInput("shotplan");
    expect(deriveRevisionApprovalCommand({
      ...unticked,
      checklist: unticked.checklist.map((item, index) => (index === 0 ? { ...item, passed: false } : item)),
    })).toBeNull();
  });
});

/* 7. Story approval state + command (script editor page) */
describe("C19 story approval state and command", () => {
  it("mirrors the accepted story checklist verbatim", () => {
    expect([...STORY_APPROVAL_CHECKLIST_VIEW]).toEqual([...APPROVAL_CHECKLISTS.story]);
  });

  const approved = (overrides: Partial<Approval> = {}): Approval =>
    ApprovalSchema.parse({
      version: 1, id: "approval_story_v1", targetKind: "story", targetId: "story_v1", targetHash: SHA_A,
      decision: "approved", actorId: "local-creator", createdAt: 50,
      checklist: APPROVAL_CHECKLISTS.story.map((id) => ({ id, passed: true, note: "checked" })),
      notes: "", advisoryAcknowledgements: [], ...overrides,
    });

  it("reports approvedCurrent only for an approval of the exact current revision hash", () => {
    expect(deriveStoryApprovalState([], story())).toEqual({ latest: null, approvedCurrent: false });
    expect(deriveStoryApprovalState([approved()], story()).approvedCurrent).toBe(true);
    expect(deriveStoryApprovalState([approved({ decision: "rejected" })], story()).approvedCurrent).toBe(false);
    expect(deriveStoryApprovalState([approved({ targetHash: SHA_B })], story()).approvedCurrent).toBe(false);
    const superseded = story({ id: "story_v0", contentHash: SHA_B });
    expect(deriveStoryApprovalState([approved()], superseded).approvedCurrent).toBe(false);
  });

  it("emits the exact POST /api/production/approvals body for the story revision", () => {
    const command = deriveStoryApprovalCommand({
      projectId: "proj_1", idempotencyKey: "key-1", story: story(),
      checklist: APPROVAL_CHECKLISTS.story.map((id) => ({ id, passed: true, note: "verified" })), notes: "read aloud",
    });
    expect(command?.projectId).toBe("proj_1");
    expect(command?.idempotencyKey).toBe("key-1");
    expect(command?.command.targetKind).toBe("story");
    expect(command?.command.targetId).toBe("story_v1");
    expect(command?.command.expectedHash).toBe(SHA_A);
    expect(command?.command.decision).toBe("approved");
    expect(command?.command.checklist.map((item) => item.id)).toEqual([...APPROVAL_CHECKLISTS.story]);
    expect(command?.command.checklist.every((item) => item.passed && item.note === "verified")).toBe(true);
    expect(command?.command.notes).toBe("read aloud");
    expect(command?.command.advisoryAcknowledgements).toEqual([]);
    expect(CreateApprovalCommandSchema.safeParse(command?.command).success).toBe(true);
    const unticked = APPROVAL_CHECKLISTS.story.map((id) => ({ id, passed: false, note: "" }));
    expect(deriveStoryApprovalCommand({ projectId: "proj_1", idempotencyKey: "key-1", story: story(), checklist: unticked, notes: "" })).toBeNull();
  });
});

/* 8. Read-only plan summary rows and the re-plan warning */
describe("C19 plan summary rows and re-plan warning", () => {
  type ReadModelShot = ProjectReadModel["shots"][number];
  const shotRevision = (overrides: Partial<ShotRevision> & Pick<ShotRevision, "id" | "order">): ShotRevision =>
    ShotRevisionSchema.parse({
      version: 1, shotId: overrides.id, storyRevisionId: "story_v1", beatIds: ["beat_1"],
      visualIntent: "Harbor establishing frame", motionIntent: "Slow push in", castBindings: [],
      locationRevisionId: "canonloc_v1", propRevisionIds: [], styleRevisionId: "canonstyle_v1",
      framing: "wide", continuation: null, contentHash: SHA_A, createdAt: 1, ...overrides,
    });
  const readModelShot = (revision: ShotRevision): ReadModelShot => ({
    shotRevision: revision, selectedAnchor: null, selectedTake: null,
    takeSelection: { takeId: null, version: 0 }, anchorHistory: [], takeHistory: [], approvals: [],
  });

  it("summarizes plan-order shots with id, beats, framing, frames and the 24fps duration label", () => {
    const rows = derivePlanSummaryRows([
      readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 192, beatIds: ["beat_1"], framing: "medium" })),
      readModelShot(shotRevision({ id: "shotrev_2", order: 1, targetFrames: 124, beatIds: ["beat_2"], framing: "close" })),
    ]);
    expect(rows.map((row) => row.shotId)).toEqual(["shotrev_1", "shotrev_2"]);
    expect(rows.map((row) => row.beatIds)).toEqual([["beat_1"], ["beat_2"]]);
    expect(rows.map((row) => row.framing)).toEqual(["medium", "close"]);
    expect(rows.map((row) => row.targetFrames)).toEqual([192, 124]);
    expect(rows.map((row) => row.durationLabel)).toEqual(["8.000s", "5.166s"]);
  });

  it("warns that creating a newer plan resets downstream approvals and stays silent without a plan", () => {
    const plan = ShotPlanRevisionSchema.parse({
      version: 1, id: "plan_v1", projectId: "proj_1", storyRevisionId: "story_v1",
      orderedShotRevisionIds: ["shotrev_1"], beatCoverage: [{ beatId: "beat_1", shotRevisionIds: ["shotrev_1"] }],
      contentHash: SHA_A, createdAt: 1,
    });
    const warning = deriveReplanWarning(plan);
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/approval/i);
    expect(warning).toMatch(/plan/i);
    expect(deriveReplanWarning(null)).toBeNull();
  });
});
