import { describe, expect, it } from "vitest";
import {
  AnimaticRevisionSchema, ApprovalSchema, CanonRevisionSchema, CreateApprovalCommandSchema, JobSchema,
  ProjectReadModelSchema, ProjectSchema, SelectTakeCommandSchema, ShotPlanRevisionSchema, ShotRevisionSchema,
  StoryRevisionSchema, TakeSchema, type Approval, type CanonRevision, type ProjectReadModel, type ShotRevision,
  type Take,
} from "./contracts";
import { hashCanonicalJson } from "./hash";
import { APPROVAL_CHECKLISTS } from "./approval";
import {
  ANIMATIC_FPS, APPROVAL_CHECKLISTS_VIEW, REFERENCE_MEDIA_NOTE, SHOTS_PER_CHUNK,
  deriveApprovalCommand, deriveApprovalReadiness, deriveGenerationReadiness, deriveHistoryEmptyState,
  derivePendingMediaJobs, deriveRejectionSelectionNotice, deriveSelectionCommand, deriveShotCurrency,
  deriveShotProvenance, deriveShotStaleNotices, deriveShotboardModel, deriveTakeRows, framesToDurationLabel,
  latestDecisionFor, type ApprovalDecisionInput, type DecisionIssue,
} from "@/components/production/storyboard";

/* Fixtures are parsed through the accepted zod schemas so the tests cannot drift from the contracts. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const shotRevision = (overrides: Partial<ShotRevision> & Pick<ShotRevision, "id" | "order" | "targetFrames">): ShotRevision =>
  ShotRevisionSchema.parse({
    version: 1, shotId: overrides.id, storyRevisionId: "story_v1", beatIds: ["beat_opening"],
    visualIntent: "Harbor establishing frame", motionIntent: "Slow push in", castBindings: [],
    locationRevisionId: "canonloc_v1", propRevisionIds: [], styleRevisionId: "canonstyle_v1",
    framing: "wide", continuation: null, contentHash: SHA_A, createdAt: 1, ...overrides,
  });
type ReadModelShot = ProjectReadModel["shots"][number];
const readModelShot = (shotRevisionValue: ShotRevision, overrides: Partial<ReadModelShot> = {}): ReadModelShot => ({
  shotRevision: shotRevisionValue, selectedAnchor: null, selectedTake: null,
  takeSelection: { takeId: null, version: 0 }, anchorHistory: [], takeHistory: [], approvals: [], ...overrides,
});
const canonRevision = (overrides: Partial<CanonRevision> & Pick<CanonRevision, "id" | "entityId" | "entityKind" | "description">): CanonRevision =>
  CanonRevisionSchema.parse({
    version: 1, revision: 1, attributes: {}, referenceAssetIds: [], contentHash: SHA_A, createdAt: 1, ...overrides,
  });
const take = (id: string, createdAt: number): Take => TakeSchema.parse({
  version: 1, id, shotRevisionId: "shotrev_1", anchorId: "anchor_1", approvalId: "approval_anchor_1", jobId: "job_1",
  assetId: `asset_${id}`, actualFrames: 48, inputsHash: SHA_A, receiptId: "receipt_1", createdAt,
});
const decision = (overrides: Partial<Approval> & Pick<Approval, "targetKind" | "targetId" | "decision">): Approval => {
  const kind = overrides.targetKind;
  const defaults = {
    version: 1, id: `approval_${overrides.targetId}`, targetHash: SHA_B, actorId: "local-creator", createdAt: 50,
    checklist: (APPROVAL_CHECKLISTS[kind as keyof typeof APPROVAL_CHECKLISTS] as readonly string[] | undefined ?? []).map((id) => ({ id, passed: true, note: "checked" })),
    notes: "", advisoryAcknowledgements: [], ...overrides,
  };
  return ApprovalSchema.parse(defaults);
};
const reasonCodes = (reasons: readonly DecisionIssue[]): string[] => reasons.map((reason) => reason.code);

/* 1. C08 stable order and duration across chunks */
describe("C08 shotboard order, chunking and duration", () => {
  // Deliberately non-lexicographic shot IDs AND an `order` field that disagrees with the array, so
  // any sorting (by id or by order) instead of preserving read-model order fails the test.
  const planOrder = ["shot_b2", "shot_10", "shot_2", "shot_aa", "shot_1", "shot_c", "shot_3", "shot_bb"];
  const targetFrames = [36, 48, 7, 24, 240, 1, 13, 96];
  const shots = planOrder.map((id, index) =>
    readModelShot(shotRevision({ id, order: planOrder.length - index, targetFrames: targetFrames[index] })));

  it("preserves read-model order across chunk boundaries with stable indices", () => {
    const model = deriveShotboardModel(shots);
    expect(model.rows.map((row) => row.shot.shotRevision.id)).toEqual(planOrder);
    expect(model.rows.map((row) => row.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(SHOTS_PER_CHUNK).toBe(6);
    expect(model.chunkCount).toBe(2);
    expect(model.chunks[0].map((row) => row.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(model.chunks[1].map((row) => row.index)).toEqual([7, 8]);
    expect(model.chunks.flat()).toEqual(model.rows);
  });

  it("derives deterministic durations from targetFrames with integer math at 24fps", () => {
    expect(ANIMATIC_FPS).toBe(24);
    expect(framesToDurationLabel(36)).toBe("1.500s");
    expect(framesToDurationLabel(48)).toBe("2.000s");
    expect(framesToDurationLabel(7)).toBe("0.291s");
    expect(framesToDurationLabel(240)).toBe("10.000s");
    expect(framesToDurationLabel(1)).toBe("0.041s");
    expect(framesToDurationLabel(96)).toBe("4.000s");
    const model = deriveShotboardModel(shots);
    expect(model.rows.map((row) => row.durationFrames)).toEqual(targetFrames);
    expect(model.rows.map((row) => row.durationLabel)).toEqual(targetFrames.map(framesToDurationLabel));
  });

  it("supports arbitrary chunk sizes above six shots without a six-shot ceiling", () => {
    const model = deriveShotboardModel(shots, 3);
    expect(model.chunkCount).toBe(3);
    expect(model.chunks.map((chunk) => chunk.length)).toEqual([3, 3, 2]);
  });
});

/* 2. C08 approve/reject states and checklist gating */
describe("C08 approval readiness and command derivation", () => {
  const anchorApproval = decision({
    targetKind: "anchor", targetId: "anchor_1", decision: "approved", targetHash: SHA_B,
    checklist: APPROVAL_CHECKLISTS.anchor.map((id) => ({ id, passed: true, note: "checked" })),
    advisoryAcknowledgements: [{ code: "vision_unavailable", reason: "No vision assessment; reviewed manually." }],
  });
  const completeChecklist = APPROVAL_CHECKLISTS.anchor.map((id) => ({ id, passed: true as const, note: "checked" }));
  const baseInput = (overrides: Partial<ApprovalDecisionInput> = {}): ApprovalDecisionInput => ({
    projectId: "proj_1", idempotencyKey: "key-1", targetKind: "anchor", targetId: "anchor_1",
    current: true, pendingJob: false, visionStatus: "pass", latestDecision: anchorApproval,
    displayedRevisionHash: null, decision: "approved", checklist: completeChecklist, notes: "", acknowledgements: [],
    ...overrides,
  });

  it("mirrors the accepted APPROVAL_CHECKLISTS verbatim as the client checklist source", () => {
    expect([...APPROVAL_CHECKLISTS_VIEW.story]).toEqual([...APPROVAL_CHECKLISTS.story]);
    expect([...APPROVAL_CHECKLISTS_VIEW.shotplan]).toEqual([...APPROVAL_CHECKLISTS.shotplan]);
    expect([...APPROVAL_CHECKLISTS_VIEW.animatic]).toEqual([...APPROVAL_CHECKLISTS.animatic]);
    expect([...APPROVAL_CHECKLISTS_VIEW.anchor]).toEqual([...APPROVAL_CHECKLISTS.anchor]);
    expect([...APPROVAL_CHECKLISTS_VIEW.take]).toEqual([...APPROVAL_CHECKLISTS.take]);
  });

  it("enables a current candidate with a complete checklist and emits the exact command", () => {
    const readiness = deriveApprovalReadiness(baseInput());
    expect(readiness.ok).toBe(true);
    const command = deriveApprovalCommand(baseInput());
    expect(command).not.toBeNull();
    expect(command?.projectId).toBe("proj_1");
    expect(command?.idempotencyKey).toBe("key-1");
    expect(command?.command.targetKind).toBe("anchor");
    expect(command?.command.targetId).toBe("anchor_1");
    expect(command?.command.expectedHash).toBe(SHA_B);
    expect(command?.command.decision).toBe("approved");
    expect(command?.command.checklist.map((item) => item.id)).toEqual([...APPROVAL_CHECKLISTS.anchor]);
    expect(command?.command.checklist.every((item) => item.passed && item.note === "checked")).toBe(true);
    expect(CreateApprovalCommandSchema.safeParse(command?.command).success).toBe(true);
  });

  it("disables a candidate without a prior decision: the read model exports no approval hash", () => {
    const readiness = deriveApprovalReadiness(baseInput({ latestDecision: null }));
    expect(readiness.ok).toBe(false);
    const hashReason = readiness.reasons.find((reason) => reason.code === "APPROVAL_HASH_UNAVAILABLE");
    expect(hashReason?.message).toBe("approval hash unavailable from the read model");
    expect(deriveApprovalCommand(baseInput({ latestDecision: null }))).toBeNull();
  });

  it("disables stale shots, rejected-latest decisions and pending jobs with exact reasons", () => {
    const stale = deriveApprovalReadiness(baseInput({ current: false }));
    expect(reasonCodes(stale.reasons)).toContain("STALE_TARGET");
    const rejectedLatest = decision({ targetKind: "anchor", targetId: "anchor_1", decision: "rejected", targetHash: SHA_B });
    const rejected = deriveApprovalReadiness(baseInput({ latestDecision: rejectedLatest }));
    expect(reasonCodes(rejected.reasons)).toContain("REJECTED_LATEST");
    const pending = deriveApprovalReadiness(baseInput({ pendingJob: true }));
    expect(reasonCodes(pending.reasons)).toContain("PENDING_JOB");
    expect(deriveApprovalCommand(baseInput({ current: false }))).toBeNull();
    expect(deriveApprovalCommand(baseInput({ pendingJob: true }))).toBeNull();
  });

  it("requires every checklist item to be explicitly set and all-passed for approvals", () => {
    const missing = deriveApprovalReadiness(baseInput({ checklist: completeChecklist.slice(1) }));
    const missingReason = missing.reasons.find((reason) => reason.code === "CHECKLIST_UNSET");
    expect(missingReason?.message).toContain("identity");
    const unset = deriveApprovalReadiness(baseInput({
      checklist: completeChecklist.map((item) => (item.id === "wardrobe" ? { ...item, passed: null } : item)),
    }));
    expect(reasonCodes(unset.reasons)).toContain("CHECKLIST_UNSET");
    const failed = deriveApprovalReadiness(baseInput({
      checklist: completeChecklist.map((item) => (item.id === "framing" ? { ...item, passed: false } : item)),
    }));
    const failedReason = failed.reasons.find((reason) => reason.code === "CHECKLIST_FAILED");
    expect(failedReason?.message).toContain("framing");
    expect(deriveApprovalCommand(baseInput({ checklist: completeChecklist.slice(1) }))).toBeNull();
  });

  it("requires explicit vision acknowledgements for anchor statuses other than pass", () => {
    const ackFor = (status: string | null) => ({
      code: `vision_${status ?? "unavailable"}`,
      reason: `Vision assessment is ${status ?? "unavailable"}; reviewed manually.`,
    });
    for (const status of [null, "warning", "failed", "exhausted"] as const) {
      const blocked = deriveApprovalReadiness(baseInput({ visionStatus: status }));
      const reason = blocked.reasons.find((item) => item.code === "VISION_ACK_REQUIRED");
      expect(reason?.message).toContain(`vision_${status ?? "unavailable"}`);
      const acknowledged = deriveApprovalReadiness(baseInput({ visionStatus: status, acknowledgements: [ackFor(status)] }));
      expect(acknowledged.ok).toBe(true);
      const command = deriveApprovalCommand(baseInput({ visionStatus: status, acknowledgements: [ackFor(status)] }));
      expect(command?.command.advisoryAcknowledgements).toEqual([ackFor(status)]);
    }
    expect(deriveApprovalReadiness(baseInput({ visionStatus: "pass" })).ok).toBe(true);
  });

  it("does not require vision acknowledgements for non-anchor targets", () => {
    const takeApproval = decision({
      targetKind: "take", targetId: "take_1", decision: "approved", targetHash: SHA_B,
      checklist: APPROVAL_CHECKLISTS.take.map((id) => ({ id, passed: true, note: "checked" })),
    });
    const readiness = deriveApprovalReadiness(baseInput({
      targetKind: "take", targetId: "take_1", visionStatus: null, latestDecision: takeApproval,
      checklist: APPROVAL_CHECKLISTS.take.map((id) => ({ id, passed: true as const, note: "checked" })),
    }));
    expect(readiness.ok).toBe(true);
  });

  it("flags a revision whose displayed hash no longer matches the recorded approval hash", () => {
    const planApproval = decision({ targetKind: "shotplan", targetId: "plan_1", decision: "approved", targetHash: SHA_B });
    const readiness = deriveApprovalReadiness(baseInput({
      targetKind: "shotplan", targetId: "plan_1", latestDecision: planApproval, displayedRevisionHash: SHA_C,
      checklist: APPROVAL_CHECKLISTS.shotplan.map((id) => ({ id, passed: true as const, note: "checked" })),
    }));
    expect(reasonCodes(readiness.reasons)).toContain("STALE_REVISION_HASH");
    expect(deriveApprovalReadiness(baseInput({
      targetKind: "shotplan", targetId: "plan_1", latestDecision: planApproval, displayedRevisionHash: SHA_B,
      checklist: APPROVAL_CHECKLISTS.shotplan.map((id) => ({ id, passed: true as const, note: "checked" })),
    })).ok).toBe(true);
  });

  it("mirrors the server rejection rule: notes or a failed check with a note", () => {
    const rejectedBase = { decision: "rejected" as const, latestDecision: anchorApproval };
    const withoutReason = deriveApprovalReadiness(baseInput({ ...rejectedBase, notes: "" }));
    expect(reasonCodes(withoutReason.reasons)).toContain("REJECTION_REASON_REQUIRED");
    const withNotes = deriveApprovalReadiness(baseInput({ ...rejectedBase, notes: "Framing drifts from the pin." }));
    expect(withNotes.ok).toBe(true);
    const command = deriveApprovalCommand(baseInput({ ...rejectedBase, notes: "Framing drifts from the pin." }));
    expect(command?.command.decision).toBe("rejected");
    expect(command?.command.expectedHash).toBe(SHA_B);
    const withFailedCheck = deriveApprovalReadiness(baseInput({
      ...rejectedBase,
      checklist: completeChecklist.map((item) => (item.id === "framing" ? { ...item, passed: false, note: "Faces the wrong street." } : item)),
    }));
    expect(withFailedCheck.ok).toBe(true);
  });

  it("requires an idempotency key before any decision is submitted", () => {
    const readiness = deriveApprovalReadiness(baseInput({ idempotencyKey: "  " }));
    expect(reasonCodes(readiness.reasons)).toContain("IDEMPOTENCY_KEY_REQUIRED");
  });
});

/* 3. C08 sibling selection is distinct and reversible; rejection retains prior take */
describe("C08 take siblings, selection and rejection retention", () => {
  const takes = [take("take_a", 10), take("take_b", 20), take("take_c", 30)];
  const shotRow = readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 }), {
    takeHistory: [takes[0], takes[2], takes[1]], // stored order is not chronological
    takeSelection: { takeId: "take_b", version: 4 },
    approvals: [decision({ targetKind: "take", targetId: "take_b", decision: "approved", targetHash: SHA_B })],
  });

  it("lists sibling takes newest-first and marks exactly the selected row distinct", () => {
    const rows = deriveTakeRows(shotRow);
    expect(rows.map((row) => row.take.id)).toEqual(["take_c", "take_b", "take_a"]);
    expect(rows.map((row) => row.selected)).toEqual([false, true, false]);
    expect(rows[1].latestDecision?.id).toBe("approval_take_b");
    expect(rows[0].latestDecision).toBeNull();
  });

  it("carries expectedSelectionVersion exactly and reverses with takeId null", () => {
    const command = deriveSelectionCommand("proj_1", "shotrev_1", "take_a", shotRow.takeSelection);
    expect(SelectTakeCommandSchema.safeParse(command).success).toBe(true);
    expect(command).toEqual({ projectId: "proj_1", shotRevisionId: "shotrev_1", takeId: "take_a", expectedSelectionVersion: 4 });
    const reversal = deriveSelectionCommand("proj_1", "shotrev_1", null, shotRow.takeSelection);
    expect(reversal.takeId).toBeNull();
    expect(reversal.expectedSelectionVersion).toBe(4);
  });

  it("never cascades a rejection into the selection", () => {
    const siblingNotice = deriveRejectionSelectionNotice("take_b", "take_a");
    expect(siblingNotice).toContain("take_a");
    expect(siblingNotice).toContain("take_b");
    expect(siblingNotice).toMatch(/untouched/i);
    const selectedNotice = deriveRejectionSelectionNotice("take_b", "take_b");
    expect(selectedNotice).toMatch(/auto-select/i);
    expect(selectedNotice).toMatch(/retained/i);
    const noneNotice = deriveRejectionSelectionNotice(null, "take_a");
    expect(noneNotice).toMatch(/auto-select/i);
  });
});

/* 4. C08 exact stale reasons and provenance */
describe("C08 stale notices and pinned provenance", () => {
  const dependencyIssues = [
    { targetKind: "shotplan", targetId: "plan_1", dependencyKind: "story", pinnedDependencyId: "story_v1", activeDependencyId: "story_v2", code: "STORY_CHANGED" },
    { targetKind: "shot", targetId: "shotrev_1", dependencyKind: "canon", pinnedDependencyId: "canonloc_v1", activeDependencyId: "canonloc_v2", code: "DEPENDENCY_REPLACED" },
    { targetKind: "shot", targetId: "shotrev_1", dependencyKind: "continuation", pinnedDependencyId: "prior_rev", activeDependencyId: null, code: "DEPENDENCY_MISSING" },
    { targetKind: "story", targetId: "story_v2", dependencyKind: "canon", pinnedDependencyId: "canonloc_v1", activeDependencyId: "canonloc_v2", code: "DEPENDENCY_REPLACED" },
  ] as const;
  const shots = [readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 }), {
    selectedAnchor: null, selectedTake: null, takeSelection: { takeId: null, version: 0 },
  })];

  it("renders shot/shotplan stale notices verbatim with pinned vs active ids and codes", () => {
    const derived = deriveShotStaleNotices({ schemaVersion: 2, dependencyIssues: [...dependencyIssues], shots });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.notices.map((notice) => notice.targetKind).every((kind) => kind === "shot" || kind === "shotplan")).toBe(true);
    const storyChanged = derived.notices.find((notice) => notice.code === "STORY_CHANGED");
    expect(storyChanged?.targetId).toBe("plan_1");
    expect(storyChanged?.pinnedDependencyId).toBe("story_v1");
    expect(storyChanged?.activeDependencyId).toBe("story_v2");
    expect(storyChanged?.message).toContain("story_v1");
    expect(storyChanged?.message).toContain("story_v2");
    const replaced = derived.notices.find((notice) => notice.code === "DEPENDENCY_REPLACED");
    expect(replaced?.pinnedDependencyId).toBe("canonloc_v1");
    expect(replaced?.activeDependencyId).toBe("canonloc_v2");
    const missing = derived.notices.find((notice) => notice.code === "DEPENDENCY_MISSING");
    expect(missing?.pinnedDependencyId).toBe("prior_rev");
    expect(missing?.activeDependencyId).toBeNull();
  });

  it("derives pinned provenance with cast descriptions and the honest reference-media note", () => {
    const charRev = canonRevision({ id: "canonchar_v1", entityId: "char_ayo", entityKind: "character", description: "Ayo, a young harbor pilot", referenceAssetIds: ["asset_char_ref"] });
    const locRev = canonRevision({ id: "canonloc_v1", entityId: "loc_harbor", entityKind: "location", description: "A foggy harbor at dawn", referenceAssetIds: ["asset_harbor_ref"] });
    const styleRev = canonRevision({ id: "canonstyle_v1", entityId: "style_book", entityKind: "style", description: "Ink-and-water storybook style", referenceAssetIds: ["asset_style_ref"] });
    const shot = shotRevision({
      id: "shotrev_1", order: 0, targetFrames: 48,
      castBindings: [{ characterId: "char_ayo", canonRevisionId: "canonchar_v1", wardrobe: "Oilskin coat" }],
      locationRevisionId: "canonloc_v1", styleRevisionId: "canonstyle_v1",
    });
    const provenance = deriveShotProvenance(shot, [locRev, styleRev, charRev]);
    expect(provenance.cast).toEqual([
      {
        characterId: "char_ayo", revisionId: "canonchar_v1", wardrobe: "Oilskin coat",
        canon: { revisionId: "canonchar_v1", entityId: "char_ayo", entityKind: "character", description: "Ayo, a young harbor pilot", referenceAssetIds: ["asset_char_ref"] },
      },
    ]);
    expect(provenance.location?.revisionId).toBe("canonloc_v1");
    expect(provenance.location?.description).toBe("A foggy harbor at dawn");
    expect(provenance.style?.description).toBe("Ink-and-water storybook style");
    expect(provenance.props).toEqual([]);
    expect(provenance.referenceAssetIds).toEqual(["asset_char_ref", "asset_harbor_ref", "asset_style_ref"]);
    expect(provenance.referenceNote).toBe("reference media not exposed by the read model");
    expect(REFERENCE_MEDIA_NOTE).toBe("reference media not exposed by the read model");
  });

  it("reports unknown canon pins as unresolved instead of guessing a description", () => {
    const locRev = canonRevision({ id: "canonloc_v1", entityId: "loc_harbor", entityKind: "location", description: "A foggy harbor at dawn" });
    const shot = shotRevision({
      id: "shotrev_1", order: 0, targetFrames: 48,
      castBindings: [{ characterId: "char_ghost", canonRevisionId: "canonchar_missing", wardrobe: "Unknown" }],
    });
    const provenance = deriveShotProvenance(shot, [locRev]);
    expect(provenance.cast[0].canon).toBeNull();
    expect(provenance.location?.description).toBe("A foggy harbor at dawn");
    expect(provenance.style).toBeNull();
  });
});

/* 5. C08 honest degraded states */
describe("C08 degraded offline states and submit gates", () => {
  it("names the prerequisite chain in empty anchor and take histories", () => {
    const anchorEmpty = deriveHistoryEmptyState("anchor", "shot_1");
    expect(anchorEmpty).toContain("shot_1");
    expect(anchorEmpty).toMatch(/approved/i);
    expect(anchorEmpty).toMatch(/animatic/i);
    expect(anchorEmpty).toMatch(/job/i);
    const takeEmpty = deriveHistoryEmptyState("take", "shot_2");
    expect(takeEmpty).toContain("shot_2");
    expect(takeEmpty).toMatch(/anchor/i);
    expect(takeEmpty).toMatch(/job/i);
  });

  it("keeps the approval disabled for a candidate without a prior decision", () => {
    const readiness = deriveApprovalReadiness({
      projectId: "proj_1", idempotencyKey: "key-1", targetKind: "anchor", targetId: "anchor_9",
      current: true, pendingJob: false, visionStatus: null, latestDecision: null, displayedRevisionHash: null,
      decision: "approved", checklist: APPROVAL_CHECKLISTS.anchor.map((id) => ({ id, passed: true as const, note: "n" })),
      notes: "", acknowledgements: [{ code: "vision_unavailable", reason: "reviewed manually" }],
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reasons.map((reason) => reason.message)).toContain("approval hash unavailable from the read model");
  });

  it("gates generation submits on approvals, currency, provider inputs and pending jobs", () => {
    const gateBase = {
      operation: "anchor" as const, providerId: "prov", modelId: "model",
      storyApprovedCurrent: true, shotPlanApprovedCurrent: true, animaticApprovedCurrent: true,
      shotCurrent: true, pendingJob: false, anchorApprovedCurrent: true,
    };
    expect(deriveGenerationReadiness(gateBase).ok).toBe(true);
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, providerId: " " }).reasons)).toContain("PROVIDER_MODEL_REQUIRED");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, storyApprovedCurrent: false }).reasons)).toContain("STORY_APPROVAL_REQUIRED");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, shotPlanApprovedCurrent: false }).reasons)).toContain("SHOT_PLAN_APPROVAL_REQUIRED");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, animaticApprovedCurrent: false }).reasons)).toContain("ANIMATIC_APPROVAL_REQUIRED");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, shotCurrent: false }).reasons)).toContain("SHOT_NOT_CURRENT");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, pendingJob: true }).reasons)).toContain("PENDING_JOB");
    expect(reasonCodes(deriveGenerationReadiness({ ...gateBase, operation: "take", anchorApprovedCurrent: false }).reasons)).toContain("ANCHOR_APPROVAL_REQUIRED");
    expect(deriveGenerationReadiness({ ...gateBase, storyApprovedCurrent: false }).ok).toBe(false);
  });
});

/* Shot currency against the full read model (currentness + current approvals + pending jobs). */
describe("C08 shot currency derivation", () => {
  const project = ProjectSchema.parse({
    version: 1, id: "proj_1", name: "Harbor short", profileId: "storybook-short-v1",
    profile: { id: "storybook-short-v1", format: "9:16", language: "en", ageIntent: "all ages", targetFrames: 240, projectCapMinor: null, dailyCapMinor: null },
    activeCanonRevisionIds: [], activeStoryRevisionId: "story_v1", activeShotPlanRevisionId: "plan_v1",
    activeAnimaticRevisionId: "anim_v1", activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0,
    createdAt: 1, updatedAt: 1, saveVersion: 1,
  });
  const story = StoryRevisionSchema.parse({
    version: 1, id: "story_v1", projectId: "proj_1", parentRevisionId: null, scriptText: "The harbor wakes.",
    beats: [{ id: "beat_opening", action: "The harbor wakes.", narration: "The harbor wakes.", dialogue: [], order: 0 }],
    canonRevisionIds: [], contentHash: SHA_A, createdAt: 1,
  });
  const plan = ShotPlanRevisionSchema.parse({
    version: 1, id: "plan_v1", projectId: "proj_1", storyRevisionId: "story_v1", orderedShotRevisionIds: ["shotrev_1"],
    beatCoverage: [{ beatId: "beat_opening", shotRevisionIds: ["shotrev_1"] }], contentHash: SHA_A, createdAt: 1,
  });
  const animatic = AnimaticRevisionSchema.parse({
    version: 1, id: "anim_v1", projectId: "proj_1", shotPlanRevisionId: "plan_v1",
    slots: [{ shotRevisionId: "shotrev_1", anchorId: null, placeholderLabel: "shot_1" }],
    timingAnnotations: [], totalFrames: 48, contentHash: SHA_A, createdAt: 1,
  });
  const currentApprovals = (["story", "shotplan", "animatic"] as const).map((kind) =>
    decision({ targetKind: kind, targetId: `${kind === "story" ? "story" : kind === "shotplan" ? "plan" : "anim"}_v1`, decision: "approved", targetHash: SHA_A }));
  const snapshot = {
    projectId: "proj_1", jobId: "job_1", idempotencyKey: "key_1", quoteId: "quote_1", providerId: "prov", modelId: "model",
    prompt: "Sail in", inputs: [], parameters: {},
    resultTarget: { kind: "take" as const, shotRevisionId: "shotrev_1", anchorId: "anchor_1", anchorApprovalId: "approval_anchor_1", inputsHash: SHA_A },
  };
  const runningJob = JobSchema.parse({
    version: 1, id: "job_1", projectId: "proj_1", operation: "take", status: "running", idempotencyKey: "key_1",
    requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: "prov", modelId: "model",
    providerRef: null, quoteId: "quote_1", receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null,
    leaseUntil: null, heartbeatAt: null, attempt: 1, errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
  });
  const buildReadModel = (overrides: Partial<ProjectReadModel> = {}): ProjectReadModel => ProjectReadModelSchema.parse({
    schemaVersion: 2, dependencyIssues: [], revisionApprovals: currentApprovals, project, canonRevisions: [],
    storyRevision: story, shotPlanRevision: plan, animaticRevision: animatic, audioMixRevision: null,
    shots: [readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 }))],
    activeJobs: [], jobs: [], exports: [], ...overrides,
  });

  it("marks a shot current with current story/plan/animatic approvals and no pending job", () => {
    const currency = deriveShotCurrency(buildReadModel(), readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 })));
    expect(currency).toEqual({ shotCurrent: true, storyApprovedCurrent: true, shotPlanApprovedCurrent: true, animaticApprovedCurrent: true, pendingMediaJob: false });
  });

  it("detects a stale plan pin, a hash-drifted story approval and a pending media job", () => {
    const staleStory = { ...story, id: "story_v2", contentHash: SHA_C, parentRevisionId: "story_v1" } as typeof story;
    const drifted = buildReadModel({
      storyRevision: staleStory,
      project: { ...project, activeStoryRevisionId: "story_v2" },
      revisionApprovals: currentApprovals,
      activeJobs: [runningJob],
    });
    const currency = deriveShotCurrency(drifted, readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 })));
    expect(currency.shotCurrent).toBe(false);
    expect(currency.storyApprovedCurrent).toBe(false);
    expect(currency.shotPlanApprovedCurrent).toBe(true);
    expect(currency.pendingMediaJob).toBe(true);
  });

  it("finds the newest decision per target deterministically", () => {
    const older = decision({ targetKind: "take", targetId: "take_b", decision: "rejected", createdAt: 10, targetHash: SHA_A });
    const newer = decision({ targetKind: "take", targetId: "take_b", decision: "approved", createdAt: 20, targetHash: SHA_B });
    expect(latestDecisionFor([older, newer], "take", "take_b")?.targetHash).toBe(SHA_B);
    expect(latestDecisionFor([], "take", "take_b")).toBeNull();
  });

  it("lists pending media jobs for one shot revision only", () => {
    const shots = [readModelShot(shotRevision({ id: "shotrev_1", order: 0, targetFrames: 48 }))];
    expect(derivePendingMediaJobs([runningJob], "shotrev_1").map((job) => job.id)).toEqual(["job_1"]);
    expect(derivePendingMediaJobs([], "shotrev_1")).toEqual([]);
    expect(shots).toHaveLength(1);
  });
});
