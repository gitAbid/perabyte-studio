import { describe, expect, it } from "vitest";
import { ProductionApplicationError } from "./errors";
import { hashCanonicalJson } from "./hash";
import {
  DEFAULT_PUBLICATION_PROFILE_CATALOG, MANUAL_UPLOAD_DISCLAIMER, PUBLICATION_TIMELINE_FPS,
  PublicationPackageSchema, PublicationProfileSchema, buildSrt, derivePackageMetadataDefaults,
  derivePublicationPackage, formatChapterTimestamp, formatSrtTimestamp, hashPublicationPackage,
  resolvePublicationProfile, selectPublicationExport,
} from "./publishing";

const sha = (seed: string) => hashCanonicalJson({ fixture: seed });
function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("Expected the publication operation to fail closed");
}
const CORE_PROFILE_KEYS = ["descriptionSections", "disclosureGuidance", "id", "reel", "thumbnails", "title"].sort();

function takeApprovalFixture(takeId: string, overrides: Record<string, unknown> = {}) {
  return { version: 1, id: `${takeId}-approval`, targetKind: "take", targetId: takeId, targetHash: sha(takeId), decision: "approved", actorId: "local-creator", createdAt: 50, checklist: [{ id: "review", passed: true, note: "fixture" }], notes: "", advisoryAcknowledgements: [], ...overrides };
}
function anchorApprovalFixture(anchorId: string) {
  return { version: 1, id: `${anchorId}-approval`, targetKind: "anchor", targetId: anchorId, targetHash: sha(anchorId), decision: "approved", actorId: "local-creator", createdAt: 40, checklist: [{ id: "review", passed: true, note: "fixture" }], notes: "", advisoryAcknowledgements: [] };
}
interface ShotFixtureOverrides { takeId?: string | null; approvals?: unknown[]; anchorAssetId?: string; dropAnchor?: boolean; actualFrames?: number; targetFrames?: number }
function shotFixture(index: number, overrides: ShotFixtureOverrides = {}) {
  const takeId: string | null = overrides.takeId === undefined ? `take-${index}` : overrides.takeId;
  const shotRevision = { version: 1, id: `shotrev-${index}`, shotId: `shot_${index}`, storyRevisionId: "story-1", beatIds: ["beat_1"], order: index, visualIntent: index === 0 ? "A lantern fox steps into the clearing." : "The child follows the light.", motionIntent: "slow push in", castBindings: [], locationRevisionId: "room", propRevisionIds: [], styleRevisionId: "look", framing: "wide", targetFrames: overrides.targetFrames ?? 48, continuation: null, contentHash: sha(`shotrev-${index}`), createdAt: index + 1 };
  const anchor = overrides.dropAnchor || takeId === null ? null : { version: 1, id: `anchor-${index}`, shotRevisionId: `shotrev-${index}`, assetId: overrides.anchorAssetId ?? `anchor-asset-${index}`, inputsHash: sha(`anchor-${index}`), jobId: `job-${index}`, visionAssessment: null, receiptId: null, createdAt: index + 1 };
  const take = takeId === null ? null : { version: 1, id: takeId, shotRevisionId: `shotrev-${index}`, anchorId: `anchor-${index}`, approvalId: `${takeId}-approval`, jobId: `job-${index}`, assetId: `video-asset-${index}`, actualFrames: overrides.actualFrames ?? 48, inputsHash: sha(takeId), receiptId: `receipt-${index}`, createdAt: index + 1 };
  return {
    shotRevision,
    selectedAnchor: anchor,
    selectedTake: take,
    takeSelection: { takeId: takeId ?? null, version: index + 1 },
    anchorHistory: anchor ? [anchor] : [],
    takeHistory: take ? [take] : [],
    approvals: overrides.approvals ?? (take !== null && takeId !== null ? [anchorApprovalFixture(`anchor-${index}`), takeApprovalFixture(takeId)] : []),
  };
}
function exportFixture(overrides: Record<string, unknown> = {}) {
  return { version: 1, id: "export-1", manifestId: "manifest-1", jobId: "export-job", assetId: "final-asset", qcReportId: "qc-1", status: "ready_for_review", createdAt: 900, approvedSha256: null, finalApprovalId: null, ...overrides };
}
function inputFixture(mutate: (input: Record<string, unknown>) => void = () => {}) {
  const input: Record<string, unknown> = {
    schemaVersion: 2,
    dependencyIssues: [],
    revisionApprovals: [],
    project: { version: 1, id: "proj-1", name: "The Lantern Fox", profileId: "storybook-short-v1", createdAt: 1, updatedAt: 2, saveVersion: 3 },
    exports: [exportFixture()],
    shots: [shotFixture(0), shotFixture(1)],
  };
  mutate(input);
  return input;
}
const narrowProfile = {
  id: "narrow-publication-v1", title: { template: "{projectName}", maxLength: 10 },
  descriptionSections: [{ id: "synopsis", heading: "Synopsis", source: "derived_summary" }],
  disclosureGuidance: "Decide and record the disclosure outcome; no default is provided.",
  reel: { maxClips: 10, ordering: "shot_plan_order" }, thumbnails: { candidateLimit: 1 },
} as const;

describe("publication genre profiles", () => {
  it("exposes three immutable genre defaults over one frozen core shape", () => {
    expect(Object.isFrozen(DEFAULT_PUBLICATION_PROFILE_CATALOG)).toBe(true);
    expect(Object.isFrozen(PublicationProfileSchema)).toBe(true);
    const ids = DEFAULT_PUBLICATION_PROFILE_CATALOG.map((profile) => (profile as { id: string }).id).sort();
    expect(ids).toEqual(["documentary-publication-v1", "mythology-publication-v1", "promotion-publication-v1"]);
    const resolved = ids.map((id) => resolvePublicationProfile(id));
    for (const profile of resolved) {
      expect(PublicationProfileSchema.safeParse(profile).success).toBe(true);
      expect(Object.keys(profile).sort()).toEqual(CORE_PROFILE_KEYS);
      expect(Object.isFrozen(profile)).toBe(false);
    }
  });

  it("returns isolated snapshots so callers cannot mutate the globals", () => {
    const first = resolvePublicationProfile("mythology-publication-v1");
    (first as { disclosureGuidance: string }).disclosureGuidance = "tampered";
    (first.descriptionSections[0] as { heading: string }).heading = "tampered";
    expect(resolvePublicationProfile("mythology-publication-v1").disclosureGuidance).not.toBe("tampered");
    expect(resolvePublicationProfile("mythology-publication-v1").descriptionSections[0]!.heading).not.toBe("tampered");
  });

  it("rejects unknown ids with a stable INVALID_INPUT error", () => {
    const error = failOf(() => resolvePublicationProfile("missing"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(failOf(() => resolvePublicationProfile("missing")).message).toBe(error.message);
  });

  it("resolves from an explicit injected catalog without code changes", () => {
    expect(resolvePublicationProfile(narrowProfile.id, [narrowProfile])).toEqual(narrowProfile);
    expect(failOf(() => resolvePublicationProfile("mythology-publication-v1", [narrowProfile])).code).toBe("INVALID_INPUT");
    expect(failOf(() => resolvePublicationProfile(narrowProfile.id, [{ ...narrowProfile, reel: { maxClips: 0, ordering: "shot_plan_order" as const } }])).code).toBe("INVALID_INPUT");
  });
});

describe("publication export gate", () => {
  it("selects the latest ready-for-review or approved export deterministically", () => {
    const basis = selectPublicationExport([
      exportFixture({ id: "export-old", status: "ready_for_review", createdAt: 10 }),
      exportFixture({ id: "export-queued", status: "queued", createdAt: 999 }),
      exportFixture({ id: "export-failed", status: "failed", createdAt: 998 }),
      exportFixture(),
    ]);
    expect(basis).toEqual({ exportId: "export-1", exportStatus: "ready_for_review", exportAssetId: "final-asset", approvedSha256: null, finalApprovalId: null, manifestId: "manifest-1" });
    const tied = selectPublicationExport([
      exportFixture({ id: "export-a", createdAt: 5 }),
      exportFixture({ id: "export-b", createdAt: 5 }),
    ]);
    expect(tied.exportId).toBe("export-b");
    const approved = selectPublicationExport([exportFixture({ status: "approved", approvedSha256: sha("final"), finalApprovalId: "final-approval" })]);
    expect(approved.exportStatus).toBe("approved");
    expect(approved.approvedSha256).toBe(sha("final"));
  });

  it("refuses when no export is ready for review or approved", () => {
    const error = failOf(() => selectPublicationExport([exportFixture({ status: "qc_failed" }), exportFixture({ id: "export-2", status: "canceled" })]));
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toMatch(/ready_for_review|approved/);
    expect(failOf(() => selectPublicationExport([])).code).toBe("APPROVAL_REQUIRED");
  });
});

describe("formatChapterTimestamp", () => {
  it("formats deterministic M:SS chapter stamps at the publishing timeline fps", () => {
    expect(PUBLICATION_TIMELINE_FPS).toBe(24);
    expect(formatChapterTimestamp(0, 24)).toBe("0:00");
    expect(formatChapterTimestamp(48, 24)).toBe("0:02");
    expect(formatChapterTimestamp(1500, 24)).toBe("1:02");
    expect(formatChapterTimestamp(3600, 1)).toBe("60:00");
  });
  it("rejects unsafe frame counts and frame rates", () => {
    expect(failOf(() => formatChapterTimestamp(-1, 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => formatChapterTimestamp(1.5, 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => formatChapterTimestamp(0, 0)).code).toBe("INVALID_INPUT");
  });
});

describe("derivePublicationPackage", () => {
  const mythology = resolvePublicationProfile("mythology-publication-v1");
  const documentary = resolvePublicationProfile("documentary-publication-v1");
  const promotion = resolvePublicationProfile("promotion-publication-v1");

  it("derives a deterministic strict package with a stable canonical hash", () => {
    const first = derivePublicationPackage(inputFixture(), mythology);
    const second = derivePublicationPackage(inputFixture(), mythology);
    expect(first).toEqual(second);
    expect(PublicationPackageSchema.safeParse(first).success).toBe(true);
    expect(hashPublicationPackage(first)).toBe(hashPublicationPackage(second));
    const roundTripped = JSON.parse(JSON.stringify(inputFixture()));
    expect(hashPublicationPackage(derivePublicationPackage(roundTripped, mythology))).toBe(hashPublicationPackage(first));
    const renamed = inputFixture((input) => { (input.project as { name: string }).name = "Another Film"; });
    expect(hashPublicationPackage(derivePublicationPackage(renamed, mythology))).not.toBe(hashPublicationPackage(first));
    expect(first.schemaVersion).toBe(1);
    expect(first.projectId).toBe("proj-1");
    expect(first.profileId).toBe("mythology-publication-v1");
  });

  it("binds the package basis to the chosen gate-passing export", () => {
    const pkg = derivePublicationPackage(inputFixture((input) => {
      input.exports = [
        exportFixture({ id: "export-old", createdAt: 10 }),
        exportFixture({ id: "export-current", createdAt: 20, status: "approved", approvedSha256: sha("final"), finalApprovalId: "final-approval", assetId: "final-asset", qcReportId: "qc-1", manifestId: "manifest-current" }),
      ];
    }), mythology);
    expect(pkg.basis).toEqual({ exportId: "export-current", exportStatus: "approved", exportAssetId: "final-asset", approvedSha256: sha("final"), finalApprovalId: "final-approval", manifestId: "manifest-current" });
  });

  it("derives titles from the genre template and truncates to the profile maximum", () => {
    expect(derivePublicationPackage(inputFixture(), mythology).title).toEqual({ text: "The Lantern Fox", maxLength: 100, truncated: false });
    expect(derivePublicationPackage(inputFixture(), documentary).title).toEqual({ text: "The Lantern Fox — Documentary", maxLength: 100, truncated: false });
    const pkg = derivePublicationPackage(inputFixture(), resolvePublicationProfile(narrowProfile.id, [narrowProfile]));
    expect(pkg.title.text.length).toBe(10);
    expect(pkg.title.truncated).toBe(true);
  });

  it("derives genre-specific description structure: creator sections stay empty, derived sections stay factual", () => {
    const myth = derivePublicationPackage(inputFixture(), mythology);
    expect(myth.description.sections.map((section) => section.id)).toEqual(["synopsis", "credits", "audience_note"]);
    const synopsis = myth.description.sections[0]!;
    expect(synopsis.source).toBe("derived_summary");
    expect(synopsis.body).toBe("The Lantern Fox: 2 shots, 96 frames at 24 fps.");
    expect(synopsis.guidance).toBeNull();
    const credits = myth.description.sections[1]!;
    expect(credits.source).toBe("creator");
    expect(credits.body).toBeNull();
    expect(credits.guidance).toEqual("List the creator credit exactly as it should appear.");

    const doc = derivePublicationPackage(inputFixture(), documentary);
    expect(doc.description.sections.map((section) => section.id)).toEqual(["synopsis", "chapters", "sources"]);
    const chapters = doc.description.sections[1]!;
    expect(chapters.source).toBe("derived_chapters");
    expect(chapters.body).toBe("0:00 A lantern fox steps into the clearing.\n0:02 The child follows the light.");

    const promo = derivePublicationPackage(inputFixture(), promotion);
    expect(promo.description.sections.map((section) => section.id)).toEqual(["hook", "summary", "call_to_action"]);
    expect(promo.description.sections[0]!.source).toBe("creator");
    expect(promo.description.sections[0]!.body).toBeNull();
    expect(promo.description.sections[1]!.body).toBe("The Lantern Fox: 2 shots, 96 frames at 24 fps.");
  });

  it("lists thumbnail references from selected anchors in shot order, capped by the profile", () => {
    const pkg = derivePublicationPackage(inputFixture(), mythology);
    expect(pkg.thumbnailCandidates).toEqual([
      { shotId: "shot_0", shotRevisionId: "shotrev-0", anchorId: "anchor-0", assetId: "anchor-asset-0" },
      { shotId: "shot_1", shotRevisionId: "shotrev-1", anchorId: "anchor-1", assetId: "anchor-asset-1" },
    ]);
    const capped = derivePublicationPackage(inputFixture(), resolvePublicationProfile(narrowProfile.id, [narrowProfile]));
    expect(capped.thumbnailCandidates).toEqual([{ shotId: "shot_0", shotRevisionId: "shotrev-0", anchorId: "anchor-0", assetId: "anchor-asset-0" }]);
    const missing = derivePublicationPackage(inputFixture((input) => { (input.shots as unknown[])[0] = shotFixture(0, { dropAnchor: true }); }), mythology);
    expect(missing.thumbnailCandidates).toEqual([{ shotId: "shot_1", shotRevisionId: "shotrev-1", anchorId: "anchor-1", assetId: "anchor-asset-1" }]);
  });

  it("plans the reel from selected take assets in shot order with deterministic durations", () => {
    const pkg = derivePublicationPackage(inputFixture(), mythology);
    expect(pkg.reelPlan.fps).toBe(24);
    expect(pkg.reelPlan.clips).toEqual([
      { order: 0, shotId: "shot_0", shotRevisionId: "shotrev-0", takeId: "take-0", assetId: "video-asset-0", targetFrames: 48, actualFrames: 48, durationFrames: 48 },
      { order: 1, shotId: "shot_1", shotRevisionId: "shotrev-1", takeId: "take-1", assetId: "video-asset-1", targetFrames: 48, actualFrames: 48, durationFrames: 48 },
    ]);
    expect(pkg.reelPlan.totalFrames).toBe(96);
    const longTake = derivePublicationPackage(inputFixture((input) => { (input.shots as unknown[])[0] = shotFixture(0, { actualFrames: 96 }); }), mythology);
    expect(longTake.reelPlan.clips[0]!.durationFrames).toBe(48);
    expect(longTake.reelPlan.totalFrames).toBe(96);
  });

  it("renders the upload checklist as creator-required fields with no defaults", () => {
    const pkg = derivePublicationPackage(inputFixture(), documentary);
    for (const field of [pkg.uploadChecklist.audienceDesignation, pkg.uploadChecklist.visibility]) {
      expect(field.status).toBe("creator_required");
      expect(field.value).toBeNull();
      expect(field.guidance.length).toBeGreaterThan(0);
    }
    expect(pkg.uploadChecklist.alteredSyntheticDisclosure).toEqual({ status: "creator_required", value: null, guidance: documentary.disclosureGuidance });
    expect(pkg.uploadChecklist.disclaimer).toBe(MANUAL_UPLOAD_DISCLAIMER);
    const myth = derivePublicationPackage(inputFixture(), mythology);
    expect(myth.uploadChecklist.alteredSyntheticDisclosure.guidance).toBe(mythology.disclosureGuidance);
    expect(myth.uploadChecklist.alteredSyntheticDisclosure.guidance).not.toBe(documentary.disclosureGuidance);
  });

  it("refuses to derive from a project with no gate-passing export", () => {
    const error = failOf(() => derivePublicationPackage(inputFixture((input) => { input.exports = [exportFixture({ status: "queued" })]; }), mythology));
    expect(error.code).toBe("APPROVAL_REQUIRED");
  });

  it("refuses to derive when a shot has no selected take", () => {
    const error = failOf(() => derivePublicationPackage(inputFixture((input) => {
      (input.shots as unknown[])[1] = shotFixture(1, { takeId: null, approvals: [] });
    }), mythology));
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.message).toMatch(/shot_1/);
  });

  it("refuses to derive when the latest take decision is not approved", () => {
    const error = failOf(() => derivePublicationPackage(inputFixture((input) => {
      (input.shots as unknown[])[0] = shotFixture(0, { approvals: [anchorApprovalFixture("anchor-0"), takeApprovalFixture("take-0"), takeApprovalFixture("take-0", { id: "take-0-rejection", decision: "rejected", createdAt: 60 })] });
    }), mythology));
    expect(error.code).toBe("APPROVAL_REQUIRED");
  });

  it("refuses to derive when the selected take has no approval at all", () => {
    const error = failOf(() => derivePublicationPackage(inputFixture((input) => {
      (input.shots as unknown[])[0] = shotFixture(0, { takeId: "take-unapproved", approvals: [anchorApprovalFixture("anchor-0"), takeApprovalFixture("take-0")] });
    }), mythology));
    expect(error.code).toBe("APPROVAL_REQUIRED");
  });

  it("refuses structurally impossible records with INVALID_INPUT", () => {
    expect(failOf(() => derivePublicationPackage(inputFixture((input) => { input.shots = []; }), mythology)).code).toBe("INVALID_INPUT");
    expect(failOf(() => derivePublicationPackage(inputFixture((input) => { input.schemaVersion = 1; }), mythology)).code).toBe("INVALID_INPUT");
    expect(failOf(() => derivePublicationPackage({ schemaVersion: 2 }, mythology)).code).toBe("INVALID_INPUT");
    const invalidProfile = { ...narrowProfile, disclosureGuidance: "" } as unknown as typeof mythology;
    expect(failOf(() => derivePublicationPackage(inputFixture(), invalidProfile)).code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// M4-5 manual package emitters (additive pure helpers).
// ---------------------------------------------------------------------------

describe("srt caption builder", () => {
  it("formats frame times as HH:MM:SS,mmm on the fps grid", () => {
    expect(formatSrtTimestamp(0, 24)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1, 24)).toBe("00:00:00,042");
    expect(formatSrtTimestamp(24, 24)).toBe("00:00:01,000");
    expect(formatSrtTimestamp(25, 24)).toBe("00:00:01,042");
    expect(formatSrtTimestamp(24 * 61, 24)).toBe("00:01:01,000");
    expect(formatSrtTimestamp(24 * 3600 + 1, 24)).toBe("01:00:00,042");
    expect(formatSrtTimestamp(5, 25)).toBe("00:00:00,200");
  });

  it("builds a valid multi-cue document with sequential numbering", () => {
    const srt = buildSrt([
      { text: "A lantern fox steps into the clearing.", startFrame: 0, endFrame: 24 },
      { text: "The child follows the light.", startFrame: 24, endFrame: 96 },
    ], 24);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,000\nA lantern fox steps into the clearing.\n\n2\n00:00:01,000 --> 00:00:04,000\nThe child follows the light.\n");
  });

  it("keeps multiline cue text verbatim and yields an empty document for no cues", () => {
    const srt = buildSrt([{ text: "line one\nline two", startFrame: 12, endFrame: 36 }], 24);
    expect(srt).toBe("1\n00:00:00,500 --> 00:00:01,500\nline one\nline two\n");
    expect(buildSrt([], 24)).toBe("");
  });

  it("fails closed on malformed cues, frames, and frame rates", () => {
    expect(failOf(() => buildSrt([{ text: "x", startFrame: 10, endFrame: 10 }], 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => buildSrt([{ text: "x", startFrame: -1, endFrame: 10 }], 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => buildSrt([{ text: "  ", startFrame: 0, endFrame: 10 }], 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => buildSrt([{ text: "x", startFrame: 0, endFrame: 10 }], 0)).code).toBe("INVALID_INPUT");
    expect(failOf(() => formatSrtTimestamp(1.5, 24)).code).toBe("INVALID_INPUT");
    expect(failOf(() => formatSrtTimestamp(-1, 24)).code).toBe("INVALID_INPUT");
  });
});

describe("package metadata defaults", () => {
  it("defaults the title to the project title and the description to joined scene titles", () => {
    const defaults = derivePackageMetadataDefaults({
      projectName: "  The Lantern Fox  ",
      sceneTitles: ["The clearing", "The following"],
      shotVisualIntents: ["unused when scenes exist"],
      workspaceName: "Lantern Studio",
      workspaceTags: ["mythology"],
    });
    expect(defaults.title).toBe("The Lantern Fox");
    expect(defaults.description).toBe("The clearing\nThe following");
  });

  it("falls back through shot intents to the title, and derives sanitized hashtags", () => {
    const fromIntents = derivePackageMetadataDefaults({ projectName: "Solo", shotVisualIntents: ["A door opens.", "  "] });
    expect(fromIntents.description).toBe("A door opens.");
    const fromTitle = derivePackageMetadataDefaults({ projectName: "Solo" });
    expect(fromTitle.description).toBe("Solo");
    const hashtags = derivePackageMetadataDefaults({
      projectName: "Solo",
      workspaceName: "  lantern  studio-films  ",
      workspaceTags: ["Mythology", "#lantern", "studio", "AI Film", "mythology"],
    });
    expect(hashtags.hashtags).toBe("#Lantern #Studio #Films #Mythology #AI #Film");
    expect(derivePackageMetadataDefaults({ projectName: "Solo", workspaceName: null, workspaceTags: [] }).hashtags).toBe("");
    expect(failOf(() => derivePackageMetadataDefaults({ projectName: "   " })).code).toBe("INVALID_INPUT");
  });
});
