import { z } from "zod";
import {
  ApprovalTargetKindSchema, ExportStatusSchema, FrameIndexSchema, IdSchema, NonEmptyTextSchema,
  NullableIdSchema, PositiveFramesSchema, Sha256Schema, UtcMillisSchema,
} from "./contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "./errors";
import { hashCanonicalJson } from "./hash";

/**
 * Publication domain: versioned genre publication profiles (mythology, documentary, promotion) as
 * immutable snapshots over ONE shared core, and the deterministic derivation of a manual-upload
 * publication package from an approved project record (the project read model JSON). Pure
 * functions only: no I/O, no network, no uploads. The package is data for a human — thumbnail
 * entries are REFERENCES to existing assets, the reel plan references selected take assets, and
 * every audience/disclosure/visibility field is left for the creator to decide. Export approval is
 * never treated as proof that any platform accepted or processed a file. Persistence lives in the
 * publishing service.
 */
export const PUBLICATION_TIMELINE_FPS = 24;
export const PUBLICATION_PACKAGE_SCHEMA_VERSION = 1;

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }

// ---------------------------------------------------------------------------
// Genre publication profiles: versioned snapshots over one shared core shape.
// ---------------------------------------------------------------------------

const publicationProfileIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

const publicationProfileSchema = z.strictObject({
  id: publicationProfileIdSchema,
  title: z.strictObject({
    template: z.string().min(1).max(200).refine((value) => value.includes("{projectName}"), "Title template must contain the {projectName} placeholder"),
    maxLength: z.number().int().safe().positive().max(200),
  }),
  descriptionSections: z.array(z.strictObject({
    id: IdSchema,
    heading: NonEmptyTextSchema.max(200),
    source: z.enum(["derived_summary", "derived_chapters", "creator"]),
    guidance: z.string().min(1).max(4000).optional(),
  })).min(1).max(20),
  disclosureGuidance: NonEmptyTextSchema.max(4000),
  reel: z.strictObject({
    maxClips: z.number().int().safe().positive().max(10_000),
    ordering: z.literal("shot_plan_order"),
  }),
  thumbnails: z.strictObject({ candidateLimit: z.number().int().safe().nonnegative().max(100) }),
});
// Warm zod's lazily cached accessors before freezing (house pattern from profiles.ts).
publicationProfileSchema.safeParse({});
export const PublicationProfileSchema = Object.freeze(publicationProfileSchema);
export type PublicationProfile = z.infer<typeof PublicationProfileSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const defaultPublicationProfiles: PublicationProfile[] = [
  {
    id: "mythology-publication-v1",
    title: { template: "{projectName}", maxLength: 100 },
    descriptionSections: [
      { id: "synopsis", heading: "Synopsis", source: "derived_summary" },
      { id: "credits", heading: "Credits", source: "creator", guidance: "List the creator credit exactly as it should appear." },
      { id: "audience_note", heading: "A note for grown-ups", source: "creator", guidance: "Describe who this film is for, in the creator's own words." },
    ],
    disclosureGuidance: "Review whether the platform's altered or synthetic content disclosure applies to this generated film and record the creator's decision; no default decision is provided.",
    reel: { maxClips: 10_000, ordering: "shot_plan_order" },
    thumbnails: { candidateLimit: 5 },
  },
  {
    id: "documentary-publication-v1",
    title: { template: "{projectName} — Documentary", maxLength: 100 },
    descriptionSections: [
      { id: "synopsis", heading: "Synopsis", source: "derived_summary" },
      { id: "chapters", heading: "Chapters", source: "derived_chapters" },
      { id: "sources", heading: "Sources", source: "creator", guidance: "List sources for every factual claim; the creator owns factual accuracy." },
    ],
    disclosureGuidance: "State honestly whether any footage is presented as real events; decide whether the platform's altered or synthetic content disclosure applies and record the creator's decision.",
    reel: { maxClips: 10_000, ordering: "shot_plan_order" },
    thumbnails: { candidateLimit: 5 },
  },
  {
    id: "promotion-publication-v1",
    title: { template: "{projectName}", maxLength: 60 },
    descriptionSections: [
      { id: "hook", heading: "Hook", source: "creator", guidance: "Write the opening hook line; the creator owns every claim in it." },
      { id: "summary", heading: "Summary", source: "derived_summary" },
      { id: "call_to_action", heading: "Call to action", source: "creator", guidance: "Write the call to action; the creator owns any promise made." },
    ],
    disclosureGuidance: "Decide whether the platform's altered or synthetic content disclosure applies to this generated promotional material and record the creator's decision; no default decision is provided.",
    reel: { maxClips: 10_000, ordering: "shot_plan_order" },
    thumbnails: { candidateLimit: 5 },
  },
];
for (const profile of defaultPublicationProfiles) deepFreeze(profile);

/** Explicitly injectable catalog of genre publication profiles; future genres need no code edits. */
export const DEFAULT_PUBLICATION_PROFILE_CATALOG: readonly PublicationProfile[] = Object.freeze(defaultPublicationProfiles);

/** Resolves a validated independent snapshot; unknown ids fail closed with stable INVALID_INPUT. */
export function resolvePublicationProfile(id: string, catalog: readonly unknown[] = defaultPublicationProfiles): PublicationProfile {
  const found = catalog.find((item) => item !== null && typeof item === "object" && "id" in item && item.id === id);
  if (!found) throw new ProductionApplicationError("INVALID_INPUT", `Unknown publication profile: ${id}`);
  const parsed = PublicationProfileSchema.safeParse(found);
  if (!parsed.success) throw new ProductionApplicationError("INVALID_INPUT", "Invalid publication profile catalog entry");
  return { ...parsed.data };
}

// ---------------------------------------------------------------------------
// Input: the project record JSON (the v2 project read model or a compatible subset).
// ---------------------------------------------------------------------------

const publicationExportInputSchema = z.looseObject({
  id: IdSchema,
  status: ExportStatusSchema,
  manifestId: IdSchema,
  assetId: NullableIdSchema,
  approvedSha256: Sha256Schema.nullable(),
  finalApprovalId: NullableIdSchema,
  createdAt: UtcMillisSchema,
});
const publicationApprovalInputSchema = z.looseObject({
  id: IdSchema,
  targetKind: ApprovalTargetKindSchema,
  targetId: IdSchema,
  targetHash: Sha256Schema,
  decision: z.enum(["approved", "rejected"]),
  createdAt: UtcMillisSchema,
});
const publicationShotInputSchema = z.looseObject({
  shotRevision: z.looseObject({
    id: IdSchema,
    shotId: IdSchema,
    order: FrameIndexSchema,
    targetFrames: PositiveFramesSchema,
    visualIntent: NonEmptyTextSchema,
  }),
  selectedAnchor: z.looseObject({ id: IdSchema, shotRevisionId: IdSchema, assetId: IdSchema }).nullable(),
  selectedTake: z.looseObject({ id: IdSchema, assetId: IdSchema, actualFrames: PositiveFramesSchema }).nullable(),
  approvals: z.array(publicationApprovalInputSchema).max(100_000),
});
const publicationInputSchema = z.looseObject({
  schemaVersion: z.literal(2),
  project: z.looseObject({ id: IdSchema, name: z.string().trim().min(1).max(160) }),
  exports: z.array(publicationExportInputSchema).max(1000),
  shots: z.array(publicationShotInputSchema).max(10_000),
});
publicationInputSchema.safeParse({});
export const PublicationInputSchema = Object.freeze(publicationInputSchema);
type PublicationInput = z.infer<typeof PublicationInputSchema>;

// ---------------------------------------------------------------------------
// Fail-closed export gate: only exports a human can review (or has approved) qualify.
// ---------------------------------------------------------------------------

export type PublicationExportBasis = Readonly<{
  exportId: string;
  exportStatus: "ready_for_review" | "approved";
  exportAssetId: string | null;
  approvedSha256: string | null;
  finalApprovalId: string | null;
  manifestId: string;
}>;

/**
 * Picks the publication basis export deterministically: among exports with status
 * ready_for_review or approved, the latest createdAt wins, ties break on the greater id. Any
 * other state (queued, rendering, qc_pending, qc_failed, failed, canceled, or no exports at all)
 * refuses with APPROVAL_REQUIRED — publication metadata is never derived from unapproved content.
 */
export function selectPublicationExport(exports: unknown): PublicationExportBasis {
  const parsed = z.array(publicationExportInputSchema).max(1000).safeParse(exports);
  if (!parsed.success) fail("INVALID_INPUT", `Invalid export records for publication: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const passing = parsed.data.filter((record) => record.status === "ready_for_review" || record.status === "approved");
  if (passing.length === 0) fail("APPROVAL_REQUIRED", "No export is ready_for_review or approved; publication metadata cannot be derived from unapproved content.");
  const chosen = passing.reduce((best, record) => (record.createdAt > best.createdAt || (record.createdAt === best.createdAt && record.id > best.id) ? record : best));
  return {
    exportId: chosen.id,
    exportStatus: chosen.status === "approved" ? ("approved" as const) : ("ready_for_review" as const),
    exportAssetId: chosen.assetId,
    approvedSha256: chosen.approvedSha256,
    finalApprovalId: chosen.finalApprovalId,
    manifestId: chosen.manifestId,
  };
}

// ---------------------------------------------------------------------------
// Manual-upload checklist: fields for the creator, never defaults on their behalf.
// ---------------------------------------------------------------------------

export const MANUAL_UPLOAD_DISCLAIMER = "Manual upload only: export approval is not proof that the platform accepted or processed the file, no automated publishing is performed, and the creator completes and owns every field.";
const AUDIENCE_DESIGNATION_GUIDANCE = "Designate the audience for this film (for example, made-for-kids or not made-for-kids) following current platform policy; the creator decides for this specific content.";
const VISIBILITY_GUIDANCE = "Choose the initial visibility of this upload (for example, public, unlisted, or private); the creator decides.";
const creatorFieldSchema = z.strictObject({ status: z.literal("creator_required"), value: z.null(), guidance: z.string().min(1).max(4000) });

// ---------------------------------------------------------------------------
// Output: the strict publication package.
// ---------------------------------------------------------------------------

const publicationPackageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: IdSchema,
  profileId: publicationProfileIdSchema,
  basis: z.strictObject({
    exportId: IdSchema,
    exportStatus: z.enum(["ready_for_review", "approved"]),
    exportAssetId: NullableIdSchema,
    approvedSha256: Sha256Schema.nullable(),
    finalApprovalId: NullableIdSchema,
    manifestId: IdSchema,
  }),
  title: z.strictObject({
    text: z.string().min(1).max(200),
    maxLength: z.number().int().safe().positive().max(200),
    truncated: z.boolean(),
  }),
  description: z.strictObject({
    sections: z.array(z.strictObject({
      id: IdSchema,
      heading: NonEmptyTextSchema.max(200),
      source: z.enum(["derived_summary", "derived_chapters", "creator"]),
      body: z.string().max(20_000).nullable(),
      guidance: z.string().max(4000).nullable(),
    })).min(1).max(20),
  }),
  /** References to existing selected anchor assets only; no thumbnail media is generated here. */
  thumbnailCandidates: z.array(z.strictObject({
    shotId: IdSchema,
    shotRevisionId: IdSchema,
    anchorId: IdSchema,
    assetId: IdSchema,
  })).max(100),
  reelPlan: z.strictObject({
    fps: z.literal(24),
    clips: z.array(z.strictObject({
      order: FrameIndexSchema,
      shotId: IdSchema,
      shotRevisionId: IdSchema,
      takeId: IdSchema,
      assetId: IdSchema,
      targetFrames: PositiveFramesSchema,
      actualFrames: PositiveFramesSchema,
      durationFrames: PositiveFramesSchema,
    })).min(1).max(10_000),
    totalFrames: PositiveFramesSchema,
  }),
  uploadChecklist: z.strictObject({
    audienceDesignation: creatorFieldSchema,
    alteredSyntheticDisclosure: creatorFieldSchema,
    visibility: creatorFieldSchema,
    disclaimer: NonEmptyTextSchema.max(4000),
  }),
});
publicationPackageSchema.safeParse({});
export const PublicationPackageSchema = Object.freeze(publicationPackageSchema);
export type PublicationPackage = z.infer<typeof PublicationPackageSchema>;

/** Canonical SHA-256 of the package content; same input always yields the same digest. */
export function hashPublicationPackage(pkg: PublicationPackage): string {
  return hashCanonicalJson(pkg);
}

/** Deterministic M:SS chapter stamp for a frame offset at the given frame rate. */
export function formatChapterTimestamp(frames: number, fps: number): string {
  if (!Number.isSafeInteger(frames) || frames < 0) fail("INVALID_INPUT", `Chapter timestamp frame count must be a nonnegative safe integer, received ${String(frames)}.`);
  if (!Number.isSafeInteger(fps) || fps <= 0) fail("INVALID_INPUT", `Chapter timestamp frame rate must be a positive safe integer, received ${String(fps)}.`);
  const seconds = Math.floor(frames / fps);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Manual package emitters (M4-5): pure text artifact builders over the same
// frozen timeline arithmetic. SRT cues are frame-ranged manifest captions; the
// frame→time conversion is deterministic integer math on the manifest fps grid.
// ---------------------------------------------------------------------------

/** SRT timestamp "HH:MM:SS,mmm" for a frame offset at the given frame rate (nearest millisecond). */
export function formatSrtTimestamp(frames: number, fps: number): string {
  if (!Number.isSafeInteger(frames) || frames < 0) fail("INVALID_INPUT", `SRT timestamp frame count must be a nonnegative safe integer, received ${String(frames)}.`);
  if (!Number.isSafeInteger(fps) || fps <= 0) fail("INVALID_INPUT", `SRT timestamp frame rate must be a positive safe integer, received ${String(fps)}.`);
  const totalMs = Math.round((frames * 1000) / fps);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(Math.floor(totalMs / 3_600_000), 2)}:${pad(Math.floor(totalMs / 60_000) % 60, 2)}:${pad(Math.floor(totalMs / 1000) % 60, 2)},${pad(totalMs % 1000, 3)}`;
}

export interface PublicationCaptionCue { readonly text: string; readonly startFrame: number; readonly endFrame: number }

/**
 * Builds a valid SRT document from frame-ranged caption cues: `1\\n00:00:01,000 --> 00:00:04,000\\nText`
 * blocks numbered from 1, in input order, with cue text kept verbatim (SRT has no escapes).
 * Fail-closed: non-integer or reversed frames, empty text, and nonpositive fps all refuse.
 */
export function buildSrt(cues: ReadonlyArray<PublicationCaptionCue>, fps: number): string {
  if (!Array.isArray(cues)) fail("INVALID_INPUT", "SRT captions must be an array of frame-ranged cues.");
  const blocks = cues.map((cue, index) => {
    if (typeof cue.text !== "string" || cue.text.trim().length === 0) fail("INVALID_INPUT", `Caption cue ${index} must carry nonempty text.`);
    if (!Number.isSafeInteger(cue.startFrame) || cue.startFrame < 0) fail("INVALID_INPUT", `Caption cue ${index} startFrame must be a nonnegative safe integer, received ${String(cue.startFrame)}.`);
    if (!Number.isSafeInteger(cue.endFrame) || cue.endFrame <= cue.startFrame) fail("INVALID_INPUT", `Caption cue ${index} endFrame must be a safe integer after startFrame ${String(cue.startFrame)}, received ${String(cue.endFrame)}.`);
    return `${index + 1}\n${formatSrtTimestamp(cue.startFrame, fps)} --> ${formatSrtTimestamp(cue.endFrame, fps)}\n${cue.text}`;
  });
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

export interface PackageMetadataDefaultsInput {
  projectName: string;
  /** Scene titles in production order; the first nonempty list wins for the description default. */
  sceneTitles?: readonly string[];
  /** Shot visual intents; the fallback when no scene titles exist. */
  shotVisualIntents?: readonly string[];
  workspaceName?: string | null;
  workspaceTags?: readonly string[];
}

/**
 * Deterministic package metadata defaults: title = project title, description = scene titles
 * joined (falling back to shot intents, then the title), hashtags = sanitized workspace-name
 * words plus workspace tags (deduped case-insensitively, capped at 8, "#"-prefixed). Every
 * value is a starting point the creator can override; nothing here invents claims.
 */
export function derivePackageMetadataDefaults(input: PackageMetadataDefaultsInput): { title: string; description: string; hashtags: string } {
  const title = typeof input.projectName === "string" ? input.projectName.trim() : "";
  if (!title) fail("INVALID_INPUT", "Package metadata defaults require a nonempty project title.");
  const cleanLines = (values: readonly string[] | undefined): string[] =>
    (values ?? []).map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0);
  const sceneTitles = cleanLines(input.sceneTitles);
  const shotIntents = cleanLines(input.shotVisualIntents);
  const description = sceneTitles.length > 0 ? sceneTitles.join("\n") : shotIntents.length > 0 ? shotIntents.join("\n") : title;
  const tokens: string[] = [];
  const pushToken = (raw: string): void => {
    const cleaned = raw.replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
    if (!cleaned) return;
    const cased = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    if (!tokens.some((token) => token.toLowerCase() === cased.toLowerCase())) tokens.push(cased);
  };
  for (const word of (input.workspaceName ?? "").split(/[\s-]+/)) pushToken(word);
  for (const tag of input.workspaceTags ?? []) for (const word of String(tag).split(/[\s-]+/)) pushToken(word);
  return { title, description, hashtags: tokens.slice(0, 8).map((token) => `#${token}`).join(" ") };
}

function assertLatestTakeDecisionApproved(approvals: PublicationInput["shots"][number]["approvals"], takeId: string, shotId: string): void {
  const decisions = approvals.filter((approval) => approval.targetKind === "take" && approval.targetId === takeId);
  if (decisions.length === 0) fail("APPROVAL_REQUIRED", `Take ${takeId} for shot ${shotId} has no approval decision; publication refuses unapproved takes.`);
  const latestAt = Math.max(...decisions.map((approval) => approval.createdAt));
  if (decisions.some((approval) => approval.createdAt === latestAt && approval.decision !== "approved")) {
    fail("APPROVAL_REQUIRED", `Take ${takeId} for shot ${shotId} was rejected after approval; publication refuses takes whose latest decision is not an approval.`);
  }
}

/**
 * Deterministically derives the strict publication package from the project record JSON under the
 * given genre profile. Fail-closed gates: an approved-or-ready export must exist, every shot must
 * have a selected take whose latest decision is an approval, and the record must be structurally
 * valid. The output contains no timestamps and no creator decisions: same input, same package,
 * same hash. No prices, platform outcomes, or upload results are ever fabricated.
 */
export function derivePublicationPackage(input: unknown, profile: PublicationProfile): PublicationPackage {
  const validatedProfile = PublicationProfileSchema.safeParse(profile);
  if (!validatedProfile.success) fail("INVALID_INPUT", "Invalid publication profile");
  const resolvedProfile = validatedProfile.data;
  const parsedInput = PublicationInputSchema.safeParse(input);
  if (!parsedInput.success) fail("INVALID_INPUT", `Invalid project record for publication: ${parsedInput.error.issues.map((issue) => issue.message).join("; ")}`);
  const record = parsedInput.data;
  const basis = selectPublicationExport(record.exports);
  if (record.shots.length === 0) fail("INVALID_INPUT", "The project record lists no shots; a publication package requires at least one planned shot.");
  if (record.shots.length > resolvedProfile.reel.maxClips) {
    fail("INVALID_INPUT", `The project record lists ${record.shots.length} shots, past the ${resolvedProfile.reel.maxClips}-clip reel maximum of ${resolvedProfile.id}.`);
  }

  const clips = record.shots.map((shot) => {
    const take = shot.selectedTake;
    if (!take) fail("APPROVAL_REQUIRED", `Shot ${shot.shotRevision.shotId} (revision ${shot.shotRevision.id}) has no selected take; publication refuses unselected shots.`);
    assertLatestTakeDecisionApproved(shot.approvals, take.id, shot.shotRevision.shotId);
    return {
      order: shot.shotRevision.order,
      shotId: shot.shotRevision.shotId,
      shotRevisionId: shot.shotRevision.id,
      takeId: take.id,
      assetId: take.assetId,
      targetFrames: shot.shotRevision.targetFrames,
      actualFrames: take.actualFrames,
      durationFrames: Math.min(take.actualFrames, shot.shotRevision.targetFrames),
    };
  });
  const totalFrames = clips.reduce((sum, clip) => sum + clip.durationFrames, 0);
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) fail("INVALID_INPUT", `The reel plan totals ${String(totalFrames)} frames; a positive safe integer total is required.`);
  const clipStartFrames: number[] = [];
  { let elapsed = 0; for (const clip of clips) { clipStartFrames.push(elapsed); elapsed += clip.durationFrames; } }

  const titleText = resolvedProfile.title.template.replaceAll("{projectName}", record.project.name);
  const truncated = titleText.length > resolvedProfile.title.maxLength;
  const title = { text: truncated ? titleText.slice(0, resolvedProfile.title.maxLength) : titleText, maxLength: resolvedProfile.title.maxLength, truncated };

  const sections = resolvedProfile.descriptionSections.map((section) => {
    if (section.source === "creator") {
      return { id: section.id, heading: section.heading, source: section.source, body: null, guidance: section.guidance ?? null };
    }
    if (section.source === "derived_chapters") {
      const lines = record.shots.map((shot, index) =>
        `${formatChapterTimestamp(clipStartFrames[index]!, PUBLICATION_TIMELINE_FPS)} ${shot.shotRevision.visualIntent.slice(0, 100)}`);
      return { id: section.id, heading: section.heading, source: section.source, body: lines.join("\n"), guidance: null };
    }
    return {
      id: section.id, heading: section.heading, source: section.source,
      body: `${record.project.name}: ${clips.length} shots, ${totalFrames} frames at ${PUBLICATION_TIMELINE_FPS} fps.`,
      guidance: null,
    };
  });

  const thumbnailCandidates: { shotId: string; shotRevisionId: string; anchorId: string; assetId: string }[] = [];
  for (const shot of record.shots) {
    if (thumbnailCandidates.length >= resolvedProfile.thumbnails.candidateLimit) break;
    if (!shot.selectedAnchor) continue;
    thumbnailCandidates.push({ shotId: shot.shotRevision.shotId, shotRevisionId: shot.shotRevision.id, anchorId: shot.selectedAnchor.id, assetId: shot.selectedAnchor.assetId });
  }

  const candidate = {
    schemaVersion: PUBLICATION_PACKAGE_SCHEMA_VERSION,
    projectId: record.project.id,
    profileId: resolvedProfile.id,
    basis,
    title,
    description: { sections },
    thumbnailCandidates,
    reelPlan: { fps: PUBLICATION_TIMELINE_FPS, clips, totalFrames },
    uploadChecklist: {
      audienceDesignation: { status: "creator_required", value: null, guidance: AUDIENCE_DESIGNATION_GUIDANCE },
      alteredSyntheticDisclosure: { status: "creator_required", value: null, guidance: resolvedProfile.disclosureGuidance },
      visibility: { status: "creator_required", value: null, guidance: VISIBILITY_GUIDANCE },
      disclaimer: MANUAL_UPLOAD_DISCLAIMER,
    },
  };
  const parsedPackage = PublicationPackageSchema.safeParse(candidate);
  if (!parsedPackage.success) fail("INVALID_INPUT", `Derived publication package failed schema validation: ${parsedPackage.error.issues.map((issue) => issue.message).join("; ")}`);
  return parsedPackage.data;
}
