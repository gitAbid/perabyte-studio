import projectFixture from "../../docs/production/fixtures/project.json";
import storyFixture from "../../docs/production/fixtures/story.json";
import shotPlanFixture from "../../docs/production/fixtures/shot-plan.json";
import * as C from "./contracts";
import { ProductionApplicationError, ProductionErrorEnvelopeSchema } from "./errors";
import type { ProductionStore } from "../repositories/production/ports";
import { describe, expect, it } from "vitest";

const digest = "a".repeat(64);
declare const productionStore: ProductionStore;
if (false) {
  // @ts-expect-error transaction callbacks cannot perform asynchronous work
  productionStore.transaction(async () => undefined);
}

describe("v1 production records", () => {
  it("parses strict provider request snapshots with optional result and billing targets", () => {
    const base = {
      projectId: "project_1", jobId: "job_1", idempotencyKey: "idem_1", quoteId: "quote_1",
      providerId: "provider_1", modelId: "model_1", prompt: "Generate a frame",
      inputs: [{ assetId: "asset_1", role: "reference", required: true }], parameters: { seed: 4, nested: { ok: true } },
    };
    expect(C.ProviderRequestSnapshotSchema.safeParse(base).success).toBe(true);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, resultTarget: { kind: "anchor", shotRevisionId: "shotrev_1", inputsHash: digest }, billingMode: "tokens" }).success).toBe(true);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, resultTarget: { kind: "take", shotRevisionId: "shotrev_1", anchorId: "anchor_1", anchorApprovalId: "approval_1", inputsHash: digest }, billingMode: "subscription" }).success).toBe(true);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, resultTarget: { kind: "take", shotRevisionId: "shotrev_1", anchorId: "anchor_1", inputsHash: digest } }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, billingMode: "automatic" }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, surprise: true }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, inputs: [{ ...base.inputs[0], extra: true }] }).success).toBe(false);
  });

  it("bounds provider prompts and inputs without trimming the exact prompt", () => {
    const exactPrompt = "  A\u0301 exact prompt  ";
    const base = {
      projectId: "project_1", jobId: "job_1", idempotencyKey: "idem_1", quoteId: "quote_1",
      providerId: "provider_1", modelId: "model_1", prompt: exactPrompt,
      inputs: [{ assetId: "asset_1", role: "reference", required: true }], parameters: {},
    };
    const parsed = C.ProviderRequestSnapshotSchema.parse(base);
    expect(parsed.prompt).toBe(exactPrompt);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, prompt: "x".repeat(100_001) }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, inputs: Array.from({ length: 101 }, (_, index) => ({ assetId: `asset_${index}`, role: "reference", required: true })) }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, inputs: [{ ...base.inputs[0], role: "" }] }).success).toBe(false);
    expect(C.ProviderRequestSnapshotSchema.safeParse({ ...base, inputs: [{ ...base.inputs[0], role: "r".repeat(201) }] }).success).toBe(false);
  });

  it("versions the derived project read model without changing persisted records", () => {
    const readModel = { schemaVersion: 2, project: projectFixture, canonRevisions: [], storyRevision: null, shotPlanRevision: null, animaticRevision: null, audioMixRevision: null, revisionApprovals: [], shots: [], activeJobs: [], jobs: [], exports: [], dependencyIssues: [{ targetKind: "shot", targetId: "shot_1", dependencyKind: "canon", pinnedDependencyId: "canon_old", activeDependencyId: "canon_new", code: "DEPENDENCY_REPLACED" }] };
    expect(C.ProjectReadModelSchema.safeParse(readModel).success).toBe(true);
    expect(C.ProjectReadModelSchema.safeParse({ ...readModel, schemaVersion: 1 }).success).toBe(false);
    expect(C.ProjectReadModelSchema.safeParse({ ...readModel, dependencyIssues: [{ ...readModel.dependencyIssues[0], activeDependencyId: null, code: "DEPENDENCY_MISSING" }] }).success).toBe(true);
    expect(C.ProjectReadModelSchema.safeParse({ ...readModel, dependencyIssues: [{ ...readModel.dependencyIssues[0], code: "APPROVED" }] }).success).toBe(false);
    const { jobs: _jobs, ...readModelWithoutJobs } = readModel;
    expect(C.ProjectReadModelSchema.safeParse(readModelWithoutJobs).success).toBe(false);
    expect(ProductionErrorEnvelopeSchema.safeParse({ error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred.", retryable: false }, requestId: "request_1" }).success).toBe(true);
  });
  it("parses the golden project, story and shot-plan fixtures", () => {
    expect(C.ProjectSchema.safeParse(projectFixture).success).toBe(true);
    expect(C.StoryRevisionSchema.safeParse(storyFixture).success).toBe(true);
    expect(C.ShotPlanRevisionSchema.safeParse(shotPlanFixture).success).toBe(true);
  });

  it("rejects unknown nested record fields rather than stripping them", () => {
    const project = {
      ...projectFixture,
      profile: { ...projectFixture.profile, surprise: true },
    };
    expect(C.ProjectSchema.safeParse(project).success).toBe(false);

    const story = {
      ...storyFixture,
      beats: [{ ...storyFixture.beats[0], surprise: true }],
    };
    expect(C.StoryRevisionSchema.safeParse(story).success).toBe(false);
  });

  it("rejects malformed versions, timestamps, frame counts, samples and hashes", () => {
    expect(C.ProjectSchema.safeParse({ ...projectFixture, version: 2 }).success).toBe(false);
    expect(C.ProjectSchema.safeParse({ ...projectFixture, createdAt: 1.5 }).success).toBe(false);
    expect(C.AssetSchema.safeParse({
      id: "asset_1", sha256: "ABC", mime: "image/png", byteSize: 1,
      vaultRef: "asset_1", sourceKind: "upload", rightsStatus: "creator_attested",
    }).success).toBe(false);
    expect(C.ShotRevisionSchema.safeParse({
      id: "shotrev_1", shotId: "shot_1", storyRevisionId: "storyrev_1",
      beatIds: ["beat_1"], order: 0, visualIntent: "A scene", motionIntent: "Still",
      castBindings: [], locationRevisionId: "locationrev_1", propRevisionIds: [],
      styleRevisionId: "stylerev_1", framing: "wide", targetFrames: 0,
      continuation: null, contentHash: digest,
    }).success).toBe(false);
    expect(C.AudioCueSchema.safeParse({
      id: "cue_1", assetId: "asset_1", sourceStartSample: 10,
      sourceEndSample: 10, timelineStartSample: 0, gainDb: 0,
      role: "narration", scriptSegmentId: null,
    }).success).toBe(false);
  });

  it("accepts legacy assets without import provenance and validates strict provenance when present", () => {
    const asset = {
      version: 1, id: "asset_1", sha256: digest, mime: "image/png", byteSize: 1,
      vaultRef: "asset_1", width: null, height: null, frames: null, fps: null,
      audioSamples: null, sourceKind: "upload", sourceJobId: null,
      rightsStatus: "creator_attested", createdAt: 1,
    };
    expect(C.AssetSchema.safeParse(asset).success).toBe(true);
    const provenance = { source: "Creator upload", rightsAttestation: "I own the rights.", actorId: "user_1", createdAt: 1 };
    expect(C.AssetSchema.safeParse({ ...asset, importProvenance: provenance }).success).toBe(true);
    expect(C.AssetSchema.safeParse({ ...asset, importProvenance: { ...provenance, surprise: true } }).success).toBe(false);
    expect(C.AssetSchema.safeParse({ ...asset, importProvenance: { ...provenance, source: "" } }).success).toBe(false);
    expect(C.AssetSchema.safeParse({ ...asset, importProvenance: { ...provenance, rightsAttestation: "" } }).success).toBe(false);
  });

  it("preserves approved spoken text and rejects malformed stable IDs without rewriting", () => {
    expect(C.VerbatimTextSchema.parse("  Keep these exact words.  ")).toBe("  Keep these exact words.  ");
    expect(C.IdSchema.safeParse("stable_id-1").success).toBe(true);
    expect(C.IdSchema.safeParse(" stable_id-1 ").success).toBe(false);
  });

  it("accepts initial zero CAS versions and rejects negative or fractional versions", () => {
    expect(C.ProjectSchema.safeParse(projectFixture).success).toBe(true);
    expect(C.ProjectSchema.safeParse({ ...projectFixture, takeSelectionVersion: -1 }).success).toBe(false);
    expect(C.ProjectSchema.safeParse({ ...projectFixture, audioMixVersion: 0.5 }).success).toBe(false);
    const selection = { projectId: "project_1", shotRevisionId: "shotrev_1", takeId: null, expectedSelectionVersion: 0 };
    expect(C.SelectTakeCommandSchema.safeParse(selection).success).toBe(true);
    expect(C.SelectTakeCommandSchema.safeParse({ ...selection, expectedSelectionVersion: -1 }).success).toBe(false);
    expect(C.SelectTakeCommandSchema.safeParse({ ...selection, expectedSelectionVersion: 0.5 }).success).toBe(false);

    const audio = {
      projectId: "project_1", expectedAudioVersion: 0, expectedStoryRevisionId: "storyrev_1",
      cues: [], mixSettings: { sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true },
    };
    expect(C.SaveAudioMixCommandSchema.safeParse(audio).success).toBe(true);
    expect(C.SaveAudioMixCommandSchema.safeParse({ ...audio, expectedAudioVersion: -1 }).success).toBe(false);
    expect(C.SaveAudioMixCommandSchema.safeParse({ ...audio, expectedAudioVersion: 1.5 }).success).toBe(false);

    expect(C.CreateManifestCommandSchema.safeParse({
      projectId: "project_1", shotPlanRevisionId: "plan_1", animaticRevisionId: "animatic_1",
      audioMixRevisionId: null, selectedTakeIds: ["take_1"], profileId: "profile_1", expectedSelectionVersion: 0,
    }).success).toBe(true);
  });

  it("rejects audio cue timelines whose derived end sample is unsafe", () => {
    const cue = {
      id: "cue_1", assetId: "asset_1", sourceStartSample: 0, sourceEndSample: 1,
      timelineStartSample: Number.MAX_SAFE_INTEGER, gainDb: 0, role: "narration",
      scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested",
    } as const;
    expect(C.AudioCueSchema.safeParse(cue).success).toBe(false);
    const { id: _id, ...commandCue } = cue;
    expect(C.SaveAudioMixCommandSchema.safeParse({
      projectId: "project_1", expectedAudioVersion: 0, expectedStoryRevisionId: "story_1",
      cues: [commandCue], mixSettings: {
        sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14,
        truePeakLimitDbtp: -1, muteNativeAudio: true,
      },
    }).success).toBe(false);
  });

  it("strictly rejects caller-supplied server fields and unknown command fields", () => {
    expect(C.CreateProjectCommandSchema.safeParse({
      name: "Lantern", profile: projectFixture.profile,
      id: "forged_id", createdAt: 1, contentHash: digest,
    }).success).toBe(false);
    expect(C.CreateStoryRevisionCommandSchema.safeParse({
      projectId: "project_short", expectedStoryRevisionId: null,
      scriptText: "A small story", beats: [{ id: "b1", action: "Finds a lantern", narration: "A lantern." }],
      canonRevisionIds: [], extra: "must fail",
    }).success).toBe(false);
    expect(C.CreateApprovalCommandSchema.safeParse({
      targetKind: "anchor", targetId: "anchor_1", expectedHash: digest,
      decision: "approved", actorId: "forged_actor", receiptId: "forged_receipt",
      checklist: [], notes: "looks good",
    }).success).toBe(false);
  });

  it("accepts only defined approval targets and decisions", () => {
    for (const targetKind of ["story", "canon", "shotplan", "animatic", "anchor", "take", "audio", "final"]) {
      expect(C.ApprovalSchema.safeParse({
        version: 1, id: "approval_1", targetKind, targetId: "target_1", targetHash: digest,
        decision: "approved", actorId: "local_creator", createdAt: 1,
        checklist: [{ id: "reviewed", passed: true, note: "checked" }], notes: "reviewed", advisoryAcknowledgements: [],
      }).success).toBe(true);
    }
    expect(C.ApprovalSchema.safeParse({
      version: 1, id: "approval_1", targetKind: "job", targetId: "target_1", targetHash: digest,
      decision: "pending", actorId: "local_creator", createdAt: 1,
      checklist: [], notes: "", advisoryAcknowledgements: [],
    }).success).toBe(false);
  });

  it("requires a nonempty passed checklist for approved decisions, while rejection may be empty", () => {
    const base = {
      version: 1, id: "approval_1", targetKind: "anchor", targetId: "anchor_1", targetHash: digest,
      actorId: "local_creator", createdAt: 1, notes: "", advisoryAcknowledgements: [],
    } as const;
    expect(C.ApprovalSchema.safeParse({ ...base, decision: "approved", checklist: [] }).success).toBe(false);
    expect(C.ApprovalSchema.safeParse({ ...base, decision: "rejected", checklist: [] }).success).toBe(true);
    expect(C.CreateApprovalCommandSchema.safeParse({
      targetKind: "anchor", targetId: "anchor_1", expectedHash: digest,
      decision: "approved", checklist: [], notes: "", advisoryAcknowledgements: [],
    }).success).toBe(false);
  });

  it("enforces upload metadata type and architecture size bounds", () => {
    const base = { kind: "audio", source: "Creator upload", rightsAttestation: "I have rights", mime: "audio/wav" };
    expect(C.ImportAssetMetadataSchema.safeParse({ ...base, byteSize: 100 * 1024 * 1024 }).success).toBe(true);
    expect(C.ImportAssetMetadataSchema.safeParse({ ...base, byteSize: 100 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(C.ImportAssetMetadataSchema.safeParse({ ...base, kind: "audio", mime: "video/mp4", byteSize: 100 }).success).toBe(false);
    expect(C.ImportAssetMetadataSchema.safeParse({
      ...base, kind: "video", mime: "video/mp4", byteSize: 2 * 1024 * 1024 * 1024,
    }).success).toBe(true);
  });

  it("publishes a strict DTO for each architecture query and command", () => {
    const names = [
      "HealthResponseSchema", "ListProjectsQuerySchema", "ProjectSummarySchema",
      "GetProjectQuerySchema", "ProjectReadModelSchema", "CapabilitiesQuerySchema",
      "CapabilityReceiptSchema", "CreateQuoteCommandSchema", "QuoteSchema",
      "CreateProjectCommandSchema", "UpdateProjectCommandSchema", "CreateCanonRevisionCommandSchema", "SelectCanonRevisionCommandSchema",
      "CreateStoryRevisionCommandSchema", "CreateShotPlanCommandSchema",
      "CreateAnchorCommandSchema", "CreateApprovalCommandSchema", "CreateTakeCommandSchema",
      "SelectTakeCommandSchema", "ImportAssetMetadataSchema", "SaveAudioMixCommandSchema",
      "CreateManifestCommandSchema", "CreateExportCommandSchema", "DraftDownloadQuerySchema",
      "FinalDownloadQuerySchema", "GetJobQuerySchema", "JobReadModelSchema",
    ] as const;
    for (const name of names) expect(C[name]).toBeDefined();

    expect(C.CreateExportCommandSchema.safeParse({
      manifestId: "manifest_1", expectedManifestHash: digest, idempotencyKey: "export-1",
      finalApprovalId: "forged_approval",
    }).success).toBe(false);
    expect(C.FinalDownloadQuerySchema.safeParse({
      exportId: "export_1", checksum: digest, approved: true,
    }).success).toBe(false);
    expect(C.DraftDownloadQuerySchema.safeParse({ exportId: "export_1" }).success).toBe(true);
    expect(C.SelectCanonRevisionCommandSchema.safeParse({ projectId: "project_1", entityId: "hero", expectedRevisionId: null, canonRevisionId: "canon_1" }).success).toBe(true);
    expect(C.SelectCanonRevisionCommandSchema.safeParse({ projectId: "project_1", entityId: "hero", expectedRevisionId: null, canonRevisionId: "canon_1", approvalId: "forged" }).success).toBe(false);
    expect(C.CreateCanonRevisionCommandSchema.safeParse({ projectId: "project_1", entityId: "hero", expectedRevisionId: null, entityKind: "character", description: "Hero", attributes: {}, assetIds: [], contentHash: digest }).success).toBe(false);
  });

  it("keeps provider, vision and export acceptance states advisory and fail-closed", () => {
    expect(C.VisionAssessmentSchema.safeParse({ status: "unavailable", summary: "offline" }).success).toBe(true);
    expect(C.VisionAssessmentSchema.safeParse({ status: "exhausted", summary: "quota" }).success).toBe(true);
    expect(C.ExportSchema.safeParse({
      version: 1, id: "export_1", manifestId: "manifest_1", jobId: null, assetId: null,
      qcReportId: null, status: "ready_for_review", createdAt: 1,
      approvedSha256: null, finalApprovalId: null,
    }).success).toBe(true);
    expect(C.ExportSchema.safeParse({
      version: 1, id: "export_1", manifestId: "manifest_1", jobId: null, assetId: "asset_1",
      qcReportId: "qc_1", status: "upload_ready", createdAt: 1,
      approvedSha256: digest, finalApprovalId: null,
    }).success).toBe(false);
  });

  it("emits only stable structured production errors", () => {
    const error = new ProductionApplicationError("APPROVAL_REQUIRED", "Approve this anchor first", {
      field: "anchorId", shotId: "shot_1", action: "review_anchor", retryable: false,
    });
    const envelope = error.toEnvelope("request_1");
    expect(ProductionErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.error.code).toBe("APPROVAL_REQUIRED");
    expect(ProductionErrorEnvelopeSchema.safeParse({
      ...envelope, error: { ...envelope.error, code: "SOMETHING_ELSE" },
    }).success).toBe(false);
  });
});

describe("strict budget contract records", () => {
  const basePolicy = { schemaVersion: 1, revisionId: "policyrev_1", policyId: "policy_1", revision: 1, providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency", dailyCap: 1000, expiresAt: null, revoked: false, actorId: "creator_1", createdAt: 1 };
  const baseAuthorization = { schemaVersion: 1, revisionId: "authrev_1", authorizationId: "auth_1", revision: 1, projectId: "project_1", policyId: "policy_1", policyRevisionIdAtAuthorization: "policyrev_1", projectCap: 500, allowedModelIds: ["model_1"], allowedOperations: ["take", "text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator_1", createdAt: 1 };

  it("models stable policy and authorization identities as immutable strict revisions", () => {
    expect(C.AccountBudgetPolicySchema.safeParse(basePolicy).success).toBe(true);
    expect(C.AccountBudgetPolicySchema.safeParse({ ...basePolicy, accountId: "account_2" }).success).toBe(true);
    expect(C.AccountBudgetPolicySchema.safeParse({ ...basePolicy, dailyCap: null }).success).toBe(true);
    expect(C.AccountBudgetPolicySchema.safeParse({ ...basePolicy, dailyCap: 0 }).success).toBe(true);
    expect(C.AccountBudgetPolicySchema.safeParse({ ...basePolicy, createdAt: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(C.BudgetAuthorizationSchema.safeParse(baseAuthorization).success).toBe(true);
    expect(C.BudgetAuthorizationSchema.safeParse({ ...baseAuthorization, allowedOperations: ["render"] }).success).toBe(false);
    expect(C.BudgetAuthorizationSchema.safeParse({ ...baseAuthorization, allowedModelIds: ["model_1", "model_1"] }).success).toBe(false);
    expect(C.BudgetAuthorizationSchema.safeParse({ ...baseAuthorization, expectedPolicyVersion: 1 }).success).toBe(false);
  });

  it("keeps media quotes compatible while allowing a first-class text proposal budget quote", () => {
    const media = { version: 1, id: "quote_1", projectId: "project_1", providerId: "provider_1", modelId: "model_1", operation: "take", inputHash: digest, entitlement: "subscription", estimateMinMinor: 1, estimateMaxMinor: 2, currency: "USD", expiresAt: 500, withinAuthorizedCap: "yes", createdAt: 1 };
    expect(C.QuoteSchema.safeParse(media).success).toBe(true);
    const textQuote = { schemaVersion: 1, id: "budgetquote_1", projectId: "project_1", providerId: "provider_1", modelId: "model_1", operation: "text_proposal", inputHash: digest, estimateMin: 1, estimateMax: 2, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 1, expiresAt: 500, mediaQuoteId: null };
    expect(C.BudgetQuoteSchema.safeParse(textQuote).success).toBe(true);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, operation: "take", mediaQuoteId: "quote_1" }).success).toBe(true);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, estimateMin: 3 }).success).toBe(false);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, unit: "spark_token" }).success).toBe(false);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, unit: "unknown", currency: null }).success).toBe(true);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, expiresAt: 1 }).success).toBe(false);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, createdAt: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(C.BudgetQuoteSchema.safeParse({ ...textQuote, extra: "browser supplied billing" }).success).toBe(false);
  });

  it("rejects caller controlled billing facts and requires explicit manual provenance", () => {
    const command = { expectedAuthorizationRevision: null, expectedPolicyRevision: 1, policyId: "policy_1", projectCap: 100, allowedModelIds: ["model_1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator_1" };
    expect(C.AuthorizeBudgetCommandSchema.safeParse(command).success).toBe(true);
    expect(C.AuthorizeBudgetCommandSchema.safeParse({ ...command, revoked: true }).success).toBe(true);
    expect(C.AuthorizeBudgetCommandSchema.safeParse({ ...command, accountId: "account_1", actual: 0 }).success).toBe(false);
    const event = { schemaVersion: 1, eventKey: "event_1", reservationId: "reservation_1", providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency", observedAt: 2, source: "provider receipt", reference: "ref_1", provenance: { kind: "manual", actorId: "creator_1", decision: "reconciled", reason: "reviewed receipt" }, fact: { kind: "actual", cumulativeActual: 3, final: true } };
    expect(C.ReconciliationEvidenceSchema.safeParse(event).success).toBe(true);
    expect(C.ReconciliationEvidenceSchema.safeParse({ ...event, provenance: { kind: "manual", actorId: "creator_1", decision: "reconciled", reason: "" } }).success).toBe(false);
    expect(C.ReconciliationEvidenceSchema.safeParse({ ...event, fact: { kind: "nonbilling", confirmedNonacceptanceOrNonbilling: true }, actual: 0 }).success).toBe(false);
    expect(C.ReconciliationEvidenceSchema.safeParse({ ...event, fact: { kind: "actual", cumulativeActual: null, final: true } }).success).toBe(false);
  });

  it("pins complete execution identity and reservation UTC attribution", () => {
    const execution = { kind: "text_proposal", executionId: "proposal_request_1", operation: "text_proposal", projectId: "project_1", idempotencyKey: "idem_1", requestHash: digest, executionSemanticHash: "b".repeat(64), providerId: "provider_1", modelId: "model_1" };
    expect(C.BudgetExecutionSchema.safeParse(execution).success).toBe(true);
    expect(C.BudgetExecutionSchema.safeParse({ ...execution, modelId: undefined }).success).toBe(false);
    const reservedAt = Date.UTC(2026, 0, 1, 23);
    const record = { schemaVersion: 1, id: "reservation_1", execution, authorizationRevisionId: "authrev_1", policyRevisionId: "policyrev_1", budgetQuoteId: "budgetquote_1", quoteBindingId: "binding_1", accountEvidenceId: "evidence_1", providerId: "provider_1", accountId: "account_1", credentialBindingId: "credential_1", currency: "USD", unit: "minor_currency", upperEstimate: 0, reservedAt, utcDay: "2026-01-01" };
    expect(C.BudgetReservationSchema.safeParse(record).success).toBe(true);
    expect(C.BudgetReservationSchema.safeParse({ ...record, utcDay: "2026-01-02" }).success).toBe(false);
    expect(C.BudgetReservationSchema.safeParse({ ...record, reservedAt: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(C.BudgetReservationSchema.safeParse({ ...record, providerId: "provider_other" }).success).toBe(false);
  });

  it("bounds every budget timestamp to a four-digit UTC year", () => {
    expect(C.MAX_BUDGET_UTC_MILLIS).toBe(Date.UTC(9999, 11, 31, 23, 59, 59, 999));
    expect(C.BudgetUtcMillisSchema.safeParse(C.MAX_BUDGET_UTC_MILLIS).success).toBe(true);
    expect(C.BudgetUtcMillisSchema.safeParse(C.MAX_BUDGET_UTC_MILLIS + 1).success).toBe(false);
  });

  it("accepts only supported database schema versions in health responses", () => {
    const base = { storage: "ready", worker: { available: false, heartbeatAgeMs: null } };
    expect(C.HealthResponseSchema.safeParse({ ...base, schemaVersion: 1 }).success).toBe(true);
    expect(C.HealthResponseSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(true);
    expect(C.HealthResponseSchema.safeParse({ ...base, schemaVersion: 3 }).success).toBe(true);
    expect(C.HealthResponseSchema.safeParse({ ...base, schemaVersion: 4 }).success).toBe(true);
    expect(C.HealthResponseSchema.safeParse({ ...base, schemaVersion: 5 }).success).toBe(false);
  });
});
