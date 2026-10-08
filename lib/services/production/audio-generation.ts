import { z } from "zod";
import {
  BudgetUtcMillisSchema,
  IdSchema,
  SafeAmountSchema,
  SchemaVersionSchema,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import {
  ReviewedPolicyInputSchema,
  ReviewedQuotePolicyConfigSchema,
  type ReviewedPolicyInput,
  type ReviewedQuotePolicyConfig,
} from "../../production/proof-policy";
import {
  AudioSpendAuthorizationSchema,
  SogniAudioGenerationRequestSchema,
  audioGenerationRequestSha256,
  estimateAudioCoverage,
  validateAudioGenerationRequest,
  type AudioCoverageReceipt,
  type AudioSpendAuthorization,
  type SogniAudioGenerationRequest,
} from "../../providers/production/sogni-audio";

/**
 * C16-AUDIO-ADAPTER service layer (contract-first, offline). It issues draft per-request audio
 * spend authorizations from the reviewed policy plus a project budget authorization. No atomic
 * reservation is taken here — the later amendment connects the budget composer; a draft proof is
 * not a ledger reservation. This service is a seam for callers and must NOT be wired into a route.
 */

// Mirrored BudgetAuthorization shape (lib/services/production/budget.ts is reference-only; this
// file deliberately does not import it). Tighten here if the upstream contract tightens.
const uniqueIds = (entries: readonly string[]): boolean => new Set(entries).size === entries.length;
export const AudioBudgetAuthorizationSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  revisionId: IdSchema,
  authorizationId: IdSchema,
  revision: z.number().int().safe().positive(),
  projectId: IdSchema,
  policyId: IdSchema,
  policyRevisionIdAtAuthorization: IdSchema,
  projectCap: SafeAmountSchema.nullable(),
  allowedModelIds: z.array(IdSchema).min(1).max(100).refine(uniqueIds, "Model IDs must be unique"),
  allowedOperations: z.array(z.enum(["anchor", "take", "speech", "music", "text_proposal"])).min(1).max(5).refine(uniqueIds, "Operations must be unique"),
  entitlementModes: z.array(z.enum(["subscription", "spark"])).min(1).max(2).refine(uniqueIds, "Entitlement modes must be unique"),
  expiresAt: BudgetUtcMillisSchema.nullable(),
  revoked: z.boolean(),
  actorId: IdSchema,
  createdAt: BudgetUtcMillisSchema,
});
export type AudioBudgetAuthorization = Readonly<z.infer<typeof AudioBudgetAuthorizationSchema>>;

export type AudioBudgetBlockReason =
  | "POLICY_MISSING" | "POLICY_EXPIRED" | "MODEL_NOT_COVERED"
  | "AUTHORIZATION_INVALID" | "AUTHORIZATION_PROJECT_MISMATCH" | "AUTHORIZATION_REVOKED" | "AUTHORIZATION_NOT_YET_VALID" | "AUTHORIZATION_EXPIRED"
  | "OPERATION_NOT_ALLOWED" | "MODEL_NOT_ALLOWED" | "ENTITLEMENT_NOT_ALLOWED"
  | "ESTIMATE_UNKNOWN" | "PROJECT_CAP_UNKNOWN" | "PROJECT_CAP_EXCEEDED" | "PROJECT_TOTALS_UNKNOWN";

export interface AudioBudgetTotals {
  readonly totalLiability: number;
}
export type AudioBudgetTotalsScope = Readonly<{ providerId: string; unit: "minor_currency" | "spark_token"; currency: string | null }>;

const AudioGenerationCommandSchema = SogniAudioGenerationRequestSchema
  .extend({ projectId: IdSchema, authorization: z.unknown().optional() })
  .omit({ outputFormat: true, sampleRate: true });

export interface AudioGenerationServiceOptions {
  reviewedPolicy: ReviewedPolicyInput | null;
  loadProjectBudgetTotals?: (input: Readonly<{ projectId: string; scope: AudioBudgetTotalsScope }>) => Promise<AudioBudgetTotals | null>;
  now?: () => number;
}

export interface PreparedAudioGeneration {
  readonly providerId: "sogni";
  readonly request: SogniAudioGenerationRequest;
  readonly authorization: AudioSpendAuthorization;
  readonly coverage: AudioCoverageReceipt;
}

export interface AudioGenerationService {
  prepareAudioGeneration(command: unknown): Promise<PreparedAudioGeneration>;
}

function blocked(reason: AudioBudgetBlockReason, message: string): never {
  throw new ProductionApplicationError("BUDGET_BLOCKED", message, { details: { reason } });
}
function invalid(message: string): never {
  throw new ProductionApplicationError("INVALID_INPUT", message);
}

/**
 * Loads and integrity-checks the reviewed policy (capture hash and canonical configuration),
 * resolves the model's billing mode and price envelope, and gates on the explicit per-request
 * authorization. The installed policy schema admits only anchor/take in priceByModel.operations,
 * so audio coverage keys on the MODEL being present in the policy while the audio operation itself
 * must be listed by the budget authorization's allowedOperations. Anchor/take entries are never
 * inferred to cover speech or music; anything missing blocks with an actionable reason.
 */
export function createAudioGenerationService(options: AudioGenerationServiceOptions): AudioGenerationService {
  const now = options.now ?? Date.now;

  const resolvePolicyConfig = (): { config: ReviewedQuotePolicyConfig; policyInput: ReviewedPolicyInput } | null => {
    if (!options.reviewedPolicy) return null;
    const parsedInput = ReviewedPolicyInputSchema.safeParse(options.reviewedPolicy);
    if (!parsedInput.success) return null;
    try {
      const config = ReviewedQuotePolicyConfigSchema.parse(JSON.parse(parsedInput.data.configCanonicalJson));
      if (canonicalJson(config) !== parsedInput.data.configCanonicalJson) return null;
      return { config, policyInput: parsedInput.data };
    } catch {
      return null;
    }
  };

  return {
    async prepareAudioGeneration(commandValue: unknown): Promise<PreparedAudioGeneration> {
      const parsedCommand = AudioGenerationCommandSchema.safeParse(commandValue);
      if (!parsedCommand.success) invalid("The audio generation command is invalid.");
      const command = parsedCommand.data;
      const { authorization: _authorization, projectId: _projectId, ...requestFields } = command;
      const request = validateAudioGenerationRequest({ ...requestFields, outputFormat: "wav", sampleRate: 48000 });
      const at = now();

      const resolved = resolvePolicyConfig();
      if (!resolved) blocked("POLICY_MISSING", "No reviewed provider policy is installed; audio generation stays blocked.");
      const { config: policyConfig, policyInput } = resolved;
      if (policyInput.expiresAt <= at) blocked("POLICY_EXPIRED", "The reviewed provider policy has expired; refresh it before requesting audio.");
      const billing = policyConfig.billingModeByModel.find(entry => entry.modelId === command.modelId);
      const price = policyConfig.priceByModel.find(entry => entry.modelId === command.modelId);
      if (!billing || !price) blocked("MODEL_NOT_COVERED", "The reviewed policy does not cover this audio model; extend the reviewed policy before requesting audio.");

      const parsedAuthorization = AudioBudgetAuthorizationSchema.safeParse(command.authorization);
      if (!parsedAuthorization.success) blocked("AUTHORIZATION_INVALID", "A valid project budget authorization record is required for audio spend.");
      const authorization = parsedAuthorization.data;
      if (authorization.projectId !== command.projectId) blocked("AUTHORIZATION_PROJECT_MISMATCH", "The budget authorization belongs to a different project.");
      if (authorization.revoked) blocked("AUTHORIZATION_REVOKED", "The budget authorization is revoked; authorize the project again.");
      if (authorization.createdAt > at) blocked("AUTHORIZATION_NOT_YET_VALID", "The budget authorization is not yet valid.");
      if (authorization.expiresAt !== null && authorization.expiresAt <= at) blocked("AUTHORIZATION_EXPIRED", "The budget authorization has expired; authorize the project again.");
      if (!authorization.allowedOperations.includes(request.kind)) blocked("OPERATION_NOT_ALLOWED", `The budget authorization does not list the "${request.kind}" operation; reauthorize the project with it.`);
      if (!authorization.allowedModelIds.includes(request.modelId)) blocked("MODEL_NOT_ALLOWED", "The budget authorization does not allow this audio model.");
      if (!authorization.entitlementModes.includes(price.entitlement)) blocked("ENTITLEMENT_NOT_ALLOWED", "The budget authorization does not include the policy's entitlement mode for this model.");
      if (price.estimateMaxMinor === null) blocked("ESTIMATE_UNKNOWN", "The reviewed policy has no bounded estimate for this audio model; audio stays blocked.");
      if (authorization.projectCap === null) blocked("PROJECT_CAP_UNKNOWN", "The budget authorization has no project cap; audio stays blocked.");

      const totals = options.loadProjectBudgetTotals
        ? await options.loadProjectBudgetTotals({ projectId: command.projectId, scope: { providerId: policyConfig.providerId, unit: price.unit, currency: price.currency } })
        : null;
      if (!totals || !Number.isSafeInteger(totals.totalLiability) || totals.totalLiability < 0) blocked("PROJECT_TOTALS_UNKNOWN", "The budget read model totals are unavailable; audio stays blocked.");
      if (totals.totalLiability + price.estimateMaxMinor > authorization.projectCap) blocked("PROJECT_CAP_EXCEEDED", "Committed liability plus the audio estimate exceeds the project cap.");

      const coverage = estimateAudioCoverage(request);
      const authorizationDraft = AudioSpendAuthorizationSchema.parse({
        schemaVersion: 1,
        kind: "audio_spend_authorization",
        providerId: "sogni",
        projectId: command.projectId,
        modelId: request.modelId,
        operation: request.kind,
        requestSha256: audioGenerationRequestSha256(request),
        policySha256: hashCanonicalJson(policyConfig),
        authorizationSha256: hashCanonicalJson(authorization),
        budgetAuthorizationId: authorization.authorizationId,
        billingMode: billing.billingMode,
        estimate: { unit: price.unit, currency: price.currency, estimateMin: price.estimateMinMinor, estimateMax: price.estimateMaxMinor, entitlement: price.entitlement },
        withinCap: true,
        issuedAt: at,
        expiresAt: at + policyConfig.quoteTtlMs,
      });
      return { providerId: "sogni", request, authorization: authorizationDraft, coverage };
    },
  };
}
