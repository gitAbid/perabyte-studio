import { z } from "zod";
import { createHash } from "node:crypto";
import {
  AccountEvidenceSchema,
  BudgetExecutionSchema,
  BudgetQuoteSchema,
  BudgetUtcMillisSchema,
  CapabilityReceiptSchema,
  IdSchema,
  MAX_BUDGET_UTC_MILLIS,
  QuoteAccountBindingSchema,
  QuoteSchema,
  Sha256Schema,
} from "./contracts";
import { canonicalJson, hashCanonicalJson } from "./hash";

const RevisionSchema = z.number().int().safe().min(1);
const VersionTextSchema = z.string().min(1).max(80);
const CanonicalTextSchema = z.string().max(262_144).superRefine((value, ctx) => {
  if (Buffer.byteLength(value, "utf8") > 262_144) {
    ctx.addIssue({ code: "custom", message: "Canonical archive text exceeds its byte limit" });
    return;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== value) {
      ctx.addIssue({ code: "custom", message: "Archive text must be a canonical JSON object" });
    }
  } catch {
    ctx.addIssue({ code: "custom", message: "Archive text must be a canonical JSON object" });
  }
});
const ReviewCaptureSchema = z.string().min(1).max(65_536).refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, "Review capture exceeds its byte limit");
const ProducerEvidenceSchema = z.strictObject({ producerId: IdSchema, producerVersion: VersionTextSchema, sourceHash: Sha256Schema });
export const ProviderCredentialGenerationSchema = z.strictObject({
  schemaVersion: z.literal(1), providerId: IdSchema, revision: RevisionSchema, generationId: IdSchema,
  accountId: IdSchema, credentialFingerprint: Sha256Schema, changedAt: BudgetUtcMillisSchema,
});
export type ProviderCredentialGeneration = z.infer<typeof ProviderCredentialGenerationSchema>;
export const ProviderSessionSchema = z.strictObject({ sessionId: IdSchema, role: z.enum(["web", "worker", "probe"]), sdkVersion: VersionTextSchema, sdkSourceHash: Sha256Schema, adapterVersion: VersionTextSchema });
export type ProviderSession = z.infer<typeof ProviderSessionSchema>;
const SubscriptionObservationSchema = z.strictObject({
  active: z.boolean(), status: z.string().min(1).max(80), tier: z.string().min(1).max(80).nullable(),
  currentPeriodEnd: BudgetUtcMillisSchema.nullable(), providerVersion: z.number().int().safe().nonnegative().nullable(),
});
export const ProviderAccountSessionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("account_session"), producer: ProducerEvidenceSchema,
  generation: ProviderCredentialGenerationSchema, session: ProviderSessionSchema,
  subscription: SubscriptionObservationSchema.nullable(), observedAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema,
}).refine((p) => p.expiresAt > p.observedAt && p.generation.changedAt < p.expiresAt, { path: ["expiresAt"], message: "Invalid account-session validity interval" });
export const ProviderReviewedPolicyPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("reviewed_policy"), producer: ProducerEvidenceSchema,
  providerId: IdSchema, reviewVersion: VersionTextSchema, sourceUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Policy source must use HTTPS"),
  sourceCapture: ReviewCaptureSchema, sourceCaptureSha256: Sha256Schema,
  reviewedConfigCanonicalJson: CanonicalTextSchema.refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, "Reviewed configuration exceeds its byte limit"),
  reviewedConfigHash: Sha256Schema, capturedAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema,
}).refine((p) => p.expiresAt > p.capturedAt && createHash("sha256").update(p.sourceCapture, "utf8").digest("hex") === p.sourceCaptureSha256 && hashCanonicalJson(JSON.parse(p.reviewedConfigCanonicalJson)) === p.reviewedConfigHash, { path: ["reviewedConfigHash"], message: "Reviewed policy integrity is invalid" });
export const ProviderMediaQuotePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("media_quote"), producer: ProducerEvidenceSchema,
  mediaQuote: QuoteSchema, budgetQuote: BudgetQuoteSchema, binding: QuoteAccountBindingSchema,
  accountEvidence: AccountEvidenceSchema, accountProofHash: Sha256Schema, policyProofHash: Sha256Schema,
  canonicalRecipeJson: CanonicalTextSchema, recipeHash: Sha256Schema,
  canonicalQuoteProjectionJson: CanonicalTextSchema, quoteProjectionHash: Sha256Schema,
  executionSemanticHash: Sha256Schema, capability: CapabilityReceiptSchema, session: ProviderSessionSchema,
  createdAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema,
}).superRefine((p, ctx) => {
  const projection = JSON.parse(p.canonicalQuoteProjectionJson) as { inputHash?: unknown };
  const media = p.mediaQuote;
  const budget = p.budgetQuote;
  const binding = p.binding;
  const cap = p.capability;
  const invalid = [
    ["quote_lifetime", p.expiresAt <= p.createdAt], ["media_quote_id", budget.mediaQuoteId !== media.id],
    ["project_id", budget.projectId !== media.projectId], ["provider_id", budget.providerId !== media.providerId],
    ["model_id", budget.modelId !== media.modelId], ["operation", budget.operation !== media.operation],
    ["input_hash", budget.inputHash !== media.inputHash], ["currency", budget.currency !== media.currency],
    ["estimate_min", budget.estimateMin !== media.estimateMinMinor], ["estimate_max", budget.estimateMax !== media.estimateMaxMinor],
    ["entitlement", budget.entitlement !== media.entitlement], ["created_at", budget.createdAt !== media.createdAt],
    ["media_expiry", budget.expiresAt > media.expiresAt], ["binding_quote_id", budget.id !== binding.budgetQuoteId],
    ["semantic_hash", binding.executionSemanticHash !== p.executionSemanticHash], ["projection_input_hash", p.quoteProjectionHash !== media.inputHash],
    ["recipe_hash", p.recipeHash !== hashCanonicalJson(JSON.parse(p.canonicalRecipeJson))],
    ["projection_hash", p.quoteProjectionHash !== hashCanonicalJson(projection)], ["binding_provider", binding.providerId !== media.providerId],
    ["evidence_binding", binding.accountEvidenceId !== p.accountEvidence.id], ["evidence_account", binding.accountId !== p.accountEvidence.accountId],
    ["credential_binding", binding.credentialBindingId !== p.accountEvidence.credentialBindingId], ["evidence_provider", p.accountEvidence.providerId !== media.providerId],
    ["evidence_observation", p.accountEvidence.observedAt > p.createdAt], ["binding_observation", binding.quotedAt > p.createdAt],
    ["evidence_expiry", p.createdAt >= p.accountEvidence.expiresAt || p.expiresAt > p.accountEvidence.expiresAt],
    ["budget_expiry", p.expiresAt > budget.expiresAt], ["capability_provider", cap.providerId !== media.providerId],
    ["capability_model", cap.modelId !== media.modelId], ["capability_provenance", cap.provenance !== "live_catalog"],
    ["capability_expiry_missing", cap.expiresAt === null], ["capability_observation", cap.observedAt > p.createdAt],
    ["capability_expiry", cap.expiresAt !== null && p.expiresAt > cap.expiresAt],
  ] as const;
  const failed = invalid.filter(([, failed]) => failed).map(([name]) => name);
  if (failed.length) ctx.addIssue({ code: "custom", path: ["budgetQuote"], message: `Provider quote snapshots are inconsistent (${failed.join(",")})` });
});
export const ProviderExecutionSessionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("execution_session"), producer: ProducerEvidenceSchema,
  execution: BudgetExecutionSchema, mediaQuoteId: IdSchema, budgetQuoteId: IdSchema, quoteBindingId: IdSchema,
  accountEvidenceId: IdSchema, quoteProofHash: Sha256Schema, accountProofHash: Sha256Schema,
  generation: ProviderCredentialGenerationSchema, session: ProviderSessionSchema, capability: CapabilityReceiptSchema,
  observedAt: BudgetUtcMillisSchema, expiresAt: BudgetUtcMillisSchema,
}).superRefine((p, ctx) => {
  if (p.execution.kind !== "media_job" || !["anchor", "take"].includes(p.execution.operation) || p.session.role !== "worker" || p.expiresAt <= p.observedAt || p.generation.changedAt >= p.expiresAt || p.capability.providerId !== p.execution.providerId || p.capability.modelId !== p.execution.modelId || p.capability.provenance !== "live_catalog" || p.capability.expiresAt === null || p.capability.observedAt > p.observedAt || p.expiresAt > p.capability.expiresAt) {
    ctx.addIssue({ code: "custom", path: ["execution"], message: "Execution session is inconsistent" });
  }
});
export const ProviderProofPayloadSchema = z.discriminatedUnion("kind", [ProviderAccountSessionPayloadSchema, ProviderReviewedPolicyPayloadSchema, ProviderMediaQuotePayloadSchema, ProviderExecutionSessionPayloadSchema]);
export type ProviderProofPayload = z.infer<typeof ProviderProofPayloadSchema>;
export const ProofArtifactSchema = z.strictObject({ schemaVersion: z.literal(1), hash: Sha256Schema, canonicalPayload: CanonicalTextSchema, createdAt: BudgetUtcMillisSchema }).superRefine((artifact, ctx) => {
  try {
    const payload = ProviderProofPayloadSchema.parse(JSON.parse(artifact.canonicalPayload));
    const time = payload.kind === "account_session" ? payload.observedAt : payload.kind === "reviewed_policy" ? payload.capturedAt : payload.kind === "media_quote" ? payload.createdAt : payload.observedAt;
    if (canonicalJson(payload) !== artifact.canonicalPayload || hashCanonicalJson(payload) !== artifact.hash || artifact.createdAt < time || artifact.createdAt < (payload.kind === "account_session" || payload.kind === "execution_session" ? payload.generation.changedAt : 0)) {
      ctx.addIssue({ code: "custom", path: ["hash"], message: "Proof artifact integrity is invalid" });
    }
  } catch {
    ctx.addIssue({ code: "custom", path: ["canonicalPayload"], message: "Proof artifact integrity is invalid" });
  }
});
export type ProofArtifact = z.infer<typeof ProofArtifactSchema>;
export const QuoteProofLinkSchema = z.strictObject({ schemaVersion: z.literal(1), mediaQuoteId: IdSchema, budgetQuoteId: IdSchema, artifactHash: Sha256Schema });
export type QuoteProofLink = z.infer<typeof QuoteProofLinkSchema>;
export const ExecutionProofLinkSchema = z.strictObject({ schemaVersion: z.literal(1), executionId: IdSchema, reservationId: IdSchema, artifactHash: Sha256Schema });
export type ExecutionProofLink = z.infer<typeof ExecutionProofLinkSchema>;

export function proofPayload(artifact: ProofArtifact): ProviderProofPayload {
  try { return ProviderProofPayloadSchema.parse(JSON.parse(artifact.canonicalPayload)); }
  catch { throw new Error("Stored provider proof failed integrity validation"); }
}

export const MAX_PROVIDER_PROOF_UTC_MILLIS = MAX_BUDGET_UTC_MILLIS;
