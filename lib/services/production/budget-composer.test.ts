import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore } from "../../repositories/production/sqlite";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { parseReviewedQuotePolicy } from "../../production/proof-policy";
import { proofPayload } from "../../production/provider-proof";
import type { ProviderRequestSnapshot } from "../../production/contracts";
import { computeProductionInputsHash } from "../../jobs/production/queue";
import { createProductionBudgetService } from "./budget";
import { createProductionBudgetComposer } from "./budget-composer";
import { toMediaQuoteRequest, quoteProjection } from "./takes";
import type { ProviderAccountObservation } from "../../providers/production/proof-port";

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed for reopen cases */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (label: string) => hashCanonicalJson({ fixture: label });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function compositionCounts(dataDir: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    return {
      quotes: count("SELECT COUNT(*) AS count FROM records WHERE kind='quote'"),
      budgetQuotes: count("SELECT COUNT(*) AS count FROM budget_quotes"),
      bindings: count("SELECT COUNT(*) AS count FROM budget_quote_bindings"),
      evidence: count("SELECT COUNT(*) AS count FROM budget_account_evidence"),
      artifacts: count("SELECT COUNT(*) AS count FROM provider_proof_artifacts"),
      quoteProofs: count("SELECT COUNT(*) AS count FROM provider_quote_proofs"),
      executionProofs: count("SELECT COUNT(*) AS count FROM provider_execution_proofs"),
      generations: count("SELECT COUNT(*) AS count FROM provider_credential_generations"),
    };
  } finally { db.close(); }
}
function artifactKindCount(dataDir: string, kind: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS count FROM provider_proof_artifacts WHERE kind=?").get(kind) as { count: number }).count; } finally { db.close(); }
}
const reviewedPolicyPayload = (overrides: Record<string, unknown> = {}, configOverride: Record<string, unknown> = {}) => {
  const config = {
    schemaVersion: 1 as const,
    providerId: "sogni",
    quoteTtlMs: 30_000,
    accountSessionTtlMs: 60_000,
    executionSessionTtlMs: 60_000,
    billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" as const }],
    priceByModel: [{ modelId: "image-model", operations: ["anchor" as const, "take" as const], entitlement: "subscription" as const, unit: "minor_currency" as const, currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }],
    ...configOverride,
  };
  const capture = "Fixture reviewed policy capture for the offline composer tests.";
  return { input: parseReviewedQuotePolicy({
    schemaVersion: 1,
    kind: "reviewed_policy",
    producer: { producerId: "fixture-reviewer", producerVersion: "fixture-reviewer-v1", sourceHash: sha("reviewer-provenance") },
    providerId: "sogni",
    reviewVersion: "review-1",
    sourceUrl: "https://policy.fixture.example/sogni-pricing-v1",
    sourceCapture: capture,
    sourceCaptureSha256: sha256(capture),
    reviewedConfigCanonicalJson: canonicalJson(config),
    reviewedConfigHash: hashCanonicalJson(config),
    capturedAt: 0,
    expiresAt: 10_000_000_000,
    ...overrides,
  }), config };
};
function fakeProvider(clock: () => number, capability: { expiresAt?: number | null; provenance?: "live_catalog" | "unknown"; discoverObservedAt?: "after_await" | "far_future" } = {}) {
  let role: "web" | "worker" = "web";
  const captured = () => ({ session: { sessionId: `sogni-session:fixture-${role}`, role, sdkVersion: "5.49.0", sdkSourceHash: sha("sdk-source"), adapterVersion: "fixture-adapter-v1" }, credentialFingerprint: sha("credential-fingerprint"), accountId: "sogni-account:fixture-account" });
  const receipt = { version: 1 as const, providerId: "sogni", modelId: "image-model", provenance: capability.provenance ?? ("live_catalog" as const), observedAt: 0, expiresAt: capability.expiresAt === undefined ? 3_600_000 : capability.expiresAt, supportedOperations: ["image" as const, "video" as const], aspectRatios: ["9:16" as const], maxReferenceImages: 9, supportsStartFrame: true, supportsEndFrame: true, supportsContextImages: true, supportsTimedKeyframes: false, minFrames: null, maxFrames: null, frameStep: null, supportsNativeAudio: false };
  // C13-LIVE-FIX: like the live Sogni provider, "after_await" stamps the receipt with this
  // provider-side clock AFTER the awaited discovery call, so observedAt lands strictly after the
  // composer's pre-await request clock; "far_future" stamps a minute ahead of even that clock.
  const discovered = (): typeof receipt => {
    if (capability.discoverObservedAt === "after_await") return { ...receipt, observedAt: clock() };
    if (capability.discoverObservedAt === "far_future") { const observedAt = clock() + 60_000; return { ...receipt, observedAt, expiresAt: observedAt + 300_000 }; }
    return receipt;
  };
  return {
    providerId: "sogni" as const,
    setRole: (next: "web" | "worker") => { role = next; },
    captured,
    capability: receipt,
    observeAccount: async () => ({ providerId: "sogni", captured: captured(), subscription: { active: true, status: "active", tier: "standard", currentPeriodEnd: null, providerVersion: 1 }, observedAt: clock() }),
    currentSession: () => captured(),
    discoverCapabilities: async () => discovered(),
    quote: async () => { throw new Error("offline fixture provider does not quote"); },
    submit: async () => { throw new Error("offline fixture provider does not submit"); },
    poll: async () => { throw new Error("offline fixture provider does not poll"); },
    cancel: async () => { throw new Error("offline fixture provider does not cancel"); },
  };
}
async function composerFixture(options: { jobStatus?: "queued" | "submitting"; providerCapability?: Parameters<typeof fakeProvider>[1] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-composer-fixture-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  let tick = 1_000; let n = 0; let b3n = 0;
  const clock = () => ++tick;
  const idFactory = () => `fixture-${++n}`;
  const project = { version: 1 as const, id: "project-1", name: "Composer fixture", profileId: "profile-1", profile: { id: "profile-1", format: "9:16" as const, language: "en", ageIntent: "family", targetFrames: 124, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [] as string[], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 };
  store.transaction(tx => tx.insertProject(project));
  const location = { version: 1 as const, id: "location-rev", entityId: "location", entityKind: "location" as const, revision: 1, description: "Quiet room", attributes: {}, referenceAssetIds: [], contentHash: sha("location"), createdAt: 100 };
  const style = { version: 1 as const, id: "style-rev", entityId: "style", entityKind: "style" as const, revision: 1, description: "Paper cutout", attributes: {}, referenceAssetIds: [], contentHash: sha("style"), createdAt: 100 };
  const story = { version: 1 as const, id: "story-rev", projectId: "project-1", parentRevisionId: null, scriptText: "A door opens.", beats: [{ id: "beat-1", action: "A door opens.", narration: "", dialogue: [], order: 0 }], canonRevisionIds: [location.id, style.id], contentHash: sha("story"), createdAt: 100 };
  const shot = { version: 1 as const, id: "shot-rev", shotId: "shot-1", storyRevisionId: story.id, beatIds: ["beat-1"], order: 0, visualIntent: "A door opens.", motionIntent: "Door opens slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide" as const, targetFrames: 124, continuation: null, contentHash: sha("shot"), createdAt: 100 };
  const plan = { version: 1 as const, id: "plan-rev", projectId: "project-1", storyRevisionId: story.id, orderedShotRevisionIds: [shot.id], beatCoverage: [{ beatId: "beat-1", shotRevisionIds: [shot.id] }], contentHash: sha("plan"), createdAt: 100 };
  const animatic = { version: 1 as const, id: "animatic-rev", projectId: "project-1", shotPlanRevisionId: plan.id, slots: [{ shotRevisionId: shot.id, anchorId: null, placeholderLabel: "reviewed timing" }], timingAnnotations: [], totalFrames: 124, contentHash: sha("animatic"), createdAt: 100 };
  const approved = (id: string, targetKind: "story" | "animatic", targetId: string, targetHash: string) => ({ version: 1 as const, id, targetKind, targetId, targetHash, decision: "approved" as const, actorId: "creator-1", createdAt: 200, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] });
  store.transaction(tx => {
    tx.insertCanonRevision(location); tx.insertCanonRevision(style); tx.insertStoryRevision(story); tx.insertShotRevisions([shot]); tx.insertShotPlanRevision(plan); tx.insertAnimaticRevision(animatic);
    tx.appendApproval(approved("story-approval", "story", story.id, story.contentHash)); tx.appendApproval(approved("animatic-approval", "animatic", animatic.id, animatic.contentHash));
    tx.compareAndSetProject({ ...project, activeCanonRevisionIds: [location.id, style.id], activeStoryRevisionId: story.id, activeShotPlanRevisionId: plan.id, activeAnimaticRevisionId: animatic.id, saveVersion: project.saveVersion + 1, updatedAt: 200 }, project.saveVersion);
  });
  const prompt = "Fixture anchor prompt";
  const semanticBase = { projectId: "project-1", jobId: "anchor-job", idempotencyKey: "anchor-key", quoteId: "semantic-probe", providerId: "sogni", modelId: "image-model", prompt, inputs: [], parameters: { recipeVersion: 1 }, billingMode: "subscription" as const, resultTarget: { kind: "anchor" as const, shotRevisionId: shot.id, inputsHash: "0".repeat(64) } };
  const semanticHash = computeProductionInputsHash(store.read, "anchor", semanticBase as ProviderRequestSnapshot);
  const resultTarget = { kind: "anchor" as const, shotRevisionId: shot.id, inputsHash: semanticHash };
  const recipe = { recipeVersion: 1 as const, operation: "anchor" as const, projectId: "project-1", providerId: "sogni", modelId: "image-model", shotRevisionId: shot.id, prompt, inputs: [] as [], parameters: { recipeVersion: 1 }, billingMode: "subscription" as const, resultTarget, canonRevisionIds: [location.id, style.id], selectionPins: { storyRevisionId: story.id, storyHash: story.contentHash, storyApprovalIds: ["story-approval"], shotPlanRevisionId: plan.id, shotPlanHash: plan.contentHash, animaticRevisionId: animatic.id, animaticHash: animatic.contentHash, animaticApprovalIds: ["animatic-approval"] } };
  const request = toMediaQuoteRequest(recipe);
  const policy = reviewedPolicyPayload();
  const provider = fakeProvider(clock, options.providerCapability);
  const producer = { producerId: "fixture-composer", producerVersion: "fixture-composer-v1", sourceHash: sha("composer-source") };
  const composer = createProductionBudgetComposer({ store, provider, reviewedPolicy: policy.input, now: clock, idFactory, producer });
  const makeComposer = (providerOverrides: Parameters<typeof fakeProvider>[1] = {}, reviewedPolicyInput: ReturnType<typeof reviewedPolicyPayload>["input"] | null = policy.input) => createProductionBudgetComposer({ store, provider: fakeProvider(clock, providerOverrides), reviewedPolicy: reviewedPolicyInput, now: clock, idFactory, producer });
  const insertJob = (quoteId: string, jobId = "anchor-job", idempotencyKey = "anchor-key") => {
    const snapshot = JSON.parse(canonicalJson({ ...semanticBase, jobId, idempotencyKey, quoteId, resultTarget })) as ProviderRequestSnapshot;
    const job = { version: 1 as const, id: jobId, projectId: "project-1", operation: "anchor" as const, status: (options.jobStatus ?? "submitting"), idempotencyKey, requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: "sogni", modelId: "image-model", providerRef: null, quoteId, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: clock(), updatedAt: clock() };
    store.transaction(tx => tx.insertJob(job, { id: `${jobId}-outbox`, jobId: job.id, createdAt: job.createdAt, claimedAt: null, claimToken: null }));
    return { job, snapshot };
  };
  const setupBudgetAuthorization = async () => {
    const b3 = createProductionBudgetService({ store, now: clock, idFactory: () => `b3-${++b3n}`, resolveAccountIdentity: composer.resolveAccountIdentity, currentCredentialBindingId: composer.currentCredentialBindingId });
    const accountPolicy = await b3.createPolicy("project-1", { providerId: "sogni", unit: "minor_currency", currency: "USD", dailyCap: 10_000, expiresAt: null, revoked: false, actorId: "creator-1" });
    const authorization = await b3.authorizeProject("project-1", { providerId: "sogni", unit: "minor_currency", currency: "USD" }, { expectedAuthorizationRevision: null, expectedPolicyRevision: accountPolicy.revision, policyId: accountPolicy.policyId, projectCap: 10_000, allowedModelIds: ["image-model"], allowedOperations: ["anchor"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
    return { b3, accountPolicy, authorization };
  };
  return { store, dataDir, clock, provider, composer, makeComposer, policy, recipe, request, producer, insertJob, setupBudgetAuthorization };
}
type ComposerFixture = Awaited<ReturnType<typeof composerFixture>>;
type Draft = Awaited<ReturnType<ComposerFixture["composer"]["prepareMediaQuoteDraft"]>>;
async function admitAndCompose(jobStatus: "queued" | "submitting") {
  const f = await composerFixture({ jobStatus });
  const draft = await f.composer.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
  if (draft.kind !== "bound") throw new Error("fixture draft was not bound");
  f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); f.composer.commitPreparedQuote(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); });
  const { job, snapshot } = f.insertJob(draft.mediaQuote.id);
  await f.setupBudgetAuthorization();
  f.provider.setRole("worker");
  const context = await f.composer.prepareWorkerBudgetContext(job, draft.mediaQuote, draft.capability);
  const at = f.clock();
  const reservation = f.store.transaction(tx => f.composer.reserveSubmission(tx, job, draft.mediaQuote, draft.capability, at, context));
  return { f, draft, job, snapshot, at, reservation };
}

describe("production budget composer", () => {
  it("I01-B6-C composes a bound account_session quote atomically or not at all", async () => {
    const f = await composerFixture();
    const draft = await f.composer.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    expect(draft.kind).toBe("bound");
    if (draft.kind !== "bound") throw new Error("unreachable");
    expect(draft.mediaQuote).toMatchObject({ entitlement: "subscription", estimateMinMinor: 10, estimateMaxMinor: 25, currency: "USD", withinAuthorizedCap: "unknown" });
    expect(draft.mediaQuote.inputHash).toBe(hashCanonicalJson(quoteProjection(f.recipe)));
    expect(draft.mediaQuote.expiresAt).toBe(draft.mediaQuote.createdAt + 30_000);
    expect(draft.binding.executionSemanticHash).toBe(f.recipe.resultTarget.inputsHash);
    expect(draft.binding.credentialBindingId).toBe(draft.expectedGeneration.generationId);
    expect(draft.accountEvidence.credentialBindingId).toBe(draft.expectedGeneration.generationId);
    const accountPayload = proofPayload(draft.accountArtifact);
    if (accountPayload.kind !== "account_session") throw new Error("unreachable");
    expect(accountPayload.generation).toEqual(draft.expectedGeneration);
    expect(accountPayload.expiresAt).toBe(accountPayload.observedAt + 60_000);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0 });

    // A throwing injected commit hook leaves zero rows of any composed kind; the durable
    // credential generation from prepare remains (composerProtocol step 2 orders the CAS write
    // before the capability check and quote assembly).
    const throwingHook = (..._: unknown[]): void => { throw new Error("injected commitPreparedQuote failure"); };
    expect(() => f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); throwingHook(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); })).toThrow("injected commitPreparedQuote failure");
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0, generations: 1 });

    // An expired capability fails closed with the same zero composed rows.
    const expired = f.makeComposer({ expiresAt: 1 });
    await expect(expired.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request })).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0 });

    // No policy or an uncovered model yields the takes-default unknown quote with no companions.
    const noPolicy = f.makeComposer({}, null);
    const unknownDraft = await noPolicy.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    expect(unknownDraft.kind).toBe("unknown");
    if (unknownDraft.kind !== "unknown") throw new Error("unreachable");
    expect(unknownDraft.mediaQuote).toMatchObject({ entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, withinAuthorizedCap: "unknown" });
    expect(unknownDraft.mediaQuote.inputHash).toBe(hashCanonicalJson(quoteProjection(f.recipe)));
    expect(unknownDraft.mediaQuote.expiresAt - unknownDraft.mediaQuote.createdAt).toBe(30_000);
    const uncoveredPolicy = reviewedPolicyPayload({}, { priceByModel: [{ modelId: "other-model", operations: ["anchor" as const], entitlement: "spark" as const, unit: "spark_token" as const, currency: null, estimateMinMinor: 1, estimateMaxMinor: 2 }] });
    const uncovered = f.makeComposer({}, uncoveredPolicy.input);
    await expect(uncovered.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request })).resolves.toMatchObject({ kind: "unknown" });
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0 });

    // The single-transaction composition is durable: reopen the SQLite fixture and verify every row.
    f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); f.composer.commitPreparedQuote(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); });

    // A conflicting re-quote (same budget quote id, mutated media quote) rejects atomically.
    const mutated: Draft = { ...draft, mediaQuote: { ...draft.mediaQuote, id: "quote:requote-mutated", estimateMaxMinor: 999 }, budgetQuote: { ...draft.budgetQuote, estimateMax: 999 } };
    expect(() => f.store.transaction(tx => { tx.insertQuote(mutated.mediaQuote); f.composer.commitPreparedQuote(tx, mutated, { recipe: f.recipe, request: f.request, at: f.clock() }); })).toThrow(/Conflicting immutable budget quote/);
    f.store.close();
    const reopened = openProductionStore({ dataDir: f.dataDir }); stores.push(reopened);
    expect(reopened.read.getQuote(draft.mediaQuote.id)).toEqual(draft.mediaQuote);
    expect(reopened.read.getBudgetQuote(draft.budgetQuote.id)).toEqual(draft.budgetQuote);
    expect(reopened.read.getQuoteAccountBinding(draft.budgetQuote.id)).toEqual(draft.binding);
    expect(reopened.read.getAccountEvidence(draft.accountEvidence.id)).toEqual(draft.accountEvidence);
    expect(reopened.read.getProofArtifact(draft.accountArtifact.hash)).toEqual(draft.accountArtifact);
    expect(reopened.read.getProofArtifact(draft.policyArtifact.hash)).toEqual(draft.policyArtifact);
    expect(reopened.read.getProofArtifact(draft.quoteArtifact.hash)).toEqual(draft.quoteArtifact);
    expect(reopened.read.getQuoteProof(draft.budgetQuote.id)).toEqual(draft.quoteProof);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 1, budgetQuotes: 1, bindings: 1, evidence: 1, artifacts: 3, quoteProofs: 1 });
  });

  it("I01-B6-C resolver admits only the exact durable pinned execution", async () => {
    const { f, draft, job, snapshot, at } = await admitAndCompose("submitting");
    const captured = f.provider.captured();
    expect(typeof f.composer.submissionProofResolver(snapshot, captured, at + 1)).toBe("boolean");
    expect(f.composer.submissionProofResolver(snapshot, captured, at + 1)).toBe(true);

    const link = f.store.read.getExecutionProof(job.id);
    if (!link) throw new Error("unreachable");
    const payload = proofPayload(f.store.read.getProofArtifact(link.artifactHash)!);
    if (payload.kind !== "execution_session") throw new Error("unreachable");
    expect(f.composer.submissionProofResolver(snapshot, captured, payload.expiresAt)).toBe(false);
    expect(f.composer.submissionProofResolver(snapshot, captured, payload.expiresAt + 1)).toBe(false);
    expect(f.composer.submissionProofResolver(snapshot, { ...captured, credentialFingerprint: sha("other-fingerprint") }, at + 1)).toBe(false);
    expect(f.composer.submissionProofResolver(snapshot, { ...captured, session: { ...captured.session, sessionId: "sogni-session:other" } }, at + 1)).toBe(false);
    expect(f.composer.submissionProofResolver({ ...snapshot, prompt: `${snapshot.prompt} mutated` }, captured, at + 1)).toBe(false);

    // A rotated durable generation head denies the captured session.
    const rotated = f.store.transaction(tx => tx.compareAndSetProviderCredentialGeneration({ schemaVersion: 1, providerId: "sogni", revision: payload.generation.revision + 1, generationId: "sogni-generation:rotated", accountId: payload.generation.accountId, credentialFingerprint: sha("rotated-fingerprint"), changedAt: payload.generation.changedAt + 1 }, payload.generation.revision));
    expect(rotated).toBe(true);
    expect(f.composer.submissionProofResolver(snapshot, captured, at + 1)).toBe(false);

    // A submitting job without a durable execution proof is denied.
    const missing = await composerFixture();
    const missingQuote = { version: 1 as const, id: "quote:missing-proof", projectId: "project-1", providerId: "sogni", modelId: "image-model", operation: "anchor" as const, inputHash: sha("missing-quote"), entitlement: "unknown" as const, estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: 100_000, withinAuthorizedCap: "unknown" as const, createdAt: 1_000 };
    missing.store.transaction(tx => tx.insertQuote(missingQuote));
    const missingJob = missing.insertJob(missingQuote.id);
    expect(missing.composer.submissionProofResolver(missingJob.snapshot, missing.provider.captured(), missing.clock())).toBe(false);

    // A job that never reached submitting is denied even with a fully pinned execution.
    const wrongStatus = await admitAndCompose("queued");
    expect(wrongStatus.f.composer.submissionProofResolver(wrongStatus.snapshot, wrongStatus.f.provider.captured(), wrongStatus.at + 1)).toBe(false);
  });

  it("I01-B6-C interleaved worker context preparations each capture their own observation", async () => {
    const f = await composerFixture({ jobStatus: "submitting" });
    const draft = await f.composer.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    if (draft.kind !== "bound") throw new Error("unreachable");
    f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); f.composer.commitPreparedQuote(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); });
    const { job: jobA } = f.insertJob(draft.mediaQuote.id);
    const { job: jobB } = f.insertJob(draft.mediaQuote.id, "anchor-job-b", "anchor-key-b");
    await f.setupBudgetAuthorization();

    // One shared composer whose observeAccount responses are deferred per call. Observations keep
    // the quote-time credential fingerprint (budget.ts pins the worker generation to the quote's
    // binding) but carry per-call worker sessions and observation times, so each call's worker
    // artifact hash is distinct and observable.
    const pendingDeliveries: Array<(observation: ProviderAccountObservation) => void> = [];
    const deferredProvider = {
      ...f.provider,
      observeAccount: () => new Promise<ProviderAccountObservation>(deliver => { pendingDeliveries.push(deliver); }),
    };
    let sharedId = 0;
    const composer = createProductionBudgetComposer({ store: f.store, provider: deferredProvider, reviewedPolicy: f.policy.input, now: f.clock, idFactory: () => `interleaved-${++sharedId}`, producer: f.producer });
    const observationFor = (label: string): ProviderAccountObservation => ({
      providerId: "sogni",
      captured: {
        session: { sessionId: `sogni-session:interleaved-${label}`, role: "worker" as const, sdkVersion: "5.49.0", sdkSourceHash: sha("sdk-source"), adapterVersion: "fixture-adapter-v1" },
        credentialFingerprint: sha("credential-fingerprint"),
        accountId: "sogni-account:fixture-account",
      },
      subscription: { active: true, status: "active", tier: "standard", currentPeriodEnd: null, providerVersion: 1 },
      observedAt: f.clock(),
    });

    const promiseA = composer.prepareWorkerBudgetContext(jobA, draft.mediaQuote, draft.capability);
    const promiseB = composer.prepareWorkerBudgetContext(jobB, draft.mediaQuote, draft.capability);
    expect(pendingDeliveries).toHaveLength(2);
    const observationB = observationFor("b");
    pendingDeliveries[1]!(observationB); // resolve in the opposite order to the call order
    await Promise.resolve(); // let call B capture its observation before call A's resolves
    const observationA = observationFor("a");
    pendingDeliveries[0]!(observationA);
    const [contextA, contextB] = await Promise.all([promiseA, promiseB]);

    // Each returned context carries exactly its own observation's worker evidence.
    expect(contextA.budgetQuoteId).toBe(draft.budgetQuote.id);
    expect(contextB.budgetQuoteId).toBe(draft.budgetQuote.id);
    const generationA = contextA.providerProofDraft.generation;
    const generationB = contextB.providerProofDraft.generation;
    expect(generationA).toEqual(generationB); // one durable head generation, adopted by both observations
    expect(contextA.accountEvidenceId).toBe(draft.accountEvidence.id);
    expect(contextB.accountEvidenceId).toBe(draft.accountEvidence.id);
    expect(contextA.providerProofDraft.observedAt).toBe(observationA.observedAt);
    expect(contextB.providerProofDraft.observedAt).toBe(observationB.observedAt);
    expect(observationA.observedAt).not.toBe(observationB.observedAt);
    expect(contextA.providerProofDraft.workerArtifact.hash).not.toBe(contextB.providerProofDraft.workerArtifact.hash);
    const workerPayloadA = proofPayload(contextA.providerProofDraft.workerArtifact);
    const workerPayloadB = proofPayload(contextB.providerProofDraft.workerArtifact);
    if (workerPayloadA.kind !== "account_session" || workerPayloadB.kind !== "account_session") throw new Error("unreachable");
    expect(workerPayloadA.generation).toEqual(generationA);
    expect(workerPayloadB.generation).toEqual(generationB);
    expect(workerPayloadA.session.sessionId).toBe(observationA.captured.session.sessionId);
    expect(workerPayloadB.session.sessionId).toBe(observationB.captured.session.sessionId);
    // The worker artifacts carried by each context are the durable rows written for that call.
    expect(f.store.read.getProofArtifact(contextA.providerProofDraft.workerArtifact.hash)).toEqual(contextA.providerProofDraft.workerArtifact);
    expect(f.store.read.getProofArtifact(contextB.providerProofDraft.workerArtifact.hash)).toEqual(contextB.providerProofDraft.workerArtifact);
  });

  it("B6-C-FIX2 requotes under the same installed reviewed policy without conflicting on the policy artifact", async () => {
    const f = await composerFixture();
    const draft1 = await f.composer.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    if (draft1.kind !== "bound") throw new Error("unreachable");
    f.store.transaction(tx => { tx.insertQuote(draft1.mediaQuote); f.composer.commitPreparedQuote(tx, draft1, { recipe: f.recipe, request: f.request, at: f.clock() }); });

    // A second, different recipe requotes under the identical installed reviewedPolicyInput
    // (same capturedAt): the policy payload is static, so its artifact must re-insert as a no-op.
    const recipe2 = { ...f.recipe, prompt: "Fixture anchor prompt, requote", resultTarget: { kind: "anchor" as const, shotRevisionId: f.recipe.shotRevisionId, inputsHash: sha("requote-semantic-target") } };
    const request2 = toMediaQuoteRequest(recipe2);
    const draft2 = await f.composer.prepareMediaQuoteDraft({ recipe: recipe2, request: request2 });
    if (draft2.kind !== "bound") throw new Error("unreachable");
    f.store.transaction(tx => { tx.insertQuote(draft2.mediaQuote); f.composer.commitPreparedQuote(tx, draft2, { recipe: recipe2, request: request2, at: f.clock() }); });

    // The policy artifact is deterministic per policy input: identical hash and identical
    // schema-floor createdAt (policyInput.capturedAt), stored exactly once.
    expect(draft2.policyArtifact).toEqual(draft1.policyArtifact);
    expect(draft1.policyArtifact.createdAt).toBe(f.policy.input.capturedAt);
    expect(f.store.read.getProofArtifact(draft1.policyArtifact.hash)).toEqual(draft1.policyArtifact);
    // Each quote still carries its own account and media quote artifacts.
    expect(draft2.mediaQuote.id).not.toBe(draft1.mediaQuote.id);
    expect(draft2.accountArtifact.hash).not.toBe(draft1.accountArtifact.hash);
    expect(draft2.quoteArtifact.hash).not.toBe(draft1.quoteArtifact.hash);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 2, budgetQuotes: 2, bindings: 2, evidence: 2, artifacts: 5, quoteProofs: 2 });
    expect(artifactKindCount(f.dataDir, "reviewed_policy")).toBe(1);
    expect(artifactKindCount(f.dataDir, "account_session")).toBe(2);
    expect(artifactKindCount(f.dataDir, "media_quote")).toBe(2);
  });

  it("C13-LIVE-FIX composes a bound live quote when the provider observes capabilities after the request clock", async () => {
    const f = await composerFixture();
    await f.setupBudgetAuthorization();
    // Live catalog discovery legitimately observes after the composer's pre-await request clock:
    // the provider stamps the receipt with its own clock after the awaited network round-trip, so
    // receipt.observedAt lands strictly after mediaQuote.createdAt (the composer's entry clock).
    // A fresh, otherwise-healthy receipt like this must still compose a bound quote.
    const live = f.makeComposer({ discoverObservedAt: "after_await" });
    const draft = await live.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    expect(draft.kind).toBe("bound");
    if (draft.kind !== "bound") throw new Error("unreachable");
    expect(draft.capability.observedAt).toBeGreaterThan(draft.mediaQuote.createdAt);
    expect(draft.mediaQuote).toMatchObject({ entitlement: "subscription", withinAuthorizedCap: "yes" });
    f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); live.commitPreparedQuote(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); });
    expect(f.store.read.getBudgetQuote(draft.budgetQuote.id)).toEqual(draft.budgetQuote);
  });

  it("C13-LIVE-FIX still blocks capability receipts stamped ahead of the post-await clock", async () => {
    const f = await composerFixture();
    // A receipt observed a full minute into the future (beyond even the post-await clock) with a
    // coherent TTL must stay blocked: moving to the post-await clock must not vacate the predicate.
    const future = f.makeComposer({ discoverObservedAt: "far_future" });
    await expect(future.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request })).rejects.toMatchObject({ code: "BUDGET_BLOCKED", message: "Fresh live provider capability evidence does not satisfy this operation; quote composition is blocked." });
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0 });
  });

  it("C13-LIVE-FIX-2 pins the execution proof to the quote-time capability when the worker re-discovers", async () => {
    // Live, the worker's admission discovery is a SECOND network call, so its receipt necessarily
    // carries a different observedAt than the quote-time receipt ("after_await" stamps every
    // discovery with the provider-side post-await clock, exactly like the live catalog). The
    // reservation must still commit: the execution proof pins the QUOTE payload's capability (the
    // evidence the quote was authorized against), while the worker's own fresh discovery remains
    // the admission/submit gate in worker.ts.
    const f = await composerFixture({ jobStatus: "submitting", providerCapability: { discoverObservedAt: "after_await" } });
    const draft = await f.composer.prepareMediaQuoteDraft({ recipe: f.recipe, request: f.request });
    if (draft.kind !== "bound") throw new Error("unreachable");
    f.store.transaction(tx => { tx.insertQuote(draft.mediaQuote); f.composer.commitPreparedQuote(tx, draft, { recipe: f.recipe, request: f.request, at: f.clock() }); });
    const { job } = f.insertJob(draft.mediaQuote.id);
    await f.setupBudgetAuthorization();
    f.provider.setRole("worker");
    // Worker admission path (worker.ts): the worker performs its own separate live discovery and
    // hands that second receipt to budget context preparation and reservation.
    const workerCapability = await f.provider.discoverCapabilities();
    expect(workerCapability.observedAt).not.toBe(draft.capability.observedAt);
    const context = await f.composer.prepareWorkerBudgetContext(job, draft.mediaQuote, workerCapability);
    const at = f.clock();
    const reservation = f.store.transaction(tx => f.composer.reserveSubmission(tx, job, draft.mediaQuote, workerCapability, at, context));
    expect(reservation.id).toBeTruthy();
    // The stored execution proof embeds the quote-time capability, never the worker's second receipt.
    const link = f.store.read.getExecutionProof(job.id);
    if (!link) throw new Error("unreachable");
    const payload = proofPayload(f.store.read.getProofArtifact(link.artifactHash)!);
    if (payload.kind !== "execution_session") throw new Error("unreachable");
    const quoteProof = f.store.read.getQuoteProof(context.budgetQuoteId);
    if (!quoteProof) throw new Error("unreachable");
    const quotePayload = proofPayload(f.store.read.getProofArtifact(quoteProof.artifactHash)!);
    if (quotePayload.kind !== "media_quote") throw new Error("unreachable");
    expect(canonicalJson(payload.capability)).toBe(canonicalJson(quotePayload.capability));
    expect(payload.capability.observedAt).toBe(draft.capability.observedAt);
    expect(payload.capability.observedAt).not.toBe(workerCapability.observedAt);
  });
});
