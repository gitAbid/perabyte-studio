import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdSchema, RenderManifestSchema, Sha256Schema, type RenderManifest } from "./contracts";
import { ProductionApplicationError } from "./errors";
import { buildRenderProfile, manifestId } from "./manifest";
import {
  disableShot, duplicateShot, retimeShot, replaceTake, setCaptions,
  type ManifestEditPins, type ManifestEditResult, type ManifestReplacementTake, type ManifestShotRenderPins,
} from "./manifest-ops";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");

function shotEntry(shotRevisionId: string, endFrame: number): RenderManifest["shots"][number] {
  return {
    shotRevisionId,
    takeId: `take-${shotRevisionId}`,
    assetId: `asset-${shotRevisionId}`,
    startFrame: 0,
    endFrame,
    crop: { x: 0, y: 0, width: 1920, height: 1080 },
    transition: "cut",
  };
}

function manifestFixture(): RenderManifest {
  return RenderManifestSchema.parse({
    version: 1,
    id: manifestId(sha("manifest-ops-fixture")),
    projectId: "project-1",
    storyRevisionId: "story-1",
    shotPlanRevisionId: "plan-1",
    animaticRevisionId: "animatic-1",
    audioMixRevisionId: null,
    profile: buildRenderProfile({ id: "profile-1", format: "16:9", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null }),
    shots: [shotEntry("shot-rev-1", 24), shotEntry("shot-rev-2", 24), shotEntry("shot-rev-3", 12)],
    audioCues: [],
    captionCues: [{ text: "Opening line", startFrame: 0, endFrame: 12 }],
    inputsHash: sha("manifest-ops-fixture-inputs"),
    createdAt: 1_000,
  });
}

const replacementCaptions = () => [
  { text: "Opening line", startFrame: 0, endFrame: 12 },
  { text: "Second line", startFrame: 12, endFrame: 24 },
];

function shotPin(shotRevisionId: string): ManifestShotRenderPins {
  return {
    shotHash: sha(`pins-shot-${shotRevisionId}`),
    takeInputsHash: sha(`pins-take-${shotRevisionId}`),
    assetSha256: sha(`pins-asset-${shotRevisionId}`),
    assetWidth: 1920,
    assetHeight: 1080,
    actualFrames: 96,
  };
}

const editPins = (): ManifestEditPins => ({
  storyHash: sha("pins-story-1"),
  shotPlanHash: sha("pins-plan-1"),
  animaticHash: sha("pins-animatic-1"),
  audioMixHash: null,
  selectionVersion: 2,
  shots: { "shot-rev-1": shotPin("shot-rev-1"), "shot-rev-2": shotPin("shot-rev-2"), "shot-rev-3": shotPin("shot-rev-3") },
});

const replacementTake = (): ManifestReplacementTake => ({
  takeId: "take-replacement-1",
  takeInputsHash: sha("replacement-take-inputs"),
  assetSha256: sha("replacement-asset-bytes"),
  assetWidth: 1920,
  assetHeight: 1080,
  actualFrames: 96,
});

type ManifestOperation = (manifest: RenderManifest) => ManifestEditResult;

// Every op targets the first or middle shot so target-only change assertions stay independent.
const operations: ReadonlyArray<readonly [string, ManifestOperation]> = [
  ["retimeShot", (manifest) => retimeShot(manifest, "shot-rev-1", 2_000, editPins())],
  ["disableShot", (manifest) => disableShot(manifest, "shot-rev-2", editPins())],
  ["duplicateShot", (manifest) => duplicateShot(manifest, "shot-rev-1", editPins())],
  ["replaceTake", (manifest) => replaceTake(manifest, "shot-rev-2", "asset-replacement", replacementTake(), editPins())],
  ["setCaptions", (manifest) => setCaptions(manifest, replacementCaptions(), editPins())],
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("C10 manifest operations", () => {
  it("every op returns a fresh manifest plus a recomputed sha-256 inputs hash and never mutates its input", () => {
    for (const [name, operation] of operations) {
      const input = deepFreeze(manifestFixture());
      const before = structuredClone(input);
      const result = operation(input);
      expect(result.manifest, name).not.toBe(input);
      expect(Sha256Schema.safeParse(result.inputsHash).success, `${name} must return a sha-256 inputsHash`).toBe(true);
      expect(result.inputsHash, `${name} must recompute, not copy, the inputs hash`).not.toBe(input.inputsHash);
      expect(input, name).toEqual(before);
    }
  });

  it("every op is deterministic across repeated invocations on equal inputs", () => {
    for (const [name, operation] of operations) {
      const first = operation(manifestFixture());
      const second = operation(manifestFixture());
      expect(first.inputsHash, name).toBe(second.inputsHash);
      expect(first.manifest, name).toEqual(second.manifest);
    }
  });

  it("retimeShot changes only the target shot duration and the hash follows the new trim", () => {
    // The render profile freezes 24 fps, so exact millisecond multiples convert exactly: 1000ms -> 24 frames, 2000ms -> 48 frames.
    const oneSecond = retimeShot(manifestFixture(), "shot-rev-1", 1_000, editPins());
    const twoSeconds = retimeShot(manifestFixture(), "shot-rev-1", 2_000, editPins());
    const input = manifestFixture();
    expect(oneSecond.manifest.shots[0].endFrame - oneSecond.manifest.shots[0].startFrame).toBe(24);
    expect(twoSeconds.manifest.shots[0].endFrame - twoSeconds.manifest.shots[0].startFrame).toBe(48);
    expect(twoSeconds.manifest.shots[0].startFrame).toBe(input.shots[0].startFrame);
    expect(twoSeconds.manifest.shots[1]).toEqual(input.shots[1]);
    expect(twoSeconds.manifest.shots[2]).toEqual(input.shots[2]);
    expect(oneSecond.inputsHash).not.toBe(twoSeconds.inputsHash);
  });

  it("disableShot flags reversible metadata on the target shot without removing or altering other shots", () => {
    const input = manifestFixture();
    const result = disableShot(deepFreeze(input), "shot-rev-2", editPins());
    expect(result.manifest.shots).toHaveLength(3);
    const disabled = result.manifest.shots[1];
    expect(disabled).not.toEqual(input.shots[1]);
    expect(disabled).toMatchObject({ ...input.shots[1], disabled: true });
    expect(result.manifest.shots[0]).toEqual(input.shots[0]);
    expect(result.manifest.shots[2]).toEqual(input.shots[2]);
  });

  it("duplicateShot inserts a copy with a new unique id immediately after its source", () => {
    const input = manifestFixture();
    const result = duplicateShot(deepFreeze(input), "shot-rev-1", editPins());
    expect(result.manifest.shots).toHaveLength(4);
    const copy = result.manifest.shots[1];
    expect(copy.shotRevisionId).not.toBe("shot-rev-1");
    expect(IdSchema.safeParse(copy.shotRevisionId).success).toBe(true);
    const ids = result.manifest.shots.map((entry) => entry.shotRevisionId);
    expect(new Set(ids).size).toBe(ids.length);
    const { shotRevisionId: _sourceId, ...sourceRest } = input.shots[0];
    expect(copy).toMatchObject(sourceRest);
    expect(result.manifest.shots[0]).toEqual(input.shots[0]);
    expect(result.manifest.shots[2]).toEqual(input.shots[1]);
    expect(result.manifest.shots[3]).toEqual(input.shots[2]);
  });

  it("replaceTake swaps the target shot's take and asset id and leaves every other shot untouched", () => {
    const input = manifestFixture();
    const result = replaceTake(deepFreeze(input), "shot-rev-2", "asset-replacement", replacementTake(), editPins());
    expect(result.manifest.shots[1].assetId).toBe("asset-replacement");
    expect(result.manifest.shots[1].takeId).toBe(replacementTake().takeId);
    const { assetId: _swapped, takeId: _retaken, ...unchanged } = input.shots[1];
    expect(result.manifest.shots[1]).toMatchObject(unchanged);
    expect(result.manifest.shots[0]).toEqual(input.shots[0]);
    expect(result.manifest.shots[2]).toEqual(input.shots[2]);
  });

  it("setCaptions replaces the caption list and leaves the shot list untouched", () => {
    const input = manifestFixture();
    const result = setCaptions(deepFreeze(input), replacementCaptions(), editPins());
    expect(result.manifest.captionCues).toEqual(replacementCaptions());
    expect(result.manifest.shots).toEqual(input.shots);
  });
});

// Error-contract coverage (extension): every op fails closed with a coded
// ProductionApplicationError, never mutates its input, and says why.
describe("C10 manifest operations error contracts", () => {
  function expectInvalidInput(run: () => unknown, messagePattern: RegExp): ProductionApplicationError {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught, `expected an INVALID_INPUT failure matching ${messagePattern}`).toBeInstanceOf(ProductionApplicationError);
    const error = caught as ProductionApplicationError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toMatch(messagePattern);
    return error;
  }

  it("retimeShot rejects durations that do not map to whole frames at the manifest frame rate", () => {
    // 24 fps freezes the frame quantum: 1100ms * 24 = 26400 frame-millis, not a multiple of 1000.
    const input = manifestFixture();
    const before = structuredClone(input);
    expectInvalidInput(() => retimeShot(input, "shot-rev-1", 1_100, editPins()), /does not map to whole frames at 24 fps/);
    expect(input, "a failed edit must not mutate its input").toEqual(before);
  });

  it("retimeShot rejects durations whose new out-point leaves the shot's pinned source frames", () => {
    // Pinned source is 96 frames: 5000ms at 24 fps would move the out-point to frame 120.
    expectInvalidInput(() => retimeShot(manifestFixture(), "shot-rev-1", 5_000, editPins()), /inside its 96-frame source/);
  });

  it("retimeShot rejects non-positive and non-integer durations", () => {
    expectInvalidInput(() => retimeShot(manifestFixture(), "shot-rev-1", 0, editPins()), /positive safe integer/);
    expectInvalidInput(() => retimeShot(manifestFixture(), "shot-rev-1", -500, editPins()), /positive safe integer/);
  });

  it("disableShot refuses to disable the last enabled shot and keeps earlier disables intact", () => {
    const first = disableShot(manifestFixture(), "shot-rev-1", editPins());
    const second = disableShot(first.manifest, "shot-rev-2", editPins());
    expect(second.manifest.shots.filter((shot) => shot.disabled === true).map((shot) => shot.shotRevisionId))
      .toEqual(["shot-rev-1", "shot-rev-2"]);
    expectInvalidInput(() => disableShot(second.manifest, "shot-rev-3", editPins()), /at least one enabled shot/);
  });

  it("duplicateShot allocates the next free copy ordinal past collisions and rejects ids that overflow the id bound", () => {
    const once = duplicateShot(manifestFixture(), "shot-rev-1", editPins());
    // The copy is now an enabled shot, so the caller's pins must cover it with the source's media facts.
    const pinsWithCopy = { ...editPins(), shots: { ...editPins().shots, "shot-rev-1-copy-1": shotPin("shot-rev-1") } };
    const twice = duplicateShot(once.manifest, "shot-rev-1", pinsWithCopy);
    // Each copy lands immediately after its source, so the newest copy precedes the older one.
    expect(twice.manifest.shots.map((shot) => shot.shotRevisionId)).toEqual([
      "shot-rev-1", "shot-rev-1-copy-2", "shot-rev-1-copy-1", "shot-rev-2", "shot-rev-3",
    ]);
    // A 195-character shot id is legal, but "<id>-copy-1" would exceed the 200-character id cap.
    const longId = "a".repeat(195);
    const crowded = RenderManifestSchema.parse({
      ...manifestFixture(),
      shots: [{ ...shotEntry(longId, 24), takeId: "take-long", assetId: "asset-long" }],
    });
    expect(IdSchema.safeParse(longId).success).toBe(true);
    expectInvalidInput(() => duplicateShot(crowded, longId, editPins()), /produces the invalid shot id .*-copy-1/);
  });

  it("replaceTake rejects a shot id that is not in the manifest", () => {
    const input = manifestFixture();
    expectInvalidInput(
      () => replaceTake(input, "shot-rev-missing", "asset-replacement", replacementTake(), editPins()),
      /replace the take of: shot shot-rev-missing is not in this manifest/,
    );
    expect(input.shots).toHaveLength(3);
    expect(input.shots[1].assetId).toBe("asset-shot-rev-2");
  });

  it("setCaptions rejects cues ending past the compiled timeline and cues violating the frozen shape", () => {
    // The fixture compiles to 24 + 24 + 12 = 60 frames; a caption ending at 61 overruns it.
    expectInvalidInput(() => setCaptions(manifestFixture(), [{ text: "Too late", startFrame: 0, endFrame: 61 }], editPins()), /past the 60-frame timeline/);
    expectInvalidInput(() => setCaptions(manifestFixture(), [{ text: "", startFrame: 0, endFrame: 12 }], editPins()), /Caption 0 is invalid/);
  });

  it("shot-targeting ops reject ids that are not in the manifest", () => {
    expectInvalidInput(() => retimeShot(manifestFixture(), "shot-rev-missing", 1_000, editPins()), /shot shot-rev-missing is not in this manifest/);
    expectInvalidInput(() => disableShot(manifestFixture(), "shot-rev-missing", editPins()), /shot shot-rev-missing is not in this manifest/);
    expectInvalidInput(() => duplicateShot(manifestFixture(), "shot-rev-missing", editPins()), /shot shot-rev-missing is not in this manifest/);
  });
});
