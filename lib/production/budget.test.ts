import { describe, expect, it } from "vitest";
import { BudgetAuthorization, AccountBudgetPolicy, AccountEvidence, BudgetQuote, BudgetReservation, MAX_BUDGET_UTC_MILLIS, ProductionQuote, ProviderRequestSnapshot, QuoteAccountBinding, ReconciliationEvidence } from "./contracts";
import { checkedAdd, checkedSubtract, foldReservation, summarizeBudget, utcBudgetDay, validateMediaBudgetQuoteCompatibility, validateReservationEligibility } from "./budget";

const reservation: BudgetReservation = {
  schemaVersion: 1, id: "reservation_1", execution: { kind: "media_job", executionId: "job_1", operation: "take", projectId: "project_1", idempotencyKey: "idem_1", requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider_1", modelId: "model_1" },
  authorizationRevisionId: "authrev_1", policyRevisionId: "policyrev_1", budgetQuoteId: "budgetquote_1", quoteBindingId: "binding_1",
  accountEvidenceId: "evidence_1", providerId: "provider_1", accountId: "account_1", credentialBindingId: "credential_1",
  currency: "USD", unit: "minor_currency", upperEstimate: 100, reservedAt: Date.UTC(2026, 0, 1, 23), utcDay: "2026-01-01",
};
const eventBase = { schemaVersion: 1 as const, reservationId: reservation.id, providerId: reservation.providerId, accountId: reservation.accountId, currency: reservation.currency, unit: reservation.unit, observedAt: 2, source: "receipt", reference: "ref_1", provenance: { kind: "provider" as const, producerId: "producer_1" } };
const actual = (eventKey: string, cumulativeActual: number | null, final = false): ReconciliationEvidence => ({ ...eventBase, eventKey, fact: { kind: "actual", cumulativeActual, final } });
const refund = (eventKey: string, amount: number): ReconciliationEvidence => ({ ...eventBase, eventKey, fact: { kind: "refund", amount } });
const nonbilling = (eventKey: string): ReconciliationEvidence => ({ ...eventBase, eventKey, fact: { kind: "nonbilling", confirmedNonacceptanceOrNonbilling: true } });

function mediaCompatibilityFixture(operation: "anchor" | "take" = "anchor") {
  const media: ProductionQuote = {
    version: 1, id: "quote_1", projectId: "project_1", providerId: "provider_1", modelId: "model_1",
    operation, inputHash: "c".repeat(64), entitlement: "subscription", estimateMinMinor: 10, estimateMaxMinor: 20,
    currency: "USD", expiresAt: 500, withinAuthorizedCap: "unknown", createdAt: 100,
  };
  const budget: BudgetQuote = {
    schemaVersion: 1, id: "budgetquote_1", projectId: "project_1", providerId: "provider_1", modelId: "model_1",
    operation, inputHash: media.inputHash, estimateMin: 10, estimateMax: 20, currency: "USD", unit: "minor_currency",
    entitlement: "subscription", createdAt: 100, expiresAt: 500, mediaQuoteId: media.id,
  };
  const resultTarget = operation === "anchor"
    ? { kind: "anchor" as const, shotRevisionId: "shotrev_1", inputsHash: "d".repeat(64) }
    : { kind: "take" as const, shotRevisionId: "shotrev_1", anchorId: "anchor_1", anchorApprovalId: "approval_1", inputsHash: "d".repeat(64) };
  const snapshot: ProviderRequestSnapshot = {
    projectId: media.projectId, jobId: "job_1", idempotencyKey: "idem_1", quoteId: media.id,
    providerId: media.providerId, modelId: media.modelId, prompt: "A frame", inputs: [], parameters: {},
    resultTarget, billingMode: "subscription",
  };
  return { media, budget, snapshot };
}

function eligibilityContext() {
  const policy: AccountBudgetPolicy = { schemaVersion: 1, revisionId: "policyrev_2", policyId: "policy_1", revision: 2, providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency", dailyCap: 1000, expiresAt: null, revoked: false, actorId: "creator_1", createdAt: 1 };
  const authorization: BudgetAuthorization = { schemaVersion: 1, revisionId: "authrev_2", authorizationId: "auth_1", revision: 2, projectId: "project_1", policyId: "policy_1", policyRevisionIdAtAuthorization: "policyrev_1", projectCap: 500, allowedModelIds: ["model_1"], allowedOperations: ["take"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator_1", createdAt: 1 };
  const evidence: AccountEvidence = { schemaVersion: 1, id: "evidence_1", providerId: "provider_1", accountId: "account_1", source: "trusted probe", reference: "probe_1", observedAt: 1, expiresAt: 1000, credentialBindingId: "credential_1" };
  const quote: BudgetQuote = { schemaVersion: 1, id: "budgetquote_1", projectId: "project_1", providerId: "provider_1", modelId: "model_1", operation: "take", inputHash: "a".repeat(64), estimateMin: 10, estimateMax: 100, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 1, expiresAt: 900, mediaQuoteId: "quote_1" };
  const binding: QuoteAccountBinding = { schemaVersion: 1, id: "binding_1", budgetQuoteId: quote.id, accountEvidenceId: evidence.id, providerId: "provider_1", accountId: "account_1", credentialBindingId: "credential_1", currency: "USD", unit: "minor_currency", executionSemanticHash: "b".repeat(64), quotedAt: 2 };
  return { now: 10, currentCredentialBindingId: "credential_1", policy, authorization, evidence, quote, binding, expectedQuoteInputHash: quote.inputHash, execution: { kind: "media_job" as const, executionId: "job_1", operation: "take" as const, projectId: "project_1", idempotencyKey: "idem_1", requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider_1", modelId: "model_1" }, executionSemanticHash: "b".repeat(64), projectLiability: 50, accountDailyLiability: 100 };
}

describe("budget arithmetic and immutable reservation accounting", () => {
  it("checks integer arithmetic and derives representable UTC day boundaries", () => {
    expect(checkedAdd(4, 5)).toBe(9);
    expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => checkedAdd(-1, 2)).toThrow();
    expect(checkedSubtract(5, 3)).toBe(2);
    expect(() => checkedSubtract(2, 3)).toThrow();
    expect(utcBudgetDay(Date.UTC(2026, 0, 1, 23, 59))).toBe("2026-01-01");
    expect(utcBudgetDay(MAX_BUDGET_UTC_MILLIS)).toBe("9999-12-31");
    expect(() => utcBudgetDay(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => utcBudgetDay(MAX_BUDGET_UTC_MILLIS + 1)).toThrow();
  });

  it("holds unknown and pending billing at the upper estimate, then settles cumulatively", () => {
    const unknown = foldReservation(reservation, []);
    expect([unknown.knownGrossActual, unknown.unresolvedLiability, unknown.totalLiability, unknown.settled]).toEqual([null, 100, 100, false]);
    const pending = foldReservation(reservation, [actual("event_1", 130)]);
    expect([pending.knownGrossActual, pending.netKnownActual, pending.unresolvedLiability, pending.totalLiability, pending.overrun]).toEqual([130, 130, 0, 130, true]);
    const final = foldReservation(reservation, [actual("event_1", 130, true)]);
    expect([final.unresolvedLiability, final.totalLiability, final.settled]).toEqual([0, 130, true]);
    expect(foldReservation(reservation, [actual("event_1", 130, true), actual("event_2", 145, true)]).totalLiability).toBe(145);
    expect(() => foldReservation(reservation, [actual("event_1", 130, true), actual("event_2", 129, true)])).toThrow();
    const reopened = foldReservation(reservation, [actual("event_1", 50, true), actual("event_2", 60)]);
    expect(reopened).toMatchObject({ knownGrossActual: 60, settled: false, totalLiability: 100, unresolvedLiability: 40 });
    expect(foldReservation(reservation, [actual("event_1", 50, true), actual("event_2", 60), actual("event_3", 60, true)])).toMatchObject({ settled: true, totalLiability: 60, unresolvedLiability: 0 });
    expect(foldReservation(reservation, [actual("event_1", 50, true), actual("event_2", 50)])).toMatchObject({ settled: true, totalLiability: 50 });
    expect(foldReservation(reservation, [actual("event_1", 50, true), actual("event_2", null)])).toMatchObject({ settled: true, totalLiability: 50 });
  });

  it("deduplicates identical event keys and rejects conflicting payloads or reservation pins", () => {
    expect(foldReservation(reservation, [actual("event_1", 50), actual("event_1", 50)]).knownGrossActual).toBe(50);
    expect(() => foldReservation(reservation, [actual("event_1", 50), actual("event_1", 51)])).toThrow();
    expect(() => foldReservation(reservation, [{ ...actual("event_1", 50), accountId: "other_account" }])).toThrow();
  });

  it("applies refunds once, requires known gross, and retains pending estimate liability", () => {
    const pendingRefund = foldReservation(reservation, [actual("actual_1", 120), refund("refund_1", 20)]);
    expect([pendingRefund.netKnownActual, pendingRefund.unresolvedLiability, pendingRefund.totalLiability, pendingRefund.refundTotal]).toEqual([100, 0, 100, 20]);
    const partiallyRefundedOverrun = foldReservation(reservation, [actual("gross_1", 150), refund("refund_2", 30)]);
    expect([partiallyRefundedOverrun.netKnownActual, partiallyRefundedOverrun.unresolvedLiability, partiallyRefundedOverrun.totalLiability]).toEqual([120, 0, 120]);
    const refundBelowEstimate = foldReservation(reservation, [actual("gross_1", 150), refund("refund_2", 80)]);
    expect([refundBelowEstimate.netKnownActual, refundBelowEstimate.unresolvedLiability, refundBelowEstimate.totalLiability]).toEqual([70, 30, 100]);
    const final = foldReservation(reservation, [actual("actual_1", 120, true), refund("refund_1", 20)]);
    expect([final.netKnownActual, final.unresolvedLiability, final.totalLiability]).toEqual([100, 0, 100]);
    expect(() => foldReservation(reservation, [refund("refund_1", 1)])).toThrow();
    expect(() => foldReservation(reservation, [actual("actual_1", 5, true), refund("refund_1", 6)])).toThrow();
  });

  it("releases confirmed nonbilling once and flags a later contradictory actual", () => {
    expect(foldReservation(reservation, [nonbilling("event_1")])).toMatchObject({ released: true, totalLiability: 0, unresolvedLiability: 0 });
    expect(foldReservation(reservation, [nonbilling("event_1"), actual("event_2", 45, true)])).toMatchObject({ reconciliationConflict: true, released: false, totalLiability: 45 });
    expect(foldReservation(reservation, [nonbilling("event_1"), actual("event_2", 45)])).toMatchObject({ reconciliationConflict: true, released: false, settled: false, totalLiability: 100, unresolvedLiability: 55 });
    expect(() => foldReservation(reservation, [actual("event_1", 5), nonbilling("event_2")])).toThrow();
  });

  it("summarizes project liabilities across days and account liabilities in their original UTC bucket", () => {
    const yesterdayReservation = { ...reservation, policyRevisionId: "policyrev_original", authorizationRevisionId: "authrev_original" };
    const yesterday = { reservation: yesterdayReservation, accounting: foldReservation(reservation, [actual("event_1", 120, true)]) };
    const todayReservation = { ...reservation, id: "reservation_2", execution: { ...reservation.execution, projectId: "project_2" }, reservedAt: Date.UTC(2026, 0, 2, 1), utcDay: "2026-01-02", upperEstimate: 80 };
    const today = { reservation: todayReservation, accounting: foldReservation(todayReservation, []) };
    expect(summarizeBudget([yesterday, today], { projectId: "project_1", providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency" })).toEqual({ knownNetActual: 120, unresolvedLiability: 0, totalLiability: 120 });
    expect(summarizeBudget([yesterday, today], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency", utcDay: "2026-01-01" }).totalLiability).toBe(120);
    expect(summarizeBudget([yesterday, today], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency", utcDay: "2026-01-02" }).totalLiability).toBe(80);
    expect(summarizeBudget([today], { providerId: "provider_1", accountId: "account_1", currency: "EUR", unit: "minor_currency" })).toEqual({ knownNetActual: 0, unresolvedLiability: 0, totalLiability: 0 });
    expect(summarizeBudget([today, { reservation: { ...todayReservation, id: "reservation_3", currency: null, unit: "spark_token" }, accounting: foldReservation({ ...todayReservation, id: "reservation_3", currency: null, unit: "spark_token" }, []) }], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency" })).toEqual({ knownNetActual: 0, unresolvedLiability: 80, totalLiability: 80 });
  });

  it("rejects understated unresolved totals below the reservation estimate", () => {
    const understated = { knownGrossActual: null, refundTotal: 0, netKnownActual: null, settled: false, released: false, unresolvedLiability: 0, totalLiability: 0, overrun: false, reconciliationConflict: false };
    expect(() => summarizeBudget([{ reservation, accounting: understated }], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency" })).toThrow();
  });

  it("rejects refunds when gross actual is unknown", () => {
    const unknownWithRefund = { knownGrossActual: null, refundTotal: 1, netKnownActual: null, settled: false, released: false, unresolvedLiability: 100, totalLiability: 100, overrun: false, reconciliationConflict: false };
    expect(() => summarizeBudget([{ reservation, accounting: unknownWithRefund }], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency" })).toThrow();
  });

  it("requires an explicit nonbilling release when settled actual is unknown", () => {
    const unjustifiedSettlement = { knownGrossActual: null, refundTotal: 0, netKnownActual: null, settled: true, released: false, unresolvedLiability: 0, totalLiability: 0, overrun: false, reconciliationConflict: false };
    expect(() => summarizeBudget([{ reservation, accounting: unjustifiedSettlement }], { providerId: "provider_1", accountId: "account_1", currency: "USD", unit: "minor_currency" })).toThrow();
  });

  it("fails closed against stale, unknown, mismatched, or over-cap quote authorization", () => {
    const context = eligibilityContext();
    expect(validateReservationEligibility(context)).toEqual({ allowed: true });
    expect(validateReservationEligibility({ ...context, evidence: { ...context.evidence, observedAt: 2 } })).toEqual({ allowed: true });
    expect(validateReservationEligibility({ ...context, policy: { ...context.policy, dailyCap: 100 } })).toMatchObject({ allowed: false, reason: "DAILY_CAP_EXCEEDED" });
    expect(validateReservationEligibility({ ...context, authorization: { ...context.authorization, projectCap: null } })).toMatchObject({ allowed: false, reason: "PROJECT_CAP_UNKNOWN" });
    expect(validateReservationEligibility({ ...context, quote: { ...context.quote, unit: "unknown" } })).toMatchObject({ allowed: false, reason: "QUOTE_SCOPE_UNKNOWN" });
    expect(validateReservationEligibility({ ...context, binding: { ...context.binding, credentialBindingId: "credential_new" } })).toMatchObject({ allowed: false, reason: "ACCOUNT_BINDING_MISMATCH" });
    expect(validateReservationEligibility({ ...context, currentCredentialBindingId: "credential_rotated" })).toMatchObject({ allowed: false, reason: "ACCOUNT_BINDING_MISMATCH" });
    expect(validateReservationEligibility({ ...context, authorization: { ...context.authorization, allowedOperations: ["text_proposal"] } })).toMatchObject({ allowed: false, reason: "AUTHORIZATION_SCOPE_MISMATCH" });
    expect(validateReservationEligibility({ ...context, policy: { ...context.policy, dailyCap: 0 } })).toMatchObject({ allowed: false, reason: "DAILY_CAP_BLOCKED" });
    expect(validateReservationEligibility({ ...context, authorization: { ...context.authorization, projectCap: 0 } })).toMatchObject({ allowed: false, reason: "PROJECT_CAP_BLOCKED" });
    expect(validateReservationEligibility({ ...context, expectedQuoteInputHash: "c".repeat(64) })).toMatchObject({ allowed: false, reason: "QUOTE_INPUT_MISMATCH" });
    expect(validateReservationEligibility({ ...context, execution: { ...context.execution, executionSemanticHash: "c".repeat(64) } })).toMatchObject({ allowed: false, reason: "QUOTE_BINDING_MISMATCH" });
    expect(validateReservationEligibility({ ...context, binding: { ...context.binding, quotedAt: 11 } })).toMatchObject({ allowed: false, reason: "QUOTE_EXPIRED" });
    expect(validateReservationEligibility({ ...context, quote: { ...context.quote, estimateMin: null, estimateMax: null } })).toMatchObject({ allowed: false, reason: "QUOTE_ESTIMATE_UNKNOWN" });
  });

  it("rejects a current policy revision created in the future", () => {
    const context = eligibilityContext();
    expect(validateReservationEligibility({ ...context, policy: { ...context.policy, createdAt: 999 } })).toMatchObject({ allowed: false, reason: "POLICY_NOT_YET_VALID" });
  });

  it("rejects a current authorization revision created in the future", () => {
    const context = eligibilityContext();
    expect(validateReservationEligibility({ ...context, authorization: { ...context.authorization, createdAt: 999 } })).toMatchObject({ allowed: false, reason: "AUTHORIZATION_NOT_YET_VALID" });
  });

  it("rejects quote binding timestamps before account evidence observation", () => {
    const context = eligibilityContext();
    expect(validateReservationEligibility({ ...context, evidence: { ...context.evidence, observedAt: 3 } })).toMatchObject({ allowed: false, reason: "QUOTE_EXPIRED" });
  });

  it("rejects quote binding timestamps at account evidence expiry", () => {
    const context = eligibilityContext();
    expect(validateReservationEligibility({ ...context, binding: { ...context.binding, quotedAt: context.evidence.expiresAt } })).toMatchObject({ allowed: false, reason: "QUOTE_EXPIRED" });
  });
});

describe("media and budget quote compatibility", () => {
  it("accepts matching subscription anchor and take quotes with exact target kinds", () => {
    for (const operation of ["anchor", "take"] as const) {
      const fixture = mediaCompatibilityFixture(operation);
      expect(validateMediaBudgetQuoteCompatibility(fixture.media, fixture.budget, fixture.snapshot)).toEqual({ allowed: true });
    }
  });

  it("rejects identity, operation, input, billing-mode, estimate, currency, and expiry mismatches", () => {
    const fixture = mediaCompatibilityFixture("anchor");
    const otherSnapshot = mediaCompatibilityFixture("take").snapshot;
    const mismatches: Array<[ProductionQuote, BudgetQuote, ProviderRequestSnapshot]> = [
      [fixture.media, { ...fixture.budget, mediaQuoteId: "quote_other" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, projectId: "project_other" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, providerId: "provider_other" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, modelId: "model_other" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, operation: "music" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, inputHash: "e".repeat(64) }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, entitlement: "spark" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, currency: "EUR" }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, estimateMin: 11 }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, estimateMax: 21 }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, createdAt: 99 }, fixture.snapshot],
      [fixture.media, { ...fixture.budget, expiresAt: 501 }, fixture.snapshot],
      [fixture.media, fixture.budget, { ...fixture.snapshot, quoteId: "quote_other" }],
      [fixture.media, fixture.budget, { ...fixture.snapshot, projectId: "project_other" }],
      [fixture.media, fixture.budget, { ...fixture.snapshot, providerId: "provider_other" }],
      [fixture.media, fixture.budget, { ...fixture.snapshot, modelId: "model_other" }],
      [fixture.media, fixture.budget, { ...fixture.snapshot, billingMode: "tokens" }],
      [fixture.media, fixture.budget, { ...fixture.snapshot, billingMode: undefined }],
      [fixture.media, fixture.budget, otherSnapshot],
      [{ ...fixture.media, entitlement: "unknown" }, fixture.budget, fixture.snapshot],
    ];
    for (const [media, budget, snapshot] of mismatches) {
      expect(validateMediaBudgetQuoteCompatibility(media, budget, snapshot)).toEqual({ allowed: false, reason: "QUOTE_INCOMPATIBLE" });
    }
  });

  it("supports proven Spark token estimates without inventing money conversion", () => {
    const fixture = mediaCompatibilityFixture("anchor");
    const media = { ...fixture.media, entitlement: "spark" as const, estimateMinMinor: null, estimateMaxMinor: null, currency: null };
    const budget = { ...fixture.budget, unit: "spark_token" as const, entitlement: "spark" as const, currency: null };
    const snapshot = { ...fixture.snapshot, billingMode: "tokens" as const };
    expect(validateMediaBudgetQuoteCompatibility(media, budget, snapshot)).toEqual({ allowed: true });
    expect(validateMediaBudgetQuoteCompatibility({ ...media, currency: "USD" }, budget, snapshot)).toEqual({ allowed: false, reason: "QUOTE_INCOMPATIBLE" });
    expect(validateMediaBudgetQuoteCompatibility({ ...media, estimateMinMinor: 0 }, budget, snapshot)).toEqual({ allowed: false, reason: "QUOTE_INCOMPATIBLE" });
    expect(validateMediaBudgetQuoteCompatibility(media, { ...budget, unit: "minor_currency", currency: "USD" }, { ...snapshot, billingMode: "subscription" })).toEqual({ allowed: false, reason: "QUOTE_INCOMPATIBLE" });
    expect(validateMediaBudgetQuoteCompatibility(fixture.media, { ...fixture.budget, unit: "spark_token", currency: null }, fixture.snapshot)).toEqual({ allowed: false, reason: "QUOTE_INCOMPATIBLE" });
  });

  it("accepts Spark entitlement with a separately quoted exact currency estimate", () => {
    const fixture = mediaCompatibilityFixture("anchor");
    const media = { ...fixture.media, entitlement: "spark" as const };
    const budget = { ...fixture.budget, entitlement: "spark" as const };
    const snapshot = { ...fixture.snapshot, billingMode: "tokens" as const };
    expect(validateMediaBudgetQuoteCompatibility(media, budget, snapshot)).toEqual({ allowed: true });
  });
});
