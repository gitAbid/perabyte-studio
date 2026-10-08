import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  SceneSchema,
  ShotPlanRevisionSchema,
  ShotRevisionSchema,
  AnimaticRevisionSchema,
  ApprovalSchema,
  ProjectSchema,
  type Approval,
  type CharacterState,
  type EnvironmentState,
  type ProductionJob,
} from "./contracts";
import { hashCanonicalJson } from "./hash";
import { buildAnimaticTimeline } from "./animatic";
import {
  appendContinuityState,
  composeGenerationStates,
  resolvedStatesStamp,
  CONTINUITY_STATE_SECTION,
  type StateLayerInput,
} from "./state-composition";
import { LocalMediaVault } from "../media/production/vault";
import { openProductionStore } from "../repositories/production/sqlite";
import { createCanonRevision, createProject, createStoryRevision } from "../services/production/revisions";
import { createShotPlan } from "../services/production/shot-plan";
import { createProductionTakeService, materializeMediaSnapshot } from "../services/production/takes";
import { computeAnchorApprovalHash, computeProductionInputsHash } from "../jobs/production/queue";

const canonCharacterLayer = {
  characterCanonRevisionId: "charrev-luna-3",
  outfit: "Travel cloak",
  hairState: "Braided",
  accessories: ["Silver pin"],
  carriedObjects: ["Brass lantern"],
  condition: ["Rested"],
  agePresentation: "Adult",
  notes: "Canon baseline",
};
const canonEnvironmentLayer = {
  environmentCanonRevisionId: "envrev-cafe-1",
  zone: "Counter nook",
  lighting: "Warm practicals",
  timeOfDay: "Morning",
  weather: "Clear",
  persistentProps: ["Espresso machine"],
};

describe("composeGenerationStates", () => {
  it("is deterministic: the same layers always render the identical block and stamp", () => {
    const input = {
      characters: [[
        { at: "canon" as const, state: canonCharacterLayer },
        { at: "scene" as const, state: { outfit: "Rain coat" } },
      ]],
      environment: [
        { at: "canon" as const, state: canonEnvironmentLayer },
        { at: "scene" as const, state: { timeOfDay: "Golden hour" } },
      ],
    };
    const first = composeGenerationStates(input);
    const second = composeGenerationStates(input);
    expect(second).toEqual(first);
    expect(second.promptBlock).toBe(first.promptBlock);
    expect(first.promptBlock).toContain(CONTINUITY_STATE_SECTION);
    expect(resolvedStatesStamp(first, "scene-1")).toEqual(resolvedStatesStamp(second, "scene-1"));
  });

  it("applies field-level precedence: a scene field overrides the canon layer while unsuperseded fields stay canon", () => {
    const composed = composeGenerationStates({
      characters: [[
        { at: "canon", state: canonCharacterLayer },
        { at: "scene", state: { outfit: "Rain coat", hairState: "Wet braid" } },
      ]],
      environment: [
        { at: "canon", state: canonEnvironmentLayer },
        { at: "scene", state: { weather: "Light rain" } },
      ],
    });
    expect(composed.characters[0]?.fields).toEqual([
      { field: "outfit", value: "Rain coat", layer: "scene" },
      { field: "hairState", value: "Wet braid", layer: "scene" },
      { field: "accessories", value: ["Silver pin"], layer: "canon" },
      { field: "carriedObjects", value: ["Brass lantern"], layer: "canon" },
      { field: "condition", value: ["Rested"], layer: "canon" },
      { field: "agePresentation", value: "Adult", layer: "canon" },
      { field: "notes", value: "Canon baseline", layer: "canon" },
    ]);
    expect(composed.environment?.fields).toEqual([
      { field: "zone", value: "Counter nook", layer: "canon" },
      { field: "lighting", value: "Warm practicals", layer: "canon" },
      { field: "timeOfDay", value: "Morning", layer: "canon" },
      { field: "weather", value: "Light rain", layer: "scene" },
      { field: "persistentProps", value: ["Espresso machine"], layer: "canon" },
    ]);
    expect(composed.promptBlock).toBe([
      CONTINUITY_STATE_SECTION,
      "characters:",
      "- charrev-luna-3: outfit: Rain coat; hairState: Wet braid; accessories: Silver pin; carriedObjects: Brass lantern; condition: Rested; agePresentation: Adult; notes: Canon baseline",
      "environment:",
      "- envrev-cafe-1: zone: Counter nook; lighting: Warm practicals; timeOfDay: Morning; weather: Light rain; persistentProps: Espresso machine",
    ].join("\n"));
  });

  it("is a no-op for empty and contentless inputs: empty block, no stamp", () => {
    const empty = composeGenerationStates({ characters: [], environment: null });
    expect(empty).toEqual({ promptBlock: "", characters: [], environment: null });
    expect(appendContinuityState("base prompt", empty.promptBlock)).toBe("base prompt");
    expect(resolvedStatesStamp(empty, null)).toBeNull();
    // The default scene-draft shape (ids + required empty arrays) carries no content either.
    const contentless = composeGenerationStates({
      characters: [[{ at: "scene", state: { characterCanonRevisionId: "charrev-luna-3", accessories: [], carriedObjects: [], condition: [] } }]],
      environment: [{ at: "scene", state: { environmentCanonRevisionId: "envrev-cafe-1", persistentProps: [] } }],
    });
    expect(contentless.promptBlock).toBe("");
    expect(contentless.characters).toEqual([]);
    expect(contentless.environment).toBeNull();
    expect(resolvedStatesStamp(contentless, "scene-1")).toBeNull();
  });

  it("orders characters by pinned revision id regardless of input order", () => {
    const composed = composeGenerationStates({
      characters: [
        [{ at: "scene", state: { characterCanonRevisionId: "charrev-zoe-1", outfit: "Red scarf" } }],
        [{ at: "scene", state: { characterCanonRevisionId: "charrev-ada-2", outfit: "Blue hat" } }],
      ],
      environment: null,
    });
    expect(composed.characters.map(character => character.characterCanonRevisionId)).toEqual(["charrev-ada-2", "charrev-zoe-1"]);
    expect(composed.promptBlock).toBe([
      CONTINUITY_STATE_SECTION,
      "characters:",
      "- charrev-ada-2: outfit: Blue hat",
      "- charrev-zoe-1: outfit: Red scarf",
    ].join("\n"));
  });

  it("fails closed without a pinned canon id, on duplicate or unknown layers, and on malformed input", () => {
    expect(() => composeGenerationStates({ characters: [[{ at: "scene", state: { outfit: "No id" } }]], environment: null }))
      .toThrow(/must pin characterCanonRevisionId/);
    expect(() => composeGenerationStates({ characters: [], environment: [{ at: "scene", state: { zone: "No id" } }] }))
      .toThrow(/must pin environmentCanonRevisionId/);
    expect(() => composeGenerationStates({
      characters: [[{ at: "canon", state: canonCharacterLayer }, { at: "canon", state: { outfit: "Twice" } }]],
      environment: null,
    })).toThrow(/Duplicate canon state layer/);
    expect(() => composeGenerationStates({ characters: "nope" as unknown as ReadonlyArray<ReadonlyArray<StateLayerInput<CharacterState>>>, environment: null })).toThrow(/invalid/);
  });
});

/* ------------------------------------------------------------------ */
/* Integration: take request snapshots compose scene state             */
/* ------------------------------------------------------------------ */

const dirs: string[] = [];
const stores: Array<ReturnType<typeof openProductionStore>> = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

async function mediaFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-state-composition-")); dirs.push(dataDir);
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
  const character = createCanonRevision(store, { projectId: project.id, entityId: "luna", expectedRevisionId: null, entityKind: "character", description: "Luna, a courier", attributes: {}, assetIds: [] }, { now: clock, idFactory });
  const story = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: "A door opens. Someone enters.", beats: [{ id: "beat_1", action: "A door opens.", narration: "", dialogue: [] }, { id: "beat_2", action: "Someone enters.", narration: "", dialogue: [] }], canonRevisionIds: [location.id, style.id] }, { now: clock, idFactory });
  const approve = (kind: Approval["targetKind"], id: string, targetHash: string, approvalId: string) => store.transaction(tx => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: approvalId, targetKind: kind, targetId: id, targetHash, decision: "approved", actorId: "local-creator", createdAt: clock(), checklist: [{ id: "review", passed: true, note: "Reviewed" }], notes: "", advisoryAcknowledgements: [] })));
  approve("story", story.id, story.contentHash, "story-approval");
  const planned = createShotPlan(store, {
    projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash,
    shots: [
      { shotId: "shot_0", beatIds: ["beat_1"], visualIntent: "A door opens.", motionIntent: "Door opens slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide", targetFrames: 124, continuation: null },
      { shotId: "shot_1", beatIds: ["beat_2"], visualIntent: "Someone enters.", motionIntent: "Someone enters slowly.", castBindings: [], locationRevisionId: location.id, propRevisionIds: [], styleRevisionId: style.id, framing: "wide", targetFrames: 124, continuation: null },
    ],
  }, { now: clock, maxShots: 10, idFactory });
  approve("animatic", planned.animaticRevision.id, planned.animaticRevision.contentHash, "animatic-approval");
  const plainShot = planned.shotRevisions[0]!;
  const anchorJob: ProductionJob = { version: 1, id: "fixture-anchor-job", projectId: project.id, operation: "anchor" as const, status: "queued" as const, idempotencyKey: "fixture-anchor-key", requestSnapshot: {}, requestHash: "d".repeat(64), providerId: "sogni", modelId: "image-model", providerRef: null, quoteId: null, receiptId: null, resultId: null, resultAssetIds: [anchorAsset.id], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null, createdAt: clock(), updatedAt: clock() };
  store.transaction(tx => tx.insertJob(anchorJob, { id: "fixture-anchor-outbox", jobId: anchorJob.id, createdAt: clock(), claimedAt: null, claimToken: null }));
  const insertAnchor = (anchorId: string, shotRevisionId: string) => {
    const anchor = { version: 1 as const, id: anchorId, shotRevisionId, assetId: anchorAsset.id, inputsHash: "c".repeat(64), jobId: anchorJob.id, visionAssessment: null, receiptId: null, createdAt: clock() };
    store.transaction(tx => tx.insertAnchor(anchor));
    approve("anchor", anchorId, computeAnchorApprovalHash(store.read, anchor), `${anchorId}-approval`);
  };
  insertAnchor("approved-anchor-plain", plainShot.id);
  const takePrep = (shotRevisionId: string, anchorId: string) => ({
    kind: "take" as const,
    command: {
      projectId: project.id, shotRevisionId, anchorId, approvalId: `${anchorId}-approval`,
      motionSettings: { providerId: "sogni", modelId: "video-model", prompt: "Door opens slowly.", targetFrames: 124, aspect: "9:16" as const, seed: null },
    },
  });
  const service = () => createProductionTakeService({
    store, now: clock, idFactory,
    resolveBillingMode: async () => "subscription" as const,
    readAssetVerified: async asset => { await vault.readVerified(asset.vaultRef, asset.sha256); },
  });
  const upsertScene = (sceneStates: { characterStates: CharacterState[]; environmentState: EnvironmentState | null }) => {
    const sceneContent = {
      projectId: project.id, storyRevisionId: story.id, order: 0, title: "Opening",
      action: "A door opens into the rain.", dialogue: [], durationTargetMs: null,
      characterStates: sceneStates.characterStates, environmentState: sceneStates.environmentState,
    };
    const scene = SceneSchema.parse({ version: 1, ...sceneContent, id: "scene-opening", contentHash: hashCanonicalJson(sceneContent), createdAt: clock() });
    store.transaction(tx => tx.upsertScene(scene));
    return scene;
  };
  /** Tags a copy of shot_0 with the scene and repoints the active selection at it. */
  const attachSceneShot = (sceneStates: { characterStates: CharacterState[]; environmentState: EnvironmentState | null }) => {
    const scene = upsertScene(sceneStates);
    const shotContent = {
      version: 1 as const, shotId: plainShot.shotId, storyRevisionId: plainShot.storyRevisionId, beatIds: [...plainShot.beatIds], order: plainShot.order,
      visualIntent: plainShot.visualIntent, motionIntent: plainShot.motionIntent, castBindings: plainShot.castBindings.map(binding => ({ ...binding })),
      locationRevisionId: plainShot.locationRevisionId, propRevisionIds: [...plainShot.propRevisionIds], styleRevisionId: plainShot.styleRevisionId,
      framing: plainShot.framing, targetFrames: plainShot.targetFrames, continuation: null,
    };
    const sceneShot = ShotRevisionSchema.parse({ ...shotContent, id: "shot-rev-scene", sceneId: scene.id, contentHash: hashCanonicalJson(shotContent), createdAt: clock() });
    const orderedShotRevisionIds = [plainShot.id, sceneShot.id];
    const beatCoverage = [{ beatId: "beat_1", shotRevisionIds: [sceneShot.id] }];
    const plan = ShotPlanRevisionSchema.parse({
      version: 1, id: "plan-scene", projectId: project.id, storyRevisionId: story.id, orderedShotRevisionIds, beatCoverage,
      contentHash: hashCanonicalJson({ projectId: project.id, storyRevisionId: story.id, orderedShotRevisionIds, beatCoverage }), createdAt: clock(),
    });
    const timeline = buildAnimaticTimeline(orderedShotRevisionIds.map(id => ({ id, shotId: id === sceneShot.id ? sceneShot.shotId : plainShot.shotId, targetFrames: sceneShot.targetFrames })));
    const animatic = AnimaticRevisionSchema.parse({
      version: 1, id: "animatic-scene", projectId: project.id, shotPlanRevisionId: plan.id,
      slots: timeline.slots, timingAnnotations: timeline.timingAnnotations, totalFrames: timeline.totalFrames,
      contentHash: hashCanonicalJson({ shotPlanRevisionId: plan.id, slots: timeline.slots, timingAnnotations: timeline.timingAnnotations, totalFrames: timeline.totalFrames }),
      createdAt: clock(),
    });
    store.transaction(tx => {
      tx.insertShotRevisions([sceneShot]);
      tx.insertShotPlanRevision(plan);
      tx.insertAnimaticRevision(animatic);
      const current = tx.getProject(project.id)!;
      const nextProject = ProjectSchema.parse({ ...current, activeShotPlanRevisionId: plan.id, activeAnimaticRevisionId: animatic.id, updatedAt: clock(), saveVersion: current.saveVersion + 1 });
      if (!tx.compareAndSetProject(nextProject, current.saveVersion)) throw new Error("fixture project CAS failed");
    });
    approve("animatic", animatic.id, animatic.contentHash, "animatic-scene-approval");
    insertAnchor("approved-anchor-scene", sceneShot.id);
    return { scene, sceneShot };
  };

  return { store, project, story, plainShot, vault, service, takePrep, upsertScene, attachSceneShot, character, location };
}

describe("take snapshot state propagation", () => {
  it("composes scene states into the take prompt and stamps the snapshot; state content participates in inputsHash", async () => {
    const f = await mediaFixture();
    // Baseline: no scene on the shot -> byte-identical to the pre-state prompt, no stamp.
    const baseline = await f.service().prepare(f.takePrep(f.plainShot.id, "approved-anchor-plain"));
    expect(baseline.prompt).toBe("Door opens slowly.");
    expect(baseline.resolvedStates).toBeUndefined();

    const { scene, sceneShot } = f.attachSceneShot({
      characterStates: [{
        characterCanonRevisionId: f.character.id, outfit: "Rain coat", hairState: "Wet braid",
        accessories: ["Iron key"], carriedObjects: ["Brass lantern"], condition: ["Soaked"],
        agePresentation: "Adult, tired", notes: "Straight from the storm",
      }],
      environmentState: {
        environmentCanonRevisionId: f.location.id, zone: "Entry hall", lighting: "Cold window light",
        timeOfDay: "Dusk", weather: "Light rain", persistentProps: ["Coat rack"],
      },
    });
    const withState = await f.service().prepare(f.takePrep(sceneShot.id, "approved-anchor-scene"));
    expect(withState.prompt).toBe([
      "Door opens slowly.",
      "",
      CONTINUITY_STATE_SECTION,
      "characters:",
      `- ${f.character.id}: outfit: Rain coat; hairState: Wet braid; accessories: Iron key; carriedObjects: Brass lantern; condition: Soaked; agePresentation: Adult, tired; notes: Straight from the storm`,
      "environment:",
      `- ${f.location.id}: zone: Entry hall; lighting: Cold window light; timeOfDay: Dusk; weather: Light rain; persistentProps: Coat rack`,
    ].join("\n"));
    expect(withState.resolvedStates).toEqual({
      version: 1,
      sceneId: scene.id,
      characters: [{
        characterCanonRevisionId: f.character.id,
        fields: [
          { field: "outfit", value: "Rain coat", layer: "scene" },
          { field: "hairState", value: "Wet braid", layer: "scene" },
          { field: "accessories", value: ["Iron key"], layer: "scene" },
          { field: "carriedObjects", value: ["Brass lantern"], layer: "scene" },
          { field: "condition", value: ["Soaked"], layer: "scene" },
          { field: "agePresentation", value: "Adult, tired", layer: "scene" },
          { field: "notes", value: "Straight from the storm", layer: "scene" },
        ],
      }],
      environment: {
        environmentCanonRevisionId: f.location.id,
        fields: [
          { field: "zone", value: "Entry hall", layer: "scene" },
          { field: "lighting", value: "Cold window light", layer: "scene" },
          { field: "timeOfDay", value: "Dusk", layer: "scene" },
          { field: "weather", value: "Light rain", layer: "scene" },
          { field: "persistentProps", value: ["Coat rack"], layer: "scene" },
        ],
      },
    });

    // The materialized job snapshot carries both the prompt section and the structured stamp,
    // and its semantic inputs hash re-derives exactly (prompt content participates in the hash).
    const snapshot = materializeMediaSnapshot(withState, { jobId: "job-state-1", idempotencyKey: "key-state-1", quoteId: "quote-state-1" });
    expect(snapshot.prompt).toBe(withState.prompt);
    expect(snapshot.resolvedStates).toEqual(withState.resolvedStates);
    expect(snapshot.resultTarget?.kind).toBe("take");
    expect(computeProductionInputsHash(f.store.read, "take", snapshot)).toBe(snapshot.resultTarget!.inputsHash);

    // Determinism: preparing the same request again yields the identical prompt, stamp, and hash.
    const repeat = await f.service().prepare(f.takePrep(sceneShot.id, "approved-anchor-scene"));
    expect(repeat.prompt).toBe(withState.prompt);
    expect(repeat.resolvedStates).toEqual(withState.resolvedStates);
    expect(repeat.resultTarget.inputsHash).toBe(withState.resultTarget.inputsHash);

    // Only the scene state content differs -> the inputs hash must move (state flows into the hash).
    f.upsertScene({ characterStates: [{ characterCanonRevisionId: f.character.id, accessories: [], carriedObjects: [], condition: [] }], environmentState: null });
    const withoutState = await f.service().prepare(f.takePrep(sceneShot.id, "approved-anchor-scene"));
    expect(withoutState.prompt).toBe("Door opens slowly.");
    expect(withoutState.resolvedStates).toBeUndefined();
    expect(withoutState.resultTarget.inputsHash).not.toBe(withState.resultTarget.inputsHash);
  });
});
