import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore } from "../../repositories/production/sqlite";
import { hashCanonicalJson } from "../../production/hash";
import { computeAnchorApprovalHash, computeProductionInputsHash } from "../../jobs/production/queue";
import { LocalMediaVault } from "../../media/production/vault";
import {
  ApprovalSchema, AnchorCandidateSchema, AnimaticRevisionSchema, AssetSchema, CanonRevisionSchema,
  HonoredInputsReceiptSchema, JobSchema, QuoteSchema, ProjectSchema,
  ProviderRequestSnapshotSchema, ShotPlanRevisionSchema, ShotRevisionSchema, StoryRevisionSchema,
} from "../../production/contracts";
import { createProject, createStoryRevision } from "./revisions";
import { createApprovalRouteHandlers, createProductionApprovalService, type ApprovalRouteCommand } from "./approval";

const dirs: string[] = [];
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-approval-"));
  dirs.push(dataDir);
  const store = openProductionStore({ dataDir });
  const project = createProject(store, { name: "Approval fixture", profileId: "storybook-short-v1" }, { now: () => 10, idFactory: () => "project-1" });
  const story = createStoryRevision(store, {
    projectId: project.id,
    expectedStoryRevisionId: null,
    scriptText: "A child follows a lantern home.",
    beats: [{ id: "beat-1", action: "A child follows a lantern home.", narration: "A child follows a lantern home.", dialogue: [] }],
    canonRevisionIds: [],
  }, { now: () => 20, idFactory: () => "story-1" });
  const clock = { time: 30 };
  const service = createProductionApprovalService({ store, now: () => clock.time, readAssetVerified: async () => undefined });
  return { store, project, story, service, dataDir, clock };
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const storyCommand = (idempotencyKey = "story-command-1", overrides: Partial<ApprovalRouteCommand["command"]> = {}): ApprovalRouteCommand => ({
  projectId: "project-1",
  idempotencyKey,
  command: {
    targetKind: "story",
    targetId: "story-1",
    expectedHash: "0".repeat(64),
    decision: "approved",
    checklist: ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"]
      .map((id) => ({ id, passed: true, note: "Reviewed" })),
    notes: "Reviewed the current story.",
    advisoryAcknowledgements: [],
    ...overrides,
  },
});

describe("production approval service", () => {
  it("appends ordered approve/reject/approve decisions and replays exact commands", async () => {
    const { store, story, service, clock } = setup();
    const command = storyCommand("story-command-1", {
      expectedHash: story.contentHash,
      checklist: [
        { id: "protagonist_goal", passed: true, note: "Cafe\u0301 reviewed" },
        ...["cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"]
          .map((id) => ({ id, passed: true, note: "Reviewed" })),
      ],
    });
    const first = await service.create(command);
    expect(first).toMatchObject({ created: true, approval: { decision: "approved", actorId: "local-creator", targetHash: story.contentHash } });
    const replay = await service.create(command);
    expect(replay).toEqual({ ...first, created: false });

    clock.time = 31;
    const reject = storyCommand("story-command-2", { expectedHash: story.contentHash, decision: "rejected", checklist: [
      { id: "protagonist_goal", passed: false, note: "The protagonist's goal is unclear." },
      ...command.command.checklist.slice(1),
    ], notes: "The protagonist's goal is unclear." });
    const second = await service.create(reject);
    clock.time = 32;
    const third = await service.create(storyCommand("story-command-3", { expectedHash: story.contentHash }));
    expect([first.approval.createdAt, second.approval.createdAt, third.approval.createdAt]).toEqual([30, 31, 32]);
    await expect(service.create(storyCommand("clock-has-not-advanced", { expectedHash: story.contentHash })))
      .rejects.toMatchObject({ code: "STALE_REVISION", retryable: true });
    await expect(service.create(storyCommand("story-command-1", {
      expectedHash: story.contentHash,
      checklist: [
        { id: "protagonist_goal", passed: true, note: "Café reviewed" },
        ...["cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"]
          .map((id) => ({ id, passed: true, note: "Reviewed" })),
      ],
    })))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(store.read.listApprovals("story", story.id)).toHaveLength(3);
    store.close();
  });

  it("rejects a stale current story without appending a decision", async () => {
    const { store, story, service } = setup();
    const project = store.read.getProject("project-1")!;
    store.transaction((tx) => {
      expect(tx.compareAndSetProject({ ...project, activeStoryRevisionId: null, saveVersion: project.saveVersion + 1, updatedAt: 29 }, project.saveVersion)).toBe(true);
    });
    const command = storyCommand("stale-story-command", { expectedHash: story.contentHash });
    await expect(service.create(command)).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(store.read.listApprovals("story", story.id)).toEqual([]);
    await expect(service.create({ projectId: project.id, idempotencyKey: "blocked-final", command: {
      targetKind: "final", targetId: "export-1", expectedHash: "9".repeat(64), decision: "rejected", checklist: [],
      notes: "QC review does not exist yet.", advisoryAcknowledgements: [],
    } })).rejects.toMatchObject({ code: "QC_BLOCKED" });
    expect(store.read.listApprovals("final", "export-1")).toEqual([]);
    store.close();
  });

  it("serves strict created/replay approval POSTs and rejects a browser actor field", async () => {
    const { store, story, dataDir } = setup();
    const handlers = createApprovalRouteHandlers({
      withStore: async (work) => work(store),
      dataDir,
      serviceOptions: { now: () => 40, readAssetVerified: async () => undefined },
    });
    const command = storyCommand("http-story-command", { expectedHash: story.contentHash });
    const post = (value: unknown) => handlers.POST(new Request("http://localhost/api/production/approvals", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    const envelope = { projectId: "project-1", idempotencyKey: "http-story-command", command: command.command };
    const created = await post(envelope);
    const replay = await post(envelope);
    const forgedActor = await post({ ...envelope, actorId: "browser-creator" });
    expect([created.status, replay.status, forgedActor.status]).toEqual([201, 200, 400]);
    expect(await created.json()).toMatchObject({ created: true, approval: { actorId: "local-creator" } });
    expect(await replay.json()).toMatchObject({ created: false });
    expect(store.read.listApprovals("story", story.id)).toHaveLength(1);
    store.close();
  });

  it("reviews a checksum-verified current anchor before it is selected in the animatic", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "perabyte-anchor-approval-"));
    dirs.push(dataDir);
    const store = openProductionStore({ dataDir });
    const vaultRoot = join(dataDir, "media");
    const vault = new LocalMediaVault({ root: vaultRoot });
    const bytes = Buffer.from("verified fixture anchor bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(vaultRoot, "sha256", sha256.slice(0, 2)), { recursive: true });
    writeFileSync(join(vaultRoot, "sha256", sha256.slice(0, 2), sha256), bytes);

    const project = ProjectSchema.parse({ version: 1, id: "project-anchor", name: "Anchor review", profileId: "short",
      profile: { id: "short", format: "9:16", language: "en", ageIntent: "all ages", targetFrames: 24, projectCapMinor: null, dailyCapMinor: null },
      activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null,
      activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 });
    const location = CanonRevisionSchema.parse({ version: 1, id: "location-r1", entityId: "location", entityKind: "location", revision: 1,
      description: "A meadow", attributes: {}, referenceAssetIds: [], contentHash: "1".repeat(64), createdAt: 2 });
    const style = CanonRevisionSchema.parse({ version: 1, id: "style-r1", entityId: "style", entityKind: "style", revision: 1,
      description: "Paper collage", attributes: {}, referenceAssetIds: [], contentHash: "2".repeat(64), createdAt: 2 });
    const story = StoryRevisionSchema.parse({ version: 1, id: "story-r1", projectId: project.id, parentRevisionId: null,
      scriptText: "A lantern glows.", beats: [{ id: "beat-1", action: "A lantern glows.", narration: "A lantern glows.", dialogue: [], order: 0 }],
      canonRevisionIds: [location.id, style.id], contentHash: "3".repeat(64), createdAt: 3 });
    const shot = ShotRevisionSchema.parse({ version: 1, id: "shot-r1", shotId: "shot-1", storyRevisionId: story.id,
      beatIds: ["beat-1"], order: 0, visualIntent: "A warm lantern in a meadow", motionIntent: "Static", castBindings: [],
      locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "medium", targetFrames: 24,
      continuation: null, contentHash: "4".repeat(64), createdAt: 4 });
    const plan = ShotPlanRevisionSchema.parse({ version: 1, id: "plan-r1", projectId: project.id, storyRevisionId: story.id,
      orderedShotRevisionIds: [shot.id], beatCoverage: [{ beatId: "beat-1", shotRevisionIds: [shot.id] }], contentHash: "5".repeat(64), createdAt: 5 });
    const animatic = AnimaticRevisionSchema.parse({ version: 1, id: "animatic-r1", projectId: project.id, shotPlanRevisionId: plan.id,
      slots: [{ shotRevisionId: shot.id, anchorId: null, placeholderLabel: "Awaiting approved still" }], timingAnnotations: [], totalFrames: 24,
      contentHash: "6".repeat(64), createdAt: 6 });
    const asset = AssetSchema.parse({ version: 1, id: "anchor-asset", sha256, mime: "image/png", byteSize: bytes.length,
      vaultRef: `sha256-${sha256}`, width: 1, height: 1, frames: null, fps: null, audioSamples: null, sourceKind: "fixture",
      sourceJobId: null, rightsStatus: "provider", createdAt: 7 });

    let snapshot = ProviderRequestSnapshotSchema.parse({ projectId: project.id, jobId: "anchor-job", idempotencyKey: "anchor-key", quoteId: "quote-1",
      providerId: "provider-1", modelId: "model-1", prompt: "A warm lantern", inputs: [], parameters: { providerAudioPolicy: "muted" },
      billingMode: "subscription", resultTarget: { kind: "anchor", shotRevisionId: shot.id, inputsHash: "0".repeat(64) } });
    let anchorHash = "0".repeat(64);
    let expectedAnchorHash = "0".repeat(64);
    store.transaction((tx) => {
      tx.insertProject(project);
      tx.insertCanonRevision(location);
      tx.insertCanonRevision(style);
      tx.insertStoryRevision(story);
      tx.insertShotRevisions([shot]);
      tx.insertShotPlanRevision(plan);
      tx.insertAnimaticRevision(animatic);
      expect(tx.compareAndSetProject({ ...project, activeCanonRevisionIds: [location.id, style.id], activeStoryRevisionId: story.id,
        activeShotPlanRevisionId: plan.id, activeAnimaticRevisionId: animatic.id, saveVersion: 2 }, 1)).toBe(true);
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: "prior-story-approval", targetKind: "story", targetId: story.id,
        targetHash: story.contentHash, decision: "approved", actorId: "local-creator", createdAt: 10,
        checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] }));
      tx.appendApproval(ApprovalSchema.parse({ version: 1, id: "prior-animatic-approval", targetKind: "animatic", targetId: animatic.id,
        targetHash: animatic.contentHash, decision: "approved", actorId: "local-creator", createdAt: 11,
        checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] }));
      snapshot = ProviderRequestSnapshotSchema.parse({ ...snapshot, resultTarget: { ...snapshot.resultTarget!,
        inputsHash: computeProductionInputsHash(tx, "anchor", snapshot) } });
      anchorHash = snapshot.resultTarget!.inputsHash;
      const quote = QuoteSchema.parse({ version: 1, id: "quote-1", projectId: project.id, providerId: "provider-1", modelId: "model-1",
        operation: "anchor", inputHash: "7".repeat(64), entitlement: "subscription", estimateMinMinor: null, estimateMaxMinor: null,
        currency: null, expiresAt: 5000, withinAuthorizedCap: "unknown", createdAt: 12 });
      tx.insertQuote(quote);
      tx.insertAsset({ asset, checksumVerified: true, verifiedAt: 7 });
      const job = JobSchema.parse({ version: 1, id: "anchor-job", projectId: project.id, operation: "anchor", status: "queued",
        idempotencyKey: "anchor-key", requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: "provider-1", modelId: "model-1",
        providerRef: null, quoteId: quote.id, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null,
        heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: 12, updatedAt: 12 });
      tx.insertJob(job, { id: "anchor-outbox", jobId: job.id, createdAt: 12, claimedAt: null, claimToken: null });
      const receipt = HonoredInputsReceiptSchema.parse({ version: 1, id: "anchor-receipt", jobId: job.id, capabilityProvenance: "unknown",
        capabilityObservedAt: 12, inputs: [], createdAt: 12 });
      tx.insertHonoredInputsReceipt(receipt);
      const fixtureNow = Date.now();
      const lease = { jobId: job.id, leaseToken: "anchor-lease", leaseUntil: fixtureNow + 10_000, heartbeatAt: fixtureNow };
      const claimed = tx.claimJob(job.id, fixtureNow, lease)!;
      const anchor = AnchorCandidateSchema.parse({ version: 1, id: "anchor-candidate", shotRevisionId: shot.id, assetId: asset.id,
        inputsHash: anchorHash, jobId: job.id, visionAssessment: null, receiptId: receipt.id, createdAt: 15 });
      tx.insertAnchor(anchor);
      expect(tx.updateLeasedJob({ ...claimed, status: "completed", receiptId: receipt.id, resultId: anchor.id, resultAssetIds: [asset.id], updatedAt: 14 }, lease.leaseToken)).toBe(true);
      expectedAnchorHash = computeAnchorApprovalHash(tx, anchor);
    });

    let changedContext = false;
    const service = createProductionApprovalService({ store, now: () => 50, readAssetVerified: async (candidate) => {
      const verified = await vault.readVerified(candidate.vaultRef, candidate.sha256);
      if (!changedContext) {
        changedContext = true;
        store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: "later-story-approval", targetKind: "story",
          targetId: story.id, targetHash: story.contentHash, decision: "approved", actorId: "local-creator", createdAt: 20,
          checklist: [{ id: "review", passed: true, note: "Re-reviewed" }], notes: "", advisoryAcknowledgements: [] })));
      }
      return verified;
    } });
    const approvalCommand: ApprovalRouteCommand["command"] = {
      targetKind: "anchor", targetId: "anchor-candidate", expectedHash: expectedAnchorHash, decision: "approved",
      checklist: ["identity", "wardrobe", "location", "props", "framing"].map((id) => ({ id, passed: true, note: "Reviewed" })),
      notes: "Reviewed the checksum-verified still.", advisoryAcknowledgements: [{ code: "vision_unavailable", reason: "Vision review was unavailable; I reviewed the still directly." }],
    };
    await expect(service.create({ projectId: project.id, idempotencyKey: "review-anchor-context-a", command: approvalCommand }))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(store.read.listApprovals("anchor", "anchor-candidate")).toEqual([]);
    const result = await service.create({ projectId: project.id, idempotencyKey: "review-anchor-context-b", command: approvalCommand });
    expect(result.created).toBe(true);
    expect(result.approval.targetHash).toHaveLength(64);
    expect(store.read.listApprovals("anchor", "anchor-candidate")).toHaveLength(1);
    expect(store.read.getAnimaticRevision(animatic.id)?.slots[0]?.anchorId).toBeNull();
    store.close();
  });
});
