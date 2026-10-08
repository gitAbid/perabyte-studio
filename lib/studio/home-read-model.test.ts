import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "@/lib/repositories/production/sqlite";
import { setCharactersPathForTests } from "@/lib/repositories/characters.repository";
import { setLocationsPathForTests } from "@/lib/repositories/locations.repository";
import { putCharacter } from "@/lib/services/characters.service";
import type {
  AudioMixRevision, CanonRevision, Project, ProductionJob, StoryRevision, Workspace,
} from "@/lib/production/contracts";
import {
  loadStudioHome, listRecentProductions, listRecentWorkspaces, onboardingStatus,
} from "./home-read-model";

/**
 * The read model's helpers (deriveProductionStage, STAGE_NOTE, HOME_WORKSPACE_LIMIT) are
 * module-private, so every expectation below runs through the exported functions against a
 * real temp-dir store — the same seam app/studio uses.
 */

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");

const dirs: string[] = [];
const stores: SqliteProductionStore[] = [];
const priorDataDir = process.env.PERABYTE_STUDIO_DATA_DIR;
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "studio-home-read-model-"));
  dirs.push(dataDir);
  process.env.PERABYTE_STUDIO_DATA_DIR = dataDir;
  setCharactersPathForTests(join(dataDir, "characters.json"));
  setLocationsPathForTests(join(dataDir, "locations.json"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  setCharactersPathForTests(null);
  setLocationsPathForTests(null);
  if (priorDataDir === undefined) delete process.env.PERABYTE_STUDIO_DATA_DIR;
  else process.env.PERABYTE_STUDIO_DATA_DIR = priorDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(): SqliteProductionStore {
  const store = openProductionStore({ dataDir });
  stores.push(store);
  return store;
}

function workspaceFixture(id: string, updatedAt: number, overrides: Partial<Workspace> = {}): Workspace {
  return {
    version: 1,
    id,
    name: `Workspace ${id}`,
    characterCanonIds: [],
    environmentCanonIds: [],
    styleCanonIds: [],
    worldBible: { version: 1, summary: "A cozy seaside show.", entries: [] },
    productionRecipe: { version: 1, qualityStrategy: "balanced", aspectRatio: "16:9", language: "en", defaultShotTargetFrames: 24 },
    rating: "General",
    budgetPolicyId: null,
    createdAt: updatedAt,
    updatedAt,
    saveVersion: 1,
    ...overrides,
  };
}

function projectFixture(id: string, updatedAt: number, overrides: Partial<Project> = {}): Project {
  return {
    version: 1,
    id,
    name: `Project ${id}`,
    profileId: "profile-1",
    profile: { id: "profile-1", format: "16:9", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null },
    activeCanonRevisionIds: [],
    activeStoryRevisionId: null,
    activeShotPlanRevisionId: null,
    activeAnimaticRevisionId: null,
    activeAudioMixRevisionId: null,
    takeSelectionVersion: 0,
    audioMixVersion: 0,
    createdAt: updatedAt,
    updatedAt,
    saveVersion: 1,
    ...overrides,
  };
}

function canonRevisionFixture(id: string, entityId: string, entityKind: CanonRevision["entityKind"]): CanonRevision {
  return {
    version: 1,
    id,
    entityId,
    entityKind,
    revision: 1,
    description: `Canon revision ${id}`,
    attributes: {},
    referenceAssetIds: [],
    contentHash: sha(`canon-${id}`),
    createdAt: 100,
  };
}

function storyFixture(id: string, projectId: string): StoryRevision {
  return {
    version: 1,
    id,
    projectId,
    parentRevisionId: null,
    scriptText: "Ayo returns to the harbor.",
    beats: [{ id: `${id}-beat-1`, action: "Ayo walks the docks.", narration: "Fog rolls in.", dialogue: [], order: 0 }],
    canonRevisionIds: [],
    contentHash: sha(`story-${id}`),
    createdAt: 200,
  };
}

function mixFixture(id: string, projectId: string, storyRevisionId: string): AudioMixRevision {
  return {
    version: 1,
    id,
    projectId,
    storyRevisionId,
    cues: [],
    mixSettings: { sampleRate: 48000 as const, channels: 2 as const, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true },
    contentHash: sha(`mix-${id}`),
    createdAt: 300,
  };
}

function jobFixture(projectId: string, status: ProductionJob["status"], at: number, suffix = ""): { job: ProductionJob; outbox: { id: string; jobId: string; createdAt: number; claimedAt: null; claimToken: null } } {
  const id = `job-${projectId}${suffix}`;
  return {
    job: {
      version: 1,
      id,
      projectId,
      operation: "take",
      status,
      idempotencyKey: `${id}-key`,
      requestSnapshot: {},
      requestHash: sha(`request-${id}`),
      providerId: "provider-1",
      modelId: "model-1",
      providerRef: null,
      quoteId: null,
      receiptId: null,
      resultId: null,
      resultAssetIds: [],
      leaseToken: null,
      leaseUntil: null,
      heartbeatAt: null,
      attempt: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
    },
    outbox: { id: `outbox-${id}`, jobId: id, createdAt: at, claimedAt: null, claimToken: null },
  };
}

/**
 * Seeds a project whose store-projected stage matches `stage`. Only "setup" | "canon" |
 * "script" | "audio" are reachable from the sqlite projection; each promotion satisfies the
 * project_refs foreign keys with real records.
 */
function seedProjectAtStage(store: SqliteProductionStore, id: string, updatedAt: number, stage: "setup" | "canon" | "script" | "audio", overrides: Partial<Project> = {}): void {
  if (stage === "canon") {
    store.transaction((tx) => tx.insertCanonRevision(canonRevisionFixture(`${id}-location-rev`, `${id}-location`, "location")));
  }
  const project = projectFixture(id, updatedAt, overrides);
  if (stage === "canon") project.activeCanonRevisionIds = [`${id}-location-rev`];
  store.transaction((tx) => tx.insertProject(project));
  if (stage === "script" || stage === "audio") {
    store.transaction((tx) => tx.insertStoryRevision(storyFixture(`${id}-story-rev`, id)));
    if (stage === "audio") {
      store.transaction((tx) => tx.insertAudioMixRevision(mixFixture(`${id}-mix-rev`, id, `${id}-story-rev`)));
    }
    const promoted = stage === "script"
      ? { ...project, activeStoryRevisionId: `${id}-story-rev`, saveVersion: 2 }
      : { ...project, activeAudioMixRevisionId: `${id}-mix-rev`, saveVersion: 2 };
    expect(store.transaction((tx) => tx.compareAndSetProject(promoted, 1))).toBe(true);
  }
}

describe("studio home read model", () => {
  describe("workspaces lane", () => {
    it("lists real workspaces newest-first, capped at the twelve-row home limit, mapping only the summary fields", async () => {
      const store = seed();
      store.transaction((tx) => {
        for (let index = 1; index <= 14; index += 1) {
          const updatedAt = 1_000 + index;
          tx.insertWorkspace(workspaceFixture(`ws-${String(index).padStart(2, "0")}`, updatedAt, index === 14 ? { rating: "Mature" } : {}));
        }
      });

      const workspaces = await listRecentWorkspaces();
      expect(workspaces).toHaveLength(3);
      expect(workspaces.map((workspace) => workspace.id)).toEqual(["ws-14", "ws-13", "ws-12"]);
      expect(workspaces[0]).toEqual({ id: "ws-14", name: "Workspace ws-14", rating: "Mature", updatedAt: 1_014 });
      expect(Object.keys(workspaces[0]).sort()).toEqual(["id", "name", "rating", "updatedAt"]);
    });

    it("breaks updatedAt ties by ascending workspace id", async () => {
      const store = seed();
      store.transaction((tx) => {
        tx.insertWorkspace(workspaceFixture("ws-b", 5_000));
        tx.insertWorkspace(workspaceFixture("ws-c", 5_000));
        tx.insertWorkspace(workspaceFixture("ws-a", 5_000));
      });

      const workspaces = await listRecentWorkspaces();
      expect(workspaces.map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b", "ws-c"]);
    });
  });

  describe("production lifecycle mapping", () => {
    it("maps every store-projected stage onto the coarse studio stage table with its calm status note", async () => {
      const store = seed();
      store.transaction((tx) => tx.insertWorkspace(workspaceFixture("ws-home", 900)));
      seedProjectAtStage(store, "proj-audio", 1_004, "audio");
      seedProjectAtStage(store, "proj-script", 1_003, "script");
      seedProjectAtStage(store, "proj-canon", 1_002, "canon");
      seedProjectAtStage(store, "proj-setup", 1_001, "setup", { workspaceId: "ws-home" });

      const productions = await listRecentProductions();
      expect(productions.map((production) => production.id)).toEqual([
        "proj-audio", "proj-script", "proj-canon", "proj-setup",
      ]);
      const byId = new Map(productions.map((production) => [production.id, production]));
      expect(byId.get("proj-setup")).toMatchObject({
        stage: "drafting",
        statusNote: "Taking shape — cast, places, and script.",
        workspaceId: "ws-home",
        workspaceName: "Workspace ws-home",
      });
      expect(byId.get("proj-canon")).toMatchObject({ stage: "drafting", statusNote: "Taking shape — cast, places, and script." });
      expect(byId.get("proj-script")).toMatchObject({ stage: "drafting", statusNote: "Taking shape — cast, places, and script." });
      expect(byId.get("proj-audio")).toMatchObject({
        stage: "in_progress",
        statusNote: "Scenes are being made and approved.",
        workspaceId: null,
        workspaceName: null,
      });
    });

    it("surfaces failed, blocked and submission-unknown jobs as one calm needs_attention state that overrides every stage", async () => {
      const store = seed();
      seedProjectAtStage(store, "proj-audio", 1_004, "audio");
      seedProjectAtStage(store, "proj-unknown", 1_003, "script");
      seedProjectAtStage(store, "proj-blocked", 1_002, "canon");
      seedProjectAtStage(store, "proj-failed", 1_001, "setup");
      seedProjectAtStage(store, "proj-completed", 1_005, "setup");
      const attentionStatuses = [
        ["proj-audio", "failed"],
        ["proj-unknown", "submission_unknown"],
        ["proj-blocked", "blocked"],
        ["proj-failed", "failed"],
        ["proj-completed", "completed"],
      ] as const;
      store.transaction((tx) => {
        for (const [projectId, status] of attentionStatuses) {
          const { job, outbox } = jobFixture(projectId, status, 2_000);
          tx.insertJob(job, outbox);
        }
      });

      const productions = await listRecentProductions();
      expect(productions.map((production) => [production.id, production.stage])).toEqual([
        ["proj-audio", "needs_attention"],
        ["proj-unknown", "needs_attention"],
        ["proj-blocked", "needs_attention"],
        ["proj-failed", "needs_attention"],
        ["proj-completed", "drafting"],
      ]);
      for (const production of productions) {
        if (production.stage === "needs_attention") {
          expect(production.statusNote).toBe("Something interrupted this episode. Open it to see what happened and retry.");
        }
      }
    });

    it("ranks ready-to-review and needs-attention entries ahead of in-progress and drafting entries regardless of recency", async () => {
      const store = seed();
      seedProjectAtStage(store, "proj-drafting", 5_000, "setup");
      seedProjectAtStage(store, "proj-running", 3_000, "audio");
      seedProjectAtStage(store, "proj-stuck", 1_000, "setup");
      const { job, outbox } = jobFixture("proj-stuck", "failed", 6_000);
      store.transaction((tx) => tx.insertJob(job, outbox));

      const productions = await listRecentProductions();
      expect(productions.map((production) => production.id)).toEqual(["proj-stuck", "proj-running", "proj-drafting"]);
      expect(productions.map((production) => production.stage)).toEqual(["needs_attention", "in_progress", "drafting"]);
    });
  });

  describe("onboarding", () => {
    it("keeps firstRun with every step open for an empty store and aggregates the whole page", async () => {
      seed();
      const status = await onboardingStatus();
      expect(status.firstRun).toBe(true);
      expect(status.steps.map((step) => [step.id, step.done])).toEqual([
        ["create_workspace", false],
        ["add_character", false],
        ["add_environment", false],
        ["start_production", false],
      ]);
      expect(status.steps.map((step) => step.href)).toEqual(["/workspaces", "/character", "/environments", "/production/new"]);

      const home = await loadStudioHome();
      expect(home).toEqual({ workspaces: [], recentProductions: [], onboarding: status });
      expect(await listRecentWorkspaces()).toEqual([]);
      expect(await listRecentProductions()).toEqual([]);
    });

    it("flips each onboarding step from real workspace, library, canon, and production records", async () => {
      const store = seed();

      expect((await onboardingStatus()).steps.every((step) => !step.done)).toBe(true);

      expect(putCharacter({ id: "char-lib-1", name: "Ayo", spec: {}, createdAt: 10, updatedAt: 10 })).not.toBeNull();
      let steps = (await onboardingStatus()).steps;
      expect(steps.find((step) => step.id === "add_character")?.done).toBe(true);
      expect(steps.find((step) => step.id === "create_workspace")?.done).toBe(false);

      const workspace = workspaceFixture("ws-onboarding", 1_000);
      store.transaction((tx) => tx.insertWorkspace(workspace));
      steps = (await onboardingStatus()).steps;
      expect(steps.find((step) => step.id === "create_workspace")?.done).toBe(true);
      expect(steps.find((step) => step.id === "add_environment")?.done).toBe(false);

      expect(store.transaction((tx) => tx.compareAndSetWorkspace(
        { ...workspace, environmentCanonIds: ["env-1"], updatedAt: 1_100, saveVersion: 2 },
        1,
      ))).toBe(true);
      steps = (await onboardingStatus()).steps;
      expect(steps.find((step) => step.id === "add_environment")?.done).toBe(true);
      expect((await onboardingStatus()).firstRun).toBe(true);

      seedProjectAtStage(store, "proj-onboarding", 1_200, "setup");
      const final = await onboardingStatus();
      expect(final.steps.every((step) => step.done)).toBe(true);
      expect(final.firstRun).toBe(false);
    });

    it("counts canon revisions pinned by the active project as character and environment signals", async () => {
      const store = seed();
      store.transaction((tx) => {
        tx.insertCanonRevision(canonRevisionFixture("char-rev-1", "char-ayo", "character"));
        tx.insertCanonRevision(canonRevisionFixture("loc-rev-1", "loc-harbor", "location"));
      });
      seedProjectAtStage(store, "proj-pins", 1_000, "setup", { activeCanonRevisionIds: ["char-rev-1", "loc-rev-1"] });

      const status = await onboardingStatus();
      expect(status.steps.find((step) => step.id === "add_character")?.done).toBe(true);
      expect(status.steps.find((step) => step.id === "add_environment")?.done).toBe(true);
      expect(status.steps.find((step) => step.id === "create_workspace")?.done).toBe(false);
      expect(status.firstRun).toBe(true);
    });
  });

  describe("degradation", () => {
    it("returns teaching empty states instead of throwing when the store cannot be opened", async () => {
      const blockedDir = join(dataDir, "not-a-directory");
      writeFileSync(blockedDir, "a regular file where the data dir should be");
      process.env.PERABYTE_STUDIO_DATA_DIR = blockedDir;
      const logError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(await listRecentWorkspaces()).toEqual([]);
        expect(await listRecentProductions()).toEqual([]);
        const status = await onboardingStatus();
        expect(status.firstRun).toBe(true);
        expect(status.steps.every((step) => !step.done)).toBe(true);
        const home = await loadStudioHome();
        expect(home).toEqual({ workspaces: [], recentProductions: [], onboarding: status });
        const unavailable = logError.mock.calls.filter((args) => String(args[0]).includes("unavailable"));
        expect(unavailable.length).toBeGreaterThanOrEqual(2);
      } finally {
        logError.mockRestore();
      }
    });
  });
});
