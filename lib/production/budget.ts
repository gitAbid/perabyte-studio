import {
  AccountBudgetPolicySchema,
  AccountEvidenceSchema,
  BudgetAuthorizationSchema,
  BudgetExecutionSchema,
  BudgetQuoteSchema,
  BudgetReservationSchema,
  MAX_BUDGET_UTC_MILLIS,
  MoneyScopeSchema,
  ProviderRequestSnapshotSchema,
  QuoteSchema as ProductionQuoteSchema,
  QuoteAccountBindingSchema,
  ReconciliationEvidenceSchema,
  ReservationAccountingSchema,
  type AccountBudgetPolicy,
  type AccountEvidence,
  type BudgetAuthorization,
  type BudgetExecution,
  type BudgetQuote,
  type BudgetReservation,
  type ProductionQuote,
  type ProviderRequestSnapshot,
  type QuoteAccountBinding,
  type ReconciliationEvidence,
} from "./contracts";
import { canonicalJson } from "./hash";

function safeAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer`);
}

export function checkedAdd(left: number, right: number): number {
  safeAmount(left, "left");
  safeAmount(right, "right");
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError("sum exceeds safe integer range");
  return result;
}

export function checkedSubtract(left: number, right: number): number {
  safeAmount(left, "left");
  safeAmount(right, "right");
  if (right > left) throw new RangeError("subtraction would underflow");
  return left - right;
}

export function utcBudgetDay(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_BUDGET_UTC_MILLIS) throw new RangeError("timestamp must be within the four-digit UTC date range");
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new RangeError("timestamp is outside the UTC date range");
  return date.toISOString().slice(0, 10);
}

export interface ReservationAccounting {
  knownGrossActual: number | null;
  refundTotal: number;
  netKnownActual: number | null;
  settled: boolean;
  released: boolean;
  unresolvedLiability: number;
  totalLiability: number;
  overrun: boolean;
  reconciliationConflict: boolean;
}

export function foldReservation(reservationValue: BudgetReservation, evidenceValues: readonly ReconciliationEvidence[]): ReservationAccounting {
  const reservation = BudgetReservationSchema.parse(reservationValue);
  let knownGrossActual: number | null = null;
  let refundTotal = 0;
  let finalActual = false;
  let released = false;
  let reconciliationConflict = false;
  const eventKeys = new Map<string, string>();

  for (const evidenceValue of evidenceValues) {
    const evidence = ReconciliationEvidenceSchema.parse(evidenceValue);
    const semantic = canonicalJson(evidence);
    const previous = eventKeys.get(evidence.eventKey);
    if (previous !== undefined) {
      if (previous !== semantic) throw new Error(`conflicting reconciliation event key: ${evidence.eventKey}`);
      continue;
    }
    eventKeys.set(evidence.eventKey, semantic);
    if (evidence.reservationId !== reservation.id || evidence.providerId !== reservation.providerId || evidence.accountId !== reservation.accountId || evidence.currency !== reservation.currency || evidence.unit !== reservation.unit) {
      throw new Error("reconciliation evidence scope does not match reservation pins");
    }

    if (evidence.fact.kind === "actual") {
      const amount = evidence.fact.cumulativeActual;
      if (amount !== null) {
        if (knownGrossActual !== null && amount < knownGrossActual) throw new Error("cumulative actual cannot decrease; use a refund event");
        const isHigherCorrection = knownGrossActual !== null && amount > knownGrossActual;
        if (finalActual && isHigherCorrection && !evidence.fact.final) finalActual = false;
        if (released && amount > 0) {
          reconciliationConflict = true;
          released = false;
        }
        if (knownGrossActual === null || amount > knownGrossActual) knownGrossActual = amount;
        if (evidence.fact.final) finalActual = true;
      }
    } else if (evidence.fact.kind === "nonbilling") {
      if (knownGrossActual !== null && knownGrossActual > 0) throw new Error("nonbilling evidence conflicts with known positive actual");
      released = true;
      finalActual = false;
    } else {
      if (knownGrossActual === null) throw new Error("refund requires known gross actual");
      refundTotal = checkedAdd(refundTotal, evidence.fact.amount);
      if (refundTotal > knownGrossActual) throw new Error("refund total exceeds known gross actual");
    }
  }

  if (knownGrossActual !== null && refundTotal > knownGrossActual) throw new Error("refund total exceeds known gross actual");
  const netKnownActual = knownGrossActual === null ? null : checkedSubtract(knownGrossActual, refundTotal);
  const settled = finalActual || released;
  let totalLiability: number;
  let unresolvedLiability: number;
  if (released && knownGrossActual === null) {
    totalLiability = 0;
    unresolvedLiability = 0;
  } else if (settled) {
    totalLiability = netKnownActual ?? 0;
    unresolvedLiability = 0;
  } else {
    const knownForCap = netKnownActual ?? 0;
    totalLiability = Math.max(reservation.upperEstimate, knownForCap);
    unresolvedLiability = checkedSubtract(totalLiability, knownForCap);
  }

  return {
    knownGrossActual,
    refundTotal,
    netKnownActual,
    settled,
    released: released && !(knownGrossActual !== null && knownGrossActual > 0),
    unresolvedLiability,
    totalLiability,
    overrun: knownGrossActual !== null && knownGrossActual > reservation.upperEstimate,
    reconciliationConflict,
  };
}

export interface ReservationAccountingWithPins {
  reservation: BudgetReservation;
  accounting: ReservationAccounting;
}

export interface BudgetSummaryScope {
  projectId?: string;
  providerId: string;
  accountId: string;
  currency: string | null;
  unit: "minor_currency" | "spark_token";
  utcDay?: string;
}

export interface BudgetSummary {
  knownNetActual: number;
  unresolvedLiability: number;
  totalLiability: number;
}

export function summarizeBudget(records: readonly ReservationAccountingWithPins[], scope: BudgetSummaryScope): BudgetSummary {
  MoneyScopeSchema.parse({ providerId: scope.providerId, accountId: scope.accountId, currency: scope.currency, unit: scope.unit });
  if (scope.projectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(scope.projectId)) throw new Error("invalid project scope");
  if (scope.utcDay !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(scope.utcDay) || Number.isNaN(Date.parse(`${scope.utcDay}T00:00:00.000Z`)) || utcBudgetDay(Date.parse(`${scope.utcDay}T00:00:00.000Z`)) !== scope.utcDay)) throw new Error("invalid UTC day scope");

  let knownNetActual = 0;
  let unresolvedLiability = 0;
  for (const record of records) {
    const reservation = BudgetReservationSchema.parse(record.reservation);
    if (reservation.providerId !== scope.providerId || reservation.accountId !== scope.accountId || reservation.currency !== scope.currency || reservation.unit !== scope.unit) continue;
    if (scope.projectId !== undefined && reservation.execution.projectId !== scope.projectId) continue;
    if (scope.utcDay !== undefined && reservation.utcDay !== scope.utcDay) continue;
    const accounting = ReservationAccountingSchema.parse(record.accounting);
    const knownForCap = accounting.netKnownActual ?? 0;
    const expectedLiability = accounting.released && accounting.knownGrossActual === null
      ? 0
      : accounting.settled ? knownForCap : Math.max(reservation.upperEstimate, knownForCap);
    const expectedUnresolved = checkedSubtract(expectedLiability, knownForCap);
    if (accounting.totalLiability !== expectedLiability || accounting.unresolvedLiability !== expectedUnresolved) throw new Error("accounting liability is inconsistent with reservation and settlement state");
    if (accounting.overrun !== (accounting.knownGrossActual !== null && accounting.knownGrossActual > reservation.upperEstimate)) throw new Error("accounting overrun does not match reservation estimate");
    knownNetActual = checkedAdd(knownNetActual, accounting.netKnownActual ?? 0);
    unresolvedLiability = checkedAdd(unresolvedLiability, accounting.unresolvedLiability);
  }
  return { knownNetActual, unresolvedLiability, totalLiability: checkedAdd(knownNetActual, unresolvedLiability) };
}

export type BudgetBlockReason =
  | "POLICY_REVOKED" | "POLICY_EXPIRED" | "POLICY_NOT_YET_VALID" | "POLICY_SCOPE_MISMATCH" | "POLICY_CAP_UNKNOWN" | "DAILY_CAP_BLOCKED" | "DAILY_CAP_EXCEEDED"
  | "AUTHORIZATION_REVOKED" | "AUTHORIZATION_EXPIRED" | "AUTHORIZATION_NOT_YET_VALID" | "AUTHORIZATION_POLICY_MISMATCH" | "AUTHORIZATION_SCOPE_MISMATCH"
  | "PROJECT_CAP_UNKNOWN" | "PROJECT_CAP_BLOCKED" | "PROJECT_CAP_EXCEEDED"
  | "EVIDENCE_MISSING_OR_STALE" | "ACCOUNT_BINDING_MISMATCH" | "QUOTE_EXPIRED" | "QUOTE_SCOPE_UNKNOWN"
  | "QUOTE_ESTIMATE_UNKNOWN" | "QUOTE_INPUT_MISMATCH" | "QUOTE_BINDING_MISMATCH" | "QUOTE_INCOMPATIBLE" | "ENTITLEMENT_UNKNOWN" | "TOTALS_INVALID";

export type BudgetDecision = { allowed: true } | { allowed: false; reason: BudgetBlockReason };

/** Pure cross-check for the existing media quote, its budget companion, and the exact provider request snapshot. */
export function validateMediaBudgetQuoteCompatibility(
  mediaValue: ProductionQuote,
  budgetValue: BudgetQuote,
  snapshotValue: ProviderRequestSnapshot,
): BudgetDecision {
  const incompatible: BudgetDecision = { allowed: false, reason: "QUOTE_INCOMPATIBLE" };
  try {
    const media = ProductionQuoteSchema.parse(mediaValue);
    const budget = BudgetQuoteSchema.parse(budgetValue);
    const snapshot = ProviderRequestSnapshotSchema.parse(snapshotValue);
    if (
      budget.mediaQuoteId !== media.id
      || budget.projectId !== media.projectId
      || budget.providerId !== media.providerId
      || budget.modelId !== media.modelId
      || budget.operation !== media.operation
      || budget.inputHash !== media.inputHash
      || snapshot.quoteId !== media.id
      || snapshot.projectId !== media.projectId
      || snapshot.providerId !== media.providerId
      || snapshot.modelId !== media.modelId
      || budget.createdAt < media.createdAt
      || budget.expiresAt > media.expiresAt
      || (media.operation === "anchor" || media.operation === "take") && snapshot.resultTarget?.kind !== media.operation
      || media.estimateMinMinor !== null && media.estimateMaxMinor !== null && media.estimateMinMinor > media.estimateMaxMinor
      || media.entitlement === "unknown"
      || budget.entitlement !== media.entitlement
      || budget.estimateMin === null
      || budget.estimateMax === null
    ) return incompatible;

    const expectedBillingMode = media.entitlement === "subscription"
      ? "subscription"
      : media.entitlement === "spark" ? "tokens" : null;
    if (expectedBillingMode === null || snapshot.billingMode !== expectedBillingMode) return incompatible;

    if (budget.unit === "minor_currency") {
      if (
        media.currency === null
        || media.estimateMinMinor === null
        || media.estimateMaxMinor === null
        || budget.currency !== media.currency
        || budget.estimateMin !== media.estimateMinMinor
        || budget.estimateMax !== media.estimateMaxMinor
      ) return incompatible;
      return { allowed: true };
    }

    if (budget.unit === "spark_token") {
      if (
        media.entitlement !== "spark"
        || budget.currency !== null
        || media.currency !== null
        || media.estimateMinMinor !== null
        || media.estimateMaxMinor !== null
      ) return incompatible;
      return { allowed: true };
    }

    return incompatible;
  } catch {
    return incompatible;
  }
}

export interface BudgetEligibilityContext {
  now: number;
  policy: AccountBudgetPolicy;
  authorization: BudgetAuthorization;
  evidence: AccountEvidence;
  quote: BudgetQuote;
  binding: QuoteAccountBinding;
  execution: BudgetExecution;
  currentCredentialBindingId: string;
  expectedQuoteInputHash: string;
  projectLiability: number;
  accountDailyLiability: number;
}

export function validateReservationEligibility(context: BudgetEligibilityContext): BudgetDecision {
  try {
    const policy = AccountBudgetPolicySchema.parse(context.policy);
    const authorization = BudgetAuthorizationSchema.parse(context.authorization);
    const evidence = AccountEvidenceSchema.parse(context.evidence);
    const quote = BudgetQuoteSchema.parse(context.quote);
    const binding = QuoteAccountBindingSchema.parse(context.binding);
    const execution = BudgetExecutionSchema.parse(context.execution);
    if (!Number.isSafeInteger(context.now) || context.now < 0 || !Number.isFinite(new Date(context.now).getTime())) return { allowed: false, reason: "TOTALS_INVALID" };
    safeAmount(context.projectLiability, "project liability");
    safeAmount(context.accountDailyLiability, "account daily liability");
    if (policy.revoked) return { allowed: false, reason: "POLICY_REVOKED" };
    if (policy.createdAt > context.now) return { allowed: false, reason: "POLICY_NOT_YET_VALID" };
    if (policy.expiresAt !== null && policy.expiresAt <= context.now) return { allowed: false, reason: "POLICY_EXPIRED" };
    if (policy.dailyCap === null) return { allowed: false, reason: "POLICY_CAP_UNKNOWN" };
    if (policy.dailyCap === 0) return { allowed: false, reason: "DAILY_CAP_BLOCKED" };
    if (policy.providerId !== execution.providerId || policy.accountId !== evidence.accountId || policy.accountId !== binding.accountId || policy.currency !== binding.currency || policy.unit !== binding.unit) return { allowed: false, reason: "POLICY_SCOPE_MISMATCH" };
    if (authorization.revoked) return { allowed: false, reason: "AUTHORIZATION_REVOKED" };
    if (authorization.createdAt > context.now) return { allowed: false, reason: "AUTHORIZATION_NOT_YET_VALID" };
    if (authorization.expiresAt !== null && authorization.expiresAt <= context.now) return { allowed: false, reason: "AUTHORIZATION_EXPIRED" };
    if (authorization.policyId !== policy.policyId) return { allowed: false, reason: "AUTHORIZATION_POLICY_MISMATCH" };
    if (quote.entitlement === "unknown") return { allowed: false, reason: "ENTITLEMENT_UNKNOWN" };
    if (authorization.projectId !== execution.projectId || !authorization.allowedModelIds.includes(execution.modelId) || !authorization.allowedOperations.includes(execution.operation) || !authorization.entitlementModes.includes(quote.entitlement)) return { allowed: false, reason: "AUTHORIZATION_SCOPE_MISMATCH" };
    if (authorization.projectCap === null) return { allowed: false, reason: "PROJECT_CAP_UNKNOWN" };
    if (authorization.projectCap === 0) return { allowed: false, reason: "PROJECT_CAP_BLOCKED" };
    if (evidence.providerId !== policy.providerId || evidence.accountId !== policy.accountId || evidence.observedAt > context.now || evidence.expiresAt <= context.now) return { allowed: false, reason: "EVIDENCE_MISSING_OR_STALE" };
    if (binding.accountEvidenceId !== evidence.id || binding.credentialBindingId !== evidence.credentialBindingId || binding.providerId !== evidence.providerId || context.currentCredentialBindingId !== evidence.credentialBindingId) return { allowed: false, reason: "ACCOUNT_BINDING_MISMATCH" };
    if (quote.expiresAt <= context.now || quote.createdAt > context.now || binding.quotedAt > context.now || binding.quotedAt < quote.createdAt || binding.quotedAt < evidence.observedAt || binding.quotedAt >= evidence.expiresAt) return { allowed: false, reason: "QUOTE_EXPIRED" };
    if (quote.unit === "unknown" || quote.currency === null && quote.unit === "minor_currency") return { allowed: false, reason: "QUOTE_SCOPE_UNKNOWN" };
    if (quote.estimateMin === null || quote.estimateMax === null) return { allowed: false, reason: "QUOTE_ESTIMATE_UNKNOWN" };
    if (quote.id !== binding.budgetQuoteId || quote.projectId !== execution.projectId || quote.providerId !== execution.providerId || quote.modelId !== execution.modelId || quote.operation !== execution.operation || quote.inputHash !== context.expectedQuoteInputHash) return { allowed: false, reason: "QUOTE_INPUT_MISMATCH" };
    if (binding.currency !== quote.currency || binding.unit !== quote.unit || binding.executionSemanticHash !== execution.executionSemanticHash || binding.providerId !== execution.providerId || binding.accountId !== evidence.accountId) return { allowed: false, reason: "QUOTE_BINDING_MISMATCH" };
    const estimate = quote.estimateMax;
    if (checkedAdd(context.projectLiability, estimate) > authorization.projectCap) return { allowed: false, reason: "PROJECT_CAP_EXCEEDED" };
    if (checkedAdd(context.accountDailyLiability, estimate) > policy.dailyCap) return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "TOTALS_INVALID" };
  }
}
