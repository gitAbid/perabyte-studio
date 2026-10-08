import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountBudgetPolicyCommandSchema,
  AccountBudgetPolicySchema,
  AccountEvidenceSchema,
  AuthorizeBudgetCommandSchema,
  BudgetUtcMillisSchema,
  BudgetAuthorizationSchema,
  BudgetExecutionSchema,
  BudgetQuoteSchema,
  BudgetReservationSchema,
  IdSchema,
  MoneyScopeSchema,
  ProviderRequestSnapshotSchema,
  QuoteAccountBindingSchema,
  ReconciliationEvidenceSchema,
  type AccountBudgetPolicy,
  type AccountEvidence,
  type AuthorizeBudgetCommand,
  type BudgetAuthorization,
  type BudgetExecution,
  type BudgetReservation,
  type MoneyScope,
  type ProductionJob,
  type ProviderRequestSnapshot,
  type QuoteAccountBinding,
  type ReconciliationEvidence,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { foldReservation, summarizeBudget, utcBudgetDay, validateMediaBudgetQuoteCompatibility, validateReservationEligibility, type BudgetBlockReason, type BudgetSummary } from "../../production/budget";
import { productionSubmissionEligibilityFingerprint, computeProductionInputsHash } from "../../jobs/production/queue";
import type { BudgetScope, LedgerScope, ProductionStore, ProductionWritePort, StoredEvidence } from "../../repositories/production/ports";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { withProductionStore } from "../../production/runtime";

export type BudgetScopeRequest = Pick<MoneyScope, "providerId" | "unit" | "currency">;
export type AccountBudgetPolicyCommand = z.infer<typeof AccountBudgetPolicyCommandSchema>;
export type CreateAccountPolicyCommand = BudgetScopeRequest & Pick<AccountBudgetPolicy, "dailyCap" | "expiresAt" | "revoked" | "actorId">;
export type TrustedAccountIdentity = Readonly<{ providerId: string; accountId: string; accountEvidenceId: string; credentialBindingId: string }>;
export type TrustedPreparedExecutionEvidence = Readonly<{ accountEvidenceId: string; budgetQuoteId: string; expectedQuoteInputHash: string; executionSemanticHash: string; credentialBindingId: string }>;

export interface PreparedBudgetContext extends TrustedPreparedExecutionEvidence {
  policyId: string;
  expectedPolicyRevision: number;
  expectedAuthorizationRevision: number;
}

export interface BudgetServiceOptions {
  store: ProductionStore;
  resolveAccountIdentity?: (providerId: string) => Promise<TrustedAccountIdentity>;
  prepareExecutionEvidence?: (input: Readonly<{ execution: BudgetExecution; budgetQuoteId: string }>) => Promise<TrustedPreparedExecutionEvidence>;
  currentCredentialBindingId?: (providerId: string) => string | null;
  produceReconciliationEvidence?: (input: Readonly<{ reservation: BudgetReservation; reference: string }>) => Promise<ReconciliationEvidence>;
  now?: () => number;
  idFactory?: () => string;
}

export type BudgetPolicyView = Omit<AccountBudgetPolicy, "accountId">;
export type BudgetAuthorizationView = BudgetAuthorization;
export type BudgetReadReason =
  | "ACCOUNT_IDENTITY_UNAVAILABLE" | "POLICY_MISSING" | "AUTHORIZATION_MISSING" | "EVIDENCE_MISSING_OR_STALE" | "ACCOUNT_BINDING_MISMATCH"
  | "POLICY_REVOKED" | "POLICY_EXPIRED" | "POLICY_NOT_YET_VALID" | "POLICY_CAP_UNKNOWN" | "DAILY_CAP_BLOCKED"
  | "AUTHORIZATION_REVOKED" | "AUTHORIZATION_EXPIRED" | "AUTHORIZATION_NOT_YET_VALID" | "PROJECT_CAP_UNKNOWN" | "PROJECT_CAP_BLOCKED" | "TOTALS_INVALID";
export interface ProjectBudgetReadModel {
  schemaVersion: 1;
  projectId: string;
  scope: BudgetScopeRequest;
  utcDay: string;
  availability: "available" | "unavailable";
  policy: BudgetPolicyView | null;
  authorization: BudgetAuthorizationView | null;
  projectTotals: BudgetSummary | null;
  accountDailyTotals: BudgetSummary | null;
  unresolved: boolean | null;
  overrun: boolean | null;
  reconciliationConflict: boolean | null;
  reasons: BudgetReadReason[];
}

export interface ProductionBudgetService {
  createPolicy(projectId: string, command: CreateAccountPolicyCommand): Promise<AccountBudgetPolicy>;
  updatePolicy(projectId: string, scope: BudgetScopeRequest, command: AccountBudgetPolicyCommand): Promise<AccountBudgetPolicy>;
  authorizeProject(projectId: string, scope: BudgetScopeRequest, command: AuthorizeBudgetCommand): Promise<BudgetAuthorization>;
  getReadModel(projectId: string, scope: BudgetScopeRequest): Promise<ProjectBudgetReadModel>;
  prepareBudgetContext(execution: BudgetExecution, budgetQuoteId: string): Promise<PreparedBudgetContext>;
  reserveInTransaction(tx: ProductionWritePort, execution: BudgetExecution, now: number, context: PreparedBudgetContext): BudgetReservation;
  reconcile(reservationId: string, reference: string): Promise<StoredEvidence>;
}

const MAX_BODY_BYTES = 16 * 1024;
const IdFactorySchema = IdSchema;
const ScopeSchema = z.strictObject({ providerId: IdSchema, unit: z.enum(["minor_currency", "spark_token"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable() })
  .superRefine((scope, ctx) => {
    if ((scope.unit === "minor_currency") !== (scope.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency must match unit" });
  });

function blocked(reason: BudgetBlockReason | "ACCOUNT_IDENTITY_UNAVAILABLE"): never {
  throw new ProductionApplicationError("BUDGET_BLOCKED", "The provider account could not be safely verified for this budget operation.", { details: { reason } });
}
function unknownProject(): never { throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Project does not exist."); }
function stale(): never { throw new ProductionApplicationError("STALE_REVISION", "The budget changed. Reload it and try again."); }
function mismatch(): never { throw new ProductionApplicationError("UNKNOWN_REFERENCE", "The requested budget scope does not exist."); }
function invalid(message = "Budget request is invalid."): never { throw new ProductionApplicationError("INVALID_INPUT", message); }
function readScope(scope: BudgetScopeRequest, accountId: string): BudgetScope {
  const parsed = ScopeSchema.safeParse({ providerId: scope.providerId, unit: scope.unit, currency: scope.currency });
  if (!parsed.success) invalid();
  return MoneyScopeSchema.parse({ ...parsed.data, accountId });
}
function sanitizePolicy(policy: AccountBudgetPolicy): BudgetPolicyView {
  const { accountId: _accountId, ...view } = policy;
  return view;
}
function safeGeneratedId(idFactory: () => string): string {
  const parsed = IdFactorySchema.safeParse(idFactory());
  if (!parsed.success) throw new Error("ID factory returned an invalid ID");
  return parsed.data;
}
function safeNow(now: () => number): number {
  const value = now();
  return BudgetUtcMillisSchema.parse(value);
}
function budgetError(reason: BudgetBlockReason): never { return blocked(reason); }
function totals(tx: ProductionWritePort, scope: LedgerScope): BudgetSummary {
  return summarizeBudget(tx.listBudgetLedger(scope).map(entry => ({ reservation: entry.reservation, accounting: foldReservation(entry.reservation, entry.events.map(event => event.evidence)) })), scope);
}
function addReason(reasons: BudgetReadReason[], reason: BudgetReadReason): void { if (!reasons.includes(reason)) reasons.push(reason); }

export function createProductionBudgetService(options: BudgetServiceOptions): ProductionBudgetService {
  const { store } = options;
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;

  const requireProject = (projectId: string): void => {
    if (!IdSchema.safeParse(projectId).success) invalid();
    if (!store.read.getProject(projectId)) unknownProject();
  };

  const resolveIdentity = async (providerId: string): Promise<TrustedAccountIdentity> => {
    if (!options.resolveAccountIdentity || !options.currentCredentialBindingId) blocked("ACCOUNT_IDENTITY_UNAVAILABLE");
    let identity: TrustedAccountIdentity;
    try { identity = await options.resolveAccountIdentity(providerId); }
    catch { return blocked("ACCOUNT_IDENTITY_UNAVAILABLE"); }
    if (!identity || identity.providerId !== providerId || !IdSchema.safeParse(identity.accountId).success || !IdSchema.safeParse(identity.accountEvidenceId).success || !IdSchema.safeParse(identity.credentialBindingId).success) blocked("ACCOUNT_IDENTITY_UNAVAILABLE");
    return identity;
  };

  const requireCurrentEvidence = (tx: ProductionWritePort, identity: TrustedAccountIdentity, at: number): AccountEvidence => {
    const evidence = AccountEvidenceSchema.safeParse(tx.getAccountEvidence(identity.accountEvidenceId));
    if (!evidence.success) return blocked("EVIDENCE_MISSING_OR_STALE");
    const value = evidence.data;
    if (value.providerId !== identity.providerId || value.accountId !== identity.accountId || value.credentialBindingId !== identity.credentialBindingId || value.observedAt > at || value.expiresAt <= at) blocked("EVIDENCE_MISSING_OR_STALE");
    let currentBinding: string | null;
    try { currentBinding = options.currentCredentialBindingId?.(identity.providerId) ?? null; } catch { return blocked("ACCOUNT_BINDING_MISMATCH"); }
    if (currentBinding === null || currentBinding !== identity.credentialBindingId) blocked("ACCOUNT_BINDING_MISMATCH");
    return value;
  };

  const appendPolicyRevision = (tx: ProductionWritePort, policy: AccountBudgetPolicy, expected: number | null): AccountBudgetPolicy => {
    if (!tx.appendAccountPolicy(policy, expected)) stale();
    return policy;
  };

  const createPolicy: ProductionBudgetService["createPolicy"] = async (projectId, command) => {
    requireProject(projectId);
    const parsed = z.strictObject({ providerId: IdSchema, unit: z.enum(["minor_currency", "spark_token"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), dailyCap: z.number().int().safe().nonnegative().nullable(), expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema }).safeParse(command);
    if (!parsed.success) invalid();
    const money = MoneyScopeSchema.safeParse({ providerId: parsed.data.providerId, unit: parsed.data.unit, currency: parsed.data.currency, accountId: "identity-placeholder" });
    if (!money.success) invalid();
    const identity = await resolveIdentity(parsed.data.providerId);
    const scope = readScope(parsed.data, identity.accountId);
    return store.transaction(tx => {
      const stamp = safeNow(now);
      requireCurrentEvidence(tx, identity, stamp);
      if (tx.getLatestAccountPolicy(scope)) stale();
      const policy = AccountBudgetPolicySchema.parse({ schemaVersion: 1, revisionId: safeGeneratedId(idFactory), policyId: safeGeneratedId(idFactory), revision: 1, ...scope, dailyCap: parsed.data.dailyCap, expiresAt: parsed.data.expiresAt, revoked: parsed.data.revoked, actorId: parsed.data.actorId, createdAt: stamp });
      return appendPolicyRevision(tx, policy, null);
    });
  };

  const updatePolicy: ProductionBudgetService["updatePolicy"] = async (projectId, scopeRequest, command) => {
    requireProject(projectId);
    const parsedCommand = AccountBudgetPolicyCommandSchema.safeParse(command);
    const parsedScope = ScopeSchema.safeParse(scopeRequest);
    if (!parsedCommand.success || !parsedScope.success || parsedCommand.data.expectedPolicyRevision === null) invalid();
    const identity = await resolveIdentity(parsedScope.data.providerId);
    const scope = readScope(parsedScope.data, identity.accountId);
    return store.transaction(tx => {
      const stamp = safeNow(now);
      requireCurrentEvidence(tx, identity, stamp);
      const prior = tx.getLatestAccountPolicy(scope);
      if (!prior || prior.policyId !== parsedCommand.data.policyId) mismatch();
      if (prior.revision !== parsedCommand.data.expectedPolicyRevision) stale();
      const policy = AccountBudgetPolicySchema.parse({ ...prior, revisionId: safeGeneratedId(idFactory), revision: prior.revision + 1, dailyCap: parsedCommand.data.dailyCap, expiresAt: parsedCommand.data.expiresAt, revoked: parsedCommand.data.revoked, actorId: parsedCommand.data.actorId, createdAt: stamp });
      return appendPolicyRevision(tx, policy, prior.revision);
    });
  };

  const authorizeProject: ProductionBudgetService["authorizeProject"] = async (projectId, scopeRequest, command) => {
    requireProject(projectId);
    const parsedCommand = AuthorizeBudgetCommandSchema.safeParse(command);
    const parsedScope = ScopeSchema.safeParse(scopeRequest);
    if (!parsedCommand.success || !parsedScope.success || parsedCommand.data.expectedPolicyRevision === null) invalid();
    const identity = await resolveIdentity(parsedScope.data.providerId);
    const scope = readScope(parsedScope.data, identity.accountId);
    return store.transaction(tx => {
      const stamp = safeNow(now);
      requireCurrentEvidence(tx, identity, stamp);
      const policy = tx.getLatestAccountPolicy(scope);
      if (!policy || policy.policyId !== parsedCommand.data.policyId) mismatch();
      if (policy.revision !== parsedCommand.data.expectedPolicyRevision) stale();
      const prior = tx.getLatestBudgetAuthorization(projectId, policy.policyId);
      if ((prior?.revision ?? null) !== parsedCommand.data.expectedAuthorizationRevision) stale();
      const authorization = BudgetAuthorizationSchema.parse({
        schemaVersion: 1, revisionId: safeGeneratedId(idFactory), authorizationId: prior?.authorizationId ?? safeGeneratedId(idFactory), revision: (prior?.revision ?? 0) + 1,
        projectId, policyId: policy.policyId, policyRevisionIdAtAuthorization: policy.revisionId,
        projectCap: parsedCommand.data.projectCap, allowedModelIds: parsedCommand.data.allowedModelIds,
        allowedOperations: parsedCommand.data.allowedOperations, entitlementModes: parsedCommand.data.entitlementModes,
        expiresAt: parsedCommand.data.expiresAt, revoked: parsedCommand.data.revoked, actorId: parsedCommand.data.actorId, createdAt: stamp,
      });
      if (!tx.appendBudgetAuthorization(authorization, prior?.revision ?? null)) stale();
      return authorization;
    });
  };

  const getReadModel: ProductionBudgetService["getReadModel"] = async (projectId, scopeRequest) => {
    requireProject(projectId);
    const parsed = ScopeSchema.safeParse(scopeRequest);
    if (!parsed.success) invalid();
    const unavailable = (day: string, reason: BudgetReadReason): ProjectBudgetReadModel => ({ schemaVersion: 1, projectId, scope: parsed.data, utcDay: day, availability: "unavailable", policy: null, authorization: null, projectTotals: null, accountDailyTotals: null, unresolved: null, overrun: null, reconciliationConflict: null, reasons: [reason] });
    let day: string;
    try { day = utcBudgetDay(safeNow(now)); } catch { return unavailable("1970-01-01", "TOTALS_INVALID"); }
    if (!options.resolveAccountIdentity || !options.currentCredentialBindingId) return unavailable(day, "ACCOUNT_IDENTITY_UNAVAILABLE");
    let identity: TrustedAccountIdentity;
    try { identity = await options.resolveAccountIdentity(parsed.data.providerId); } catch { return unavailable(day, "ACCOUNT_IDENTITY_UNAVAILABLE"); }
    if (!identity || identity.providerId !== parsed.data.providerId || !IdSchema.safeParse(identity.accountId).success || !IdSchema.safeParse(identity.accountEvidenceId).success || !IdSchema.safeParse(identity.credentialBindingId).success) return unavailable(day, "ACCOUNT_IDENTITY_UNAVAILABLE");
    const scope = readScope(parsed.data, identity.accountId);
    return store.transaction(tx => {
      const stamp = safeNow(now);
      const today = utcBudgetDay(stamp);
      const evidence = AccountEvidenceSchema.safeParse(tx.getAccountEvidence(identity.accountEvidenceId));
      const reasons: BudgetReadReason[] = [];
      if (!evidence.success || evidence.data.providerId !== identity.providerId || evidence.data.accountId !== identity.accountId || evidence.data.credentialBindingId !== identity.credentialBindingId || evidence.data.observedAt > stamp || evidence.data.expiresAt <= stamp) addReason(reasons, "EVIDENCE_MISSING_OR_STALE");
      let currentBinding: string | null;
      try { currentBinding = options.currentCredentialBindingId?.(identity.providerId) ?? null; } catch { return { ...unavailable(today, "ACCOUNT_BINDING_MISMATCH"), reasons: ["ACCOUNT_BINDING_MISMATCH"] }; }
      if (currentBinding !== identity.credentialBindingId) addReason(reasons, "ACCOUNT_BINDING_MISMATCH");
      if (reasons.length) return { ...unavailable(today, reasons[0]!), reasons };
      const policy = tx.getLatestAccountPolicy(scope);
      const authorization = policy ? tx.getLatestBudgetAuthorization(projectId, policy.policyId) : null;
      if (!policy) addReason(reasons, "POLICY_MISSING");
      if (!authorization) addReason(reasons, "AUTHORIZATION_MISSING");
      if (policy) {
        if (policy.revoked) addReason(reasons, "POLICY_REVOKED");
        if (policy.createdAt > stamp) addReason(reasons, "POLICY_NOT_YET_VALID");
        if (policy.expiresAt !== null && policy.expiresAt <= stamp) addReason(reasons, "POLICY_EXPIRED");
        if (policy.dailyCap === null) addReason(reasons, "POLICY_CAP_UNKNOWN");
        if (policy.dailyCap === 0) addReason(reasons, "DAILY_CAP_BLOCKED");
      }
      if (authorization) {
        if (authorization.revoked) addReason(reasons, "AUTHORIZATION_REVOKED");
        if (authorization.createdAt > stamp) addReason(reasons, "AUTHORIZATION_NOT_YET_VALID");
        if (authorization.expiresAt !== null && authorization.expiresAt <= stamp) addReason(reasons, "AUTHORIZATION_EXPIRED");
        if (authorization.projectCap === null) addReason(reasons, "PROJECT_CAP_UNKNOWN");
        if (authorization.projectCap === 0) addReason(reasons, "PROJECT_CAP_BLOCKED");
      }
      try {
        const projectTotals = totals(tx, { kind: "project", projectId, ...scope });
        const accountDailyTotals = totals(tx, { kind: "account_day", utcDay: today, ...scope });
        const entries = tx.listBudgetLedger({ kind: "project", projectId, ...scope });
        const accountings = entries.map(entry => foldReservation(entry.reservation, entry.events.map(event => event.evidence)));
        return { schemaVersion: 1, projectId, scope: parsed.data, utcDay: today, availability: "available", policy: policy ? sanitizePolicy(policy) : null, authorization, projectTotals, accountDailyTotals, unresolved: accountings.some(item => !item.settled), overrun: accountings.some(item => item.overrun), reconciliationConflict: accountings.some(item => item.reconciliationConflict), reasons };
      } catch { addReason(reasons, "TOTALS_INVALID"); return unavailable(today, "TOTALS_INVALID"); }
    });
  };

  const prepareBudgetContext: ProductionBudgetService["prepareBudgetContext"] = async (executionValue, budgetQuoteId) => {
    const executionParsed = BudgetExecutionSchema.safeParse(executionValue);
    if (!executionParsed.success || !IdSchema.safeParse(budgetQuoteId).success) invalid();
    const execution = executionParsed.data;
    if (!options.prepareExecutionEvidence) blocked("ACCOUNT_IDENTITY_UNAVAILABLE");
    let prepared: TrustedPreparedExecutionEvidence;
    try { prepared = await options.prepareExecutionEvidence({ execution, budgetQuoteId }); } catch { return blocked("ACCOUNT_IDENTITY_UNAVAILABLE"); }
    const proof = z.strictObject({ accountEvidenceId: IdSchema, budgetQuoteId: IdSchema, expectedQuoteInputHash: z.string().regex(/^[a-f0-9]{64}$/), executionSemanticHash: z.string().regex(/^[a-f0-9]{64}$/), credentialBindingId: IdSchema }).safeParse(prepared);
    if (!proof.success || proof.data.budgetQuoteId !== budgetQuoteId || proof.data.executionSemanticHash !== execution.executionSemanticHash) blocked("QUOTE_BINDING_MISMATCH");
    return store.transaction(tx => {
      const stamp = safeNow(now);
      const quote = BudgetQuoteSchema.safeParse(tx.getBudgetQuote(budgetQuoteId));
      if (!quote.success) blocked("QUOTE_INPUT_MISMATCH");
      const binding = QuoteAccountBindingSchema.safeParse(tx.getQuoteAccountBinding(budgetQuoteId));
      const evidence = AccountEvidenceSchema.safeParse(tx.getAccountEvidence(proof.data.accountEvidenceId));
      if (!binding.success || !evidence.success) blocked("ACCOUNT_BINDING_MISMATCH");
      const trusted = evidence.data;
      if (trusted.providerId !== execution.providerId || trusted.credentialBindingId !== proof.data.credentialBindingId || trusted.observedAt > stamp || trusted.expiresAt <= stamp) blocked("EVIDENCE_MISSING_OR_STALE");
      let currentBinding: string | null;
      try { currentBinding = options.currentCredentialBindingId?.(execution.providerId) ?? null; } catch { return blocked("ACCOUNT_BINDING_MISMATCH"); }
      if (currentBinding === null || currentBinding !== proof.data.credentialBindingId) blocked("ACCOUNT_BINDING_MISMATCH");
      if (quote.data.projectId !== execution.projectId || quote.data.providerId !== execution.providerId || quote.data.modelId !== execution.modelId || quote.data.operation !== execution.operation || quote.data.inputHash !== proof.data.expectedQuoteInputHash || quote.data.expiresAt <= stamp || quote.data.createdAt > stamp) blocked("QUOTE_INPUT_MISMATCH");
      if (binding.data.accountEvidenceId !== trusted.id || binding.data.providerId !== trusted.providerId || binding.data.accountId !== trusted.accountId || binding.data.credentialBindingId !== trusted.credentialBindingId || binding.data.executionSemanticHash !== execution.executionSemanticHash || binding.data.currency !== quote.data.currency || binding.data.unit !== quote.data.unit) blocked("QUOTE_BINDING_MISMATCH");
      if ((execution.kind === "text_proposal") !== (quote.data.mediaQuoteId === null)) blocked("QUOTE_INPUT_MISMATCH");
      if (execution.kind === "media_job") {
        if (execution.operation !== "anchor" && execution.operation !== "take") blocked("QUOTE_INPUT_MISMATCH");
        const job = tx.getJob(execution.executionId);
        if (!job || !thisJobMatches(job, execution)) blocked("QUOTE_INPUT_MISMATCH");
        const snapshot = parseSnapshot(job.requestSnapshot);
        const mediaQuoteId = quote.data.mediaQuoteId;
        const mediaQuote = mediaQuoteId ? tx.getQuote(mediaQuoteId) : null;
        if (!snapshot || !mediaQuote || mediaQuote.id !== job.quoteId || snapshot.quoteId !== mediaQuote.id || tx.getBudgetQuoteForMediaQuote(mediaQuote.id)?.id !== quote.data.id || mediaQuote.inputHash !== proof.data.expectedQuoteInputHash || mediaQuote.inputHash !== quote.data.inputHash) blocked("QUOTE_INPUT_MISMATCH");
        const compatibility = validateMediaBudgetQuoteCompatibility(mediaQuote, quote.data, snapshot);
        if (!compatibility.allowed) blocked(compatibility.reason);
        if (mediaQuote.expiresAt <= stamp || mediaQuote.createdAt > stamp) blocked("QUOTE_EXPIRED");
        const semantic = computeProductionInputsHash(tx, execution.operation, snapshot);
        if (semantic !== execution.executionSemanticHash || semantic !== snapshot.resultTarget?.inputsHash) blocked("QUOTE_BINDING_MISMATCH");
        if (!productionSubmissionEligibilityFingerprint(tx, job, mediaQuote, snapshot)) blocked("QUOTE_INPUT_MISMATCH");
      }
      // Budget quote unknown units cannot define a reservation scope; they remain viewable but cannot be prepared.
      if (binding.data.unit === "unknown") blocked("QUOTE_SCOPE_UNKNOWN");
      const moneyScope = MoneyScopeSchema.safeParse({ providerId: trusted.providerId, accountId: trusted.accountId, currency: binding.data.currency, unit: binding.data.unit });
      if (!moneyScope.success) blocked("QUOTE_BINDING_MISMATCH");
      const policy = tx.getLatestAccountPolicy(moneyScope.data);
      if (!policy) blocked("POLICY_SCOPE_MISMATCH");
      const authorization = tx.getLatestBudgetAuthorization(execution.projectId, policy.policyId);
      if (!authorization) blocked("AUTHORIZATION_POLICY_MISMATCH");
      return { ...proof.data, policyId: policy.policyId, expectedPolicyRevision: policy.revision, expectedAuthorizationRevision: authorization.revision };
    });
  };

  const reserveInTransaction: ProductionBudgetService["reserveInTransaction"] = (tx, executionValue, at, context) => {
    const execution = BudgetExecutionSchema.parse(executionValue);
    const parsedContext = z.strictObject({ accountEvidenceId: IdSchema, budgetQuoteId: IdSchema, expectedQuoteInputHash: z.string().regex(/^[a-f0-9]{64}$/), executionSemanticHash: z.string().regex(/^[a-f0-9]{64}$/), credentialBindingId: IdSchema, policyId: IdSchema, expectedPolicyRevision: z.number().int().safe().positive(), expectedAuthorizationRevision: z.number().int().safe().positive() }).safeParse(context);
    if (!parsedContext.success || parsedContext.data.executionSemanticHash !== execution.executionSemanticHash || !BudgetUtcMillisSchema.safeParse(at).success) invalid();
    const prepared = parsedContext.data;
    let currentBinding: string | null;
    try { currentBinding = options.currentCredentialBindingId?.(execution.providerId) ?? null; } catch { return budgetError("ACCOUNT_BINDING_MISMATCH"); }
    if (!options.currentCredentialBindingId || currentBinding === null || currentBinding !== prepared.credentialBindingId) budgetError("ACCOUNT_BINDING_MISMATCH");
    const quote = BudgetQuoteSchema.safeParse(tx.getBudgetQuote(prepared.budgetQuoteId));
    const binding = QuoteAccountBindingSchema.safeParse(tx.getQuoteAccountBinding(prepared.budgetQuoteId));
    const evidence = AccountEvidenceSchema.safeParse(tx.getAccountEvidence(prepared.accountEvidenceId));
    if (!quote.success || !binding.success) budgetError("QUOTE_BINDING_MISMATCH");
    if (!evidence.success || evidence.data.credentialBindingId !== prepared.credentialBindingId || evidence.data.providerId !== execution.providerId || evidence.data.observedAt > at || evidence.data.expiresAt <= at) budgetError("EVIDENCE_MISSING_OR_STALE");
    if (binding.data.accountEvidenceId !== evidence.data.id || binding.data.credentialBindingId !== prepared.credentialBindingId || binding.data.executionSemanticHash !== execution.executionSemanticHash || quote.data.inputHash !== prepared.expectedQuoteInputHash || quote.data.projectId !== execution.projectId || quote.data.providerId !== execution.providerId || quote.data.modelId !== execution.modelId || quote.data.operation !== execution.operation || quote.data.expiresAt <= at) budgetError("QUOTE_INPUT_MISMATCH");
    if (binding.data.unit === "unknown" || quote.data.unit === "unknown") budgetError("QUOTE_SCOPE_UNKNOWN");
    if (quote.data.estimateMax === null) budgetError("QUOTE_ESTIMATE_UNKNOWN");
    const scope = MoneyScopeSchema.parse({ providerId: execution.providerId, accountId: evidence.data.accountId, currency: binding.data.currency, unit: binding.data.unit });
    const policy = tx.getLatestAccountPolicy(scope);
    if (!policy) budgetError("POLICY_SCOPE_MISMATCH");
    if (policy.policyId !== prepared.policyId) budgetError("POLICY_SCOPE_MISMATCH");
    if (execution.kind === "media_job") {
      if (execution.operation !== "anchor" && execution.operation !== "take") budgetError("QUOTE_INPUT_MISMATCH");
      const job = tx.getJob(execution.executionId);
      if (!job || !thisJobMatches(job, execution)) budgetError("QUOTE_INPUT_MISMATCH");
      const snapshot = parseSnapshot(job.requestSnapshot);
      const mediaQuote = quote.data.mediaQuoteId ? tx.getQuote(quote.data.mediaQuoteId) : null;
      if (!snapshot || !mediaQuote) budgetError("QUOTE_INPUT_MISMATCH");
      const compatibility = validateMediaBudgetQuoteCompatibility(mediaQuote, quote.data, snapshot);
      if (!compatibility.allowed) budgetError(compatibility.reason);
      if (snapshot.quoteId !== mediaQuote.id || job.quoteId !== mediaQuote.id || tx.getBudgetQuoteForMediaQuote(mediaQuote.id)?.id !== quote.data.id || mediaQuote.inputHash !== prepared.expectedQuoteInputHash || computeProductionInputsHash(tx, execution.operation, snapshot) !== execution.executionSemanticHash || !productionSubmissionEligibilityFingerprint(tx, job, mediaQuote, snapshot)) budgetError("QUOTE_INPUT_MISMATCH");
      if (mediaQuote.expiresAt <= at || mediaQuote.createdAt > at) budgetError("QUOTE_EXPIRED");
    } else if (quote.data.mediaQuoteId !== null) budgetError("QUOTE_INPUT_MISMATCH");

    const byExecution = tx.getReservationByExecution(execution.executionId);
    const byKey = tx.getReservationByIdempotency(execution.projectId, execution.idempotencyKey);
    const existing = byExecution ?? byKey;
    if (existing) {
      const pinnedPolicy = tx.getAccountPolicyRevision(existing.policyRevisionId);
      const pinnedAuthorization = tx.getBudgetAuthorizationRevision(existing.authorizationRevisionId);
      if ((byExecution && byExecution.id !== existing.id) || (byKey && byKey.id !== existing.id) || hashCanonicalJson(existing.execution) !== hashCanonicalJson(execution) || existing.budgetQuoteId !== prepared.budgetQuoteId || existing.accountEvidenceId !== prepared.accountEvidenceId || existing.credentialBindingId !== prepared.credentialBindingId || existing.providerId !== scope.providerId || existing.accountId !== scope.accountId || existing.currency !== scope.currency || existing.unit !== scope.unit || existing.quoteBindingId !== binding.data.id || existing.execution.executionSemanticHash !== prepared.executionSemanticHash || pinnedPolicy?.policyId !== prepared.policyId || pinnedPolicy.revision !== prepared.expectedPolicyRevision || pinnedPolicy.providerId !== scope.providerId || pinnedPolicy.accountId !== scope.accountId || pinnedPolicy.currency !== scope.currency || pinnedPolicy.unit !== scope.unit || pinnedAuthorization?.projectId !== execution.projectId || pinnedAuthorization.policyId !== prepared.policyId || pinnedAuthorization.revision !== prepared.expectedAuthorizationRevision) budgetError("QUOTE_BINDING_MISMATCH");
      return existing;
    }

    const authorization = tx.getLatestBudgetAuthorization(execution.projectId, policy.policyId);
    if (!authorization) budgetError("AUTHORIZATION_POLICY_MISMATCH");
    if (policy.revision !== prepared.expectedPolicyRevision || authorization.revision !== prepared.expectedAuthorizationRevision) stale();

    const projectTotals = totals(tx, { kind: "project", projectId: execution.projectId, ...scope });
    const accountTotals = totals(tx, { kind: "account_day", utcDay: utcBudgetDay(at), ...scope });
    const decision = validateReservationEligibility({ now: at, policy, authorization, evidence: evidence.data, quote: quote.data, binding: binding.data, execution, currentCredentialBindingId: currentBinding, expectedQuoteInputHash: prepared.expectedQuoteInputHash, projectLiability: projectTotals.totalLiability, accountDailyLiability: accountTotals.totalLiability });
    if (!decision.allowed) budgetError(decision.reason);
    tx.registerBudgetExecution(execution);
    const reservation = BudgetReservationSchema.parse({ schemaVersion: 1, id: safeGeneratedId(idFactory), execution, authorizationRevisionId: authorization.revisionId, policyRevisionId: policy.revisionId, budgetQuoteId: quote.data.id, quoteBindingId: binding.data.id, accountEvidenceId: evidence.data.id, providerId: execution.providerId, accountId: evidence.data.accountId, credentialBindingId: evidence.data.credentialBindingId, currency: binding.data.currency, unit: binding.data.unit, upperEstimate: quote.data.estimateMax, reservedAt: at, utcDay: utcBudgetDay(at) });
    const stored = tx.insertBudgetReservation(reservation);
    if (!stored.created || hashCanonicalJson(stored.record) !== hashCanonicalJson(reservation)) throw new Error("Budget reservation insert did not create the prepared reservation");
    return stored.record;
  };

  const reconcile: ProductionBudgetService["reconcile"] = async (reservationId, reference) => {
    if (!IdSchema.safeParse(reservationId).success || typeof reference !== "string" || reference.length < 1 || reference.length > 500) invalid();
    if (!options.produceReconciliationEvidence) blocked("ACCOUNT_IDENTITY_UNAVAILABLE");
    const reservation = store.read.getBudgetReservation(reservationId);
    if (!reservation) mismatch();
    let evidence: ReconciliationEvidence;
    try { evidence = await options.produceReconciliationEvidence({ reservation, reference }); } catch { return blocked("ACCOUNT_IDENTITY_UNAVAILABLE"); }
    const parsed = ReconciliationEvidenceSchema.safeParse(evidence);
    if (!parsed.success || parsed.data.provenance.kind !== "provider" || parsed.data.reservationId !== reservation.id || parsed.data.providerId !== reservation.providerId || parsed.data.accountId !== reservation.accountId || parsed.data.currency !== reservation.currency || parsed.data.unit !== reservation.unit || parsed.data.reference !== reference) budgetError("QUOTE_BINDING_MISMATCH");
    return store.transaction(tx => {
      const current = tx.getBudgetReservation(reservation.id);
      if (!current || hashCanonicalJson(current) !== hashCanonicalJson(reservation)) mismatch();
      return tx.appendReconciliationEvidence(parsed.data).record;
    });
  };

  return { createPolicy, updatePolicy, authorizeProject, getReadModel, prepareBudgetContext, reserveInTransaction, reconcile };
}

function thisJobMatches(job: ProductionJob, execution: BudgetExecution): boolean {
  return execution.kind === "media_job" && job.id === execution.executionId && job.projectId === execution.projectId && job.idempotencyKey === execution.idempotencyKey && job.requestHash === execution.requestHash && job.operation === execution.operation && job.providerId === execution.providerId && job.modelId === execution.modelId;
}
function parseSnapshot(value: unknown): ProviderRequestSnapshot | null {
  const parsed = ProviderRequestSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type BudgetRouteCommand =
  | ({ kind: "create_policy" } & CreateAccountPolicyCommand)
  | ({ kind: "update_policy"; command: AccountBudgetPolicyCommand } & BudgetScopeRequest)
  | ({ kind: "authorize"; command: AuthorizeBudgetCommand } & BudgetScopeRequest);
const CreatePolicyBodySchema = z.strictObject({ kind: z.literal("create_policy"), providerId: IdSchema, unit: z.enum(["minor_currency", "spark_token"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), dailyCap: z.number().int().safe().nonnegative().nullable(), expiresAt: BudgetUtcMillisSchema.nullable(), revoked: z.boolean(), actorId: IdSchema }).superRefine((value, ctx) => { if ((value.unit === "minor_currency") !== (value.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency must match unit" }); });
const UpdatePolicyBodySchema = z.strictObject({ kind: z.literal("update_policy"), providerId: IdSchema, unit: z.enum(["minor_currency", "spark_token"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), command: AccountBudgetPolicyCommandSchema }).superRefine((value, ctx) => { if ((value.unit === "minor_currency") !== (value.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency must match unit" }); if (value.command.expectedPolicyRevision === null) ctx.addIssue({ code: "custom", path: ["command", "expectedPolicyRevision"], message: "Update requires a positive revision" }); });
const AuthorizeBodySchema = z.strictObject({ kind: z.literal("authorize"), providerId: IdSchema, unit: z.enum(["minor_currency", "spark_token"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), command: AuthorizeBudgetCommandSchema }).superRefine((value, ctx) => { if ((value.unit === "minor_currency") !== (value.currency !== null)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency must match unit" }); });
const BudgetRouteCommandSchema = z.discriminatedUnion("kind", [CreatePolicyBodySchema, UpdatePolicyBodySchema, AuthorizeBodySchema]);

export interface BudgetRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  serviceOptions?: Omit<BudgetServiceOptions, "store">;
}
export function createBudgetRouteHandlers(options: BudgetRouteHandlerOptions = {}) {
  const withStore: NonNullable<BudgetRouteHandlerOptions["withStore"]> = options.withStore ?? (work => withProductionStore(store => work(store)));
  return {
    async GET(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        const { projectId } = await context.params;
        if (!IdSchema.safeParse(projectId).success) invalid();
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some(key => !["providerId", "unit", "currency"].includes(key))) invalid("Budget query contains unsupported parameters.");
        for (const name of ["providerId", "unit"]) if (url.searchParams.getAll(name).length !== 1) invalid("Budget query requires exactly one providerId and unit.");
        const unit = url.searchParams.get("unit");
        const currencies = url.searchParams.getAll("currency");
        if (unit === "minor_currency" && currencies.length !== 1 || unit === "spark_token" && currencies.length !== 0) invalid("Budget currency must match its unit.");
        const parsedScope = ScopeSchema.safeParse({ providerId: url.searchParams.get("providerId"), unit, currency: unit === "spark_token" ? null : currencies[0] });
        if (!parsedScope.success) invalid("Budget query scope is invalid.");
        const scope = parsedScope.data;
        const result = await withStore(store => createProductionBudgetService({ ...options.serviceOptions, store }).getReadModel(projectId, scope));
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) { return productionErrorResponse(error, requestId); }
    },
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const { projectId } = await context.params;
        if (!IdSchema.safeParse(projectId).success) invalid();
        const command = await readProductionJson(request, BudgetRouteCommandSchema, { maxBytes: MAX_BODY_BYTES });
        const result = await withStore(async store => {
          const service = createProductionBudgetService({ ...options.serviceOptions, store });
          switch (command.kind) {
            case "create_policy": {
              const { kind: _kind, ...fields } = command;
              return { status: 201, body: { kind: command.kind, policy: sanitizePolicy(await service.createPolicy(projectId, fields)) } };
            }
            case "update_policy": {
              const { kind: _kind, command: update, providerId, unit, currency } = command;
              return { status: 200, body: { kind: command.kind, policy: sanitizePolicy(await service.updatePolicy(projectId, { providerId, unit, currency }, update)) } };
            }
            case "authorize": {
              const { kind: _kind, command: authorization, providerId, unit, currency } = command;
              return { status: 200, body: { kind: command.kind, authorization: await service.authorizeProject(projectId, { providerId, unit, currency }, authorization) } };
            }
          }
        });
        return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
      } catch (error) { return productionErrorResponse(error, requestId); }
    },
  };
}
