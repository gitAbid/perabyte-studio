import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import sharp from "sharp";
import { LocalMediaVault } from "../../media/production/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProductionStore } from "../../repositories/production/sqlite";
import { ApprovalSchema, ProviderRequestSnapshotSchema, type Approval, type Asset, type CreateShotPlanCommand, type ProductionJob, type ProductionQuote } from "../../production/contracts";
import { createHash } from "node:crypto";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { computeAnchorApprovalHash, computeProductionInputsHash, productionSubmissionEligibilityFingerprint } from "../../jobs/production/queue";
import { computeTakeApprovalHash } from "../../production/approval";
import { createCanonRevision, createProject, createStoryRevision } from "./revisions";
import { createShotPlan } from "./shot-plan";
import { createMediaRouteHandlers, createProductionTakeService, quoteProjection, type ValidatedMediaRecipe } from "./takes";
import type { ProviderQuoteRequest } from "../../repositories/production/ports";
import { parseReviewedQuotePolicy } from "../../production/proof-policy";
import { createProductionBudgetComposer } from "./budget-composer";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof openProductionStore>> = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function persistedCounts(dataDir: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    return {
      jobs: count("SELECT COUNT(*) AS count FROM records WHERE kind='job'"),
      quotes: count("SELECT COUNT(*) AS count FROM records WHERE kind='quote'"),
      outbox: count("SELECT COUNT(*) AS count FROM outbox"),
      budgetQuotes: count("SELECT COUNT(*) AS count FROM budget_quotes"),
      bindings: count("SELECT COUNT(*) AS count FROM budget_quote_bindings"),
      evidence: count("SELECT COUNT(*) AS count FROM budget_account_evidence"),
      artifacts: count("SELECT COUNT(*) AS count FROM provider_proof_artifacts"),
      quoteProofs: count("SELECT COUNT(*) AS count FROM provider_quote_proofs"),
    };
  } finally { db.close(); }
}
const seamSha = (label: string) => hashCanonicalJson({ fixture: label });
function seamFakeProvider(clock: () => number) {
  let role: "web" | "worker" = "web";
  const captured = () => ({ session: { sessionId: `sogni-session:fixture-${role}`, role, sdkVersion: "5.49.0", sdkSourceHash: seamSha("sdk-source"), adapterVersion: "fixture-adapter-v1" }, credentialFingerprint: seamSha("credential-fingerprint"), accountId: "sogni-account:fixture-account" });
  const capability = { version: 1 as const, providerId: "sogni", modelId: "image-model", provenance: "live_catalog" as const, observedAt: 0, expiresAt: 3_600_000, supportedOperations: ["image" as const, "video" as const], aspectRatios: ["9:16" as const], maxReferenceImages: 9, supportsStartFrame: true, supportsEndFrame: true, supportsContextImages: true, supportsTimedKeyframes: false, minFrames: null, maxFrames: null, frameStep: null, supportsNativeAudio: false };
  return {
    providerId: "sogni" as const,
    captured,
    observeAccount: async () => ({ providerId: "sogni", captured: captured(), subscription: { active: true, status: "active", tier: "standard", currentPeriodEnd: null, providerVersion: 1 }, observedAt: clock() }),
    currentSession: () => captured(),
    discoverCapabilities: async () => capability,
    quote: async () => { throw new Error("offline fixture provider does not quote"); },
    submit: async () => { throw new Error("offline fixture provider does not submit"); },
    poll: async () => { throw new Error("offline fixture provider does not poll"); },
    cancel: async () => { throw new Error("offline fixture provider does not cancel"); },
  };
}
function seamReviewedPolicy() {
  const capture = "Fixture reviewed policy capture for the offline takes seam tests.";
  const config = {
    schemaVersion: 1 as const,
    providerId: "sogni",
    quoteTtlMs: 30_000,
    accountSessionTtlMs: 60_000,
    executionSessionTtlMs: 60_000,
    billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" as const }],
    priceByModel: [{ modelId: "image-model", operations: ["anchor" as const, "take" as const], entitlement: "subscription" as const, unit: "minor_currency" as const, currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }],
  };
  return parseReviewedQuotePolicy({ schemaVersion: 1, kind: "reviewed_policy", producer: { producerId: "fixture-reviewer", producerVersion: "fixture-reviewer-v1", sourceHash: seamSha("reviewer-provenance") }, providerId: "sogni", reviewVersion: "review-1", sourceUrl: "https://policy.fixture.example/sogni-pricing-v1", sourceCapture: capture, sourceCaptureSha256: createHash("sha256").update(capture, "utf8").digest("hex"), reviewedConfigCanonicalJson: canonicalJson(config), reviewedConfigHash: hashCanonicalJson(config), capturedAt: 0, expiresAt: 10_000_000_000 });
}

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-takes-fixture-")); dirs.push(dataDir);
  const vault = new LocalMediaVault({ root: join(dataDir, "media") });
  const store = openProductionStore({ dataDir });
  stores.push(store);
  let n = 0; let now = 100;
  const idFactory = () => `fixture-${++n}`;
  const clock = () => ++now;
  const project = createProject(store, { name: "Fixture", profileId: "storybook-short-v1" }, { now: clock, idFactory });
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 30, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
  const contextAsset = (await vault.put(png, { mime: "image/png", sourceKind: "fixture", now: clock() })).asset;
  const anchorAsset = (await vault.put(png, { mime: "image/png", sourceKind: "fixture", now: clock() })).asset;
  store.transaction(tx => { tx.insertAsset({ asset: contextAsset, verifiedAt: clock(), checksumVerified: true }); tx.insertAsset({ asset: anchorAsset, verifiedAt: clock(), checksumVerified: true }); });
  const location = createCanonRevision(store, { projectId: project.id, entityId: "room", expectedRevisionId: null, entityKind: "location", description: "Quiet room", attributes: { palette: "blue" }, assetIds: [contextAsset.id] }, { now: clock, idFactory });
  const style = createCanonRevision(store, { projectId: project.id, entityId: "style", expectedRevisionId: null, entityKind: "style", description: "Paper cutout", attributes: {}, assetIds: [] }, { now: clock, idFactory });
  const story = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: "A door opens. Someone enters.", beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [] }, { id: "beat_2", action: "Someone enters.", narration: "", dialogue: [] }], canonRevisionIds: [location.id, style.id] }, { now: clock, idFactory });
  const approve = (kind: Approval["targetKind"], id: string, targetHash: string, approvalId: string, at = clock(), decision: Approval["decision"] = "approved") => store.transaction(tx => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: approvalId, targetKind: kind, targetId: id, targetHash, decision, actorId: "local-creator", createdAt: at, checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: decision === "rejected" ? "Rejected fixture" : "", advisoryAcknowledgements: [] })));
  approve("story", story.id, story.contentHash, "story-approval");
  const firstShot: CreateShotPlanCommand["shots"][number] = { shotId: "shot_0", beatIds: ["beat_1"], visualIntent: "A door opens.", motionIntent: "Door opens slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide", targetFrames: 124, continuation: null };
  const secondShot: CreateShotPlanCommand["shots"][number] = { shotId: "shot_1", beatIds: ["beat_2"], visualIntent: "Someone enters.", motionIntent: "Someone enters slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide", targetFrames: 124, continuation: null };
  const planOptions = { now: clock, maxShots: 10, idFactory };
  const initialPlan = createShotPlan(store, { projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash, shots: [firstShot, secondShot] }, planOptions);
  const predecessorId = initialPlan.shotPlanRevision.orderedShotRevisionIds[0]!;
  const continued = { ...secondShot, continuation: { previousShotRevisionId: predecessorId, endFrameAssetId: contextAsset.id } };
  const planned = createShotPlan(store, { projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash, shots: [firstShot, continued] }, planOptions);
  approve("animatic", planned.animaticRevision.id, planned.animaticRevision.contentHash, "animatic-approval");
  const shot = planned.shotRevisions[1]!;
  const anchorJob: ProductionJob = { version: 1, id: "fixture-job", projectId: project.id, operation: "anchor", status: "queued", idempotencyKey: "fixture-job-key", requestSnapshot: {}, requestHash: "d".repeat(64), providerId: "sogni", modelId: "image-model", providerRef: null, quoteId: "anchor-source-quote", receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: clock(), updatedAt: clock() };
  store.transaction(tx => {
    tx.insertQuote({ version: 1, id: "anchor-source-quote", projectId: project.id, providerId: "sogni", modelId: "image-model", operation: "anchor", inputHash: "e".repeat(64), entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: 100_000, withinAuthorizedCap: "unknown", createdAt: clock() });
    tx.insertJob(anchorJob, { id: "fixture-outbox", jobId: anchorJob.id, createdAt: clock(), claimedAt: null, claimToken: null });
  });
  const anchor = { version: 1 as const, id: "approved_anchor", shotRevisionId: shot.id, assetId: anchorAsset.id, inputsHash: "c".repeat(64), jobId: anchorJob.id, visionAssessment: null, receiptId: null, createdAt: clock() };
  store.transaction(tx => tx.insertAnchor(anchor));
  const anchorHash = computeAnchorApprovalHash(store.read, anchor);
  approve("anchor", anchor.id, anchorHash, "anchor-approval");
  const readAssetVerified = vi.fn(async (asset: (typeof contextAsset)) => { await vault.readVerified(asset.vaultRef, asset.sha256); });
  let videoAssetPromise: ReturnType<typeof vault.put> | null = null;
  let videoAssetPersisted = false;
  const createApprovedTake = async (takeId: string, jobId: string) => {
    if (!videoAssetPromise) {
      const path = join(dataDir, "take-source.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-n", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=24:d=1", "-frames:v", "24", "-c:v", "mpeg4", "-threads", "1", "-pix_fmt", "yuv420p", path]);
      videoAssetPromise = vault.put(readFileSync(path), { mime: "video/mp4", sourceKind: "fixture", now: clock() });
    }
    const videoAsset = (await videoAssetPromise).asset;
    const quoteId = `${jobId}-quote`;
    const receiptId = `${jobId}-receipt`;
    store.transaction(tx => tx.insertQuote({ version: 1, id: quoteId, projectId: project.id, providerId: "sogni", modelId: "video-model", operation: "take", inputHash: "e".repeat(64), entitlement: "subscription", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: 100_000, withinAuthorizedCap: "unknown", createdAt: clock() }));
    const snapshotBase = ProviderRequestSnapshotSchema.parse({ projectId: project.id, jobId, idempotencyKey: `${jobId}-key`, quoteId, providerId: "sogni", modelId: "video-model", prompt: "Door opens slowly.", inputs: [{ assetId: anchorAsset.id, role: "start_frame", required: true }, { assetId: contextAsset.id, role: "end_frame", required: true }], parameters: { aspect: "9:16", frameCount: shot.targetFrames, seed: 0, providerAudioPolicy: "muted" }, resultTarget: { kind: "take", shotRevisionId: shot.id, anchorId: anchor.id, anchorApprovalId: "anchor-approval", inputsHash: "a".repeat(64) }, billingMode: "subscription" });
    const inputsHash = computeProductionInputsHash(store.read, "take", snapshotBase);
    const snapshot = ProviderRequestSnapshotSchema.parse({ ...snapshotBase, resultTarget: { ...snapshotBase.resultTarget!, inputsHash } });
    const now = clock();
    const job: ProductionJob = { version: 1, id: jobId, projectId: project.id, operation: "take", status: "queued", idempotencyKey: `${jobId}-key`, requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: "sogni", modelId: "video-model", providerRef: "fixture-provider-ref", quoteId, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now };
    const receipt = { version: 1 as const, id: receiptId, jobId, capabilityProvenance: "sdk_contract" as const, capabilityObservedAt: now, inputs: snapshot.inputs.map(input => ({ role: input.role, assetId: input.assetId, required: input.required, state: "mapped" as const, providerField: input.role, disclosedOmission: null })), createdAt: now };
    const take = { version: 1 as const, id: takeId, shotRevisionId: shot.id, anchorId: anchor.id, approvalId: "anchor-approval", jobId, assetId: videoAsset.id, actualFrames: videoAsset.frames!, inputsHash, receiptId, createdAt: now };
    store.transaction(tx => { if (!videoAssetPersisted) { tx.insertAsset({ asset: videoAsset, verifiedAt: now, checksumVerified: true }); videoAssetPersisted = true; } tx.insertJob(job, { id: `${jobId}-outbox`, jobId, createdAt: now, claimedAt: null, claimToken: null }); tx.insertHonoredInputsReceipt(receipt); tx.insertTake(take); });
    approve("take", take.id, computeTakeApprovalHash(store.read, take), `${takeId}-approval`);
    store.transaction(tx => {
      const at = Date.now(); const lease = { jobId, leaseToken: `${jobId}-lease`, leaseUntil: at + 60_000, heartbeatAt: at };
      if (!tx.claimJob(jobId, at, lease)) throw new Error("Fixture job lease was not acquired");
      const current = tx.getJob(jobId)!;
      if (!tx.updateLeasedJob({ ...current, status: "completed", providerRef: `${jobId}-provider-ref`, receiptId, resultId: takeId, resultAssetIds: [videoAsset.id], updatedAt: at }, lease.leaseToken)) throw new Error("Fixture completed result was not committed");
    });
    return take;
  };
  const service = (withResolver = true) => createProductionTakeService({ store, now: clock, idFactory, readAssetVerified, ...(withResolver ? { resolveBillingMode: async () => "subscription" as const } : {}) });
  const composer = createProductionBudgetComposer({ store, provider: seamFakeProvider(clock), reviewedPolicy: seamReviewedPolicy(), now: clock, idFactory, producer: { producerId: "fixture-producer", producerVersion: "fixture-producer-v1", sourceHash: seamSha("producer-source") } });
  return { store, project, shot, anchor, contextAsset, approve, service, readAssetVerified, dataDir, vault, createApprovedTake, composer, clock };
}

describe("production media recipe service", () => {
  it("selects approved completed takes and preserves retake history across switch, stale CAS, clear, and reselect", async () => {
    const f = await fixture();
    const first = await f.createApprovedTake("take-first", "take-job-first");
    const sibling = await f.createApprovedTake("take-sibling", "take-job-sibling");
    const verified = vi.fn(async (asset: Asset) => { await f.vault.readVerified(asset.vaultRef, asset.sha256); });
    const handlers = createMediaRouteHandlers({ withStore: async operation => operation(f.store), serviceOptions: { readAssetVerified: verified } });
    const post = (takeId: string | null, expectedSelectionVersion: number) => handlers.selectionPOST(new Request(`http://localhost/api/production/shots/${f.shot.shotId}/selection`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ projectId: f.project.id, shotRevisionId: f.shot.id, takeId, expectedSelectionVersion }) }), { params: { shotId: f.shot.shotId } });

    const selected = await post(first.id, 0);
    expect(selected.status).toBe(200);
    expect(selected.headers.get("cache-control")).toBe("no-store");
    expect(await selected.json()).toEqual({ selection: { takeId: first.id, version: 1 }, changed: true });
    expect(f.store.read.listTakesForShot(f.shot.id).map(take => take.id)).toEqual([first.id, sibling.id]);
    expect(await (await post(sibling.id, 1)).json()).toEqual({ selection: { takeId: sibling.id, version: 2 }, changed: true });

    const stale = await post(first.id, 1);
    expect(stale.status).toBe(409);
    expect(f.store.read.getTakeSelection(f.project.id, f.shot.shotId)).toEqual({ takeId: sibling.id, version: 2 });
    expect(await (await post(null, 2)).json()).toEqual({ selection: { takeId: null, version: 3 }, changed: true });
    expect(await (await post(first.id, 3)).json()).toEqual({ selection: { takeId: first.id, version: 4 }, changed: true });
    expect(await (await post(first.id, 4)).json()).toEqual({ selection: { takeId: first.id, version: 4 }, changed: false });
    expect(f.store.read.listTakesForShot(f.shot.id).map(take => take.id)).toEqual([first.id, sibling.id]);
    expect(verified).toHaveBeenCalledTimes(4);
  });

  it("rejects take-approval drift during vault verification without changing selection", async () => {
    const f = await fixture();
    const take = await f.createApprovedTake("take-drift", "take-job-drift");
    let drifted = false;
    const handlers = createMediaRouteHandlers({ withStore: async operation => operation(f.store), serviceOptions: { readAssetVerified: async asset => {
      if (!drifted) { drifted = true; f.approve("take", take.id, computeTakeApprovalHash(f.store.read, take), "take-rejection-during-read", Number.MAX_SAFE_INTEGER, "rejected"); }
      await f.vault.readVerified(asset.vaultRef, asset.sha256);
    } } });
    const response = await handlers.selectionPOST(new Request(`http://localhost/api/production/shots/${f.shot.shotId}/selection`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ projectId: f.project.id, shotRevisionId: f.shot.id, takeId: take.id, expectedSelectionVersion: 0 }) }), { params: { shotId: f.shot.shotId } });
    expect(response.status).toBe(409);
    expect(f.store.read.getTakeSelection(f.project.id, f.shot.shotId)).toEqual({ takeId: null, version: 0 });
    expect(f.store.read.listTakesForShot(f.shot.id)).toHaveLength(1);
  });

  it("quotes and enqueues one full anchor recipe, then replays its immutable job before stale checks", async () => {
    const f = await fixture();
    const prep = { kind: "anchor" as const, command: { projectId: f.project.id, shotRevisionId: f.shot.id, renderSettings: { providerId: "sogni", modelId: "image-model", aspect: "9:16" as const, resolution: "720p" as const, seed: null, referenceAssetIds: [f.contextAsset.id, f.contextAsset.id] } } };
    const recipe = await f.service().prepare(prep);
    const handlers = createMediaRouteHandlers({ withStore: async operation => operation(f.store), serviceOptions: { resolveBillingMode: async () => "subscription", readAssetVerified: f.readAssetVerified } });
    const quoteResponse = await handlers.quotePOST(new Request("http://localhost/api/production/media-quotes", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(prep) }));
    expect(quoteResponse.status).toBe(200);
    expect(quoteResponse.headers.get("cache-control")).toBe("no-store");
    const quote = await quoteResponse.json() as ProductionQuote;
    expect(quote.inputHash).toBe(hashCanonicalJson(quoteProjection(recipe)));
    expect(quote.inputHash).not.toBe(recipe.resultTarget.inputsHash);
    expect(quote.entitlement).toBe("unknown");
    expect(quote.withinAuthorizedCap).toBe("unknown");
    const command = { ...prep.command, quoteId: quote.id, idempotencyKey: "anchor-key" };
    const post = (body: unknown, shotId = f.shot.shotId) => handlers.anchorPOST(new Request(`http://localhost/api/production/shots/${shotId}/anchors`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: { shotId } });
    const createdResponse = await post(command);
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const created = await createdResponse.json() as { job: ProductionJob; created: boolean };
    expect(created).toMatchObject({ created: true, job: { status: "queued", operation: "anchor", quoteId: quote.id } });
    expect(created.job.requestSnapshot).toMatchObject({ inputs: [{ assetId: f.contextAsset.id, role: "context_image", required: true }, { assetId: f.contextAsset.id, role: "end_frame", required: true }], parameters: { seed: 0 } });
    expect(created.job.requestHash).not.toBe(quote.inputHash);
    expect(productionSubmissionEligibilityFingerprint(f.store.read, created.job, quote, ProviderRequestSnapshotSchema.parse(created.job.requestSnapshot))).toBeNull();
    expect(f.store.read.getQuote(quote.id)?.inputHash).toBe(quote.inputHash);
    expect(persistedCounts(f.dataDir)).toMatchObject({ jobs: 2, quotes: 2, outbox: 2 });
    f.approve("story", f.store.read.getStoryRevision(f.shot.storyRevisionId)!.id, f.store.read.getStoryRevision(f.shot.storyRevisionId)!.contentHash, "story-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    const replayResponse = await post(command);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual({ job: created.job, created: false });
    const badRoute = await post(command, "wrong-shot");
    expect(badRoute.status).toBe(400);
    const conflict = await post({ ...command, renderSettings: { ...command.renderSettings, resolution: "1080p" } });
    expect(conflict.status).toBe(409);
    expect(f.store.read.listProjectJobs(f.project.id)).toHaveLength(2);
    expect(persistedCounts(f.dataDir)).toMatchObject({ jobs: 2, outbox: 2 });
  });

  it("requires the exact approved anchor frame and rejects a stale approval without another job", async () => {
    const f = await fixture();
    const prep = { kind: "take" as const, command: { projectId: f.project.id, shotRevisionId: f.shot.id, anchorId: f.anchor.id, approvalId: "anchor-approval", motionSettings: { providerId: "sogni", modelId: "video-model", prompt: "Door opens slowly.", targetFrames: f.shot.targetFrames, aspect: "9:16" as const, seed: null } } };
    const quote = await f.service().quote(prep);
    const command = { ...prep.command, quoteId: quote.id, idempotencyKey: "take-key" };
    const approvedAt = f.store.read.listApprovals("anchor", f.anchor.id).find(approval => approval.id === "anchor-approval")!.createdAt;
    let approvalSetChanged = false;
    const changingService = createProductionTakeService({ store: f.store, now: () => 1_000, idFactory: () => "take-drift", resolveBillingMode: async () => "subscription", readAssetVerified: async asset => {
      if (!approvalSetChanged) { approvalSetChanged = true; f.approve("anchor", f.anchor.id, computeAnchorApprovalHash(f.store.read, f.anchor), "anchor-approval-tied", approvedAt); }
      await f.vault.readVerified(asset.vaultRef, asset.sha256);
    } });
    const beforeDriftedEnqueue = persistedCounts(f.dataDir);
    await expect(changingService.enqueueTake(command, f.shot.shotId)).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(persistedCounts(f.dataDir)).toEqual(beforeDriftedEnqueue);

    const freshQuote = await f.service().quote(prep);
    const created = await f.service().enqueueTake({ ...command, quoteId: freshQuote.id, idempotencyKey: "take-key-fresh" }, f.shot.shotId);
    expect(created.job.requestSnapshot).toMatchObject({ inputs: [{ assetId: f.anchor.assetId, role: "start_frame", required: true }, { assetId: f.contextAsset.id, role: "end_frame", required: true }], parameters: { frameCount: f.shot.targetFrames, seed: 0, providerAudioPolicy: "muted" } });
    expect(persistedCounts(f.dataDir)).toMatchObject({ jobs: 2, outbox: 2 });
    f.approve("anchor", f.anchor.id, computeAnchorApprovalHash(f.store.read, f.anchor), "anchor-rejection", Number.MAX_SAFE_INTEGER, "rejected");
    await expect(f.service().enqueueTake({ ...command, idempotencyKey: "take-key-2" }, f.shot.shotId)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(persistedCounts(f.dataDir)).toMatchObject({ jobs: 2, outbox: 2 });
  });

  it("fails closed without a trusted billing resolver before creating a quote or job", async () => {
    const f = await fixture();
    const prep = { kind: "anchor" as const, command: { projectId: f.project.id, shotRevisionId: f.shot.id, renderSettings: { providerId: "sogni", modelId: "image-model", aspect: "9:16" as const, resolution: "720p" as const, seed: 0, referenceAssetIds: [f.contextAsset.id, f.contextAsset.id] } } };
    await expect(f.service(false).quote(prep)).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(f.store.read.listProjectJobs(f.project.id)).toHaveLength(1);
    expect(persistedCounts(f.dataDir)).toMatchObject({ jobs: 1, quotes: 1, outbox: 1 });
  });

  it("I01-B6-C takes seam: bound draft requires commit hook and stays atomic", async () => {
    const f = await fixture();
    const prep = { kind: "anchor" as const, command: { projectId: f.project.id, shotRevisionId: f.shot.id, renderSettings: { providerId: "sogni", modelId: "image-model", aspect: "9:16" as const, resolution: "720p" as const, seed: 0, referenceAssetIds: [f.contextAsset.id, f.contextAsset.id] } } };
    let currentTime = 10_000;
    const service = (seam: Partial<Omit<Parameters<typeof createProductionTakeService>[0], "store">> = {}) => createProductionTakeService({ store: f.store, now: () => currentTime, idFactory: () => "async-quote", resolveBillingMode: async () => "subscription", readAssetVerified: f.readAssetVerified, ...seam });
    const draftSource = async ({ recipe, request }: { recipe: ValidatedMediaRecipe; request: ProviderQuoteRequest }) => f.composer.prepareMediaQuoteDraft({ recipe, request });

    // An asynchronous producer may still resolve an unknown draft; it is validated and persisted as today.
    const unknownProducer = service({ quoteRecipe: async ({ request }) => {
      await Promise.resolve();
      currentTime += 1;
      return { kind: "unknown" as const, mediaQuote: { version: 1 as const, id: "async-valid-quote", projectId: request.projectId, providerId: request.providerId, modelId: request.modelId, operation: request.operation, inputHash: hashCanonicalJson(request.inputSnapshot), entitlement: "unknown" as const, estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: currentTime + 30_000, withinAuthorizedCap: "unknown" as const, createdAt: currentTime } };
    } });
    await expect(unknownProducer.quote(prep)).resolves.toMatchObject({ id: "async-valid-quote", createdAt: 10_001 });

    // A bound draft without a configured commit hook is rejected before any write.
    const beforeBound = persistedCounts(f.dataDir);
    await expect(service({ quoteRecipe: draftSource }).quote(prep)).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
    expect(persistedCounts(f.dataDir)).toEqual(beforeBound);

    // With the hook, the media quote and its companions commit atomically and survive a reopen.
    const quoted = await service({ quoteRecipe: draftSource, commitPreparedQuote: f.composer.commitPreparedQuote }).quote(prep);
    expect(quoted).toMatchObject({ entitlement: "subscription", estimateMinMinor: 10, estimateMaxMinor: 25, currency: "USD" });
    const reopened = openProductionStore({ dataDir: f.dataDir }); stores.push(reopened);
    expect(reopened.read.getQuote(quoted.id)).toEqual(quoted);
    const budgetQuote = reopened.read.getBudgetQuoteForMediaQuote(quoted.id);
    expect(budgetQuote).toMatchObject({ mediaQuoteId: quoted.id, entitlement: "subscription", estimateMax: 25, unit: "minor_currency" });
    const binding = budgetQuote ? reopened.read.getQuoteAccountBinding(budgetQuote.id) : null;
    expect(binding).not.toBeNull();
    const quoteProof = budgetQuote ? reopened.read.getQuoteProof(budgetQuote.id) : null;
    expect(quoteProof).not.toBeNull();
    expect(binding && reopened.read.getAccountEvidence(binding.accountEvidenceId)).not.toBeNull();
    expect(quoteProof && reopened.read.getProofArtifact(quoteProof.artifactHash)).not.toBeNull();

    // A stale selection during the producer await rolls the whole composition back, companions included.
    const beforeStale = persistedCounts(f.dataDir);
    const story = reopened.read.getStoryRevision(f.shot.storyRevisionId)!;
    const storyApprovedAt = reopened.read.listApprovals("story", story.id)[0]!.createdAt;
    const staleService = service({ quoteRecipe: async input => {
      f.approve("story", story.id, story.contentHash, "story-approval-tied", storyApprovedAt);
      return draftSource(input);
    }, commitPreparedQuote: f.composer.commitPreparedQuote });
    await expect(staleService.quote(prep)).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(persistedCounts(f.dataDir)).toEqual(beforeStale);

    // A throwing commit hook rolls the media quote back together with its companions.
    const beforeThrow = persistedCounts(f.dataDir);
    const throwingService = service({ quoteRecipe: draftSource, commitPreparedQuote: () => { throw new Error("injected commitPreparedQuote failure"); } });
    await expect(throwingService.quote(prep)).rejects.toThrow("injected commitPreparedQuote failure");
    expect(persistedCounts(f.dataDir)).toEqual(beforeThrow);
  });
});
