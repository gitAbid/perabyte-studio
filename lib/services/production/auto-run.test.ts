import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import {
  advanceAutoRun, cancelAutoRun, confirmAutoRun, createAutoRun, estimateAutoRunCost, parseAutoStoryDraft,
  type AutoRunAdvanceDeps,
} from "./auto-run";
import type { TextProvider } from "../../providers/types";
import { createCanonRevision, createProject } from "./revisions";
import { ProductionApplicationError } from "../../production/errors";

function storeFixture(): SqliteProductionStore {
  const dataDir = mkdtempSync(join(tmpdir(), "auto-run-"));
  return openProductionStore({ dataDir });
}

function projectFixture(store: SqliteProductionStore): string {
  const project = createProject(store, { name: "Auto Run Fixture", profileId: "storybook-short-v1" }, { idFactory: () => `proj-${Math.random().toString(36).slice(2, 10)}` });
  const idFactory = () => `rev-${Math.random().toString(36).slice(2, 10)}`;
  createCanonRevision(store, { projectId: project.id, entityId: "loc-fixture", expectedRevisionId: null, entityKind: "location", description: "A moonlit forest clearing", attributes: {}, assetIds: [] }, { idFactory });
  createCanonRevision(store, { projectId: project.id, entityId: "style-fixture", expectedRevisionId: null, entityKind: "style", description: "Warm storybook watercolor", attributes: {}, assetIds: [] }, { idFactory });
  return project.id;
}

const stubProvider: TextProvider = {
  id: "stub",
  label: "stub",
  isConfigured: () => true,
  listTextModels: () => [{ id: "m1", label: "Model 1", provider: "stub", contextTokens: 16_384 }],
  async generateText({ userPrompt }) {
    if (!userPrompt.includes("Idea:")) throw new Error("prompt missing idea");
    return {
      text: [
        "## BEAT: The lamp dies",
        "NARRATOR: The storm swallows the light, and the keeper holds the rail.",
        "",
        "## BEAT: Dawn",
        "NARRATOR: The tide retreats, taking the night with it.",
      ].join("\n"),
      model: "m1",
      provider: "stub",
    };
  },
};

const deps: AutoRunAdvanceDeps = { textProvider: stubProvider };

function failOf(run: () => unknown): ProductionApplicationError {
  try { run(); } catch (error) { if (error instanceof ProductionApplicationError) return error; throw error; }
  throw new Error("expected failure");
}

describe("auto-run service (C17 / spec 14)", () => {
  it("creates an awaiting-confirmation run with a coarse estimate and full stage spine", () => {
    const store = storeFixture();
    const projectId = projectFixture(store);
    const run = createAutoRun(store, { projectId, idea: "A lighthouse keeper befriends a storm.", durationTargetMs: 120_000, qualityStrategy: "balanced" });
    expect(run.state).toBe("awaiting_confirmation");
    expect(run.stages.map((stage) => stage.kind)).toEqual(["story", "storyboard", "anchors", "takes", "audio", "assembly"]);
    expect(run.estimatedCost?.minMicros).toBeLessThan(run.estimatedCost!.maxMicros);
    store.close();
  });

  it("refuses to confirm without an installed spend policy (fail-closed)", async () => {
    const store = storeFixture();
    const projectId = projectFixture(store);
    const run = createAutoRun(store, { projectId, idea: "A storm film.", durationTargetMs: 60_000, qualityStrategy: "economy" });
    const error = await confirmAutoRun(store, run.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProductionApplicationError);
    expect((error as ProductionApplicationError).code).toBe("BUDGET_BLOCKED");
    store.close();
  });

  it("advances story → storyboard with no manual prompt writing, then parks for review", async () => {
    const store = storeFixture();
    const projectId = projectFixture(store);
    const run = createAutoRun(store, { projectId, idea: "A lighthouse keeper befriends a storm.", durationTargetMs: 120_000, qualityStrategy: "balanced" });
    // Simulate an installed policy by confirming through the same path the route uses —
    // the policy check consults the data dir; seed it via the env-independent store only.
    // (Confirm's gate is separately tested above; here we drive the machine directly.)
    const seeded = { ...run, state: "running" as const, confirmedAt: 1, saveVersion: run.saveVersion + 1 };
    store.transaction((tx) => { expect(tx.compareAndSetAutoRun(seeded, run.saveVersion)).toBe(true); });

    const afterStory = await advanceAutoRun(store, run.id, deps);
    expect(afterStory.stages.find((stage) => stage.kind === "story")?.state).toBe("completed");
    expect(afterStory.stages.find((stage) => stage.kind === "storyboard")?.state).toBe("queued");
    // Zero auto-approvals: the run parks until the story is approved by a human.
    expect(afterStory.state).toBe("awaiting_review");

    const stillParked = await advanceAutoRun(store, run.id, deps);
    expect(stillParked.state).toBe("awaiting_review");
    expect(stillParked.stages.find((stage) => stage.kind === "storyboard")?.state).toBe("queued");

    const storyId = store.read.getProject(projectId)!.activeStoryRevisionId!;
    const story = store.read.getStoryRevision(storyId)!;
    store.transaction((tx) => tx.appendApproval({
      version: 1, id: "approval-story-1", targetKind: "story", targetId: storyId, targetHash: story.contentHash,
      decision: "approved", actorId: "local-creator", createdAt: 50,
      checklist: [{ id: "review", passed: true, note: "fixture" }], notes: "", advisoryAcknowledgements: [],
    }));

    const afterStoryboard = await advanceAutoRun(store, run.id, deps);
    expect(afterStoryboard.state).toBe("awaiting_review");
    expect(afterStoryboard.stages.find((stage) => stage.kind === "storyboard")?.state).toBe("completed");
    expect(afterStoryboard.stages.find((stage) => stage.kind === "anchors")?.state).toBe("running");
    const project = store.read.getProject(projectId);
    expect(project?.activeStoryRevisionId).toBe(storyId);
    expect(project?.activeShotPlanRevisionId).toBeTruthy();
    store.close();
  });

  it("reuses the existing story on rerun (never pays twice)", async () => {
    const store = storeFixture();
    const projectId = projectFixture(store);
    const first = createAutoRun(store, { projectId, idea: "First idea.", durationTargetMs: 90_000, qualityStrategy: "best" });
    store.transaction((tx) => { tx.compareAndSetAutoRun({ ...first, state: "running" as const, confirmedAt: 1, saveVersion: first.saveVersion + 1 }, first.saveVersion); });
    await advanceAutoRun(store, first.id, deps);
    const storyId = store.read.getProject(projectId)!.activeStoryRevisionId!;
    expect(storyId).toBeTruthy();

    const second = createAutoRun(store, { projectId, idea: "Different idea entirely.", durationTargetMs: 90_000, qualityStrategy: "best" });
    store.transaction((tx) => { tx.compareAndSetAutoRun({ ...second, state: "running" as const, confirmedAt: 1, saveVersion: second.saveVersion + 1 }, second.saveVersion); });
    const after = await advanceAutoRun(store, second.id, deps);
    expect(after.stages.find((stage) => stage.kind === "story")?.state).toBe("completed");
    expect(after.stages.find((stage) => stage.kind === "story")?.targetId).toBe(storyId);
    store.close();
  });

  it("cancel preserves completed artifacts and stops pending stages", () => {
    const store = storeFixture();
    const projectId = projectFixture(store);
    const run = createAutoRun(store, { projectId, idea: "A short film.", durationTargetMs: 60_000, qualityStrategy: "balanced" });
    const canceled = cancelAutoRun(store, run.id);
    expect(canceled.state).toBe("canceled");
    expect(canceled.stages.every((stage) => stage.state === "canceled" || stage.state === "pending")).toBe(true);
    expect(cancelAutoRun(store, run.id).state).toBe("canceled");
    store.close();
  });

  it("parseAutoStoryDraft is deterministic and rejects unusable engine output", () => {
    const good = parseAutoStoryDraft("## BEAT: One\nNARRATOR: Hello.\nLUNA: Hi.\n\n## BEAT: Two\nNARRATOR: Bye.");
    expect(good.beats.map((beat) => beat.id)).toEqual(["beat-auto-1", "beat-auto-2"]);
    expect(parseAutoStoryDraft("## BEAT: One\nNARRATOR: Hello.")).toEqual(good && parseAutoStoryDraft("## BEAT: One\nNARRATOR: Hello."));
    expect(failOf(() => parseAutoStoryDraft("just prose, no beats"))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("estimates stay coarse and ordered", () => {
    const economy = estimateAutoRunCost({ durationTargetMs: 120_000, qualityStrategy: "economy" });
    const best = estimateAutoRunCost({ durationTargetMs: 120_000, qualityStrategy: "best" });
    expect(economy.maxMicros).toBeLessThan(best.minMicros);
  });
});
