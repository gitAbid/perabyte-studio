import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductionApplicationError } from "./errors";
import { canonicalJson, hashCanonicalJson } from "./hash";
import { parseReviewedQuotePolicy, ReviewedQuotePolicyConfigSchema } from "./proof-policy";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sourceCapture = "Fixture reviewed policy capture for the offline provider price registry.";
const validConfig = {
  schemaVersion: 1 as const,
  providerId: "sogni",
  quoteTtlMs: 30_000,
  accountSessionTtlMs: 60_000,
  executionSessionTtlMs: 60_000,
  billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" as const }],
  priceByModel: [{ modelId: "image-model", operations: ["anchor" as const, "take" as const], entitlement: "subscription" as const, unit: "minor_currency" as const, currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }],
};
const payload = (overrides: Record<string, unknown> = {}, config: unknown = validConfig) => ({
  schemaVersion: 1,
  kind: "reviewed_policy",
  producer: { producerId: "fixture-reviewer", producerVersion: "fixture-reviewer-v1", sourceHash: sha256("reviewer-provenance") },
  providerId: "sogni",
  reviewVersion: "review-1",
  sourceUrl: "https://policy.fixture.example/sogni-pricing-v1",
  sourceCapture,
  sourceCaptureSha256: sha256(sourceCapture),
  reviewedConfigCanonicalJson: canonicalJson(config),
  reviewedConfigHash: hashCanonicalJson(config),
  capturedAt: 0,
  expiresAt: 10_000_000_000,
  ...overrides,
});
const expectBlocked = (input: unknown) => {
  try { parseReviewedQuotePolicy(input); } catch (error) {
    expect(error).toBeInstanceOf(ProductionApplicationError);
    expect((error as ProductionApplicationError).code).toBe("BUDGET_BLOCKED");
    return;
  }
  throw new Error("Expected the reviewed policy input to be rejected");
};

describe("reviewed provider policy parsing", () => {
  it("I01-B6-C reviewed policy parsing is strict and fail-closed", () => {
    const parsed = parseReviewedQuotePolicy(payload());
    expect(parsed).toMatchObject({ reviewVersion: "review-1", capturedAt: 0, expiresAt: 10_000_000_000, sourceCaptureSha256: sha256(sourceCapture) });
    expect(parsed.configCanonicalJson).toBe(canonicalJson(validConfig));
    expect(ReviewedQuotePolicyConfigSchema.parse(JSON.parse(parsed.configCanonicalJson))).toMatchObject({ providerId: "sogni", quoteTtlMs: 30_000, executionSessionTtlMs: 60_000 });
    expect(hashCanonicalJson(JSON.parse(parsed.configCanonicalJson))).toBe(hashCanonicalJson(validConfig));

    expectBlocked(payload({ sourceCaptureSha256: sha256("tampered") }));
    expectBlocked(payload({ reviewedConfigHash: sha256("tampered") }));
    const nonCanonical = JSON.stringify(validConfig);
    expectBlocked(payload({ reviewedConfigCanonicalJson: nonCanonical, reviewedConfigHash: hashCanonicalJson(JSON.parse(nonCanonical)) }));
    expectBlocked(payload({ capturedAt: 10_000_000_000, expiresAt: 10_000_000_000 }));
    expectBlocked(payload({ providerId: "other-provider" }));

    expectBlocked(payload({}, { ...validConfig, quoteTtlMs: 0 }));
    expectBlocked(payload({}, { ...validConfig, quoteTtlMs: 3_600_001 }));
    expectBlocked(payload({}, { ...validConfig, accountSessionTtlMs: 3_600_001 }));
    expectBlocked(payload({}, { ...validConfig, executionSessionTtlMs: 0 }));
    expectBlocked(payload({}, { ...validConfig, billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" }, { modelId: "image-model", billingMode: "tokens" }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [validConfig.priceByModel[0], { ...validConfig.priceByModel[0], entitlement: "spark", unit: "spark_token", currency: null }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], unit: "minor_currency", currency: null }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], unit: "spark_token", currency: "USD" }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], currency: "usd" }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], estimateMinMinor: 30 }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], estimateMaxMinor: -1 }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], operations: [] }] }));
    expectBlocked(payload({}, { ...validConfig, priceByModel: [{ ...validConfig.priceByModel[0], operations: ["anchor", "anchor"] }] }));
    expectBlocked(payload({}, { ...validConfig, extraField: true }));
    expectBlocked(payload({ unexpected: 1 }));
    const { reviewVersion: _omitted, ...missingField } = payload();
    void _omitted;
    expectBlocked(missingField);

    const emptyRegistry = { ...validConfig, priceByModel: [] };
    const emptyParsed = parseReviewedQuotePolicy(payload({}, emptyRegistry));
    expect(ReviewedQuotePolicyConfigSchema.parse(JSON.parse(emptyParsed.configCanonicalJson)).priceByModel).toEqual([]);
  });
});
