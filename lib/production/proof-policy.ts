import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetUtcMillisSchema, IdSchema, Sha256Schema } from "./contracts";
import { ProductionApplicationError } from "./errors";
import { canonicalJson } from "./hash";
import { ProviderReviewedPolicyPayloadSchema } from "./provider-proof";

/** Reviewed quote policies are bounded per kind; an out-of-range TTL can never widen a quote lifetime. */
const TtlSchema = z.number().int().safe().min(1).max(3_600_000);
const uniqueModelIds = (entries: readonly { modelId: string }[]): boolean => new Set(entries.map(entry => entry.modelId)).size === entries.length;

export const ReviewedQuotePolicyConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providerId: IdSchema,
  quoteTtlMs: TtlSchema,
  accountSessionTtlMs: TtlSchema,
  executionSessionTtlMs: TtlSchema,
  billingModeByModel: z.array(z.strictObject({ modelId: IdSchema, billingMode: z.enum(["subscription", "tokens"]) })).max(100).refine(uniqueModelIds, "Duplicate modelId billing modes are not allowed"),
  priceByModel: z.array(z.strictObject({
    modelId: IdSchema,
    operations: z.array(z.enum(["anchor", "take"])).min(1).max(2).refine(operations => new Set(operations).size === operations.length, "Operations must be unique"),
    entitlement: z.enum(["subscription", "spark"]),
    unit: z.enum(["minor_currency", "spark_token"]),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    estimateMinMinor: z.number().int().safe().nonnegative().nullable(),
    estimateMaxMinor: z.number().int().safe().nonnegative().nullable(),
  })).max(100),
}).superRefine((config, ctx) => {
  if (!uniqueModelIds(config.priceByModel)) ctx.addIssue({ code: "custom", path: ["priceByModel"], message: "Duplicate modelId prices are not allowed" });
  config.priceByModel.forEach((entry, index) => {
    if ((entry.unit === "minor_currency") !== (entry.currency !== null)) ctx.addIssue({ code: "custom", path: ["priceByModel", index, "currency"], message: "Currency must match the price unit" });
    if (entry.estimateMinMinor !== null && entry.estimateMaxMinor !== null && entry.estimateMinMinor > entry.estimateMaxMinor) ctx.addIssue({ code: "custom", path: ["priceByModel", index, "estimateMinMinor"], message: "Minimum estimate cannot exceed maximum" });
  });
});
export type ReviewedQuotePolicyConfig = Readonly<z.infer<typeof ReviewedQuotePolicyConfigSchema>>;

export const ReviewedPolicyInputSchema = z.strictObject({
  reviewVersion: z.string().min(1).max(80),
  sourceUrl: z.string().url().max(2048).refine(value => value.startsWith("https://"), "Policy source must use HTTPS"),
  sourceCapture: z.string().min(1).max(65_536),
  sourceCaptureSha256: Sha256Schema,
  capturedAt: BudgetUtcMillisSchema,
  expiresAt: BudgetUtcMillisSchema,
  configCanonicalJson: z.string().min(1).max(65_536),
}).refine(input => input.expiresAt > input.capturedAt, { path: ["expiresAt"], message: "Reviewed policy must expire after capture" })
  .refine(input => createSha256(input.sourceCapture) === input.sourceCaptureSha256, { path: ["sourceCaptureSha256"], message: "Reviewed policy capture integrity is invalid" });

export type ReviewedPolicyInput = Readonly<z.infer<typeof ReviewedPolicyInputSchema>>;

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Validates a reviewed policy payload offline (capture and configuration hash integrity included)
 * and projects the exact input the composer consumes. Anything missing or malformed is BUDGET_BLOCKED;
 * no default policy value is ever invented. The configuration's providerId must match the payload's.
 */
export function parseReviewedQuotePolicy(input: unknown): ReviewedPolicyInput {
  try {
    const payload = ProviderReviewedPolicyPayloadSchema.parse(input);
    const config = ReviewedQuotePolicyConfigSchema.parse(JSON.parse(payload.reviewedConfigCanonicalJson));
    if (config.providerId !== payload.providerId || canonicalJson(config) !== payload.reviewedConfigCanonicalJson) throw new Error("Reviewed configuration does not match its provider or canonical form");
    return ReviewedPolicyInputSchema.parse({ reviewVersion: payload.reviewVersion, sourceUrl: payload.sourceUrl, sourceCapture: payload.sourceCapture, sourceCaptureSha256: payload.sourceCaptureSha256, capturedAt: payload.capturedAt, expiresAt: payload.expiresAt, configCanonicalJson: payload.reviewedConfigCanonicalJson });
  } catch {
    throw new ProductionApplicationError("BUDGET_BLOCKED", "The reviewed provider policy could not be validated; pricing stays blocked.");
  }
}
