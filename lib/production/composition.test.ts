import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProductionStore, type SqliteProductionStore, type SqliteStoreOptions } from "../repositories/production/sqlite";
import type { ProductionRuntimeOptions } from "./runtime";
import { canonicalJson, hashCanonicalJson } from "./hash";
import { parseReviewedQuotePolicy } from "./proof-policy";
import { withProductionComposition, loadReviewedPolicyFromPath, type ProductionComposition, type ProductionCompositionProviderFactory } from "./composition";
import type { SogniFactoryOptions } from "../providers/production/sogni-provider";
import { computeProductionInputsHash, ProductionJobQueue } from "../jobs/production/queue";
import { ProductionWorker, type ProductionWorkerOptions } from "../jobs/production/worker";
import { createBudgetRouteHandlers } from "../services/production/budget";
import { createMediaRouteHandlers, toMediaQuoteRequest } from "../services/production/takes";
import type { PreparedSubmissionContext } from "../services/production/budget-composer";
import type { CapabilityReceipt } from "./contracts";
import type { ProviderMediaResult, ProviderSubmissionAck } from "../repositories/production/ports";
import type { ProviderRequestSnapshot } from "./contracts";

const dirs: string[] = [];
const stores: SqliteProductionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* reopened fixtures are already closed */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (label: string) => hashCanonicalJson({ fixture: label });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function compositionCounts(dataDir: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    return {
      quotes: count("SELECT COUNT(*) AS count FROM records WHERE kind='quote'"),
      jobs: count("SELECT COUNT(*) AS count FROM records WHERE kind='job'"),
      budgetQuotes: count("SELECT COUNT(*) AS count FROM budget_quotes"),
      bindings: count("SELECT COUNT(*) AS count FROM budget_quote_bindings"),
      evidence: count("SELECT COUNT(*) AS count FROM budget_account_evidence"),
      artifacts: count("SELECT COUNT(*) AS count FROM provider_proof_artifacts"),
      quoteProofs: count("SELECT COUNT(*) AS count FROM provider_quote_proofs"),
      executionProofs: count("SELECT COUNT(*) AS count FROM provider_execution_proofs"),
      generations: count("SELECT COUNT(*) AS count FROM provider_credential_generations"),
      reservations: count("SELECT COUNT(*) AS count FROM budget_reservations"),
    };
  } finally { db.close(); }
}

function reviewedPolicy(overrides: { capturedAt?: number; expiresAt?: number } = {}) {
  const capture = "Fixture reviewed policy capture for the offline composition tests.";
  const config = {
    schemaVersion: 1 as const,
    providerId: "sogni",
    quoteTtlMs: 30_000,
    accountSessionTtlMs: 60_000,
    executionSessionTtlMs: 60_000,
    billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" as const }],
    priceByModel: [{ modelId: "image-model", operations: ["anchor" as const, "take" as const], entitlement: "subscription" as const, unit: "minor_currency" as const, currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }],
  };
  return parseReviewedQuotePolicy({ schemaVersion: 1, kind: "reviewed_policy", producer: { producerId: "fixture-reviewer", producerVersion: "fixture-reviewer-v1", sourceHash: sha("reviewer-provenance") }, providerId: "sogni", reviewVersion: "review-1", sourceUrl: "https://policy.fixture.example/sogni-pricing-v1", sourceCapture: capture, sourceCaptureSha256: sha256(capture), reviewedConfigCanonicalJson: canonicalJson(config), reviewedConfigHash: hashCanonicalJson(config), capturedAt: 0, expiresAt: 10_000_000_000_000, ...overrides });
}

type FakeProviderOptions = { projectsCreate: (modelId: string) => string; resolverCalls?: boolean[]; closes?: number[]; pollState?: () => "running" | "completed" };
function fakeProviderFactory(options: FakeProviderOptions): ProductionCompositionProviderFactory {
  return factoryOptions => {
    // Observations advance monotonically like C's offline composer fixtures: two same-millisecond
    // observations would otherwise rebuild an identical account_session payload while the durable
    // credential generation head keeps a fresher changedAt, conflicting on artifact createdAt.
    let observationTick = Date.now() - 10_000;
    const role = factoryOptions.role === "worker" ? "worker" as const : "web" as const;
    const captured = () => ({ session: { sessionId: `sogni-session:composition-${role}`, role, sdkVersion: "5.49.0", sdkSourceHash: sha("sdk-source"), adapterVersion: "fixture-adapter-v1" }, credentialFingerprint: sha("credential-fingerprint"), accountId: "sogni-account:composition-account" });
    // Anchored behind the monotonic observation base so live capability evidence always
    // predates every account observation, as provider catalogs do in reality.
    const observedAt = Date.now() - 70_000;
    const capability: CapabilityReceipt = { version: 1, providerId: "sogni", modelId: "image-model", provenance: "live_catalog", observedAt, expiresAt: observedAt + 24 * 3_600_000, supportedOperations: ["image", "video"], aspectRatios: ["9:16"], maxReferenceImages: 9, supportsStartFrame: true, supportsEndFrame: true, supportsContextImages: true, supportsTimedKeyframes: false, minFrames: null, maxFrames: null, frameStep: null, supportsNativeAudio: false };
    return {
      providerId: "sogni" as const,
      observeAccount: async () => ({ providerId: "sogni", captured: captured(), subscription: { active: true, status: "active", tier: "standard", currentPeriodEnd: null, providerVersion: 1 }, observedAt: ++observationTick }),
      currentSession: () => captured(),
      discoverCapabilities: async () => capability,
      quote: async () => { throw new Error("offline fixture provider does not quote"); },
      submit: async (snapshot, receipt): Promise<ProviderSubmissionAck> => {
        const session = captured();
        const admitted = typeof factoryOptions.submissionProofResolver === "function" && factoryOptions.submissionProofResolver(snapshot, session, Date.now());
        options.resolverCalls?.push(admitted);
        if (!admitted) throw new Error("fixture submission was not admitted by the durable execution proof resolver");
        options.projectsCreate(snapshot.modelId);
        return { providerRef: "fixture-provider-ref", honoredInputs: { version: 1, id: `receipt:${snapshot.jobId}`, jobId: snapshot.jobId, capabilityProvenance: receipt.provenance, capabilityObservedAt: receipt.observedAt, inputs: snapshot.inputs.map(input => ({ role: input.role, assetId: input.assetId, required: input.required, state: "mapped" as const, providerField: input.role, disclosedOmission: null })), createdAt: Date.now() } };
      },
      poll: async (): Promise<ProviderMediaResult> => (options.pollState?.() ?? "running") === "completed"
        ? { providerRef: "fixture-provider-ref", state: "completed", temporaryUrl: "https://fixture.invalid/composition-result", mime: "image/png", width: null, height: null, frames: null, errorCode: null, errorMessage: null }
        : { providerRef: "fixture-provider-ref", state: "running", temporaryUrl: null, mime: null, width: null, height: null, frames: null, errorCode: null, errorMessage: null },
      cancel: async () => {},
      close: async () => { options.closes?.push(1); },
    };
  };
}

function fixtureStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-composition-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir }); stores.push(store);
  const project = { version: 1 as const, id: "project-1", name: "Composition fixture", profileId: "profile-1", profile: { id: "profile-1", format: "9:16" as const, language: "en", ageIntent: "family", targetFrames: 124, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [] as string[], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 };
  store.transaction(tx => tx.insertProject(project));
  const location = { version: 1 as const, id: "location-rev", entityId: "location", entityKind: "location" as const, revision: 1, description: "Quiet room", attributes: {}, referenceAssetIds: [], contentHash: sha("location"), createdAt: 100 };
  const style = { version: 1 as const, id: "style-rev", entityId: "style", entityKind: "style" as const, revision: 1, description: "Paper cutout", attributes: {}, referenceAssetIds: [], contentHash: sha("style"), createdAt: 100 };
  const story = { version: 1 as const, id: "story-rev", projectId: project.id, parentRevisionId: null, scriptText: "A door opens.", beats: [{ id: "beat-1", action: "A door opens.", narration: "", dialogue: [], order: 0 }], canonRevisionIds: [location.id, style.id], contentHash: sha("story"), createdAt: 100 };
  const shot = { version: 1 as const, id: "shot-rev", shotId: "shot-1", storyRevisionId: story.id, beatIds: ["beat-1"], order: 0, visualIntent: "A door opens.", motionIntent: "Door opens slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide" as const, targetFrames: 124, continuation: null, contentHash: sha("shot"), createdAt: 100 };
  const plan = { version: 1 as const, id: "plan-rev", projectId: project.id, storyRevisionId: story.id, orderedShotRevisionIds: [shot.id], beatCoverage: [{ beatId: "beat-1", shotRevisionIds: [shot.id] }], contentHash: sha("plan"), createdAt: 100 };
  const animatic = { version: 1 as const, id: "animatic-rev", projectId: project.id, shotPlanRevisionId: plan.id, slots: [{ shotRevisionId: shot.id, anchorId: null, placeholderLabel: "reviewed timing" }], timingAnnotations: [], totalFrames: 124, contentHash: sha("animatic"), createdAt: 100 };
  const approved = (id: string, targetKind: "story" | "animatic", targetId: string, targetHash: string) => ({ version: 1 as const, id, targetKind, targetId, targetHash, decision: "approved" as const, actorId: "creator-1", createdAt: 200, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] });
  store.transaction(tx => {
    tx.insertCanonRevision(location); tx.insertCanonRevision(style); tx.insertStoryRevision(story); tx.insertShotRevisions([shot]); tx.insertShotPlanRevision(plan); tx.insertAnimaticRevision(animatic);
    tx.appendApproval(approved("story-approval", "story", story.id, story.contentHash)); tx.appendApproval(approved("animatic-approval", "animatic", animatic.id, animatic.contentHash));
    tx.compareAndSetProject({ ...project, activeCanonRevisionIds: [location.id, style.id], activeStoryRevisionId: story.id, activeShotPlanRevisionId: plan.id, activeAnimaticRevisionId: animatic.id, saveVersion: project.saveVersion + 1, updatedAt: 200 }, project.saveVersion);
  });
  return { store, dataDir, project, story, shot, location, style, plan, animatic };
}

const anchorPrep = (f: ReturnType<typeof fixtureStore>) => ({ kind: "anchor" as const, command: { projectId: f.project.id, shotRevisionId: f.shot.id, renderSettings: { providerId: "sogni", modelId: "image-model", aspect: "9:16" as const, resolution: "720p" as const, seed: null, referenceAssetIds: [] as string[] } } });

function anchorRecipe(f: ReturnType<typeof fixtureStore>) {
  const prompt = "Fixture anchor prompt";
  const semanticBase = { projectId: f.project.id, jobId: "recipe-probe", idempotencyKey: "recipe-key", quoteId: "recipe-quote", providerId: "sogni", modelId: "image-model", prompt, inputs: [], parameters: { recipeVersion: 1 }, billingMode: "subscription" as const, resultTarget: { kind: "anchor" as const, shotRevisionId: f.shot.id, inputsHash: "0".repeat(64) } };
  const semanticHash = computeProductionInputsHash(f.store.read, "anchor", semanticBase as ProviderRequestSnapshot);
  return { recipeVersion: 1 as const, operation: "anchor" as const, projectId: f.project.id, providerId: "sogni", modelId: "image-model", shotRevisionId: f.shot.id, prompt, inputs: [] as [], parameters: { recipeVersion: 1 }, billingMode: "subscription" as const, resultTarget: { kind: "anchor" as const, shotRevisionId: f.shot.id, inputsHash: semanticHash }, canonRevisionIds: [f.location.id, f.style.id], selectionPins: { storyRevisionId: f.story.id, storyHash: f.story.contentHash, storyApprovalIds: ["story-approval"], shotPlanRevisionId: f.plan.id, shotPlanHash: f.plan.contentHash, animaticRevisionId: f.animatic.id, animaticHash: f.animatic.contentHash, animaticApprovalIds: ["animatic-approval"] } };
}

function workerCallbacks(composition: ProductionComposition): Pick<ProductionWorkerOptions, "prepareBudgetContext" | "reserveSubmission"> {
  return {
    prepareBudgetContext: (job, quote, capability) => composition.composer.prepareWorkerBudgetContext(job, quote, capability),
    reserveSubmission: (tx, job, quote, capability, at, context) => composition.composer.reserveSubmission(tx, job, quote, capability, at, context as PreparedSubmissionContext),
  };
}

describe("production composition", () => {
  it("I01-B6-W composition lifecycle and fail-closed defaults", async () => {
    const f = fixtureStore();
    const closes: number[] = [];
    const providerFactory = vi.fn(fakeProviderFactory({ projectsCreate: () => "fixture-project-id", closes }));
    const providedClose = vi.spyOn(f.store, "close");

    // Nothing opens before a composition runs, and a throwing work function still closes
    // exactly the resources the composition created (its store and its provider).
    const createdStores: SqliteProductionStore[] = [];
    let createdStoreCloses = 0;
    const runtimeDir = mkdtempSync(join(tmpdir(), "perabyte-composition-runtime-")); dirs.push(runtimeDir);
    const storeFactory = vi.fn((storeOptions: SqliteStoreOptions) => {
      const created = openProductionStore(storeOptions);
      const originalClose = created.close.bind(created);
      created.close = () => { createdStoreCloses += 1; originalClose(); };
      createdStores.push(created);
      return created;
    });
    await expect(withProductionComposition(async () => { throw new Error("injected composition failure"); }, { role: "web", providerFactory, runtimeOptions: { env: { PERABYTE_STUDIO_DATA_DIR: runtimeDir }, storeFactory } })).rejects.toThrow("injected composition failure");
    expect(storeFactory).toHaveBeenCalledTimes(1);
    expect(createdStoreCloses).toBe(1);
    expect(closes).toEqual([1]);
    const factoryOptions = providerFactory.mock.calls[0]![0] as SogniFactoryOptions;
    expect(factoryOptions.role).toBe("web");
    expect(factoryOptions.dataDir).toBe(resolve(runtimeDir));
    expect(factoryOptions.proofMetadata).toMatchObject({ adapterVersion: "sogni-production-proof-v1" });
    expect(typeof factoryOptions.submissionProofResolver).toBe("function");
    expect(typeof factoryOptions.readAsset).toBe("function");

    // Fail-closed defaults with reviewedPolicy null: unknown quotes with zero companions,
    // blocked billing modes (route 403), and an unavailable budget identity read model.
    const recipe = anchorRecipe(f);
    const request = toMediaQuoteRequest(recipe);
    const result = await withProductionComposition(async composition => {
      const draft = await composition.composer.prepareMediaQuoteDraft({ recipe, request });
      expect(draft.kind).toBe("unknown");
      await expect(composition.composer.resolveBillingMode({ projectId: f.project.id, providerId: "sogni", modelId: "image-model", operation: "anchor" })).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });

      const handlers = createMediaRouteHandlers({ withStore: async operation => operation(composition.store), serviceOptions: { resolveBillingMode: composition.composer.resolveBillingMode, quoteRecipe: composition.composer.prepareMediaQuoteDraft, commitPreparedQuote: composition.composer.commitPreparedQuote, readAssetVerified: composition.readAssetVerified } });
      const response = await handlers.quotePOST(new Request("http://localhost/api/production/media-quotes", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(anchorPrep(f)) }));
      expect(response.status).toBe(403);
      const quoteBody = await response.json() as { error: { code: string } };
      expect(quoteBody.error.code).toBe("BUDGET_BLOCKED");

      const budgetHandlers = createBudgetRouteHandlers({ withStore: async operation => operation(composition.store), serviceOptions: { resolveAccountIdentity: composition.composer.resolveAccountIdentity, prepareExecutionEvidence: composition.composer.prepareExecutionEvidence, currentCredentialBindingId: composition.composer.currentCredentialBindingId } });
      const read = await budgetHandlers.GET(new Request(`http://localhost/api/production/projects/${f.project.id}/budget?providerId=sogni&unit=minor_currency&currency=USD`), { params: Promise.resolve({ projectId: f.project.id }) });
      expect(read.status).toBe(200);
      return { quoteBody, budgetBody: await read.json() as { availability: string; reasons: string[] } };
    }, { role: "web", store: f.store, providerFactory });
    expect(result.budgetBody).toMatchObject({ availability: "unavailable", reasons: ["ACCOUNT_IDENTITY_UNAVAILABLE"], policy: null, projectTotals: null });
    expect(providedClose).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(f.dataDir);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 0, jobs: 0, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0, executionProofs: 0, generations: 0, reservations: 0 });
    providedClose.mockRestore();
  });

  it("I01-B6-W offline admission end-to-end through the worker", async () => {
    const f = fixtureStore();
    const resolverCalls: boolean[] = [];
    const closes: number[] = [];
    const projectsCreate = vi.fn(() => "fixture-project-id");
    let pollState: "running" | "completed" = "running";
    const providerFactory = fakeProviderFactory({ projectsCreate, resolverCalls, closes, pollState: () => pollState });
    const validPolicy = reviewedPolicy();
    const expiredPolicy = reviewedPolicy({ expiresAt: 1 });
    const resultPng = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 30, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();

    // 1) Known bound quote plus standing budget authorization admit exactly one offline submission.
    const first = await withProductionComposition(async composition => {
      const accountPolicy = await composition.budgetService.createPolicy(f.project.id, { providerId: "sogni", unit: "minor_currency", currency: "USD", dailyCap: 10_000, expiresAt: null, revoked: false, actorId: "creator-1" });
      await composition.budgetService.authorizeProject(f.project.id, { providerId: "sogni", unit: "minor_currency", currency: "USD" }, { expectedAuthorizationRevision: null, expectedPolicyRevision: accountPolicy.revision, policyId: accountPolicy.policyId, projectCap: 10_000, allowedModelIds: ["image-model"], allowedOperations: ["anchor"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1" });
      const quote = await composition.takeService.quote(anchorPrep(f));
      expect(quote).toMatchObject({ entitlement: "subscription", estimateMaxMinor: 25, currency: "USD", withinAuthorizedCap: "yes" });
      const enqueued = await composition.takeService.enqueueAnchor({ ...anchorPrep(f).command, quoteId: quote.id, idempotencyKey: "composition-job-1" }, f.shot.shotId);
      expect(enqueued.created).toBe(true);
      const queue = new ProductionJobQueue(composition.store, () => Date.now());
      const worker = new ProductionWorker({ queue, providers: { sogni: composition.provider }, vault: composition.vault, downloadResult: async () => Readable.from([resultPng]), ...workerCallbacks(composition) });
      expect(await worker.runOnce()).toBe(true);
      expect(queue.get(enqueued.job.id)).toMatchObject({ status: "running", providerRef: "fixture-provider-ref", errorCode: null, errorMessage: null });
      return { jobId: enqueued.job.id, quoteId: quote.id };
    }, { role: "worker", store: f.store, reviewedPolicy: validPolicy, providerFactory });

    expect(projectsCreate).toHaveBeenCalledTimes(1);
    expect(resolverCalls).toEqual([true]);
    const budgetQuote = f.store.read.getBudgetQuoteForMediaQuote(first.quoteId);
    expect(budgetQuote).toMatchObject({ mediaQuoteId: first.quoteId, estimateMax: 25 });
    expect(f.store.read.getQuoteProof(budgetQuote!.id)).not.toBeNull();
    expect(f.store.read.getExecutionProof(first.jobId)).not.toBeNull();
    expect(f.store.read.getReservationByExecution(first.jobId)).toMatchObject({ budgetQuoteId: budgetQuote!.id, upperEstimate: 25 });

    // 2) A second queued job from a fresh composition over the same store is ready to admit.
    // It reuses the still-current known quote because the frozen composer derives the reviewed
    // policy proof artifact's createdAt from quote time, so a second quote under one installed
    // policy would conflict with the first quote's immutable artifact (C-owned; reported).
    const second = await withProductionComposition(async composition => {
      const enqueued = await composition.takeService.enqueueAnchor({ ...anchorPrep(f).command, quoteId: first.quoteId, idempotencyKey: "composition-job-2" }, f.shot.shotId);
      expect(enqueued.created).toBe(true);
      return enqueued.job.id;
    }, { role: "worker", store: f.store, reviewedPolicy: validPolicy, providerFactory });
    expect(projectsCreate).toHaveBeenCalledTimes(1);

    // 3) An expired reviewed policy fails closed: zero creates, the job blocks as BUDGET_BLOCKED.
    await withProductionComposition(async composition => {
      const queue = new ProductionJobQueue(composition.store, () => Date.now());
      const worker = new ProductionWorker({ queue, providers: { sogni: composition.provider }, vault: composition.vault, ...workerCallbacks(composition) });
      expect(await worker.runOnce()).toBe(true);
      expect(queue.get(second)).toMatchObject({ status: "blocked", errorCode: "BUDGET_BLOCKED" });
    }, { role: "worker", store: f.store, reviewedPolicy: expiredPolicy, providerFactory });
    expect(projectsCreate).toHaveBeenCalledTimes(1);

    // 4) Restart with a fresh composition resumes the poll path without a second create.
    pollState = "completed";
    await withProductionComposition(async composition => {
      let skew = 40_000; // expire the first run's lease on the shared queue clock
      const now = () => Date.now() + skew;
      const queue = new ProductionJobQueue(composition.store, now);
      const worker = new ProductionWorker({ queue, providers: { sogni: composition.provider }, vault: composition.vault, downloadResult: async () => Readable.from([resultPng]), now, ...workerCallbacks(composition) });
      expect(await worker.runOnce()).toBe(true);
      expect(queue.get(first.jobId)).toMatchObject({ status: "completed", errorCode: null, errorMessage: null });
    }, { role: "worker", store: f.store, reviewedPolicy: validPolicy, providerFactory });
    expect(projectsCreate).toHaveBeenCalledTimes(1);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 1, jobs: 2, budgetQuotes: 1, bindings: 1, reservations: 1, executionProofs: 1 });
    expect(closes.length).toBe(4);
  });

  it("B6-POLICY-LOAD env-installed reviewed policy loads per composition and fails closed sanitized", async () => {
    expect(loadReviewedPolicyFromPath(undefined)).toBeNull();
    const f = fixtureStore();
    const closes: number[] = [];
    const providerFactory = vi.fn(fakeProviderFactory({ projectsCreate: () => "fixture-project-id", closes }));
    const policyDir = mkdtempSync(join(tmpdir(), "perabyte-composition-policy-")); dirs.push(policyDir);
    let policyFile = 0;
    const writePolicy = (payload: unknown, content = JSON.stringify(payload)): string => { const path = join(policyDir, `reviewed-policy-${++policyFile}.json`); writeFileSync(path, content, "utf8"); return path; };
    // Same payload pattern as the accepted budget-composer fixtures: a reviewed_policy capture whose
    // configuration canonical JSON matches its reviewed hash.
    const reviewedPolicyPayload = (overrides: Record<string, unknown> = {}, configOverride: Record<string, unknown> = {}) => {
      const config = { schemaVersion: 1 as const, providerId: "sogni", quoteTtlMs: 30_000, accountSessionTtlMs: 60_000, executionSessionTtlMs: 60_000, billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" as const }], priceByModel: [{ modelId: "image-model", operations: ["anchor" as const, "take" as const], entitlement: "subscription" as const, unit: "minor_currency" as const, currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }], ...configOverride };
      const capture = "Fixture reviewed policy capture for the offline composition tests.";
      return { config, payload: { schemaVersion: 1, kind: "reviewed_policy", producer: { producerId: "fixture-reviewer", producerVersion: "fixture-reviewer-v1", sourceHash: sha("reviewer-provenance") }, providerId: "sogni", reviewVersion: "review-1", sourceUrl: "https://policy.fixture.example/sogni-pricing-v1", sourceCapture: capture, sourceCaptureSha256: sha256(capture), reviewedConfigCanonicalJson: canonicalJson(config), reviewedConfigHash: hashCanonicalJson(config), capturedAt: 0, expiresAt: 10_000_000_000_000, ...overrides } };
    };
    const sanitized = (error: unknown) => {
      expect(error).toMatchObject({ code: "BUDGET_BLOCKED", message: "The reviewed policy could not be loaded; pricing stays blocked." });
      expect(String(error)).not.toContain(policyDir);
    };
    const loadFailure = (policyPath: string): unknown => { try { loadReviewedPolicyFromPath(policyPath); return null; } catch (error) { return error; } };
    const envWith = (policyPath: string) => ({ PERABYTE_STUDIO_DATA_DIR: policyDir, PERABYTE_STUDIO_REVIEWED_POLICY_PATH: policyPath });

    // (b) A valid installed file is resolved inside the composition: the composer receives it and
    // a bound quote composes end-to-end through the fake provider and commits durably.
    const valid = reviewedPolicyPayload();
    const quote = await withProductionComposition(async composition => {
      await expect(composition.composer.resolveBillingMode({ projectId: f.project.id, providerId: "sogni", modelId: "image-model", operation: "anchor" })).resolves.toBe("subscription");
      return composition.takeService.quote(anchorPrep(f));
    }, { role: "web", store: f.store, providerFactory, runtimeOptions: { env: envWith(writePolicy(valid.payload)) } });
    expect(quote).toMatchObject({ entitlement: "subscription", estimateMaxMinor: 25, currency: "USD" });
    expect(f.store.read.getBudgetQuoteForMediaQuote(quote.id)).toMatchObject({ mediaQuoteId: quote.id, estimateMax: 25 });

    // (c) A malformed file blocks the whole composition with a sanitized error: work never runs and
    // the provider is never built.
    let composed = false;
    const malformed = await withProductionComposition(async () => { composed = true; }, { role: "web", store: f.store, providerFactory, runtimeOptions: { env: envWith(writePolicy(null, "{ this is not json")) } }).catch((error: unknown) => error);
    expect(composed).toBe(false);
    sanitized(malformed);

    // (d) A tampered configuration (canonical JSON no longer matching its reviewed hash),
    // (e) an expired capture, and a missing file all fail identically loud and sanitized.
    const tampered = { ...valid.payload, reviewedConfigCanonicalJson: canonicalJson({ ...valid.config, estimateMaxMinor: 999 }) };
    sanitized(loadFailure(writePolicy(tampered)));
    sanitized(loadFailure(writePolicy(reviewedPolicyPayload({ expiresAt: 1 }).payload)));
    sanitized(loadFailure(join(policyDir, "absent-reviewed-policy.json")));
    expect(closes).toEqual([1]);
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(compositionCounts(f.dataDir)).toMatchObject({ quotes: 1, budgetQuotes: 1, bindings: 1, reservations: 0 });
  });
});
