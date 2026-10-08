import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionStore, ProductionWritePort, SynchronousValue } from "../../repositories/production/ports";
import { openProductionStore } from "../../repositories/production/sqlite";
import { hashCanonicalJson } from "../../production/hash";
import { computeAnchorApprovalHash, computeProductionInputsHash } from "../../jobs/production/queue";
import type { AnchorCandidate, Approval, AnimaticRevision, Asset, BudgetExecution, CanonRevision, ProductionJob, ProductionQuote, Project, ProviderRequestSnapshot, ShotPlanRevision, ShotRevision, StoryRevision } from "../../production/contracts";
import { createProductionBudgetService } from "./budget";

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "production-budget-service-"));
  dirs.push(dataDir);
  const store = openProductionStore({ dataDir });
  stores.push(store);
  const project: Project = {
    version: 1, id: "project-1", name: "Budget test", profileId: "profile-1",
    profile: { id: "profile-1", format: "9:16", language: "en", ageIntent: "family", targetFrames: 124, projectCapMinor: null, dailyCapMinor: null },
    activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null,
    activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0,
    audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1,
  };
  store.transaction(tx => tx.insertProject(project));
  const identity = { providerId: "provider-1", accountId: "account-1", accountEvidenceId: "evidence-1", credentialBindingId: "binding-1" };
  const reconciliationFacts = new Map<string, { kind: "actual"; cumulativeActual: number | null; final: boolean } | { kind: "nonbilling"; confirmedNonacceptanceOrNonbilling: true } | { kind: "refund"; amount: number }>();
  store.transaction(tx => tx.insertAccountEvidence({
    schemaVersion: 1, id: identity.accountEvidenceId, providerId: identity.providerId, accountId: identity.accountId,
    source: "trusted account resolver", reference: "proof-1", observedAt: 1, expiresAt: 3_000_000_000_000, credentialBindingId: identity.credentialBindingId,
  }));
  const service = createProductionBudgetService({
    store, now: () => 10_000, idFactory: (() => { let id = 0; return () => `generated-${++id}`; })(),
    resolveAccountIdentity: async () => identity,
    prepareExecutionEvidence: async ({ execution, budgetQuoteId }) => ({ accountEvidenceId: identity.accountEvidenceId, budgetQuoteId, expectedQuoteInputHash: store.read.getBudgetQuote(budgetQuoteId)?.inputHash ?? "0".repeat(64), executionSemanticHash: execution.executionSemanticHash, credentialBindingId: identity.credentialBindingId }),
    produceReconciliationEvidence: async ({ reservation, reference }) => ({ schemaVersion: 1, eventKey: reference, reservationId: reservation.id, providerId: reservation.providerId, accountId: reservation.accountId, currency: reservation.currency, unit: reservation.unit, observedAt: 10_000, source: "trusted-reconciliation", reference, provenance: { kind: "provider", producerId: "producer-1" }, fact: reconciliationFacts.get(reference)! }),
    currentCredentialBindingId: () => identity.credentialBindingId,
  });
  return { dataDir, store, project, identity, service, reconciliationFacts };
}
function insertTextBudgetQuote(store: ProductionStore, execution: BudgetExecution, budgetQuoteId: string, changes: { estimateMax?: number; currency?: string | null; unit?: "minor_currency" | "spark_token"; entitlement?: "subscription" | "spark"; expiresAt?: number } = {}) {
  const inputHash = hashCanonicalJson({ budgetQuoteId });
  store.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: budgetQuoteId, projectId: execution.projectId, providerId: execution.providerId, modelId: execution.modelId, operation: "text_proposal", inputHash, estimateMin: 1, estimateMax: changes.estimateMax ?? 10, currency: changes.currency === undefined ? "USD" : changes.currency, unit: changes.unit ?? "minor_currency", entitlement: changes.entitlement ?? "subscription", createdAt: 100, expiresAt: changes.expiresAt ?? 20_000, mediaQuoteId: null }, { schemaVersion: 1, id: `${budgetQuoteId}-binding`, budgetQuoteId, accountEvidenceId: "evidence-1", providerId: execution.providerId, accountId: "account-1", credentialBindingId: "binding-1", currency: changes.currency === undefined ? "USD" : changes.currency, unit: changes.unit ?? "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200 }));
  return inputHash;
}
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed for the reopen case */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("production budget service", () => {
  it("fails closed when trusted account identity or the live credential binding is unavailable", async () => {
    const { store, identity } = setup();
    const unavailable = createProductionBudgetService({ store, now: () => 10_000 });
    await expect(unavailable.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 500, expiresAt: null, revoked: false, actorId: "creator-1" })).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    const rotated = createProductionBudgetService({ store, now: () => 10_000, resolveAccountIdentity: async () => identity, currentCredentialBindingId: () => "rotated-binding" });
    await expect(rotated.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 500, expiresAt: null, revoked: false, actorId: "creator-1" })).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    store.transaction(tx => tx.insertAccountEvidence({ schemaVersion: 1, id: "expired-evidence", providerId: "provider-1", accountId: "account-1", source: "trusted resolver", reference: "expired-proof", observedAt: 1, expiresAt: 9_999, credentialBindingId: "binding-1" }));
    const expired = createProductionBudgetService({ store, now: () => 10_000, resolveAccountIdentity: async () => ({ ...identity, accountEvidenceId: "expired-evidence" }), currentCredentialBindingId: () => identity.credentialBindingId });
    await expect(expired.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 500, expiresAt: null, revoked: false, actorId: "creator-1" })).rejects.toMatchObject({ code: "BUDGET_BLOCKED", details: { reason: "EVIDENCE_MISSING_OR_STALE" } });
    const forged = createProductionBudgetService({ store, now: () => 10_000, resolveAccountIdentity: async () => ({ ...identity, accountId: "forged-account" }), currentCredentialBindingId: () => identity.credentialBindingId });
    await expect(forged.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 500, expiresAt: null, revoked: false, actorId: "creator-1" })).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(store.read.getLatestAccountPolicy({ providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toBeNull();
  });

  it("creates and updates scoped policies through revision CAS without exposing account identity", async () => {
    const { service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const created = await service.createPolicy("project-1", { ...scope, dailyCap: null, expiresAt: null, revoked: false, actorId: "creator-1" });
    expect(created).toMatchObject({ revision: 1, dailyCap: null, revoked: false });
    expect(created.accountId).toBe("account-1");
    const authorization = await service.authorizeProject("project-1", scope, {
      expectedAuthorizationRevision: null, expectedPolicyRevision: created.revision, policyId: created.policyId,
      projectCap: null, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"],
      expiresAt: null, revoked: false, actorId: "creator-1",
    });
    await expect(service.authorizeProject("project-1", scope, {
      expectedAuthorizationRevision: null, expectedPolicyRevision: created.revision, policyId: created.policyId,
      projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"],
      expiresAt: null, revoked: false, actorId: "creator-1",
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
    const expiredAuthorization = await service.authorizeProject("project-1", scope, {
      expectedAuthorizationRevision: authorization.revision, expectedPolicyRevision: created.revision, policyId: created.policyId,
      projectCap: 0, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"],
      expiresAt: 9_999, revoked: true, actorId: "creator-1",
    });
    expect(expiredAuthorization).toMatchObject({ revision: 2, projectCap: 0, expiresAt: 9_999, revoked: true });
    const updated = await service.updatePolicy("project-1", scope, { policyId: created.policyId, expectedPolicyRevision: 1, dailyCap: 0, expiresAt: null, revoked: false, actorId: "creator-1" });
    expect(updated).toMatchObject({ policyId: created.policyId, revision: 2, dailyCap: 0 });
    await expect(service.updatePolicy("project-1", scope, { policyId: created.policyId, expectedPolicyRevision: 1, dailyCap: 900, expiresAt: null, revoked: false, actorId: "creator-1" })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(store.read.getLatestAccountPolicy({ providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })?.dailyCap).toBe(0);
    const revoked = await service.updatePolicy("project-1", scope, { policyId: created.policyId, expectedPolicyRevision: 2, dailyCap: 0, expiresAt: 9_999, revoked: true, actorId: "creator-1" });
    expect(revoked).toMatchObject({ revision: 3, revoked: true, expiresAt: 9_999 });
    expect((await service.getReadModel("project-1", scope)).reasons).toEqual(expect.arrayContaining(["POLICY_REVOKED", "POLICY_EXPIRED", "DAILY_CAP_BLOCKED", "AUTHORIZATION_REVOKED", "AUTHORIZATION_EXPIRED", "PROJECT_CAP_BLOCKED"]));
  });

  it.each([
    ["null policy cap", null, null, false, false],
    ["zero policy cap", 0, null, false, false],
    ["expired policy", 100, 9_999, false, false],
    ["revoked policy", 100, null, true, false],
    ["null authorization cap", 100, null, false, true],
    ["zero authorization cap", 100, null, false, false],
    ["expired authorization", 100, null, false, false],
    ["revoked authorization", 100, null, false, false],
  ] as const)("denies reserve with zero writes for %s", async (name, dailyCap, policyExpiry, policyRevoked, nullAuthorizationCap) => {
    const { service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap, expiresAt: policyExpiry, revoked: policyRevoked, actorId: "creator-1" });
    const auth = await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: nullAuthorizationCap ? null : name === "zero authorization cap" ? 0 : 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: name === "expired authorization" ? 9_999 : null, revoked: name === "revoked authorization", actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: `guard-${name.replaceAll(" ", "-")}`, operation: "text_proposal", projectId: "project-1", idempotencyKey: `idem-${name.replaceAll(" ", "-")}`, requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider-1", modelId: "model-1" };
    insertTextBudgetQuote(store, execution, `quote-${name.replaceAll(" ", "-")}`);
    const context = await service.prepareBudgetContext(execution, `quote-${name.replaceAll(" ", "-")}`);
    expect(context).toMatchObject({ expectedPolicyRevision: policy.revision, expectedAuthorizationRevision: auth.revision });
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED" }));
    expect(store.read.getBudgetExecution(execution.executionId)).toBeNull();
    expect(store.read.getReservationByExecution(execution.executionId)).toBeNull();
    expect(store.read.getReservationByIdempotency(execution.projectId, execution.idempotencyKey)).toBeNull();
    expect(store.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(0);
  });

  it("rejects stale policy and authorization pins before registering execution", async () => {
    for (const staleHead of ["policy", "authorization"] as const) {
      const { service, store } = setup();
      const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
      const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
      const authorization = await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
      const execution: BudgetExecution = { kind: "text_proposal", executionId: `stale-${staleHead}`, operation: "text_proposal", projectId: "project-1", idempotencyKey: `idem-stale-${staleHead}`, requestHash: "c".repeat(64), executionSemanticHash: "d".repeat(64), providerId: "provider-1", modelId: "model-1" };
      const quoteId = `stale-quote-${staleHead}`;
      insertTextBudgetQuote(store, execution, quoteId);
      const context = await service.prepareBudgetContext(execution, quoteId);
      if (staleHead === "policy") await service.updatePolicy("project-1", scope, { policyId: policy.policyId, expectedPolicyRevision: policy.revision, dailyCap: 90, expiresAt: null, revoked: false, actorId: "creator-1" });
      else await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: authorization.revision, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 90, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
      expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context))).toThrow(expect.objectContaining({ code: "STALE_REVISION" }));
      expect(store.read.getBudgetExecution(execution.executionId)).toBeNull();
      expect(store.read.getReservationByExecution(execution.executionId)).toBeNull();
      expect(store.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(0);
    }
  });

  it("samples credential rotation inside the final transaction and rejects before writes", async () => {
    const { store, identity } = setup();
    const baseTransaction = store.transaction.bind(store);
    let inTransaction = false;
    store.transaction = (<T>(work: (tx: ProductionWritePort) => SynchronousValue<T>) => baseTransaction(tx => {
      inTransaction = true;
      try { return work(tx); } finally { inTransaction = false; }
    })) as ProductionStore["transaction"];
    let currentBinding: string | null = identity.credentialBindingId;
    const sampleLocations: boolean[] = [];
    const service = createProductionBudgetService({
      store, now: () => 10_000, resolveAccountIdentity: async () => identity,
      currentCredentialBindingId: () => { sampleLocations.push(inTransaction); return currentBinding; },
      prepareExecutionEvidence: async ({ execution, budgetQuoteId }) => ({ accountEvidenceId: identity.accountEvidenceId, budgetQuoteId, expectedQuoteInputHash: store.read.getBudgetQuote(budgetQuoteId)?.inputHash ?? "0".repeat(64), executionSemanticHash: execution.executionSemanticHash, credentialBindingId: identity.credentialBindingId }),
    });
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 1000, expiresAt: null, revoked: false, actorId: "creator-1" });
    await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "rotation-after-prepare", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-rotation-after-prepare", requestHash: "e".repeat(64), executionSemanticHash: "f".repeat(64), providerId: "provider-1", modelId: "model-1" };
    const quoteId = "rotation-quote";
    insertTextBudgetQuote(store, execution, quoteId);
    const context = await service.prepareBudgetContext(execution, quoteId);
    expect(sampleLocations.at(-1)).toBe(true);
    sampleLocations.length = 0;
    currentBinding = "rotated-after-prepare";
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED", details: { reason: "ACCOUNT_BINDING_MISMATCH" } }));
    expect(sampleLocations).toEqual([true]);
    expect(store.read.getBudgetExecution(execution.executionId)).toBeNull();
    expect(store.read.getReservationByExecution(execution.executionId)).toBeNull();
    expect(store.read.listBudgetLedger({ kind: "project", projectId: execution.projectId, providerId: execution.providerId, accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(0);
  });

  it("rejects an expired evidence pin at reserve with no execution or ledger write", async () => {
    const { service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
    const authorization = await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "expired-evidence-reserve", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-expired-evidence-reserve", requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider-1", modelId: "model-1" };
    const validQuoteId = "evidence-context-quote";
    insertTextBudgetQuote(store, execution, validQuoteId);
    const context = await service.prepareBudgetContext(execution, validQuoteId);
    const expiredEvidenceId = "expired-evidence-reserve";
    store.transaction(tx => {
      tx.insertAccountEvidence({ schemaVersion: 1, id: expiredEvidenceId, providerId: "provider-1", accountId: "account-1", source: "trusted account resolver", reference: "expired-reserve-proof", observedAt: 1, expiresAt: 9_999, credentialBindingId: "binding-1" });
      tx.insertBudgetQuote({ schemaVersion: 1, id: "expired-evidence-quote", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "c".repeat(64), estimateMin: 1, estimateMax: 10, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 20_000, mediaQuoteId: null }, { schemaVersion: 1, id: "expired-evidence-quote-binding", budgetQuoteId: "expired-evidence-quote", accountEvidenceId: expiredEvidenceId, providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200 });
    });
    const expiredContext = { ...context, accountEvidenceId: expiredEvidenceId, budgetQuoteId: "expired-evidence-quote", expectedQuoteInputHash: "c".repeat(64), policyId: policy.policyId, expectedPolicyRevision: policy.revision, expectedAuthorizationRevision: authorization.revision };
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, expiredContext))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED", details: { reason: "EVIDENCE_MISSING_OR_STALE" } }));
    expect(store.read.getBudgetExecution(execution.executionId)).toBeNull();
    expect(store.read.getReservationByExecution(execution.executionId)).toBeNull();
    expect(store.read.listBudgetLedger({ kind: "project", projectId: execution.projectId, providerId: execution.providerId, accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(0);
  });

  it("uses a pure text proposal reservation DTO and returns an exact replay without adding ledger rows", async () => {
    const { service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 1000, expiresAt: null, revoked: false, actorId: "creator-1" });
    const auth = await service.authorizeProject("project-1", scope, {
      expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId,
      projectCap: 1000, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"],
      expiresAt: null, revoked: false, actorId: "creator-1",
    });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "text-1", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-text-1", requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider-1", modelId: "model-1" };
    store.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-text-1", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "c".repeat(64), estimateMin: 25, estimateMax: 50, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 20_000, mediaQuoteId: null }, {
      schemaVersion: 1, id: "binding-text-1", budgetQuoteId: "budget-text-1", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200,
    }));
    const context = await service.prepareBudgetContext(execution, "budget-text-1");
    expect(context).toMatchObject({ policyId: policy.policyId, expectedAuthorizationRevision: auth.revision, expectedPolicyRevision: policy.revision, executionSemanticHash: execution.executionSemanticHash });
    const first = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context));
    await service.updatePolicy("project-1", scope, { policyId: policy.policyId, expectedPolicyRevision: policy.revision, dailyCap: 500, expiresAt: null, revoked: false, actorId: "creator-1" });
    const second = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_001, context));
    expect(first).toEqual(second);
    expect(first.execution.kind).toBe("text_proposal");
    expect(store.read.getBudgetQuote(first.budgetQuoteId)?.mediaQuoteId).toBeNull();
    expect(store.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(1);

    const conflictingExecution: BudgetExecution = { ...execution, requestHash: "9".repeat(64) };
    insertTextBudgetQuote(store, conflictingExecution, "budget-text-conflicting-replay");
    const conflictingContext = await service.prepareBudgetContext(conflictingExecution, "budget-text-conflicting-replay");
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, conflictingExecution, 10_002, conflictingContext))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED" }));
    expect(store.read.getReservationByExecution(execution.executionId)).toEqual(first);
    expect(store.read.getReservationByIdempotency(execution.projectId, execution.idempotencyKey)).toEqual(first);
    expect(store.read.getBudgetExecution(conflictingExecution.executionId)).toEqual(execution);
    expect(store.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(1);
    const contextConflict = { ...context, budgetQuoteId: "budget-text-conflicting-replay", expectedQuoteInputHash: store.read.getBudgetQuote("budget-text-conflicting-replay")!.inputHash };
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_003, contextConflict))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED" }));
    expect(store.read.getReservationByExecution(execution.executionId)).toEqual(first);
    expect(store.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(1);
  });

  it("reopens SQLite and accounts project liability across days while account liability stays in its original UTC day", async () => {
    const { dataDir, service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 1000, expiresAt: null, revoked: false, actorId: "creator-1" });
    await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 1000, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "text-midnight", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-midnight", requestHash: "d".repeat(64), executionSemanticHash: "e".repeat(64), providerId: "provider-1", modelId: "model-1" };
    store.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-midnight", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "f".repeat(64), estimateMin: 30, estimateMax: 80, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 3_000_000_000_000, mediaQuoteId: null }, { schemaVersion: 1, id: "binding-midnight", budgetQuoteId: "budget-midnight", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200 }));
    const context = await service.prepareBudgetContext(execution, "budget-midnight");
    const midnight = Date.UTC(2026, 1, 2, 0, 0);
    store.transaction(tx => service.reserveInTransaction(tx, execution, midnight - 1, context));
    store.close();
    const reopened = openProductionStore({ dataDir });
    stores.push(reopened);
    const reopenedService = createProductionBudgetService({ store: reopened, now: () => midnight, idFactory: () => "reservation-next", resolveAccountIdentity: async () => ({ providerId: "provider-1", accountId: "account-1", accountEvidenceId: "evidence-1", credentialBindingId: "binding-1" }), currentCredentialBindingId: () => "binding-1", prepareExecutionEvidence: async ({ execution, budgetQuoteId }) => ({ accountEvidenceId: "evidence-1", budgetQuoteId, expectedQuoteInputHash: reopened.read.getBudgetQuote(budgetQuoteId)?.inputHash ?? "0".repeat(64), executionSemanticHash: execution.executionSemanticHash, credentialBindingId: "binding-1" }) });
    await reopenedService.authorizeProject("project-1", scope, { expectedAuthorizationRevision: 1, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const nextExecution = { ...execution, executionId: "text-next", idempotencyKey: "idem-next", requestHash: "1".repeat(64), executionSemanticHash: "2".repeat(64) };
    reopened.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-next", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "3".repeat(64), estimateMin: 30, estimateMax: 80, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 3_000_000_000_000, mediaQuoteId: null }, { schemaVersion: 1, id: "binding-next", budgetQuoteId: "budget-next", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: nextExecution.executionSemanticHash, quotedAt: 200 }));
    const nextContext = await reopenedService.prepareBudgetContext(nextExecution, "budget-next");
    expect(() => reopened.transaction(tx => reopenedService.reserveInTransaction(tx, nextExecution, midnight, nextContext))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED", details: { reason: "PROJECT_CAP_EXCEEDED" } }));
    const projectLedger = reopened.read.listBudgetLedger({ kind: "project", projectId: "project-1", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" });
    expect(projectLedger).toHaveLength(1);
    expect(projectLedger[0]?.reservation.utcDay).toBe("2026-02-01");
    const ledger = reopened.read.listBudgetLedger({ kind: "account_day", utcDay: "2026-02-01", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" });
    expect(ledger).toHaveLength(1);
    expect(reopened.read.listBudgetLedger({ kind: "account_day", utcDay: "2026-02-02", providerId: "provider-1", accountId: "account-1", currency: "USD", unit: "minor_currency" })).toHaveLength(0);
    expect(await reopenedService.getReadModel("project-1", scope)).toMatchObject({ policy: { dailyCap: 1000 }, authorization: { projectCap: 100 }, projectTotals: { totalLiability: 80 }, accountDailyTotals: { totalLiability: 0 } });
    reopened.close();
  });

  it("keeps a zero-estimate reservation visibly unsettled until trusted final billing evidence arrives", async () => {
    const { service, store, reconciliationFacts } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
    await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "text-zero", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-zero", requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider-1", modelId: "model-1" };
    store.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-zero", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "c".repeat(64), estimateMin: 0, estimateMax: 0, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 20_000, mediaQuoteId: null }, { schemaVersion: 1, id: "binding-zero", budgetQuoteId: "budget-zero", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200 }));
    const context = await service.prepareBudgetContext(execution, "budget-zero");
    const reservation = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context));
    const view = await service.getReadModel("project-1", scope);
    expect(view.projectTotals).toMatchObject({ totalLiability: 0 });
    expect(view.unresolved).toBe(true);
    expect(view.overrun).toBe(false);
    reconciliationFacts.set("release", { kind: "nonbilling", confirmedNonacceptanceOrNonbilling: true });
    const released = await service.reconcile(reservation.id, "release");
    expect(await service.reconcile(reservation.id, "release")).toEqual(released);
    expect((await service.getReadModel("project-1", scope)).unresolved).toBe(false);
    reconciliationFacts.set("release", { kind: "actual", cumulativeActual: 1, final: true });
    await expect(service.reconcile(reservation.id, "release")).rejects.toThrow(/Conflicting reconciliation event key/);
    expect(store.read.getReconciliationEvent("provider-1", "account-1", "release")).toEqual(released);
  });

  it("folds trusted actuals, refunds, nonbilling, and duplicate or conflicting evidence", async () => {
    const { service, store, reconciliationFacts } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
    await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: "text-reconcile", operation: "text_proposal", projectId: "project-1", idempotencyKey: "idem-reconcile", requestHash: "d".repeat(64), executionSemanticHash: "e".repeat(64), providerId: "provider-1", modelId: "model-1" };
    store.transaction(tx => tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-reconcile", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "text_proposal", inputHash: "f".repeat(64), estimateMin: 20, estimateMax: 50, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 100, expiresAt: 20_000, mediaQuoteId: null }, { schemaVersion: 1, id: "binding-reconcile", budgetQuoteId: "budget-reconcile", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: execution.executionSemanticHash, quotedAt: 200 }));
    const context = await service.prepareBudgetContext(execution, "budget-reconcile");
    const reservation = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context));
    expect((await service.getReadModel("project-1", scope)).unresolved).toBe(true);
    reconciliationFacts.set("unknown-actual", { kind: "actual", cumulativeActual: null, final: false });
    await service.reconcile(reservation.id, "unknown-actual");
    expect((await service.getReadModel("project-1", scope)).unresolved).toBe(true);
    reconciliationFacts.set("actual-1", { kind: "actual", cumulativeActual: 75, final: false });
    const actual = await service.reconcile(reservation.id, "actual-1");
    expect(actual.evidence.fact).toEqual({ kind: "actual", cumulativeActual: 75, final: false });
    expect(await service.reconcile(reservation.id, "actual-1")).toEqual(actual);
    reconciliationFacts.set("actual-1", { kind: "actual", cumulativeActual: 74, final: false });
    await expect(service.reconcile(reservation.id, "actual-1")).rejects.toThrow(/Conflicting reconciliation event key/);
    reconciliationFacts.set("refund-1", { kind: "refund", amount: 10 });
    await service.reconcile(reservation.id, "refund-1");
    reconciliationFacts.set("actual-final", { kind: "actual", cumulativeActual: 75, final: true });
    await service.reconcile(reservation.id, "actual-final");
    const view = await service.getReadModel("project-1", scope);
    expect(view.projectTotals).toMatchObject({ knownNetActual: 65, totalLiability: 65 });
    expect(view.overrun).toBe(true);
    expect(view.unresolved).toBe(false);
  });

  it.each(["manual provenance", "wrong account scope"] as const)("rejects reconciliation with %s before ledger append", async (mode) => {
    const { service, store } = setup();
    const scope = { providerId: "provider-1", unit: "minor_currency" as const, currency: "USD" };
    const policy = await service.createPolicy("project-1", { ...scope, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
    await service.authorizeProject("project-1", scope, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const execution: BudgetExecution = { kind: "text_proposal", executionId: `reconcile-${mode.replaceAll(" ", "-")}`, operation: "text_proposal", projectId: "project-1", idempotencyKey: `idem-reconcile-${mode.replaceAll(" ", "-")}`, requestHash: "a".repeat(64), executionSemanticHash: "b".repeat(64), providerId: "provider-1", modelId: "model-1" };
    const quoteId = `budget-${mode.replaceAll(" ", "-")}`;
    insertTextBudgetQuote(store, execution, quoteId);
    const context = await service.prepareBudgetContext(execution, quoteId);
    const reservation = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context));
    const invalidProducer = createProductionBudgetService({
      store, now: () => 10_000,
      produceReconciliationEvidence: async ({ reservation: pinned, reference }) => ({ schemaVersion: 1, eventKey: reference, reservationId: pinned.id, providerId: pinned.providerId, accountId: mode === "wrong account scope" ? "foreign-account" : pinned.accountId, currency: pinned.currency, unit: pinned.unit, observedAt: 10_000, source: "fixture producer", reference, provenance: mode === "manual provenance" ? { kind: "manual", actorId: "creator-1", decision: "reconciled", reason: "Manual evidence is not provider reconciliation" } : { kind: "provider", producerId: "producer-1" }, fact: { kind: "actual", cumulativeActual: 9, final: false } }),
    });
    await expect(invalidProducer.reconcile(reservation.id, "reconcile-invalid")).rejects.toMatchObject({ code: "BUDGET_BLOCKED", details: { reason: "QUOTE_BINDING_MISMATCH" } });
    expect(store.read.getReconciliationEvent("provider-1", "account-1", "reconcile-invalid")).toBeNull();
    expect(await service.getReadModel("project-1", scope)).toMatchObject({ unresolved: true, projectTotals: { totalLiability: 10 } });
  });

  it.each(["matching anchor and take pins", "entitlement and mode mismatch", "companion currency mismatch", "companion amount mismatch", "companion expiry beyond media quote"] as const)("pins canonical media semantics with %s", async (scenario) => {
    const { store, identity } = setup();
    let credentialSamples = 0;
    const service = createProductionBudgetService({
      store, now: () => 10_000, idFactory: (() => { let id = 0; return () => `media-reservation-${++id}`; })(),
      resolveAccountIdentity: async () => identity,
      currentCredentialBindingId: () => { credentialSamples += 1; return identity.credentialBindingId; },
      prepareExecutionEvidence: async ({ execution, budgetQuoteId }) => ({ accountEvidenceId: identity.accountEvidenceId, budgetQuoteId, expectedQuoteInputHash: store.read.getBudgetQuote(budgetQuoteId)?.inputHash ?? "0".repeat(64), executionSemanticHash: execution.executionSemanticHash, credentialBindingId: identity.credentialBindingId }),
    });
    const hash = (value: unknown) => hashCanonicalJson(value);
    const location: CanonRevision = { version: 1, id: "location-rev", entityId: "location", entityKind: "location", revision: 1, description: "Location", attributes: {}, referenceAssetIds: [], contentHash: hash({ location: 1 }), createdAt: 100 };
    const style: CanonRevision = { version: 1, id: "style-rev", entityId: "style", entityKind: "style", revision: 1, description: "Style", attributes: {}, referenceAssetIds: [], contentHash: hash({ style: 1 }), createdAt: 100 };
    const story: StoryRevision = { version: 1, id: "story-rev", projectId: "project-1", parentRevisionId: null, scriptText: "A test.", beats: [{ id: "beat-1", action: "A test action", narration: "", dialogue: [], order: 0 }], canonRevisionIds: [location.id, style.id], contentHash: hash({ story: 1 }), createdAt: 100 };
    const shot: ShotRevision = { version: 1, id: "shot-rev", shotId: "shot-1", storyRevisionId: story.id, beatIds: ["beat-1"], order: 0, visualIntent: "A still", motionIntent: "Still", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "medium", targetFrames: 124, continuation: null, contentHash: hash({ shot: 1 }), createdAt: 100 };
    const plan: ShotPlanRevision = { version: 1, id: "plan-rev", projectId: "project-1", storyRevisionId: story.id, orderedShotRevisionIds: [shot.id], beatCoverage: [{ beatId: "beat-1", shotRevisionIds: [shot.id] }], contentHash: hash({ plan: 1 }), createdAt: 100 };
    const animatic: AnimaticRevision = { version: 1, id: "animatic-rev", projectId: "project-1", shotPlanRevisionId: plan.id, slots: [{ shotRevisionId: shot.id, anchorId: null, placeholderLabel: "reviewed timing" }], timingAnnotations: [], totalFrames: 124, contentHash: hash({ animatic: 1 }), createdAt: 100 };
    const approved = (id: string, targetKind: "story" | "animatic", targetId: string, targetHash: string): Approval => ({ version: 1, id, targetKind, targetId, targetHash, decision: "approved", actorId: "creator-1", createdAt: 200, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] });
    const mediaQuote: ProductionQuote = { version: 1, id: "media-quote", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "anchor", inputHash: hash({ revisionIds: [], assetIds: [], parameters: {} }), entitlement: "subscription", estimateMinMinor: 10, estimateMaxMinor: 20, currency: "USD", expiresAt: 20_000, withinAuthorizedCap: "yes", createdAt: 1000 };
    let snapshot: ProviderRequestSnapshot = { projectId: "project-1", jobId: "anchor-job", idempotencyKey: "anchor-key", quoteId: mediaQuote.id, providerId: "provider-1", modelId: "model-1", prompt: "A still", inputs: [], parameters: {}, billingMode: "subscription", resultTarget: { kind: "anchor", shotRevisionId: shot.id, inputsHash: "0".repeat(64) } };
    store.transaction(tx => {
      tx.insertCanonRevision(location); tx.insertCanonRevision(style); tx.insertStoryRevision(story); tx.insertShotRevisions([shot]); tx.insertShotPlanRevision(plan); tx.insertAnimaticRevision(animatic);
      tx.appendApproval(approved("story-approval", "story", story.id, story.contentHash)); tx.appendApproval(approved("animatic-approval", "animatic", animatic.id, animatic.contentHash));
      const project = tx.getProject("project-1")!;
      tx.compareAndSetProject({ ...project, activeCanonRevisionIds: [location.id, style.id], activeStoryRevisionId: story.id, activeShotPlanRevisionId: plan.id, activeAnimaticRevisionId: animatic.id, saveVersion: project.saveVersion + 1, updatedAt: 200 }, project.saveVersion);
      snapshot = { ...snapshot, resultTarget: { ...snapshot.resultTarget!, inputsHash: computeProductionInputsHash(tx, "anchor", snapshot) } };
      tx.insertQuote(mediaQuote);
      const job: ProductionJob = { version: 1, id: "anchor-job", projectId: "project-1", operation: "anchor", status: "queued", idempotencyKey: "anchor-key", requestSnapshot: snapshot, requestHash: hash(snapshot), providerId: "provider-1", modelId: "model-1", providerRef: null, quoteId: mediaQuote.id, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 };
      tx.insertJob(job, { id: "anchor-outbox", jobId: job.id, createdAt: 1000, claimedAt: null, claimToken: null });
      tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-media", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "anchor", inputHash: mediaQuote.inputHash, estimateMin: 10, estimateMax: 20, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 1000, expiresAt: 20_000, mediaQuoteId: mediaQuote.id }, { schemaVersion: 1, id: "media-binding", budgetQuoteId: "budget-media", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: snapshot.resultTarget!.inputsHash, quotedAt: 1000 });
    });
    const execution: BudgetExecution = { kind: "media_job", executionId: "anchor-job", operation: "anchor", projectId: "project-1", idempotencyKey: "anchor-key", requestHash: hash(snapshot), executionSemanticHash: snapshot.resultTarget!.inputsHash, providerId: "provider-1", modelId: "model-1" };
    const policy = await service.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
    const mediaAuthorization = await service.authorizeProject("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD" }, { expectedAuthorizationRevision: null, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["anchor"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const context = await service.prepareBudgetContext(execution, "budget-media");
    const reservation = store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, context));
    expect(reservation.execution.executionSemanticHash).toBe(snapshot.resultTarget!.inputsHash);
    expect(reservation.budgetQuoteId).toBe("budget-media");
    expect(credentialSamples).toBeGreaterThanOrEqual(4);
    const forged = { ...context, expectedQuoteInputHash: "9".repeat(64) };
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, execution, 10_000, forged))).toThrow();

    await service.authorizeProject("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "USD" }, { expectedAuthorizationRevision: 1, expectedPolicyRevision: policy.revision, policyId: policy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["anchor", "take"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    const anchorAsset: Asset = { version: 1, id: "approved-anchor-asset", sha256: hash({ bytes: "anchor" }), mime: "image/png", byteSize: 1, vaultRef: "anchor-vault-ref", width: 1, height: 1, frames: null, fps: null, audioSamples: null, sourceKind: "upload", sourceJobId: null, rightsStatus: "creator_attested", createdAt: 100 };
    const candidate: AnchorCandidate = { version: 1, id: "approved-anchor", shotRevisionId: shot.id, assetId: anchorAsset.id, inputsHash: "a".repeat(64), jobId: "anchor-job", visionAssessment: null, receiptId: null, createdAt: 100 };
    let takeSnapshot: ProviderRequestSnapshot = { projectId: "project-1", jobId: "take-job", idempotencyKey: "take-key", quoteId: "take-media-quote", providerId: "provider-1", modelId: "model-1", prompt: "A short take", inputs: [{ assetId: anchorAsset.id, role: "start_frame", required: true }], parameters: {}, billingMode: "subscription", resultTarget: { kind: "take", shotRevisionId: shot.id, anchorId: candidate.id, anchorApprovalId: "anchor-approval", inputsHash: "0".repeat(64) } };
    const takeQuote: ProductionQuote = { ...mediaQuote, id: "take-media-quote", operation: "take", inputHash: hash({ revisionIds: [], assetIds: [anchorAsset.id], parameters: {} }) };
    store.transaction(tx => {
      tx.insertAsset({ asset: anchorAsset, verifiedAt: 100, checksumVerified: true });
      tx.insertAnchor(candidate);
      const takeApproval: Approval = { version: 1, id: "anchor-approval", targetKind: "anchor", targetId: candidate.id, targetHash: computeAnchorApprovalHash(tx, candidate), decision: "approved", actorId: "creator-1", createdAt: 200, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] };
      tx.appendApproval(takeApproval);
      takeSnapshot = { ...takeSnapshot, resultTarget: { ...takeSnapshot.resultTarget!, inputsHash: computeProductionInputsHash(tx, "take", takeSnapshot) } };
      tx.insertQuote(takeQuote);
      tx.insertJob({ version: 1, id: takeSnapshot.jobId, projectId: "project-1", operation: "take", status: "queued", idempotencyKey: takeSnapshot.idempotencyKey, requestSnapshot: takeSnapshot, requestHash: hash(takeSnapshot), providerId: "provider-1", modelId: "model-1", providerRef: null, quoteId: takeQuote.id, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }, { id: "take-outbox", jobId: takeSnapshot.jobId, createdAt: 1000, claimedAt: null, claimToken: null });
      tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-take", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "take", inputHash: takeQuote.inputHash, estimateMin: 10, estimateMax: 20, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 1000, expiresAt: 20_000, mediaQuoteId: takeQuote.id }, { schemaVersion: 1, id: "take-binding", budgetQuoteId: "budget-take", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: takeSnapshot.resultTarget!.inputsHash, quotedAt: 1000 });
    });
    const takeExecution: BudgetExecution = { kind: "media_job", executionId: takeSnapshot.jobId, operation: "take", projectId: "project-1", idempotencyKey: takeSnapshot.idempotencyKey, requestHash: hash(takeSnapshot), executionSemanticHash: takeSnapshot.resultTarget!.inputsHash, providerId: "provider-1", modelId: "model-1" };
    const takeContext = await service.prepareBudgetContext(takeExecution, "budget-take");
    const takeReservation = store.transaction(tx => service.reserveInTransaction(tx, takeExecution, 10_000, takeContext));
    expect(takeReservation.execution.operation).toBe("take");
    expect(takeReservation.budgetQuoteId).toBe("budget-take");
    const wrongRoleQuote: ProductionQuote = { ...takeQuote, id: "take-wrong-role-quote" };
    let wrongRoleSnapshot: ProviderRequestSnapshot = { ...takeSnapshot, jobId: "take-wrong-role-job", idempotencyKey: "take-wrong-role-key", quoteId: wrongRoleQuote.id, inputs: [{ assetId: anchorAsset.id, role: "reference", required: true }] };
    store.transaction(tx => {
      wrongRoleSnapshot = { ...wrongRoleSnapshot, resultTarget: { ...wrongRoleSnapshot.resultTarget!, inputsHash: computeProductionInputsHash(tx, "take", wrongRoleSnapshot) } };
      tx.insertQuote(wrongRoleQuote);
      tx.insertJob({ ...tx.getJob("take-job")!, id: wrongRoleSnapshot.jobId, idempotencyKey: wrongRoleSnapshot.idempotencyKey, quoteId: wrongRoleQuote.id, requestSnapshot: wrongRoleSnapshot, requestHash: hash(wrongRoleSnapshot) }, { id: "take-wrong-role-outbox", jobId: wrongRoleSnapshot.jobId, createdAt: 1000, claimedAt: null, claimToken: null });
      tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-take-wrong-role", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "take", inputHash: wrongRoleQuote.inputHash, estimateMin: 10, estimateMax: 20, currency: "USD", unit: "minor_currency", entitlement: "subscription", createdAt: 1000, expiresAt: 20_000, mediaQuoteId: wrongRoleQuote.id }, { schemaVersion: 1, id: "take-wrong-role-binding", budgetQuoteId: "budget-take-wrong-role", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: "USD", unit: "minor_currency", executionSemanticHash: wrongRoleSnapshot.resultTarget!.inputsHash, quotedAt: 1000 });
    });
    const wrongRoleExecution: BudgetExecution = { kind: "media_job", executionId: wrongRoleSnapshot.jobId, operation: "take", projectId: "project-1", idempotencyKey: wrongRoleSnapshot.idempotencyKey, requestHash: hash(wrongRoleSnapshot), executionSemanticHash: wrongRoleSnapshot.resultTarget!.inputsHash, providerId: "provider-1", modelId: "model-1" };
    await expect(service.prepareBudgetContext(wrongRoleExecution, "budget-take-wrong-role")).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(store.read.getBudgetExecution(wrongRoleExecution.executionId)).toBeNull();
    expect(store.read.getReservationByExecution(wrongRoleExecution.executionId)).toBeNull();
    if (scenario === "matching anchor and take pins") return;

    const isEntitlementMismatch = scenario === "entitlement and mode mismatch";
    const conflictingCurrency = scenario === "companion currency mismatch" ? "EUR" : "USD";
    const conflictingMediaQuote: ProductionQuote = { ...mediaQuote, id: `media-${scenario.replaceAll(" ", "-")}`, entitlement: isEntitlementMismatch ? "spark" : "subscription" };
    let conflictingSnapshot: ProviderRequestSnapshot = { ...snapshot, jobId: `anchor-${scenario.replaceAll(" ", "-")}`, idempotencyKey: `anchor-key-${scenario.replaceAll(" ", "-")}`, quoteId: conflictingMediaQuote.id, billingMode: isEntitlementMismatch ? "tokens" : "subscription", resultTarget: { ...snapshot.resultTarget!, inputsHash: "0".repeat(64) } };
    store.transaction(tx => {
      conflictingSnapshot = { ...conflictingSnapshot, resultTarget: { ...conflictingSnapshot.resultTarget!, inputsHash: computeProductionInputsHash(tx, "anchor", conflictingSnapshot) } };
      tx.insertQuote(conflictingMediaQuote);
      tx.insertJob({ ...tx.getJob("anchor-job")!, id: conflictingSnapshot.jobId, idempotencyKey: conflictingSnapshot.idempotencyKey, quoteId: conflictingMediaQuote.id, requestSnapshot: conflictingSnapshot, requestHash: hash(conflictingSnapshot) }, { id: "anchor-token-outbox", jobId: conflictingSnapshot.jobId, createdAt: 1000, claimedAt: null, claimToken: null });
      tx.insertBudgetQuote({ schemaVersion: 1, id: "budget-token-mismatch", projectId: "project-1", providerId: "provider-1", modelId: "model-1", operation: "anchor", inputHash: conflictingMediaQuote.inputHash, estimateMin: isEntitlementMismatch ? 0 : 10, estimateMax: isEntitlementMismatch ? 0 : scenario === "companion amount mismatch" ? 19 : 20, currency: conflictingCurrency, unit: "minor_currency", entitlement: "subscription", createdAt: 1000, expiresAt: scenario === "companion expiry beyond media quote" ? 20_001 : 20_000, mediaQuoteId: conflictingMediaQuote.id }, { schemaVersion: 1, id: "token-mismatch-binding", budgetQuoteId: "budget-token-mismatch", accountEvidenceId: "evidence-1", providerId: "provider-1", accountId: "account-1", credentialBindingId: "binding-1", currency: conflictingCurrency, unit: "minor_currency", executionSemanticHash: conflictingSnapshot.resultTarget!.inputsHash, quotedAt: 1000 });
    });
    let conflictingContextPins = { ...context, budgetQuoteId: "budget-token-mismatch", expectedQuoteInputHash: conflictingMediaQuote.inputHash, executionSemanticHash: conflictingSnapshot.resultTarget!.inputsHash, policyId: policy.policyId, expectedPolicyRevision: policy.revision, expectedAuthorizationRevision: mediaAuthorization.revision };
    if (conflictingCurrency === "EUR") {
      const euroPolicy = await service.createPolicy("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "EUR", dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" });
      const euroAuthorization = await service.authorizeProject("project-1", { providerId: "provider-1", unit: "minor_currency", currency: "EUR" }, { expectedAuthorizationRevision: null, expectedPolicyRevision: euroPolicy.revision, policyId: euroPolicy.policyId, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["anchor"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
      Object.assign(conflictingContextPins, { policyId: euroPolicy.policyId, expectedPolicyRevision: euroPolicy.revision, expectedAuthorizationRevision: euroAuthorization.revision });
    }
    const conflictingExecution: BudgetExecution = { ...execution, executionId: conflictingSnapshot.jobId, idempotencyKey: conflictingSnapshot.idempotencyKey, requestHash: hash(conflictingSnapshot), executionSemanticHash: conflictingSnapshot.resultTarget!.inputsHash };
    await expect(service.prepareBudgetContext(conflictingExecution, "budget-token-mismatch")).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(() => store.transaction(tx => service.reserveInTransaction(tx, conflictingExecution, 10_000, conflictingContextPins))).toThrow(expect.objectContaining({ code: "BUDGET_BLOCKED", details: { reason: "QUOTE_INCOMPATIBLE" } }));
    expect(store.read.getReservationByExecution(conflictingExecution.executionId)).toBeNull();
    expect(store.read.getReservationByIdempotency(conflictingExecution.projectId, conflictingExecution.idempotencyKey)).toBeNull();
    expect(store.read.getBudgetExecution(conflictingExecution.executionId)).toBeNull();
  });
});
