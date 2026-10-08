import { z } from "zod";

/** Shared primitives are deliberately stricter than JavaScript's coercions. */
export const SchemaVersionSchema = z.literal(1);
export const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "ID contains unsupported characters");
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const UtcMillisSchema = z.number().int().safe().nonnegative();
export const FrameIndexSchema = z.number().int().safe().nonnegative();
export const PositiveFramesSchema = z.number().int().safe().positive();
export const SampleIndexSchema = z.number().int().safe().nonnegative();
export const PositiveSamplesSchema = z.number().int().safe().positive();
export const NonEmptyTextSchema = z.string().trim().min(1).max(100_000);
export const VerbatimTextSchema = z.string().min(1).max(100_000).refine((value) => value.trim().length > 0, "Text cannot be whitespace only");
export const NullableIdSchema = IdSchema.nullable();

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(), z.boolean(), z.number().finite(), z.string(),
    z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
  ]),
);
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const LocalProfileSchema = z.strictObject({
  id: IdSchema,
  format: z.enum(["9:16", "16:9"]),
  language: z.string().trim().min(2).max(35),
  ageIntent: z.string().trim().min(1).max(80),
  targetFrames: PositiveFramesSchema,
  projectCapMinor: z.number().int().safe().nonnegative().nullable(),
  dailyCapMinor: z.number().int().safe().nonnegative().nullable(),
});
export type ProductionProfile = z.infer<typeof LocalProfileSchema>;

export const ProjectSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  profileId: IdSchema,
  profile: LocalProfileSchema,
  activeCanonRevisionIds: z.array(IdSchema).max(500),
  activeStoryRevisionId: NullableIdSchema,
  activeShotPlanRevisionId: NullableIdSchema,
  activeAnimaticRevisionId: NullableIdSchema,
  activeAudioMixRevisionId: NullableIdSchema,
  /** Wave-0 workspace link (C5); optional on read for legacy rows, set by writers when a workspace snapshot is bound. */
  workspaceId: NullableIdSchema.optional(),
  activeSnapshotId: NullableIdSchema.optional(),
  /** Project-global version shared by all per-shot take selections; starts at zero. */
  takeSelectionVersion: z.number().int().safe().nonnegative(),
  /** Audio-mix CAS version; starts at zero before the first immutable mix revision. */
  audioMixVersion: z.number().int().safe().nonnegative(),
  createdAt: UtcMillisSchema,
  updatedAt: UtcMillisSchema,
  saveVersion: z.number().int().safe().positive(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CanonEntityKindSchema = z.enum(["character", "environment", "location", "prop", "style"]);
export type CanonEntityKind = z.infer<typeof CanonEntityKindSchema>;
/** "environment" is the canonical written value; "location" remains valid for legacy records (read path tolerates it). */
export const isEnvironmentKind = (kind: CanonEntityKind): boolean => kind === "environment" || kind === "location";
export const CanonRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  entityId: IdSchema,
  entityKind: CanonEntityKindSchema,
  revision: z.number().int().safe().positive(),
  description: NonEmptyTextSchema,
  attributes: z.record(z.string(), JsonValueSchema),
  referenceAssetIds: z.array(IdSchema).max(100),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type CanonRevision = z.infer<typeof CanonRevisionSchema>;

export const StoryBeatSchema = z.strictObject({
  id: IdSchema,
  action: NonEmptyTextSchema,
  narration: z.string().max(20_000),
  dialogue: z.array(z.strictObject({ characterId: IdSchema, text: VerbatimTextSchema.max(20_000) })).max(100),
  order: z.number().int().safe().nonnegative(),
});
export const StoryRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  parentRevisionId: NullableIdSchema,
  scriptText: z.string().max(500_000),
  beats: z.array(StoryBeatSchema).min(1).max(10_000),
  canonRevisionIds: z.array(IdSchema).max(500),
  /** Additive recommendation marker (C8); optional on read for legacy revisions. */
  recommendedAt: UtcMillisSchema.nullable().optional(),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type StoryBeat = z.infer<typeof StoryBeatSchema>;
export type StoryRevision = z.infer<typeof StoryRevisionSchema>;

export const ShotCastBindingSchema = z.strictObject({
  characterId: IdSchema,
  canonRevisionId: IdSchema,
  wardrobe: NonEmptyTextSchema,
});
export type ShotCastBinding = z.infer<typeof ShotCastBindingSchema>;
export const ShotContinuationSchema = z.strictObject({
  previousShotRevisionId: IdSchema,
  endFrameAssetId: IdSchema,
});
export const ShotRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  shotId: IdSchema,
  storyRevisionId: IdSchema,
  beatIds: z.array(IdSchema).min(1).max(100),
  order: z.number().int().safe().nonnegative(),
  visualIntent: NonEmptyTextSchema,
  motionIntent: NonEmptyTextSchema,
  castBindings: z.array(ShotCastBindingSchema).max(3),
  locationRevisionId: IdSchema,
  propRevisionIds: z.array(IdSchema).max(100),
  styleRevisionId: IdSchema,
  framing: z.enum(["extreme_wide", "wide", "medium_wide", "medium", "close", "extreme_close"]),
  targetFrames: PositiveFramesSchema.max(100_000),
  continuation: ShotContinuationSchema.nullable(),
  /** Additive nullable fields (C7); optional on read for legacy shot revisions. Scene.shotIds are derived via sceneId. */
  sceneId: NullableIdSchema.optional(),
  cameraMotion: z.string().max(200).nullable().optional(),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type ShotRevision = z.infer<typeof ShotRevisionSchema>;

export const BeatCoverageSchema = z.strictObject({
  beatId: IdSchema,
  shotRevisionIds: z.array(IdSchema).min(1).max(10_000),
});
export const ShotPlanRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  storyRevisionId: IdSchema,
  orderedShotRevisionIds: z.array(IdSchema).min(1).max(10_000),
  beatCoverage: z.array(BeatCoverageSchema).min(1).max(10_000),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type ShotPlanRevision = z.infer<typeof ShotPlanRevisionSchema>;

export const AnimaticSlotSchema = z.strictObject({
  shotRevisionId: IdSchema,
  anchorId: NullableIdSchema,
  placeholderLabel: z.string().max(200).nullable(),
});
export const AnimaticTimingAnnotationSchema = z.strictObject({
  id: IdSchema,
  shotRevisionId: IdSchema,
  startFrame: FrameIndexSchema,
  endFrame: PositiveFramesSchema,
  note: z.string().max(2000),
}).refine((x) => x.endFrame > x.startFrame, { path: ["endFrame"], message: "endFrame must follow startFrame" });
export const AnimaticRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  shotPlanRevisionId: IdSchema,
  slots: z.array(AnimaticSlotSchema).min(1).max(10_000),
  timingAnnotations: z.array(AnimaticTimingAnnotationSchema).max(100_000),
  totalFrames: PositiveFramesSchema,
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type AnimaticRevision = z.infer<typeof AnimaticRevisionSchema>;

export const AudioRoleSchema = z.enum(["narration", "dialogue", "music", "sfx"]);
/** C16 (spec 12): per-line delivery presets; `auto` defers to the voice adapter. */
export const DeliveryPresetSchema = z.enum(["auto", "calm", "excited", "scared", "angry", "whisper", "shout"]);
export type DeliveryPreset = z.infer<typeof DeliveryPresetSchema>;
const hasSafeCueTimelineEnd = (cue: { sourceStartSample: number; sourceEndSample: number; timelineStartSample: number }) =>
  Number.isSafeInteger(cue.timelineStartSample + (cue.sourceEndSample - cue.sourceStartSample));
export const AudioCueSchema = z.strictObject({
  id: IdSchema,
  assetId: IdSchema,
  sourceStartSample: SampleIndexSchema,
  sourceEndSample: PositiveSamplesSchema,
  timelineStartSample: SampleIndexSchema,
  gainDb: z.number().finite().min(-60).max(12),
  role: AudioRoleSchema,
  scriptSegmentId: NullableIdSchema,
  sourceText: z.string().max(20_000).nullable(),
  sourceRights: z.enum(["creator_attested", "licensed", "public_domain", "provider", "unknown"]),
  /** Additive fields (C16, spec 12); optional on read for legacy cues. */
  delivery: DeliveryPresetSchema.nullable().optional(),
  voiceId: NullableIdSchema.optional(),
}).refine((x) => x.sourceEndSample > x.sourceStartSample, {
  path: ["sourceEndSample"], message: "sourceEndSample must follow sourceStartSample",
}).refine(hasSafeCueTimelineEnd, {
  path: ["timelineStartSample"], message: "derived timeline end sample must be a safe integer",
});
export type AudioCue = z.infer<typeof AudioCueSchema>;
export const AudioMixSettingsSchema = z.strictObject({
  sampleRate: z.literal(48_000),
  channels: z.literal(2),
  loudnessTargetLufs: z.number().finite().min(-30).max(-5),
  truePeakLimitDbtp: z.number().finite().min(-12).max(0),
  muteNativeAudio: z.boolean(),
});
export const AudioMixRevisionSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  storyRevisionId: IdSchema,
  cues: z.array(AudioCueSchema).max(100_000),
  mixSettings: AudioMixSettingsSchema,
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type AudioMixRevision = z.infer<typeof AudioMixRevisionSchema>;

export const VisionAssessmentSchema = z.strictObject({
  status: z.enum(["pass", "warning", "failed", "unavailable", "exhausted"]),
  summary: z.string().max(4000),
  scores: z.record(z.string(), z.number().finite().min(0).max(1)).optional(),
  reviewedAt: UtcMillisSchema.optional(),
});
export type VisionAssessment = z.infer<typeof VisionAssessmentSchema>;
export const AnchorCandidateSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  shotRevisionId: IdSchema,
  assetId: IdSchema,
  inputsHash: Sha256Schema,
  jobId: IdSchema,
  visionAssessment: VisionAssessmentSchema.nullable(),
  receiptId: NullableIdSchema,
  /** Additive recommendation marker (C8); optional on read for legacy candidates. */
  recommendedAt: UtcMillisSchema.nullable().optional(),
  createdAt: UtcMillisSchema,
});
export type AnchorCandidate = z.infer<typeof AnchorCandidateSchema>;

export const ApprovalTargetKindSchema = z.enum(["story", "canon", "shotplan", "animatic", "anchor", "take", "audio", "final"]);
export const ApprovalChecklistItemSchema = z.strictObject({
  id: IdSchema,
  passed: z.boolean(),
  note: z.string().max(4000),
});
export const ApprovalSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  targetKind: ApprovalTargetKindSchema,
  targetId: IdSchema,
  targetHash: Sha256Schema,
  decision: z.enum(["approved", "rejected"]),
  actorId: IdSchema,
  createdAt: UtcMillisSchema,
  checklist: z.array(ApprovalChecklistItemSchema).max(100),
  notes: z.string().max(10_000),
  advisoryAcknowledgements: z.array(z.strictObject({ code: IdSchema, reason: NonEmptyTextSchema })).max(100),
}).superRefine((record, ctx) => {
  if (record.decision === "approved" && record.checklist.length === 0) {
    ctx.addIssue({ code: "custom", path: ["checklist"], message: "Approved decisions require a nonempty checklist" });
  }
  if (record.decision === "approved" && record.checklist.some((item) => !item.passed)) {
    ctx.addIssue({ code: "custom", path: ["checklist"], message: "An approval cannot include failed required checklist items" });
  }
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const TakeSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  shotRevisionId: IdSchema,
  anchorId: IdSchema,
  approvalId: IdSchema,
  jobId: IdSchema,
  assetId: IdSchema,
  actualFrames: PositiveFramesSchema,
  inputsHash: Sha256Schema,
  receiptId: IdSchema,
  /** Additive fields (C7/C8); optional on read for legacy takes. paramsHash aliases inputsHash for the same request snapshot. */
  paramsHash: Sha256Schema.optional(),
  directionNote: z.string().max(2000).nullable().optional(),
  recommendation: z.enum(["none", "recommended"]).nullable().optional(),
  recommendedAt: UtcMillisSchema.nullable().optional(),
  createdAt: UtcMillisSchema,
});
export type Take = z.infer<typeof TakeSchema>;

export const MediaSourceKindSchema = z.enum(["upload", "generation", "legacy", "derived", "fixture"]);
export const RightsStatusSchema = z.enum(["creator_attested", "licensed", "public_domain", "provider", "unknown", "legacy_unreviewed"]);
export const ImportProvenanceSchema = z.strictObject({
  source: NonEmptyTextSchema.max(1_000),
  rightsAttestation: NonEmptyTextSchema.max(4_000),
  actorId: IdSchema,
  createdAt: UtcMillisSchema,
});
export type ImportProvenance = z.infer<typeof ImportProvenanceSchema>;
export const AssetSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  sha256: Sha256Schema,
  mime: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  byteSize: z.number().int().safe().positive(),
  vaultRef: IdSchema,
  width: z.number().int().safe().positive().nullable(),
  height: z.number().int().safe().positive().nullable(),
  frames: PositiveFramesSchema.nullable(),
  fps: z.number().finite().positive().nullable(),
  audioSamples: PositiveSamplesSchema.nullable(),
  sourceKind: MediaSourceKindSchema,
  sourceJobId: NullableIdSchema,
  rightsStatus: RightsStatusSchema,
  importProvenance: ImportProvenanceSchema.optional(),
  createdAt: UtcMillisSchema,
});
export type Asset = z.infer<typeof AssetSchema>;

export const RenderProfileSchema = z.strictObject({
  id: IdSchema,
  version: SchemaVersionSchema,
  aspect: z.enum(["9:16", "16:9"]),
  width: z.number().int().safe().positive(),
  height: z.number().int().safe().positive(),
  fps: z.literal(24),
  videoCodec: z.literal("h264"),
  pixelFormat: z.literal("yuv420p"),
  audioCodec: z.enum(["aac", "none"]),
  sampleRate: z.literal(48_000),
});
export const ManifestShotSchema = z.strictObject({
  shotRevisionId: IdSchema,
  takeId: IdSchema,
  assetId: IdSchema,
  startFrame: FrameIndexSchema,
  endFrame: PositiveFramesSchema,
  crop: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }),
  transition: z.enum(["cut", "crossfade"]),
}).refine((x) => x.endFrame > x.startFrame, { path: ["endFrame"], message: "endFrame must follow startFrame" });
export const RenderManifestSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  storyRevisionId: IdSchema,
  shotPlanRevisionId: IdSchema,
  animaticRevisionId: IdSchema,
  audioMixRevisionId: NullableIdSchema,
  profile: RenderProfileSchema,
  shots: z.array(ManifestShotSchema).min(1).max(10_000),
  audioCues: z.array(AudioCueSchema).max(100_000),
  captionCues: z.array(z.strictObject({
    text: NonEmptyTextSchema, startFrame: FrameIndexSchema, endFrame: PositiveFramesSchema,
  }).refine((x) => x.endFrame > x.startFrame, { path: ["endFrame"] })).max(100_000),
  inputsHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export const ExportStatusSchema = z.enum(["queued", "rendering", "qc_pending", "qc_failed", "ready_for_review", "approved", "failed", "canceled"]);
export const ExportSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  manifestId: IdSchema,
  jobId: NullableIdSchema,
  assetId: NullableIdSchema,
  qcReportId: NullableIdSchema,
  status: ExportStatusSchema,
  createdAt: UtcMillisSchema,
  approvedSha256: Sha256Schema.nullable(),
  finalApprovalId: NullableIdSchema,
}).superRefine((record, ctx) => {
  if (record.status === "approved" && (!record.approvedSha256 || !record.finalApprovalId || !record.assetId || !record.qcReportId)) {
    ctx.addIssue({ code: "custom", message: "approved export requires checksum-bound final approval, asset, and QC report" });
  }
});
export type ExportRecord = z.infer<typeof ExportSchema>;

export const JobStatusSchema = z.enum(["queued", "validating", "submitting", "running", "persisting", "blocked", "submission_unknown", "cancel_requested", "canceled", "failed", "completed"]);
export const JobScopeSchema = z.strictObject({
  workspaceId: NullableIdSchema,
  productionId: NullableIdSchema,
  sceneId: NullableIdSchema,
  shotId: NullableIdSchema,
});
export type JobScope = z.infer<typeof JobScopeSchema>;
export const JobSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  operation: z.enum(["anchor", "take", "audio", "export"]),
  status: JobStatusSchema,
  idempotencyKey: IdSchema,
  requestSnapshot: JsonValueSchema,
  requestHash: Sha256Schema,
  providerId: NullableIdSchema,
  modelId: NullableIdSchema,
  providerRef: NullableIdSchema,
  quoteId: NullableIdSchema,
  receiptId: NullableIdSchema,
  resultId: NullableIdSchema,
  resultAssetIds: z.array(IdSchema).max(100),
  leaseToken: NullableIdSchema,
  leaseUntil: UtcMillisSchema.nullable(),
  heartbeatAt: UtcMillisSchema.nullable(),
  attempt: z.number().int().safe().nonnegative(),
  errorCode: NullableIdSchema,
  errorMessage: z.string().max(4000).nullable(),
  createdAt: UtcMillisSchema,
  updatedAt: UtcMillisSchema,
  /** Additive fields (C9); optional on read for legacy jobs. Retry derivations set retryOf on NEW jobs. */
  scope: JobScopeSchema.nullable().optional(),
  retryOf: NullableIdSchema.optional(),
  resolvedReferenceIds: z.array(IdSchema).max(500).optional(),
}).superRefine((record, ctx) => {
  if (record.status === "completed" && (!record.receiptId || (!record.resultId && record.resultAssetIds.length === 0))) {
    ctx.addIssue({ code: "custom", message: "Completed jobs require a result and persisted receipt" });
  }
});
export type ProductionJob = z.infer<typeof JobSchema>;

export const EntitlementSchema = z.enum(["subscription", "spark", "unknown"]);
export const BudgetOperationSchema = z.enum(["anchor", "take", "speech", "music", "text_proposal"]);
export const BudgetUnitSchema = z.enum(["minor_currency", "spark_token"]);
export const BudgetQuoteUnitSchema = z.enum(["minor_currency", "spark_token", "unknown"]);
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const SafeAmountSchema = z.number().int().safe().nonnegative();
export const MAX_BUDGET_UTC_MILLIS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const BudgetUtcMillisSchema = UtcMillisSchema.max(MAX_BUDGET_UTC_MILLIS).refine((value) => Number.isFinite(new Date(value).getTime()), "Timestamp must be representable as a four-digit UTC date");
const PositiveRevisionSchema = z.number().int().safe().positive();
const BoundedUniqueIdsSchema = z.array(IdSchema).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "IDs must be unique");
const BoundedUniqueBudgetOperationsSchema = z.array(BudgetOperationSchema).min(1).max(5).refine((items) => new Set(items).size === items.length, "Operations must be unique");
const BoundedUniqueEntitlementsSchema = z.array(z.enum(["subscription", "spark"])).min(1).max(2).refine((items) => new Set(items).size === items.length, "Entitlement modes must be unique");

export const MoneyScopeSchema = z.strictObject({
  providerId: IdSchema, accountId: IdSchema, currency: CurrencyCodeSchema.nullable(), unit: BudgetUnitSchema,
}).superRefine((scope, ctx) => {
  if ((scope.unit === "minor_currency") !== (scope.currency !== null)) {
    ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency is required only for minor_currency" });
  }
});
export type MoneyScope = z.infer<typeof MoneyScopeSchema>;

const BudgetQuoteScopeSchema = z.strictObject({
  currency: CurrencyCodeSchema.nullable(), unit: BudgetQuoteUnitSchema,
}).superRefine((scope, ctx) => {
  if (scope.unit === "minor_currency" && scope.currency === null) ctx.addIssue({ code: "custom", path: ["currency"], message: "minor_currency quotes require a currency" });
  if (scope.unit === "spark_token" && scope.currency !== null) ctx.addIssue({ code: "custom", path: ["currency"], message: "spark_token quotes cannot claim a currency" });
});

const BudgetRevisionFields = {
  schemaVersion: SchemaVersionSchema,
  revisionId: IdSchema,
};
export const AccountBudgetPolicySchema = z.strictObject({
  ...BudgetRevisionFields, policyId: IdSchema, revision: PositiveRevisionSchema,
  providerId: IdSchema, accountId: IdSchema, currency: CurrencyCodeSchema.nullable(), unit: BudgetUnitSchema,
  dailyCap: SafeAmountSchema.nullable(), expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema, createdAt: BudgetUtcMillisSchema,
}).superRefine((policy, ctx) => {
  if ((policy.unit === "minor_currency") !== (policy.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency must match policy unit" });
});
export type AccountBudgetPolicy = z.infer<typeof AccountBudgetPolicySchema>;

export const BudgetAuthorizationSchema = z.strictObject({
  ...BudgetRevisionFields, authorizationId: IdSchema, revision: PositiveRevisionSchema,
  projectId: IdSchema, policyId: IdSchema, policyRevisionIdAtAuthorization: IdSchema,
  projectCap: SafeAmountSchema.nullable(), allowedModelIds: BoundedUniqueIdsSchema,
  allowedOperations: BoundedUniqueBudgetOperationsSchema, entitlementModes: BoundedUniqueEntitlementsSchema,
  expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema, createdAt: BudgetUtcMillisSchema,
});
export type BudgetAuthorization = z.infer<typeof BudgetAuthorizationSchema>;

export const AuthorizeBudgetCommandSchema = z.strictObject({
  expectedAuthorizationRevision: z.number().int().safe().positive().nullable(), expectedPolicyRevision: PositiveRevisionSchema,
  policyId: IdSchema, projectCap: SafeAmountSchema.nullable(), allowedModelIds: BoundedUniqueIdsSchema,
  allowedOperations: BoundedUniqueBudgetOperationsSchema, entitlementModes: BoundedUniqueEntitlementsSchema,
  expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema,
});
export type AuthorizeBudgetCommand = z.infer<typeof AuthorizeBudgetCommandSchema>;

export const AccountBudgetPolicyCommandSchema = z.strictObject({
  policyId: IdSchema, expectedPolicyRevision: z.number().int().safe().positive().nullable(), dailyCap: SafeAmountSchema.nullable(),
  expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema,
});

export const AccountEvidenceSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema, id: IdSchema, providerId: IdSchema, accountId: IdSchema,
  source: NonEmptyTextSchema.max(200), reference: NonEmptyTextSchema.max(500),
  observedAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema, credentialBindingId: IdSchema,
}).refine((evidence) => evidence.expiresAt > evidence.observedAt, { path: ["expiresAt"], message: "Evidence must expire after observation" });
export type AccountEvidence = z.infer<typeof AccountEvidenceSchema>;

export const BudgetQuoteSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, providerId: IdSchema, modelId: IdSchema,
  operation: BudgetOperationSchema, inputHash: Sha256Schema,
  estimateMin: SafeAmountSchema.nullable(), estimateMax: SafeAmountSchema.nullable(),
  currency: CurrencyCodeSchema.nullable(), unit: BudgetQuoteUnitSchema, entitlement: EntitlementSchema,
  createdAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema, mediaQuoteId: NullableIdSchema,
}).superRefine((quote, ctx) => {
  if (quote.expiresAt <= quote.createdAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Quote must expire after creation" });
  if (quote.estimateMin !== null && quote.estimateMax !== null && quote.estimateMin > quote.estimateMax) ctx.addIssue({ code: "custom", path: ["estimateMin"], message: "Minimum estimate cannot exceed maximum" });
  const scope = BudgetQuoteScopeSchema.safeParse({ currency: quote.currency, unit: quote.unit });
  if (!scope.success) ctx.addIssue({ code: "custom", path: ["currency"], message: "Quote currency and unit are inconsistent" });
  if ((quote.operation === "text_proposal") === (quote.mediaQuoteId !== null)) ctx.addIssue({ code: "custom", path: ["mediaQuoteId"], message: "Text quotes have no media quote; media operations require one" });
});
export type BudgetQuote = z.infer<typeof BudgetQuoteSchema>;

export const QuoteAccountBindingSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema, id: IdSchema, budgetQuoteId: IdSchema, accountEvidenceId: IdSchema,
  providerId: IdSchema, accountId: IdSchema, credentialBindingId: IdSchema,
  currency: CurrencyCodeSchema.nullable(), unit: BudgetQuoteUnitSchema, executionSemanticHash: Sha256Schema, quotedAt: BudgetUtcMillisSchema,
}).superRefine((binding, ctx) => {
  if (!BudgetQuoteScopeSchema.safeParse({ currency: binding.currency, unit: binding.unit }).success) ctx.addIssue({ code: "custom", path: ["currency"], message: "Binding currency and unit are inconsistent" });
});
export type QuoteAccountBinding = z.infer<typeof QuoteAccountBindingSchema>;

export const BudgetExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("media_job"), executionId: IdSchema, operation: z.enum(["anchor", "take", "speech", "music"]), projectId: IdSchema, idempotencyKey: IdSchema, requestHash: Sha256Schema, executionSemanticHash: Sha256Schema, providerId: IdSchema, modelId: IdSchema }),
  z.strictObject({ kind: z.literal("text_proposal"), executionId: IdSchema, operation: z.literal("text_proposal"), projectId: IdSchema, idempotencyKey: IdSchema, requestHash: Sha256Schema, executionSemanticHash: Sha256Schema, providerId: IdSchema, modelId: IdSchema }),
]);
export type BudgetExecution = z.infer<typeof BudgetExecutionSchema>;
export const BudgetReservationSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema, id: IdSchema, execution: BudgetExecutionSchema,
  authorizationRevisionId: IdSchema, policyRevisionId: IdSchema, budgetQuoteId: IdSchema, quoteBindingId: IdSchema,
  accountEvidenceId: IdSchema, providerId: IdSchema, accountId: IdSchema, credentialBindingId: IdSchema,
  currency: CurrencyCodeSchema.nullable(), unit: BudgetUnitSchema, upperEstimate: SafeAmountSchema,
  reservedAt: BudgetUtcMillisSchema, utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).superRefine((reservation, ctx) => {
  const date = new Date(reservation.reservedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reservation.utcDay) ctx.addIssue({ code: "custom", path: ["utcDay"], message: "UTC day must match reservation time" });
  if ((reservation.unit === "minor_currency") !== (reservation.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Reservation currency must match unit" });
  if (reservation.providerId !== reservation.execution.providerId) ctx.addIssue({ code: "custom", path: ["providerId"], message: "Reservation provider must match execution" });
  if (reservation.execution.projectId.length === 0) ctx.addIssue({ code: "custom", path: ["execution", "projectId"], message: "Execution project is required" });
  if ((reservation.execution.operation === "text_proposal") !== (reservation.execution.kind === "text_proposal")) ctx.addIssue({ code: "custom", path: ["execution"], message: "Text operation requires text proposal execution" });
});
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

const ReconciliationCommon = {
  schemaVersion: SchemaVersionSchema, eventKey: IdSchema, reservationId: IdSchema,
  providerId: IdSchema, accountId: IdSchema, currency: CurrencyCodeSchema.nullable(), unit: BudgetUnitSchema,
  observedAt: BudgetUtcMillisSchema, source: NonEmptyTextSchema.max(200), reference: NonEmptyTextSchema.max(500),
  provenance: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("provider"), producerId: IdSchema }),
    z.strictObject({ kind: z.literal("manual"), actorId: IdSchema, decision: z.literal("reconciled"), reason: NonEmptyTextSchema.max(4000) }),
  ]),
};
export const ReconciliationEvidenceSchema = z.strictObject({ ...ReconciliationCommon, fact: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("actual"), cumulativeActual: SafeAmountSchema.nullable(), final: z.boolean() }).refine((fact) => fact.cumulativeActual !== null || !fact.final, { path: ["final"], message: "Unknown actual cannot be final" }),
  z.strictObject({ kind: z.literal("nonbilling"), confirmedNonacceptanceOrNonbilling: z.literal(true) }),
  z.strictObject({ kind: z.literal("refund"), amount: SafeAmountSchema.positive() }),
])}).superRefine((event, ctx) => {
  if ((event.unit === "minor_currency") !== (event.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Event currency must match unit" });
});
export type ReconciliationEvidence = z.infer<typeof ReconciliationEvidenceSchema>;

export const ReservationAccountingSchema = z.strictObject({
  knownGrossActual: SafeAmountSchema.nullable(), refundTotal: SafeAmountSchema,
  netKnownActual: SafeAmountSchema.nullable(), settled: z.boolean(), released: z.boolean(),
  unresolvedLiability: SafeAmountSchema, totalLiability: SafeAmountSchema, overrun: z.boolean(), reconciliationConflict: z.boolean(),
}).superRefine((accounting, ctx) => {
  if ((accounting.knownGrossActual === null) !== (accounting.netKnownActual === null)) ctx.addIssue({ code: "custom", path: ["netKnownActual"], message: "Known gross and net actual must be known together" });
  if (accounting.knownGrossActual === null && accounting.refundTotal > 0) ctx.addIssue({ code: "custom", path: ["refundTotal"], message: "Refunds require known gross actual" });
  if (accounting.knownGrossActual !== null && accounting.netKnownActual !== null && accounting.knownGrossActual - accounting.refundTotal !== accounting.netKnownActual) ctx.addIssue({ code: "custom", path: ["netKnownActual"], message: "Net actual must equal gross less refunds" });
  if (accounting.settled && accounting.unresolvedLiability !== 0) ctx.addIssue({ code: "custom", path: ["unresolvedLiability"], message: "Settled reservations have no unresolved liability" });
  if (accounting.released && !accounting.settled) ctx.addIssue({ code: "custom", path: ["released"], message: "Released reservations are settled" });
  if (accounting.settled && accounting.knownGrossActual === null && !accounting.released) ctx.addIssue({ code: "custom", path: ["released"], message: "Settlement without known actual requires confirmed release" });
  if (accounting.released && accounting.knownGrossActual !== null && accounting.knownGrossActual > 0) ctx.addIssue({ code: "custom", path: ["released"], message: "Positive actual cannot remain released" });
});
export type ReservationAccountingRecord = z.infer<typeof ReservationAccountingSchema>;

export const QuoteSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  operation: z.enum(["anchor", "take", "speech", "music"]),
  inputHash: Sha256Schema,
  entitlement: EntitlementSchema,
  estimateMinMinor: z.number().int().safe().nonnegative().nullable(),
  estimateMaxMinor: z.number().int().safe().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  expiresAt: UtcMillisSchema,
  withinAuthorizedCap: z.enum(["yes", "no", "unknown"]),
  createdAt: UtcMillisSchema,
});
export type ProductionQuote = z.infer<typeof QuoteSchema>;

export const CapabilityProvenanceSchema = z.enum(["live_catalog", "sdk_contract", "curated_fallback", "unknown"]);
export const CapabilityReceiptSchema = z.strictObject({
  version: SchemaVersionSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  provenance: CapabilityProvenanceSchema,
  observedAt: UtcMillisSchema,
  expiresAt: UtcMillisSchema.nullable(),
  supportedOperations: z.array(z.enum(["image", "video", "speech", "music", "vision"])).max(5),
  aspectRatios: z.array(z.enum(["1:1", "9:16", "16:9", "4:3", "3:4"])).max(5),
  maxReferenceImages: z.number().int().safe().nonnegative().nullable(),
  supportsStartFrame: z.boolean().nullable(),
  supportsEndFrame: z.boolean().nullable(),
  supportsContextImages: z.boolean().nullable(),
  supportsTimedKeyframes: z.boolean().nullable(),
  minFrames: PositiveFramesSchema.nullable(),
  maxFrames: PositiveFramesSchema.nullable(),
  frameStep: PositiveFramesSchema.nullable(),
  supportsNativeAudio: z.boolean().nullable(),
});
export type CapabilityReceipt = z.infer<typeof CapabilityReceiptSchema>;

export const HonoredInputItemSchema = z.strictObject({
  role: IdSchema,
  assetId: IdSchema,
  required: z.boolean(),
  state: z.enum(["mapped", "acknowledged", "rejected", "unknown"]),
  providerField: z.string().max(200).nullable(),
  disclosedOmission: z.string().max(1000).nullable(),
});
export const HonoredInputsReceiptSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  jobId: IdSchema,
  capabilityProvenance: CapabilityProvenanceSchema,
  capabilityObservedAt: UtcMillisSchema,
  inputs: z.array(HonoredInputItemSchema).max(100),
  createdAt: UtcMillisSchema,
});
export type HonoredInputsReceipt = z.infer<typeof HonoredInputsReceiptSchema>;

/* API DTOs: every request is strict and contains no server-authored result fields. */
const CursorSchema = z.string().max(1000).nullable();
export const SupportedStorageSchemaVersionSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]);
export const HealthResponseSchema = z.strictObject({
  schemaVersion: SupportedStorageSchemaVersionSchema,
  storage: z.enum(["ready", "degraded", "unavailable"]),
  worker: z.strictObject({ available: z.boolean(), heartbeatAgeMs: z.number().int().safe().nonnegative().nullable() }),
});
export const ListProjectsQuerySchema = z.strictObject({ cursor: CursorSchema, limit: z.number().int().safe().min(1).max(24) });
export const ProjectSummarySchema = z.strictObject({
  id: IdSchema, name: z.string().min(1), profileId: IdSchema, updatedAt: UtcMillisSchema,
  stage: z.enum(["setup", "canon", "script", "shots", "anchors", "takes", "audio", "export", "complete"]),
  saveVersion: z.number().int().safe().positive(),
});
export const ProjectListResponseSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema).max(24), nextCursor: CursorSchema,
});
export const GetProjectQuerySchema = z.strictObject({ projectId: IdSchema });
/** Derived response v2; persisted revision records remain v1. */
export const DependencyIssueSchema = z.strictObject({
  targetKind: z.enum(["story", "shotplan", "animatic", "shot", "audio"]),
  targetId: IdSchema,
  dependencyKind: z.enum(["canon", "story", "shot", "continuation"]),
  pinnedDependencyId: IdSchema,
  activeDependencyId: IdSchema.nullable(),
  code: z.enum(["DEPENDENCY_REPLACED", "STORY_CHANGED", "DEPENDENCY_MISSING"]),
});
export type DependencyIssue = z.infer<typeof DependencyIssueSchema>;
export const ProjectReadModelSchema = z.strictObject({
  schemaVersion: z.literal(2),
  dependencyIssues: z.array(DependencyIssueSchema).max(100_000),
  revisionApprovals: z.array(ApprovalSchema).max(100_000),
  project: ProjectSchema,
  canonRevisions: z.array(CanonRevisionSchema).max(500),
  storyRevision: StoryRevisionSchema.nullable(),
  shotPlanRevision: ShotPlanRevisionSchema.nullable(),
  animaticRevision: AnimaticRevisionSchema.nullable(),
  audioMixRevision: AudioMixRevisionSchema.nullable(),
  shots: z.array(z.strictObject({
    shotRevision: ShotRevisionSchema,
    selectedAnchor: AnchorCandidateSchema.nullable(),
    selectedTake: TakeSchema.nullable(),
    takeSelection: z.strictObject({ takeId: NullableIdSchema, version: z.number().int().safe().nonnegative() }),
    anchorHistory: z.array(AnchorCandidateSchema).max(100_000),
    takeHistory: z.array(TakeSchema).max(100_000),
    approvals: z.array(ApprovalSchema).max(100_000),
  })).max(10_000),
  activeJobs: z.array(JobSchema).max(1000),
  jobs: z.array(JobSchema).max(100_000),
  exports: z.array(ExportSchema).max(1000),
});
export const CapabilitiesQuerySchema = z.strictObject({ providerModelIds: z.array(IdSchema).min(1).max(100) });
export const CapabilitiesResponseSchema = z.strictObject({ receipts: z.array(CapabilityReceiptSchema).max(100) });

export const CreateQuoteCommandSchema = z.strictObject({
  projectId: IdSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  operation: z.enum(["anchor", "take", "speech", "music"]),
  inputSnapshot: z.strictObject({
    revisionIds: z.array(IdSchema).max(100),
    assetIds: z.array(IdSchema).max(100),
    parameters: z.strictObject({
      aspect: z.enum(["9:16", "16:9"]).optional(),
      resolution: z.enum(["480p", "720p", "1080p"]).optional(),
      frameCount: PositiveFramesSchema.optional(),
      durationFrames: PositiveFramesSchema.optional(),
      seed: z.number().int().safe().nonnegative().nullable().optional(),
      textLength: z.number().int().safe().nonnegative().max(4096).optional(),
      audioDurationSamples: PositiveSamplesSchema.max(48_000 * 60 * 60).optional(),
    }),
  }),
});

export const ProviderResultTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("anchor"), shotRevisionId: IdSchema, inputsHash: Sha256Schema }),
  z.strictObject({ kind: z.literal("take"), shotRevisionId: IdSchema, anchorId: IdSchema, anchorApprovalId: IdSchema, inputsHash: Sha256Schema }),
]);
/** One resolved continuity-state field plus the layer that supplied it (M4 audit stamp). */
export const ResolvedStateFieldSchema = z.strictObject({
  field: z.string().min(1).max(64),
  value: JsonValueSchema,
  layer: z.enum(["canon", "production", "scene", "shot"]),
});
export type ResolvedStateField = z.infer<typeof ResolvedStateFieldSchema>;
/**
 * Structured record of the character/environment states composed into this request's prompt:
 * which scene resolved, and which layer supplied each field (canon -> production -> scene -> shot).
 * Absent for jobs created before state propagation or without any state content; retries that
 * rewrite the prompt carry an inherited stamp forward unchanged.
 */
export const ResolvedStatesStampSchema = z.strictObject({
  version: z.literal(1),
  sceneId: NullableIdSchema,
  characters: z.array(z.strictObject({
    characterCanonRevisionId: IdSchema,
    fields: z.array(ResolvedStateFieldSchema).max(64),
  })).max(10),
  environment: z.strictObject({
    environmentCanonRevisionId: IdSchema,
    fields: z.array(ResolvedStateFieldSchema).max(64),
  }).nullable(),
});
export type ResolvedStatesStamp = z.infer<typeof ResolvedStatesStampSchema>;
export const ProviderRequestSnapshotSchema = z.strictObject({
  projectId: IdSchema,
  jobId: IdSchema,
  idempotencyKey: IdSchema,
  quoteId: IdSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  prompt: z.string().max(100_000),
  inputs: z.array(z.strictObject({ assetId: IdSchema, role: z.string().min(1).max(200), required: z.boolean() })).max(100),
  parameters: z.record(z.string(), JsonValueSchema),
  resultTarget: ProviderResultTargetSchema.optional(),
  billingMode: z.enum(["subscription", "tokens"]).optional(),
  /** Additive optional (C7): continuity-state resolution stamp; see {@link ResolvedStatesStampSchema}. */
  resolvedStates: ResolvedStatesStampSchema.optional(),
});
export const CreateProjectCommandSchema = z.strictObject({ name: z.string().trim().min(1).max(160), profileId: IdSchema });
export const CreateCanonRevisionCommandSchema = z.strictObject({
  projectId: IdSchema, entityId: IdSchema, expectedRevisionId: NullableIdSchema,
  entityKind: CanonEntityKindSchema, description: NonEmptyTextSchema,
  attributes: z.record(z.string(), JsonValueSchema), assetIds: z.array(IdSchema).max(100),
});
export const SelectCanonRevisionCommandSchema = z.strictObject({
  projectId: IdSchema,
  entityId: IdSchema,
  expectedRevisionId: NullableIdSchema,
  canonRevisionId: IdSchema,
});
export const UpdateProjectCommandSchema = z.strictObject({
  expectedSaveVersion: z.number().int().safe().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  profileId: IdSchema.optional(),
}).refine((value) => value.name !== undefined || value.profileId !== undefined, 'At least one project field is required');
export const CreateStoryRevisionCommandSchema = z.strictObject({
  projectId: IdSchema, expectedStoryRevisionId: NullableIdSchema, scriptText: z.string().max(500_000),
  beats: z.array(StoryBeatSchema.omit({ order: true })).min(1).max(10_000), canonRevisionIds: z.array(IdSchema).max(500),
});
export const CreateShotPlanCommandSchema = z.strictObject({
  projectId: IdSchema, storyRevisionId: IdSchema, approvedStoryHash: Sha256Schema,
  shots: z.array(z.strictObject({
    shotId: IdSchema, beatIds: z.array(IdSchema).min(1).max(100), visualIntent: NonEmptyTextSchema,
    motionIntent: NonEmptyTextSchema, castBindings: z.array(ShotCastBindingSchema).max(3),
    locationRevisionId: IdSchema, propRevisionIds: z.array(IdSchema).max(100),
    styleRevisionId: IdSchema, framing: ShotRevisionSchema.shape.framing, targetFrames: PositiveFramesSchema,
    continuation: ShotContinuationSchema.nullable(),
    /** Additive optional scene pin (C7); null/omitted falls back to order correspondence in the plan service. */
    sceneId: NullableIdSchema.optional(),
  })).min(1).max(10_000),
});
export const AnchorRenderSettingsSchema = z.strictObject({
  providerId: IdSchema, modelId: IdSchema, aspect: z.enum(["9:16", "16:9"]),
  resolution: z.enum(["480p", "720p", "1080p"]), seed: z.number().int().safe().nonnegative().nullable(),
  referenceAssetIds: z.array(IdSchema).max(100),
});
export const CreateAnchorCommandSchema = z.strictObject({
  projectId: IdSchema, shotRevisionId: IdSchema, quoteId: IdSchema,
  idempotencyKey: IdSchema, renderSettings: AnchorRenderSettingsSchema,
});
export const CreateApprovalCommandSchema = z.strictObject({
  targetKind: ApprovalTargetKindSchema, targetId: IdSchema, expectedHash: Sha256Schema,
  decision: z.enum(["approved", "rejected"]), checklist: z.array(ApprovalChecklistItemSchema).max(100),
  notes: z.string().max(10_000), advisoryAcknowledgements: z.array(z.strictObject({ code: IdSchema, reason: NonEmptyTextSchema })).max(100),
}).superRefine((command, ctx) => {
  if (command.decision === "approved" && command.checklist.length === 0) {
    ctx.addIssue({ code: "custom", path: ["checklist"], message: "Approved decisions require a nonempty checklist" });
  }
  if (command.decision === "approved" && command.checklist.some((item) => !item.passed)) {
    ctx.addIssue({ code: "custom", path: ["checklist"], message: "An approval cannot include failed required checklist items" });
  }
});
export const MotionSettingsSchema = z.strictObject({
  providerId: IdSchema, modelId: IdSchema, prompt: NonEmptyTextSchema,
  targetFrames: PositiveFramesSchema, aspect: z.enum(["9:16", "16:9"]), seed: z.number().int().safe().nonnegative().nullable(),
});
export const CreateTakeCommandSchema = z.strictObject({
  projectId: IdSchema, shotRevisionId: IdSchema, anchorId: IdSchema, approvalId: IdSchema,
  quoteId: IdSchema, idempotencyKey: IdSchema, motionSettings: MotionSettingsSchema,
  /** C9/C15: set by retry flows (Try Again / Different Take / guided re-roll); null on first runs. */
  retryOf: NullableIdSchema.optional(),
});
export const SelectTakeCommandSchema = z.strictObject({
  projectId: IdSchema, shotRevisionId: IdSchema, takeId: NullableIdSchema,
  expectedSelectionVersion: z.number().int().safe().nonnegative(),
});
export const ImportAssetMetadataSchema = z.strictObject({
  kind: z.enum(["image", "audio", "video"]), mime: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  byteSize: z.number().int().safe().positive(), source: NonEmptyTextSchema.max(1000),
  rightsAttestation: NonEmptyTextSchema.max(4000),
}).superRefine((x, ctx) => {
  const allowed: Record<string, readonly string[]> = {
    image: ["image/png", "image/jpeg", "image/webp"],
    audio: ["audio/wav", "audio/mpeg", "audio/aac", "audio/flac", "audio/x-wav"],
    video: ["video/mp4", "video/quicktime"],
  };
  const cap = x.kind === "video" ? 2 * 1024 * 1024 * 1024 : 100 * 1024 * 1024;
  if (!allowed[x.kind].includes(x.mime)) ctx.addIssue({ code: "custom", path: ["mime"], message: "MIME type is not allowed for this asset kind" });
  if (x.byteSize > cap) ctx.addIssue({ code: "custom", path: ["byteSize"], message: "Asset exceeds the configured upload size limit" });
});
export const SaveAudioMixCommandSchema = z.strictObject({
  projectId: IdSchema, expectedAudioVersion: z.number().int().safe().nonnegative(),
  expectedStoryRevisionId: IdSchema, cues: z.array(z.strictObject({
    assetId: IdSchema,
    sourceStartSample: SampleIndexSchema,
    sourceEndSample: PositiveSamplesSchema,
    timelineStartSample: SampleIndexSchema,
    gainDb: z.number().finite().min(-60).max(12),
    role: AudioRoleSchema,
    scriptSegmentId: NullableIdSchema,
    sourceText: z.string().max(20_000).nullable(),
    sourceRights: z.enum(["creator_attested", "licensed", "public_domain", "provider", "unknown"]),
  }).refine((cue) => cue.sourceEndSample > cue.sourceStartSample, {
    path: ["sourceEndSample"], message: "sourceEndSample must follow sourceStartSample",
  }).refine(hasSafeCueTimelineEnd, {
    path: ["timelineStartSample"], message: "derived timeline end sample must be a safe integer",
  })).max(100_000),
  mixSettings: AudioMixSettingsSchema,
});
export const CreateManifestCommandSchema = z.strictObject({
  projectId: IdSchema, shotPlanRevisionId: IdSchema, animaticRevisionId: IdSchema,
  audioMixRevisionId: NullableIdSchema, selectedTakeIds: z.array(IdSchema).min(1).max(10_000),
  profileId: IdSchema, expectedSelectionVersion: z.number().int().safe().nonnegative(),
});
export const CreateExportCommandSchema = z.strictObject({
  projectId: IdSchema, manifestId: IdSchema, expectedManifestHash: Sha256Schema, idempotencyKey: IdSchema,
});
export const DraftDownloadQuerySchema = z.strictObject({ exportId: IdSchema });
export const FinalDownloadQuerySchema = z.strictObject({ exportId: IdSchema });
export const GetJobQuerySchema = z.strictObject({ jobId: IdSchema, sinceEvent: z.number().int().safe().nonnegative().optional() });
export const JobEventSchema = z.strictObject({
  sequence: z.number().int().safe().positive(), at: UtcMillisSchema, status: JobStatusSchema,
  message: z.string().max(2000), progress: z.number().finite().min(0).max(100).nullable(),
});
export const JobReadModelSchema = z.strictObject({
  job: JobSchema, events: z.array(JobEventSchema).max(10_000), recoveryAction: z.string().max(1000).nullable(),
});

export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;
export type ProjectReadModel = z.infer<typeof ProjectReadModelSchema>;
export type CreateQuoteCommand = z.infer<typeof CreateQuoteCommandSchema>;
export type ProviderResultTarget = z.infer<typeof ProviderResultTargetSchema>;
export type ProviderRequestSnapshot = z.infer<typeof ProviderRequestSnapshotSchema>;
export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type CreateCanonRevisionCommand = z.infer<typeof CreateCanonRevisionCommandSchema>;
export type SelectCanonRevisionCommand = z.infer<typeof SelectCanonRevisionCommandSchema>;
export type UpdateProjectCommand = z.infer<typeof UpdateProjectCommandSchema>;
export type CreateStoryRevisionCommand = z.infer<typeof CreateStoryRevisionCommandSchema>;
export type CreateShotPlanCommand = z.infer<typeof CreateShotPlanCommandSchema>;
export type CreateAnchorCommand = z.infer<typeof CreateAnchorCommandSchema>;
export type CreateApprovalCommand = z.infer<typeof CreateApprovalCommandSchema>;
export type CreateTakeCommand = z.infer<typeof CreateTakeCommandSchema>;
export type SelectTakeCommand = z.infer<typeof SelectTakeCommandSchema>;
export type ImportAssetMetadata = z.infer<typeof ImportAssetMetadataSchema>;
export type SaveAudioMixCommand = z.infer<typeof SaveAudioMixCommandSchema>;
export type CreateManifestCommand = z.infer<typeof CreateManifestCommandSchema>;
export type CreateExportCommand = z.infer<typeof CreateExportCommandSchema>;

/* Wave-0 shared contracts (CONTRACTS-FROZEN C2-C9, C13). */

export const ApprovalStateSchema = z.enum(["draft", "recommended", "approved"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const WorldBibleEntrySchema = z.strictObject({
  id: IdSchema,
  title: NonEmptyTextSchema.max(200),
  body: NonEmptyTextSchema.max(20_000),
  tags: z.array(z.string()).max(20),
});
export type WorldBibleEntry = z.infer<typeof WorldBibleEntrySchema>;
/** World Bible version bumps only through an explicit save command; it is content, not prose-prompt. */
export const WorldBibleSchema = z.strictObject({
  version: z.number().int().safe().positive(),
  summary: z.string().max(20_000),
  entries: z.array(WorldBibleEntrySchema).max(500),
});
export type WorldBible = z.infer<typeof WorldBibleSchema>;

export const ProductionRecipeSchema = z.strictObject({
  version: z.number().int().safe().positive(),
  qualityStrategy: z.enum(["economy", "balanced", "best"]),
  aspectRatio: z.enum(["16:9", "9:16"]),
  language: z.string().trim().min(2).max(35),
  defaultShotTargetFrames: PositiveFramesSchema,
});
export type ProductionRecipe = z.infer<typeof ProductionRecipeSchema>;

export const WorkspaceSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  name: NonEmptyTextSchema.max(160),
  /** Canon ENTITY ids (not revision ids). */
  characterCanonIds: z.array(IdSchema).max(200),
  environmentCanonIds: z.array(IdSchema).max(200),
  styleCanonIds: z.array(IdSchema).max(50),
  worldBible: WorldBibleSchema,
  productionRecipe: ProductionRecipeSchema,
  rating: z.enum(["General", "Mature", "Adult"]),
  /** Links to the existing budget_policies table. */
  budgetPolicyId: NullableIdSchema,
  createdAt: UtcMillisSchema,
  updatedAt: UtcMillisSchema,
  /** Optimistic concurrency, same semantics as Project.saveVersion. */
  saveVersion: z.number().int().safe().positive(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Immutable pinning of canon REVISION ids at production creation; workspace edits affect new productions only. */
export const ProductionSnapshotSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  workspaceId: IdSchema,
  characterRevisionIds: z.array(IdSchema).max(200),
  environmentRevisionIds: z.array(IdSchema).max(200),
  styleRevisionIds: z.array(IdSchema).max(50),
  recipeVersion: z.number().int().safe().positive(),
  worldBibleVersion: z.number().int().safe().positive(),
  createdAt: UtcMillisSchema,
});
export type ProductionSnapshot = z.infer<typeof ProductionSnapshotSchema>;

export const CharacterStateSchema = z.strictObject({
  characterCanonRevisionId: IdSchema,
  outfit: NonEmptyTextSchema.max(500).optional(),
  hairState: NonEmptyTextSchema.max(500).optional(),
  accessories: z.array(z.string()).max(20),
  carriedObjects: z.array(z.string()).max(20),
  condition: z.array(z.string()).max(20),
  agePresentation: NonEmptyTextSchema.max(200).optional(),
  notes: NonEmptyTextSchema.max(2000).optional(),
});
export type CharacterState = z.infer<typeof CharacterStateSchema>;

export const EnvironmentStateSchema = z.strictObject({
  environmentCanonRevisionId: IdSchema,
  zone: NonEmptyTextSchema.max(200).optional(),
  lighting: NonEmptyTextSchema.max(200).optional(),
  timeOfDay: NonEmptyTextSchema.max(200).optional(),
  weather: NonEmptyTextSchema.max(200).optional(),
  persistentProps: z.array(z.string()).max(50),
});
export type EnvironmentState = z.infer<typeof EnvironmentStateSchema>;

export const SceneDialogueLineSchema = z.strictObject({
  characterCanonRevisionId: IdSchema,
  text: VerbatimTextSchema.max(20_000),
});
export type SceneDialogueLine = z.infer<typeof SceneDialogueLineSchema>;
/** Scene.shotIds are DERIVED (shots whose sceneId equals this scene id, ordered by order); never authored directly. */
export const SceneSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  storyRevisionId: NullableIdSchema,
  order: z.number().int().safe().nonnegative(),
  title: NonEmptyTextSchema.max(200),
  action: NonEmptyTextSchema.max(20_000),
  dialogue: z.array(SceneDialogueLineSchema).max(100),
  durationTargetMs: UtcMillisSchema.nullable(),
  characterStates: z.array(CharacterStateSchema).max(10),
  environmentState: EnvironmentStateSchema.nullable(),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
});
export type Scene = z.infer<typeof SceneSchema>;

export const CreateWorkspaceCommandSchema = z.strictObject({
  name: WorkspaceSchema.shape.name,
  characterCanonIds: WorkspaceSchema.shape.characterCanonIds,
  environmentCanonIds: WorkspaceSchema.shape.environmentCanonIds,
  styleCanonIds: WorkspaceSchema.shape.styleCanonIds,
  worldBible: WorldBibleSchema,
  productionRecipe: ProductionRecipeSchema,
  rating: WorkspaceSchema.shape.rating,
  budgetPolicyId: NullableIdSchema,
});
export type CreateWorkspaceCommand = z.infer<typeof CreateWorkspaceCommandSchema>;

export const UpdateWorkspaceCommandSchema = z.strictObject({
  expectedSaveVersion: z.number().int().safe().positive(),
  name: WorkspaceSchema.shape.name.optional(),
  characterCanonIds: WorkspaceSchema.shape.characterCanonIds.optional(),
  environmentCanonIds: WorkspaceSchema.shape.environmentCanonIds.optional(),
  styleCanonIds: WorkspaceSchema.shape.styleCanonIds.optional(),
  worldBible: WorldBibleSchema.optional(),
  productionRecipe: ProductionRecipeSchema.optional(),
  rating: WorkspaceSchema.shape.rating.optional(),
  budgetPolicyId: NullableIdSchema.optional(),
}).refine((value) => value.name !== undefined || value.characterCanonIds !== undefined || value.environmentCanonIds !== undefined ||
  value.styleCanonIds !== undefined || value.worldBible !== undefined || value.productionRecipe !== undefined ||
  value.rating !== undefined || value.budgetPolicyId !== undefined, "At least one workspace field is required");
export type UpdateWorkspaceCommand = z.infer<typeof UpdateWorkspaceCommandSchema>;

export const CreateProductionSnapshotCommandSchema = z.strictObject({
  projectId: IdSchema,
  workspaceId: IdSchema,
  characterRevisionIds: ProductionSnapshotSchema.shape.characterRevisionIds,
  environmentRevisionIds: ProductionSnapshotSchema.shape.environmentRevisionIds,
  styleRevisionIds: ProductionSnapshotSchema.shape.styleRevisionIds,
  recipeVersion: ProductionSnapshotSchema.shape.recipeVersion,
  worldBibleVersion: ProductionSnapshotSchema.shape.worldBibleVersion,
});
export type CreateProductionSnapshotCommand = z.infer<typeof CreateProductionSnapshotCommandSchema>;

export const UpsertSceneCommandSchema = SceneSchema.omit({ version: true, contentHash: true, createdAt: true });
export type UpsertSceneCommand = z.infer<typeof UpsertSceneCommandSchema>;

export const ListScenesQuerySchema = z.strictObject({ projectId: IdSchema, storyRevisionId: NullableIdSchema });
export type ListScenesQuery = z.infer<typeof ListScenesQuerySchema>;

export const WorkspaceListResponseSchema = z.strictObject({ workspaces: z.array(WorkspaceSchema).max(10_000) });
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;
export const SceneListResponseSchema = z.strictObject({ scenes: z.array(SceneSchema).max(10_000) });
export type SceneListResponse = z.infer<typeof SceneListResponseSchema>;

// ── C17. Auto Draft run state machine (spec 14, M5) ──────────────────────────

export const AutoRunStageKindSchema = z.enum(["story", "storyboard", "anchors", "takes", "audio", "assembly"]);
export type AutoRunStageKind = z.infer<typeof AutoRunStageKindSchema>;
export const AutoRunStageStateSchema = z.enum(["pending", "queued", "running", "completed", "failed", "canceled", "skipped"]);
export type AutoRunStageState = z.infer<typeof AutoRunStageStateSchema>;
export const AutoRunStageSchema = z.strictObject({
  id: IdSchema,
  kind: AutoRunStageKindSchema,
  state: AutoRunStageStateSchema,
  order: z.number().int().safe().nonnegative(),
  /** Per-scene lanes carry their scene; null for whole-production stages. */
  sceneId: NullableIdSchema,
  /** Produced artifact id once known (story revision, shot plan, job id, export id). */
  targetId: NullableIdSchema,
  childJobIds: z.array(IdSchema).max(10_000),
  error: z.string().max(4000).nullable(),
  startedAt: UtcMillisSchema.nullable(),
  completedAt: UtcMillisSchema.nullable(),
});
export type AutoRunStage = z.infer<typeof AutoRunStageSchema>;
export const AutoRunStateSchema = z.enum(["awaiting_confirmation", "running", "awaiting_review", "completed", "failed", "canceled"]);
export type AutoRunState = z.infer<typeof AutoRunStateSchema>;
export const AutoRunEstimatedCostSchema = z.strictObject({
  currency: z.literal("USD"),
  minMicros: z.number().int().safe().nonnegative(),
  maxMicros: z.number().int().safe().nonnegative(),
}).refine((x) => x.maxMicros >= x.minMicros, { path: ["maxMicros"], message: "maxMicros must be >= minMicros" });
export type AutoRunEstimatedCost = z.infer<typeof AutoRunEstimatedCostSchema>;
export const AutoRunSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  idea: VerbatimTextSchema.max(5000),
  durationTargetMs: UtcMillisSchema,
  qualityStrategy: z.enum(["economy", "balanced", "best"]),
  state: AutoRunStateSchema,
  stages: z.array(AutoRunStageSchema).min(1).max(1000),
  estimatedCost: AutoRunEstimatedCostSchema.nullable(),
  /** Optimistic concurrency, same discipline as workspaces. */
  saveVersion: z.number().int().safe().positive(),
  confirmedAt: UtcMillisSchema.nullable(),
  createdAt: UtcMillisSchema,
  updatedAt: UtcMillisSchema,
});
export type AutoRun = z.infer<typeof AutoRunSchema>;
export const CreateAutoRunCommandSchema = AutoRunSchema.omit({ version: true, id: true, state: true, stages: true, estimatedCost: true, saveVersion: true, confirmedAt: true, createdAt: true, updatedAt: true });
export type CreateAutoRunCommand = z.infer<typeof CreateAutoRunCommandSchema>;
export const UpdateAutoRunCommandSchema = z.strictObject({
  id: IdSchema,
  saveVersion: z.number().int().safe().positive(),
  state: AutoRunStateSchema.optional(),
  stages: z.array(AutoRunStageSchema).min(1).max(1000).optional(),
  estimatedCost: AutoRunEstimatedCostSchema.nullable().optional(),
  confirmedAt: UtcMillisSchema.nullable().optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), { message: "At least one auto-run field is required" });
export type UpdateAutoRunCommand = z.infer<typeof UpdateAutoRunCommandSchema>;

// ── C19. Product metric events (spec 01 §7 / 17, M4) ─────────────────────────

export const MetricEventKindSchema = z.enum([
  "story_proposal_completed",
  "storyboard_completed",
  "first_cut_completed",
  "generation_completed",
  "generation_failed",
  "asset_recommended",
  "asset_approved",
  "export_completed",
  "review_completed",
]);
export type MetricEventKind = z.infer<typeof MetricEventKindSchema>;
export const MetricEventSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: NullableIdSchema,
  workspaceId: NullableIdSchema,
  kind: MetricEventKindSchema,
  at: UtcMillisSchema,
  durationMs: UtcMillisSchema.nullable(),
  costMicros: z.number().int().safe().nonnegative().nullable(),
  /** Bounded free-form dimensions (e.g. assetKind=take, providerId=sogni); projections interpret these. */
  dims: z.record(z.string().max(60), z.string().max(200)).optional(),
});
export type MetricEvent = z.infer<typeof MetricEventSchema>;
export const RecordMetricEventCommandSchema = MetricEventSchema.omit({ version: true });
export type RecordMetricEventCommand = z.infer<typeof RecordMetricEventCommandSchema>;

// ── C20. Platform upload records (spec 15, M6; config-gated YouTube) ─────────

export const PlatformKindSchema = z.enum(["youtube"]);
export type PlatformKind = z.infer<typeof PlatformKindSchema>;
export const PlatformUploadStateSchema = z.enum(["queued", "running", "completed", "failed"]);
export type PlatformUploadState = z.infer<typeof PlatformUploadStateSchema>;
export const PlatformUploadRecordSchema = z.strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  projectId: IdSchema,
  platform: PlatformKindSchema,
  exportId: IdSchema,
  state: PlatformUploadStateSchema,
  privacy: z.enum(["public", "unlisted", "private"]),
  remoteVideoId: NullableIdSchema,
  remoteUrl: NullableIdSchema,
  error: z.string().max(4000).nullable(),
  createdAt: UtcMillisSchema,
  completedAt: UtcMillisSchema.nullable(),
});
export type PlatformUploadRecord = z.infer<typeof PlatformUploadRecordSchema>;
