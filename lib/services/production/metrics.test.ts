import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MetricEvent, Project } from "../../production/contracts";
import { openProductionStore } from "../../repositories/production/sqlite";
import type { ProductionStore, ProductionWritePort } from "../../repositories/production/ports";
import {
  ASSET_KIND_DIM,
  PROPOSAL_LINKAGE_DIM,
  loadProductionMetricsSnapshot,
  projectProductionMetrics,
  recordGeneration,
  recordMetricEvent,
  type ProductionMetricsExtras,
} from "./metrics";

const event = (overrides: Partial<MetricEvent> = {}): MetricEvent => ({
  version: 1,
  id: overrides.id ?? `metric-${randomUUID()}`,
  projectId: "project-1",
  workspaceId: null,
  kind: "generation_completed",
  at: 1_000,
  durationMs: null,
  costMicros: null,
  ...overrides,
});
const extras = (overrides: Partial<ProductionMetricsExtras> = {}): ProductionMetricsExtras => ({
  projectCreatedAt: 0, firstStoryboardAt: null, firstCutAt: null, finishedMinuteDurationMs: null, selectedTakeCount: null,
  ...overrides,
});

describe("recordMetricEvent", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const capturingStore = (insert: (event: MetricEvent) => void): ProductionStore =>
    ({ read: {}, transaction: (work: (tx: ProductionWritePort) => unknown) => work({ insertMetricEvent: insert } as unknown as ProductionWritePort) }) as unknown as ProductionStore;
  const failingStore = (failure: () => void): ProductionStore =>
    ({ read: {}, transaction: () => { failure(); } }) as unknown as ProductionStore;

  it("stamps version and id and inserts inside one transaction", () => {
    const inserted: MetricEvent[] = [];
    recordMetricEvent(capturingStore((event) => inserted.push(event)), { projectId: "project-1", workspaceId: null, kind: "export_completed", at: 5, durationMs: null, costMicros: null });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ version: 1, projectId: "project-1", kind: "export_completed", at: 5 });
    expect(inserted[0]!.id).toMatch(/^metric-/);
    recordMetricEvent(capturingStore((event) => inserted.push(event)), { id: "metric-custom-1", projectId: null, workspaceId: null, kind: "story_proposal_completed", at: 6, durationMs: 10, costMicros: 7, dims: { provider: "p" } });
    expect(inserted[1]).toMatchObject({ version: 1, id: "metric-custom-1", projectId: null, costMicros: 7, dims: { provider: "p" } });
  });

  it("never throws when the store or transaction fails, and logs the swallow", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => recordMetricEvent(failingStore(() => { throw new Error("disk on fire"); }), { projectId: "project-1", workspaceId: null, kind: "generation_completed", at: 1, durationMs: null, costMicros: null })).not.toThrow();
    expect(() => recordMetricEvent(failingStore(() => { throw new Error("insert blew up"); }), { projectId: "project-1", workspaceId: null, kind: "generation_completed", at: 1, durationMs: null, costMicros: null })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain("best-effort");
  });

  it("never throws on an invalid command; nothing is inserted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inserted: MetricEvent[] = [];
    recordMetricEvent(capturingStore((event) => inserted.push(event)), { projectId: "project-1", workspaceId: null, kind: "not-a-kind" as never, at: -5, durationMs: null, costMicros: null });
    expect(inserted).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("recordGeneration mirrors the recorder with defaults", () => {
    const inserted: MetricEvent[] = [];
    recordGeneration(capturingStore((event) => inserted.push(event)), { projectId: "project-1", kind: "generation_failed" });
    expect(inserted[0]).toMatchObject({ version: 1, projectId: "project-1", workspaceId: null, kind: "generation_failed", durationMs: null, costMicros: null });
    expect(inserted[0]!.dims).toBeUndefined();
    expect(inserted[0]!.at).toBeGreaterThan(0);
  });
});

describe("projectProductionMetrics", () => {
  it("returns a null-safe all-empty projection without events or extras", () => {
    expect(projectProductionMetrics([], {})).toEqual({
      eventCount: 0,
      generations: { completed: 0, failed: 0, manualPromptCount: 0 },
      acceptanceRates: {},
      generatedSelected: { generated: 0, selected: 0, ratio: null },
      cost: { totalMicros: 0, perFinishedMinuteMicros: null },
      reviewTimeMedianMs: null,
      reviewTimeSamples: 0,
      timeToFirstStoryboardMs: null,
      timeToFirstCutMs: null,
    });
  });

  it("counts generations by status with the manual-prompt proxy", () => {
    const events = [
      event({ kind: "generation_completed" }),
      event({ kind: "generation_failed" }),
      event({ kind: "generation_completed", dims: { [PROPOSAL_LINKAGE_DIM]: "proposal-1" } }),
      event({ kind: "generation_completed", dims: { operation: "take" } }),
      event({ kind: "story_proposal_completed" }),
    ];
    const projection = projectProductionMetrics(events, extras());
    expect(projection.generations).toEqual({ completed: 3, failed: 1, manualPromptCount: 3 });
    expect(projection.eventCount).toBe(5);
  });

  it("computes acceptance rates per asset kind from approved and rejected decisions", () => {
    const events = [
      event({ kind: "asset_approved", dims: { [ASSET_KIND_DIM]: "character", assetId: "c1" } }),
      event({ kind: "asset_approved", dims: { [ASSET_KIND_DIM]: "character", assetId: "c2", decision: "rejected" } }),
      event({ kind: "asset_approved", dims: { [ASSET_KIND_DIM]: "character", assetId: "c3" } }),
      event({ kind: "review_completed", dims: { [ASSET_KIND_DIM]: "environment", decision: "rejected" } }),
      event({ kind: "asset_recommended", dims: { [ASSET_KIND_DIM]: "storyboard" } }),
      event({ kind: "asset_approved", dims: { decision: "rejected" } }),
    ];
    const projection = projectProductionMetrics(events, extras());
    expect(projection.acceptanceRates.character).toEqual({ approved: 2, rejected: 1, rate: 2 / 3 });
    expect(projection.acceptanceRates.environment).toEqual({ approved: 0, rejected: 1, rate: 0 });
    expect(projection.acceptanceRates.storyboard).toBeUndefined();
  });

  it("computes the generated/selected ratio from extras, falling back to the selected dim", () => {
    const events = [
      event({ kind: "generation_completed" }),
      event({ kind: "generation_completed" }),
      event({ kind: "generation_completed", dims: { selected: "true" } }),
      event({ kind: "generation_failed" }),
    ];
    // The selected event is itself a completed generation, so generated counts it too.
    expect(projectProductionMetrics(events, extras({ selectedTakeCount: 1 })).generatedSelected).toEqual({ generated: 3, selected: 1, ratio: 3 });
    // Without an extras count the projection falls back to the selected dim on the events.
    expect(projectProductionMetrics(events, extras({ selectedTakeCount: null })).generatedSelected).toEqual({ generated: 3, selected: 1, ratio: 3 });
    // With no selections anywhere (no extras count, no dim) the ratio is honestly null.
    expect(projectProductionMetrics([events[0]!, events[3]!], extras()).generatedSelected).toEqual({ generated: 1, selected: 0, ratio: null });
  });

  it("sums cost and scales cost per finished minute from the manifest duration", () => {
    const events = [event({ costMicros: 100 }), event({ costMicros: null }), event({ costMicros: 200 })];
    expect(projectProductionMetrics(events, extras({ finishedMinuteDurationMs: 30_000 })).cost).toEqual({ totalMicros: 300, perFinishedMinuteMicros: 600 });
    expect(projectProductionMetrics(events, extras({ finishedMinuteDurationMs: 0 })).cost).toEqual({ totalMicros: 300, perFinishedMinuteMicros: null });
    expect(projectProductionMetrics(events, extras()).cost).toEqual({ totalMicros: 300, perFinishedMinuteMicros: null });
  });

  it("takes the median recommended-to-approved review delta over matched pairs only", () => {
    const events = [
      // Later pair first in the input to prove the projection orders by event time.
      event({ kind: "asset_recommended", at: 10_000, dims: { assetId: "t2" } }),
      event({ kind: "asset_approved", at: 15_000, dims: { assetId: "t2" } }),
      event({ kind: "asset_recommended", at: 1_000, dims: { assetId: "t1" } }),
      event({ kind: "asset_approved", at: 4_000, dims: { assetId: "t1" } }),
      // Approved without any prior recommendation and a dimless pair are both skipped.
      event({ kind: "asset_approved", at: 99_000, dims: { assetId: "t3" } }),
      event({ kind: "asset_recommended", at: 2_000 }),
      event({ kind: "asset_approved", at: 3_000 }),
    ];
    const projection = projectProductionMetrics(events, extras());
    expect(projection.reviewTimeSamples).toBe(2);
    expect(projection.reviewTimeMedianMs).toBe(4_000);
    expect(projectProductionMetrics([events[0]!, events[1]!], extras())).toEqual(expect.objectContaining({ reviewTimeMedianMs: 5_000, reviewTimeSamples: 1 }));
  });

  it("measures time to first storyboard and cut from the project origin, null-safe", () => {
    expect(projectProductionMetrics([], extras({ projectCreatedAt: 0, firstStoryboardAt: 61_000, firstCutAt: 130_000 }))).toMatchObject({ timeToFirstStoryboardMs: 61_000, timeToFirstCutMs: 130_000 });
    expect(projectProductionMetrics([], extras({ projectCreatedAt: 5_000 })).timeToFirstStoryboardMs).toBeNull();
    expect(projectProductionMetrics([], extras({ projectCreatedAt: 5_000, firstStoryboardAt: 1_000 }))).toMatchObject({ timeToFirstStoryboardMs: null, timeToFirstCutMs: null });
    expect(projectProductionMetrics([], extras({ projectCreatedAt: 0, firstStoryboardAt: 0 }))).toMatchObject({ timeToFirstStoryboardMs: 0 });
  });
});

describe("loadProductionMetricsSnapshot", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-metrics-"));
    dirs.push(dir);
    return openProductionStore({ dataDir: dir });
  };
  const project = (id: string): Project => ({ version: 1, id, name: "Summary project", profileId: "profile-1", profile: { id: "profile-1", format: "9:16", language: "en", ageIntent: "family", targetFrames: 192, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 100, updatedAt: 100, saveVersion: 1 });

  it("returns null for an unknown project and stays pure for an empty one", () => {
    const store = open();
    try {
      expect(loadProductionMetricsSnapshot(store, "project-missing")).toBeNull();
      store.transaction((tx) => tx.insertProject(project("project-empty")));
      const snapshot = loadProductionMetricsSnapshot(store, "project-empty");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.project).toEqual({ id: "project-empty", name: "Summary project", createdAt: 100 });
      expect(snapshot!.events).toEqual([]);
      expect(snapshot!.extras).toEqual({ projectCreatedAt: 100, firstStoryboardAt: null, firstCutAt: null, finishedMinuteDurationMs: null, selectedTakeCount: null });
      expect(snapshot!.projection.eventCount).toBe(0);
      expect(snapshot!.projection.timeToFirstStoryboardMs).toBeNull();
      expect(snapshot!.projection.timeToFirstCutMs).toBeNull();
    } finally { store.close(); }
  });

  it("derives firstCutAt from the first playable export and lists project events", () => {
    const store = open();
    try {
      // A well-formed minimal manifest row (the store API's compiler path needs the full
      // revision chain; the loader only reads shots/profile/projectId off the payload).
      const manifestPayload = JSON.stringify({
        version: 1, id: "manifest-1", projectId: "project-metrics", storyRevisionId: "story-1", shotPlanRevisionId: "plan-1",
        animaticRevisionId: "animatic-1", audioMixRevisionId: null, profile: { id: "profile-1", version: 1, aspect: "9:16", width: 720, height: 1280, fps: 24, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", sampleRate: 48_000 },
        shots: [], audioCues: [], captionCues: [], inputsHash: "a".repeat(64), createdAt: 3_000,
      });
      store.transaction((tx) => {
        tx.insertProject(project("project-metrics"));
        tx.insertMetricEvent({ version: 1, id: "metric-1", projectId: "project-metrics", workspaceId: null, kind: "export_completed", at: 5_001, durationMs: 1_000, costMicros: null });
      });
      const dbPath = join(dirs[dirs.length - 1]!, "production.sqlite");
      const db = new Database(dbPath);
      db.prepare("INSERT INTO records(kind,id,project_id,natural_key,payload) VALUES('manifest','manifest-1','project-metrics',NULL,?)").run(manifestPayload);
      db.close();
      store.transaction((tx) => {
        tx.insertExport({ version: 1, id: "export-queued", manifestId: "manifest-1", jobId: null, assetId: null, qcReportId: null, status: "queued", createdAt: 4_000, approvedSha256: null, finalApprovalId: null });
        tx.insertExport({ version: 1, id: "export-ready", manifestId: "manifest-1", jobId: null, assetId: null, qcReportId: null, status: "ready_for_review", createdAt: 5_000, approvedSha256: null, finalApprovalId: null });
      });
      const snapshot = loadProductionMetricsSnapshot(store, "project-metrics");
      expect(snapshot!.events.map((event) => event.id)).toEqual(["metric-1"]);
      expect(snapshot!.extras.firstCutAt).toBe(5_000);
      expect(snapshot!.projection.timeToFirstCutMs).toBe(4_900);
      expect(snapshot!.projection.eventCount).toBe(1);
    } finally { store.close(); }
  });
});
