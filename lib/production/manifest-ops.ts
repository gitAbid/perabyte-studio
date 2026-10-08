import { z } from "zod";
import { IdSchema, ManifestShotSchema, RenderManifestSchema, Sha256Schema, type RenderManifest } from "./contracts";
import { ProductionApplicationError, type ProductionErrorCode } from "./errors";
import {
  MANIFEST_MASTERING_RECIPE_VERSION,
  MANIFEST_SAMPLES_PER_FRAME,
  compileManifestTimeline,
  manifestInputsHash,
  validateAudioExactness,
  type ManifestCompileModel,
  type ManifestShot,
  type ManifestShotSource,
} from "./manifest";

/**
 * Deterministic manifest edit operations (CONTRACTS-FROZEN C10, spec 02 §10, spec 13).
 *
 * Pure functions over a `RenderManifest`: every operation validates the manifest, applies one
 * edit to a fresh copy (the input is never mutated), revalidates the full compile invariants
 * (legal trims against the pinned source media, crop fit, final cut, positive timeline, audio
 * exactness, caption bounds) and recompiles `inputsHash` via the existing `manifestInputsHash`,
 * returning `{ manifest, inputsHash }`. No feature-local frame-level NLE behavior lives here —
 * the frozen timeline arithmetic stays in `manifest.ts`.
 *
 * `manifestInputsHash` pins revision content hashes and per-shot source media facts that a
 * stored manifest does not carry, so callers pass them once as {@link ManifestEditPins} (the
 * same pins the compile service used); `replaceTake` supplies the replacement take's media
 * facts as {@link ManifestReplacementTake}. Every operation is then deterministic: equal
 * inputs produce equal manifests and equal hashes.
 *
 * `disabled` is reversible metadata on the shot entry (CONTRACTS-FROZEN C10): a disabled shot
 * stays in `manifest.shots` with all its trim and take metadata and contributes zero frames
 * to the compiled timeline, audio bound and hash until re-enabled. `setCaptions` follows the
 * v1 mastering recipe: caption cues are stored on the manifest but the frozen hash recipe
 * pins `captionCues` to `[]`, so caption edits do not move `inputsHash` until that recipe
 * version bumps.
 */
export type EditableManifestShot = ManifestShot & { disabled?: boolean };
export type EditableRenderManifest = Omit<RenderManifest, "shots"> & { shots: EditableManifestShot[] };
export type ManifestCaptionCue = RenderManifest["captionCues"][number];
export type ManifestEditResult = { manifest: EditableRenderManifest; inputsHash: string };

/** Per-shot pinned source media facts required to revalidate and rehash the manifest. */
export interface ManifestShotRenderPins {
  readonly shotHash: string;
  readonly takeInputsHash: string;
  readonly assetSha256: string;
  readonly assetWidth: number;
  readonly assetHeight: number;
  readonly actualFrames: number;
}

/** Compile-level pinned inputs (revision content hashes and selection version) for manifest edit operations. */
export interface ManifestEditPins {
  readonly storyHash: string;
  readonly shotPlanHash: string;
  readonly animaticHash: string;
  readonly audioMixHash: string | null;
  readonly selectionVersion: number;
  readonly shots: Readonly<Record<string, ManifestShotRenderPins>>;
}

/** A replacement take's media facts for `replaceTake` (the shot revision, and therefore its `shotHash`, is unchanged). */
export interface ManifestReplacementTake {
  readonly takeId: string;
  readonly takeInputsHash: string;
  readonly assetSha256: string;
  readonly assetWidth: number;
  readonly assetHeight: number;
  readonly actualFrames: number;
}

// Standard (stripping) object over the frozen base shape: `shots` is validated separately so
// the optional `disabled` metadata can ride along on shot entries without schema churn.
const RenderManifestBaseSchema = z.object(RenderManifestSchema.omit({ shots: true }).shape);
const CaptionCueSchema = RenderManifestSchema.shape.captionCues.element;

function fail(code: ProductionErrorCode, message: string): never {
  throw new ProductionApplicationError(code, message);
}

function positiveInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_INPUT", `${label} must be a positive safe integer, received ${String(value)}.`);
}

function parseManifestInput(manifest: EditableRenderManifest): { base: Omit<RenderManifest, "shots">; shots: EditableManifestShot[] } {
  const parsedBase = RenderManifestBaseSchema.safeParse(manifest);
  if (!parsedBase.success) {
    const issue = parsedBase.error.issues[0];
    fail("INVALID_INPUT", `Manifest does not match the frozen RenderManifest shape at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`);
  }
  if (!Array.isArray(manifest.shots) || manifest.shots.length < 1 || manifest.shots.length > 10_000) {
    fail("INVALID_INPUT", "Manifest edits require a shots array of 1 to 10000 entries.");
  }
  const shots: EditableManifestShot[] = [];
  for (const [index, entry] of manifest.shots.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("INVALID_INPUT", `Manifest shot ${index} must be a shot object.`);
    const { disabled, ...fields } = entry as EditableManifestShot;
    const parsed = ManifestShotSchema.safeParse(fields);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail("INVALID_INPUT", `Manifest shot ${index} does not match the frozen ManifestShot shape at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`);
    }
    shots.push(disabled === undefined ? parsed.data : { ...parsed.data, disabled });
  }
  return { base: parsedBase.data, shots };
}

function validateEditPins(pins: ManifestEditPins): void {
  if (!pins || typeof pins !== "object") fail("INVALID_INPUT", "Manifest edits require the pinned compile inputs.");
  for (const [label, value] of [["storyHash", pins.storyHash], ["shotPlanHash", pins.shotPlanHash], ["animaticHash", pins.animaticHash]] as const) {
    if (!Sha256Schema.safeParse(value).success) fail("INVALID_INPUT", `Manifest edit pins require a valid sha256 ${label}, received ${String(value)}.`);
  }
  if (pins.audioMixHash !== null && !Sha256Schema.safeParse(pins.audioMixHash).success) {
    fail("INVALID_INPUT", `Manifest edit pins require a valid sha256 audioMixHash or null, received ${String(pins.audioMixHash)}.`);
  }
  if (!Number.isSafeInteger(pins.selectionVersion) || pins.selectionVersion < 0) {
    fail("INVALID_INPUT", `Manifest edit pins require a nonnegative safe integer selectionVersion, received ${String(pins.selectionVersion)}.`);
  }
}

function requiredShotPin(pins: ManifestEditPins, shotRevisionId: string): ManifestShotRenderPins {
  const pin = pins.shots ? pins.shots[shotRevisionId] : undefined;
  if (!pin) fail("INVALID_INPUT", `Manifest edits require pinned render inputs for shot revision ${shotRevisionId}.`);
  for (const [label, value] of [["shotHash", pin.shotHash], ["takeInputsHash", pin.takeInputsHash], ["assetSha256", pin.assetSha256]] as const) {
    if (!Sha256Schema.safeParse(value).success) fail("INVALID_INPUT", `Pinned render inputs for shot revision ${shotRevisionId} require a valid sha256 ${label}, received ${String(value)}.`);
  }
  positiveInt(pin.assetWidth, `Pinned assetWidth for shot revision ${shotRevisionId}`);
  positiveInt(pin.assetHeight, `Pinned assetHeight for shot revision ${shotRevisionId}`);
  positiveInt(pin.actualFrames, `Pinned actualFrames for shot revision ${shotRevisionId}`);
  return pin;
}

function requireManifestShot(shots: readonly EditableManifestShot[], shotId: string, action: string): number {
  const index = shots.findIndex((shot) => shot.shotRevisionId === shotId);
  if (index === -1) fail("INVALID_INPUT", `Cannot ${action}: shot ${shotId} is not in this manifest.`);
  return index;
}

/**
 * Revalidates and rehashes the manifest after an edit: normalizes the effective final enabled
 * shot to a cut, rebuilds the pinned compile model for the enabled shots, revalidates the
 * timeline, audio exactness and caption bounds, then recomputes `inputsHash` via
 * `manifestInputsHash`. The returned manifest is a fresh copy (id, version and createdAt are
 * preserved; identity assignment is the persistence layer's decision).
 */
function finalizeEdit(
  base: Omit<RenderManifest, "shots">,
  shots: readonly EditableManifestShot[],
  pins: ManifestEditPins,
  overrides: ReadonlyMap<string, ManifestShotRenderPins>,
): ManifestEditResult {
  const enabled = shots.filter((shot) => shot.disabled !== true);
  if (enabled.length === 0) fail("INVALID_INPUT", "A manifest must keep at least one enabled shot; disabling every shot leaves no renderable timeline.");
  const last = enabled[enabled.length - 1];
  if (last.transition !== "cut") last.transition = "cut";

  const sources: ManifestShotSource[] = enabled.map((shot) => {
    const pin = overrides.get(shot.shotRevisionId) ?? requiredShotPin(pins, shot.shotRevisionId);
    return {
      shotRevisionId: shot.shotRevisionId,
      shotHash: pin.shotHash,
      takeId: shot.takeId,
      takeInputsHash: pin.takeInputsHash,
      assetId: shot.assetId,
      assetSha256: pin.assetSha256,
      assetWidth: pin.assetWidth,
      assetHeight: pin.assetHeight,
      actualFrames: pin.actualFrames,
      startFrame: shot.startFrame,
      endFrame: shot.endFrame,
      crop: shot.crop,
      transition: shot.transition,
    };
  });

  const totalFrames = compileManifestTimeline(sources);
  validateAudioExactness(totalFrames, base.audioCues);
  for (const [index, caption] of base.captionCues.entries()) {
    if (caption.endFrame > totalFrames) {
      fail("INVALID_INPUT", `Caption ${index} ends at frame ${caption.endFrame}, past the ${totalFrames}-frame timeline produced by this edit.`);
    }
  }

  const model: ManifestCompileModel = {
    projectId: base.projectId,
    storyRevisionId: base.storyRevisionId,
    storyHash: pins.storyHash,
    shotPlanRevisionId: base.shotPlanRevisionId,
    shotPlanHash: pins.shotPlanHash,
    animaticRevisionId: base.animaticRevisionId,
    animaticHash: pins.animaticHash,
    audioMixRevisionId: base.audioMixRevisionId,
    audioMixHash: pins.audioMixHash,
    profile: base.profile,
    shots: sources,
    audioCues: base.audioCues,
    captionCues: [],
    totalFrames,
    totalAudioSamples: totalFrames * MANIFEST_SAMPLES_PER_FRAME,
    selectionVersion: pins.selectionVersion,
    masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
  };
  const inputsHash = manifestInputsHash(model);
  return { manifest: { ...base, shots: [...shots], inputsHash }, inputsHash };
}

/**
 * Retimes one manifest shot to `newDurationMs`: the trim in-point (`startFrame`) is kept and
 * the out-point moves to exactly `startFrame + newDurationMs * profile.fps / 1000` frames.
 * The duration must map to whole frames at the manifest's frame rate, and the new out-point
 * must stay inside the shot's pinned source frames.
 */
export function retimeShot(manifest: EditableRenderManifest, shotId: string, newDurationMs: number, pins: ManifestEditPins): ManifestEditResult {
  const { base, shots } = parseManifestInput(manifest);
  validateEditPins(pins);
  const index = requireManifestShot(shots, shotId, "retime");
  const fps = base.profile.fps;
  if (!Number.isSafeInteger(newDurationMs) || newDurationMs <= 0) {
    fail("INVALID_INPUT", `Retime duration must be a positive safe integer of milliseconds, received ${String(newDurationMs)}.`);
  }
  const scaled = newDurationMs * fps;
  if (!Number.isSafeInteger(scaled) || scaled % 1000 !== 0) {
    fail("INVALID_INPUT", `Retime duration ${String(newDurationMs)}ms does not map to whole frames at ${fps} fps; choose a multiple of ${1000 / fps}ms.`);
  }
  const shot = shots[index];
  shots[index] = { ...shot, endFrame: shot.startFrame + scaled / 1000 };
  return finalizeEdit(base, shots, pins, new Map());
}

/**
 * Marks one manifest shot disabled: reversible metadata, not deletion. The shot keeps its
 * trim, take and transition metadata (including a `disabled` flag to clear later) and
 * contributes zero frames to the compiled timeline, audio bound and hash.
 */
export function disableShot(manifest: EditableRenderManifest, shotId: string, pins: ManifestEditPins): ManifestEditResult {
  const { base, shots } = parseManifestInput(manifest);
  validateEditPins(pins);
  const index = requireManifestShot(shots, shotId, "disable");
  shots[index] = { ...shots[index], disabled: true };
  return finalizeEdit(base, shots, pins, new Map());
}

/**
 * Duplicates one manifest shot in place: a fresh shot entry (new deterministic id
 * `<shotId>-copy-<n>` with the smallest free n) is inserted immediately after its source,
 * copying the source's take, trim, crop, transition and disabled metadata, and reusing the
 * source's pinned render inputs for revalidation and hashing.
 */
export function duplicateShot(manifest: EditableRenderManifest, shotId: string, pins: ManifestEditPins): ManifestEditResult {
  const { base, shots } = parseManifestInput(manifest);
  validateEditPins(pins);
  const index = requireManifestShot(shots, shotId, "duplicate");
  const existing = new Set(shots.map((shot) => shot.shotRevisionId));
  let ordinal = 1;
  let duplicateId = `${shotId}-copy-${ordinal}`;
  while (existing.has(duplicateId)) {
    ordinal += 1;
    duplicateId = `${shotId}-copy-${ordinal}`;
  }
  if (!IdSchema.safeParse(duplicateId).success) {
    fail("INVALID_INPUT", `Duplicating shot ${shotId} produces the invalid shot id ${duplicateId}; shot ids are capped at 200 characters.`);
  }
  const source = shots[index];
  shots.splice(index + 1, 0, { ...source, shotRevisionId: duplicateId });
  return finalizeEdit(base, shots, pins, new Map([[duplicateId, requiredShotPin(pins, shotId)]]));
}

/**
 * Replaces the selected take of one manifest shot: the shot entry now points at
 * `replacementTake.takeId` rendering `newAssetId`. The replacement media must fit the shot's
 * existing trim and crop (validated against the replacement's pinned source frames and
 * dimensions) and the manifest is rehashed with the replacement take's pinned media facts.
 */
export function replaceTake(
  manifest: EditableRenderManifest,
  shotId: string,
  newAssetId: string,
  replacementTake: ManifestReplacementTake,
  pins: ManifestEditPins,
): ManifestEditResult {
  const { base, shots } = parseManifestInput(manifest);
  validateEditPins(pins);
  const index = requireManifestShot(shots, shotId, "replace the take of");
  if (!IdSchema.safeParse(newAssetId).success) fail("INVALID_INPUT", `replaceTake requires a valid asset id, received ${String(newAssetId)}.`);
  if (!replacementTake || typeof replacementTake !== "object") fail("INVALID_INPUT", `Replacing the take of shot ${shotId} requires the replacement take's pinned media facts.`);
  if (!IdSchema.safeParse(replacementTake.takeId).success) fail("INVALID_INPUT", `Replacement take requires a valid takeId, received ${String(replacementTake.takeId)}.`);
  for (const [label, value] of [["takeInputsHash", replacementTake.takeInputsHash], ["assetSha256", replacementTake.assetSha256]] as const) {
    if (!Sha256Schema.safeParse(value).success) fail("INVALID_INPUT", `Replacement take requires a valid sha256 ${label}, received ${String(value)}.`);
  }
  positiveInt(replacementTake.assetWidth, "Replacement take assetWidth");
  positiveInt(replacementTake.assetHeight, "Replacement take assetHeight");
  positiveInt(replacementTake.actualFrames, "Replacement take actualFrames");
  const shot = shots[index];
  shots[index] = { ...shot, takeId: replacementTake.takeId, assetId: newAssetId };
  const overrides = new Map([[shotId, { shotHash: requiredShotPin(pins, shotId).shotHash, ...replacementTake }]]);
  return finalizeEdit(base, shots, pins, overrides);
}

/**
 * Replaces the manifest's caption cues wholesale. Each cue is validated against the frozen
 * caption shape and every cue must end at or before the compiled timeline. Captions are
 * overlay metadata in the v1 mastering recipe: they are stored on the manifest but do not
 * move `inputsHash` (the frozen hash recipe pins `captionCues` to `[]`).
 */
export function setCaptions(manifest: EditableRenderManifest, captions: ReadonlyArray<ManifestCaptionCue>, pins: ManifestEditPins): ManifestEditResult {
  const { base, shots } = parseManifestInput(manifest);
  validateEditPins(pins);
  if (!Array.isArray(captions)) fail("INVALID_INPUT", "setCaptions requires an array of caption cues.");
  const parsedCaptions: ManifestCaptionCue[] = [];
  for (const [index, caption] of captions.entries()) {
    const parsed = CaptionCueSchema.safeParse(caption);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail("INVALID_INPUT", `Caption ${index} is invalid at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`);
    }
    parsedCaptions.push(parsed.data);
  }
  return finalizeEdit({ ...base, captionCues: parsedCaptions }, shots, pins, new Map());
}
