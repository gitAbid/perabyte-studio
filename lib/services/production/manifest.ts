import {
  CreateExportCommandSchema, CreateManifestCommandSchema, ExportSchema, IdSchema, RenderManifestSchema,
  type AudioCue, type CreateExportCommand, type CreateManifestCommand, type ExportRecord,
  type RenderManifest, type StoryRevision,
} from "../../production/contracts";
import { DEFAULT_AUDIO_OVERLAP_POLICY, serializeAudioTimeline } from "../../production/audio";
import { latestMatchingApproval } from "../../production/approval-policy";
import { computeTakeApprovalHash } from "../../production/approval";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { withProductionStore } from "../../production/runtime";
import {
  MANIFEST_MASTERING_RECIPE_VERSION, buildRenderProfile, compileManifestTimeline, manifestId,
  manifestInputsHash, validateAudioExactness,
  type ManifestCompileModel, type ManifestShotSource,
} from "../../production/manifest";
import { shotsCompatibleWithStory } from "../../production/revisions";
import type { ProductionStore } from "../../repositories/production/ports";

export interface ManifestServiceOptions { now?: () => number }
export interface ManifestCompileResult { manifest: RenderManifest; created: boolean }

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }

/**
 * Compiles the render manifest synchronously inside one store transaction: it pins only the exact
 * accepted matching take revisions currently selected for the active shot plan and the approved
 * audio mix, under the current story and animatic approvals. Every validation happens before the
 * single insert, so any failure leaves the store untouched, and identical inputs resolve to the
 * same content-derived manifest id so recompiles are idempotent. No provider, media I/O, or
 * FFmpeg is involved.
 */
export function compileManifest(store: ProductionStore, rawCommand: CreateManifestCommand, options: ManifestServiceOptions = {}): ManifestCompileResult {
  const parsedCommand = CreateManifestCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) fail("INVALID_INPUT", `Invalid manifest command: ${parsedCommand.error.issues.map((issue) => issue.message).join("; ")}`);
  const command = parsedCommand.data;
  if (new Set(command.selectedTakeIds).size !== command.selectedTakeIds.length) fail("INVALID_INPUT", "Manifest command repeats a selected take ID; each selected take must be listed once.");
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_INPUT", "Clock must return a nonnegative safe integer timestamp");
  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId);
    if (!project) fail("UNKNOWN_REFERENCE", `Project ${command.projectId} not found`);
    if (command.profileId !== project.profileId) fail("STALE_REVISION", `Command profile ${command.profileId} does not match the project profile ${project.profileId}; reload the project and retry.`);
    if (!project.activeStoryRevisionId) fail("STALE_REVISION", `Project ${project.id} has no active story revision to compile.`);
    const story = tx.getStoryRevision(project.activeStoryRevisionId);
    if (!story || story.projectId !== project.id) fail("STALE_REVISION", `Active story revision ${project.activeStoryRevisionId} is missing or foreign to project ${project.id}.`);
    const plan = tx.getShotPlanRevision(command.shotPlanRevisionId);
    if (!plan || plan.projectId !== project.id || plan.id !== project.activeShotPlanRevisionId) fail("STALE_REVISION", `Shot plan revision ${command.shotPlanRevisionId} is missing, foreign, or not the project's active plan.`);
    const animatic = tx.getAnimaticRevision(command.animaticRevisionId);
    if (!animatic || animatic.projectId !== project.id || animatic.shotPlanRevisionId !== plan.id) fail("STALE_REVISION", `Animatic revision ${command.animaticRevisionId} is missing, foreign, or not bound to shot plan ${plan.id}.`);
    if (plan.storyRevisionId !== story.id) fail("STALE_REVISION", `Shot plan ${plan.id} pins story ${plan.storyRevisionId}, not the active story ${story.id}.`);
    if (command.expectedSelectionVersion !== project.takeSelectionVersion) fail("STALE_REVISION", `Take selection changed: command expects version ${command.expectedSelectionVersion} but the project is at ${project.takeSelectionVersion}; reload and retry.`);
    if (!latestMatchingApproval(tx.listApprovals("story", story.id), "story", story.id, story.contentHash)) fail("APPROVAL_REQUIRED", `Story revision ${story.id} has no current matching approval.`);
    if (!latestMatchingApproval(tx.listApprovals("animatic", animatic.id), "animatic", animatic.id, animatic.contentHash)) fail("APPROVAL_REQUIRED", `Animatic revision ${animatic.id} has no current matching approval.`);

    const selectedTakeIds = new Set(command.selectedTakeIds);
    const selectedByShotId = new Map<string, string>();
    const shots: ManifestShotSource[] = [];
    // Shots compile in plan order, never command order.
    for (const shotRevisionId of plan.orderedShotRevisionIds) {
      const shot = tx.getShotRevision(shotRevisionId);
      if (!shot) fail("STALE_REVISION", `Shot plan ${plan.id} references missing shot revision ${shotRevisionId}.`);
      const selection = tx.getTakeSelection(project.id, shot.shotId);
      if (!selection.takeId || !selectedTakeIds.has(selection.takeId)) {
        fail("STALE_REVISION", `Shot ${shot.shotId} (revision ${shot.id}) has no selected take inside the command's take set; reload selections and retry.`);
      }
      selectedByShotId.set(shot.shotId, selection.takeId);
      const take = tx.getTake(selection.takeId);
      if (!take || take.shotRevisionId !== shot.id) fail("STALE_REVISION", `Selected take ${selection.takeId} for shot revision ${shot.id} is missing or bound to a different shot revision outside the selected plan.`);
      const asset = tx.getAsset(take.assetId);
      if (!asset || !asset.mime.startsWith("video/")) fail("MEDIA_UNAVAILABLE", `Take ${take.id} references missing or non-video asset ${take.assetId}.`);
      if (asset.frames === null || asset.frames !== take.actualFrames) fail("MEDIA_UNAVAILABLE", `Asset ${asset.id} frame count ${String(asset.frames)} does not match the ${take.actualFrames} actual frames of take ${take.id}.`);
      if (asset.width === null || asset.height === null || asset.width <= 0 || asset.height <= 0) fail("MEDIA_UNAVAILABLE", `Asset ${asset.id} behind take ${take.id} has no positive integer source dimensions.`);
      // Take-acceptance policy re-expressed from the domain helpers exactly as proven at
      // lib/services/production/takes.ts:119-124 (captureTakeSelectionCandidate): the take's latest
      // decision set must all be approvals matching its current content hash; a later rejection or
      // any hash drift blocks compilation. takes.ts itself is never imported (layering).
      const takeApprovals = latestMatchingApproval(tx.listApprovals("take", take.id), "take", take.id, computeTakeApprovalHash(tx, take));
      if (!takeApprovals) fail("APPROVAL_REQUIRED", `Take ${take.id} for shot revision ${shot.id} has no current matching approval; the latest decision is missing, drifted, or a rejection.`);
      if (shot.storyRevisionId !== story.id) {
        // Canon-only successor compatibility, walked exactly as proven at takes.ts getSelection
        // (descending lineage bounded at 10_000, project-selected canon, plan-predecessor continuation).
        const origin = tx.getStoryRevision(shot.storyRevisionId);
        if (!origin || origin.projectId !== project.id) fail("STALE_REVISION", `Shot revision ${shot.id} pins missing or foreign story revision ${shot.storyRevisionId}.`);
        const lineage: StoryRevision[] = [];
        let cursor: StoryRevision | null = story;
        while (cursor && lineage.length <= 10_000) { lineage.push(cursor); cursor = cursor.parentRevisionId ? tx.getStoryRevision(cursor.parentRevisionId) : null; }
        const { id: _id, contentHash: _contentHash, createdAt: _createdAt, ...candidate } = shot;
        const continuationIsValid = !shot.continuation || plan.orderedShotRevisionIds[plan.orderedShotRevisionIds.indexOf(shot.id) - 1] === shot.continuation.previousShotRevisionId;
        if (!shotsCompatibleWithStory(shot, origin, story, { projectId: project.id, storyLineage: lineage, selectedCanonRevisions: tx.listCanonRevisions(project.activeCanonRevisionIds), candidate: { ...candidate, storyRevisionId: story.id }, continuationIsValid })) {
          fail("APPROVAL_REQUIRED", `Shot revision ${shot.id} is not compatible with the currently approved story ${story.id} and must be re-approved for the successor story.`);
        }
      }
      // v1 compiler defaults (the command carries no trim/crop/transition fields): trim the accepted
      // take to the approved shot length, full-frame crop, cut transitions. A short take blocks
      // compilation; longer output is trimmed to the approved length, never padded or looped.
      if (take.actualFrames < shot.targetFrames) fail("MEDIA_UNAVAILABLE", `Take ${take.id} for shot revision ${shot.id} has ${take.actualFrames} frames, shorter than the approved ${shot.targetFrames}-frame shot length; padding is never introduced.`);
      shots.push({
        shotRevisionId: shot.id, shotHash: shot.contentHash, takeId: take.id, takeInputsHash: take.inputsHash,
        assetId: asset.id, assetSha256: asset.sha256, assetWidth: asset.width, assetHeight: asset.height,
        actualFrames: take.actualFrames, startFrame: 0, endFrame: shot.targetFrames,
        crop: { x: 0, y: 0, width: asset.width, height: asset.height }, transition: "cut",
      });
    }
    // Exact selection-set equality: the command may neither omit nor substitute current selections.
    if (selectedTakeIds.size !== selectedByShotId.size) {
      fail("STALE_REVISION", `The command's take set does not exactly equal the current selection set of shot plan ${plan.id}; extra or substituted takes are rejected.`);
    }
    const totalFrames = compileManifestTimeline(shots, { expectedTotalFrames: animatic.totalFrames });

    let audioCues: AudioCue[] = [];
    let audioMixHash: string | null = null;
    if (command.audioMixRevisionId !== null) {
      const mix = tx.getAudioMixRevision(command.audioMixRevisionId);
      if (!mix || mix.id !== project.activeAudioMixRevisionId || mix.projectId !== project.id || mix.storyRevisionId !== story.id) {
        fail("STALE_REVISION", `Audio mix ${command.audioMixRevisionId} is missing, not the project's active mix, foreign, or not bound to story ${story.id}.`);
      }
      if (!latestMatchingApproval(tx.listApprovals("audio", mix.id), "audio", mix.id, mix.contentHash)) fail("APPROVAL_REQUIRED", `Audio mix ${mix.id} has no current matching approval.`);
      for (const cue of mix.cues) {
        // AssetSchema enforces the sha256 field, so existence plus a probed sample count is the full media pin.
        const cueAsset = tx.getAsset(cue.assetId);
        if (!cueAsset || cueAsset.audioSamples === null) {
          fail("MEDIA_UNAVAILABLE", `Audio cue ${cue.id} references missing or unprobed asset ${cue.assetId}.`);
        }
      }
      try {
        serializeAudioTimeline(mix, DEFAULT_AUDIO_OVERLAP_POLICY);
      } catch (error) {
        fail("INVALID_INPUT", `Audio mix ${mix.id} violates the ${DEFAULT_AUDIO_OVERLAP_POLICY} overlap policy: ${error instanceof Error ? error.message : "unknown overlap error"}`);
      }
      audioCues = [...mix.cues];
      audioMixHash = mix.contentHash;
    }
    const exactness = validateAudioExactness(totalFrames, audioCues);
    const model: ManifestCompileModel = {
      projectId: project.id, storyRevisionId: story.id, storyHash: story.contentHash,
      shotPlanRevisionId: plan.id, shotPlanHash: plan.contentHash,
      animaticRevisionId: animatic.id, animaticHash: animatic.contentHash,
      audioMixRevisionId: command.audioMixRevisionId, audioMixHash,
      profile: buildRenderProfile(project.profile), shots, audioCues, captionCues: [],
      totalFrames, totalAudioSamples: exactness.totalSamples,
      selectionVersion: project.takeSelectionVersion, masteringRecipeVersion: MANIFEST_MASTERING_RECIPE_VERSION,
    };
    const inputsHash = manifestInputsHash(model);
    const id = manifestId(inputsHash);
    const existing = tx.getManifest(id);
    if (existing) return { manifest: existing, created: false };
    const manifest = RenderManifestSchema.parse({
      version: 1, id, projectId: project.id, storyRevisionId: story.id, shotPlanRevisionId: plan.id,
      animaticRevisionId: animatic.id, audioMixRevisionId: command.audioMixRevisionId, profile: model.profile,
      shots: shots.map(({ shotRevisionId, takeId, assetId, startFrame, endFrame, crop, transition }) => ({ shotRevisionId, takeId, assetId, startFrame, endFrame, crop, transition })),
      audioCues, captionCues: [], inputsHash, createdAt: now,
    });
    tx.insertManifest(manifest);
    return { manifest, created: true };
  });
}

// ---------------------------------------------------------------------------
// C11-FULL remainder: thin route-handler factories and the export command
// service. The compiler above (accepted C11-PRE slice) is behavior-unchanged.
// ---------------------------------------------------------------------------

export interface ManifestRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  serviceOptions?: ManifestServiceOptions;
}
export interface ExportScheduler { trigger(projectId: string): void }
export interface ExportRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  scheduler?: ExportScheduler;
  serviceOptions?: ManifestServiceOptions;
}

/**
 * Manifest route handlers following the audio-route convention: same-origin mutation guard, strict
 * JSON command, route/command project match, one store session, 201 on compile and 200 on replay.
 */
export function createManifestRouteHandlers(options: ManifestRouteHandlerOptions = {}) {
  const withStore: NonNullable<ManifestRouteHandlerOptions["withStore"]> = options.withStore ?? (work => withProductionStore(store => work(store)));
  return {
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const { projectId } = await context.params;
        if (!IdSchema.safeParse(projectId).success) fail("INVALID_INPUT", "Invalid project ID");
        const command = await readProductionJson(request, CreateManifestCommandSchema);
        if (command.projectId !== projectId) fail("INVALID_INPUT", "Route project ID does not match command project ID");
        const result = await withStore(store => compileManifest(store, command, options.serviceOptions));
        return Response.json(result, { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}

export interface ExportCommandResult { exportRecord: ExportRecord; created: boolean; projectId: string }

/**
 * Creates (or replays) the durable export record for a manifest after re-validating the manifest's
 * own pins, so historical manifests stay exportable while their take/audio approvals and media
 * remain live. The export id is content-derived from the idempotency key, making retries return the
 * same record and conflicting reuse fail closed.
 */
export function createExportCommand(store: ProductionStore, rawCommand: CreateExportCommand, options: ManifestServiceOptions = {}): ExportCommandResult {
  const parsedCommand = CreateExportCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) fail("INVALID_INPUT", `Invalid export command: ${parsedCommand.error.issues.map((issue) => issue.message).join("; ")}`);
  const command = parsedCommand.data;
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_INPUT", "Clock must return a nonnegative safe integer timestamp");
  return store.transaction((tx) => {
    const manifest = tx.getManifest(command.manifestId);
    if (!manifest) fail("UNKNOWN_REFERENCE", `Manifest ${command.manifestId} not found`);
    if (manifest.projectId !== command.projectId) fail("STALE_REVISION", `Manifest ${manifest.id} belongs to project ${manifest.projectId}, not ${command.projectId}.`);
    if (manifest.inputsHash !== command.expectedManifestHash) fail("STALE_REVISION", `Manifest ${manifest.id} inputs hash ${manifest.inputsHash} does not match the expected ${command.expectedManifestHash}; reload the manifest and retry.`);
    for (const shot of manifest.shots) {
      const take = tx.getTake(shot.takeId);
      if (!take || take.shotRevisionId !== shot.shotRevisionId) fail("STALE_REVISION", `Shot revision ${shot.shotRevisionId} pins missing take ${shot.takeId}; the manifest's plan no longer matches the selected plan.`);
      const asset = tx.getAsset(take.assetId);
      if (!asset || !asset.mime.startsWith("video/")) fail("MEDIA_UNAVAILABLE", `Take ${take.id} for shot revision ${shot.shotRevisionId} references missing or non-video asset ${take.assetId}.`);
      if (!latestMatchingApproval(tx.listApprovals("take", take.id), "take", take.id, computeTakeApprovalHash(tx, take))) {
        fail("APPROVAL_REQUIRED", `Take ${take.id} for shot revision ${shot.shotRevisionId} has no current matching approval; export requires an accepted take.`);
      }
    }
    if (manifest.audioMixRevisionId !== null) {
      const mix = tx.getAudioMixRevision(manifest.audioMixRevisionId);
      if (!mix) fail("STALE_REVISION", `Manifest ${manifest.id} pins missing audio mix ${manifest.audioMixRevisionId}.`);
      if (!latestMatchingApproval(tx.listApprovals("audio", mix.id), "audio", mix.id, mix.contentHash)) {
        fail("APPROVAL_REQUIRED", `Audio mix ${mix.id} has no current matching approval; export requires accepted audio.`);
      }
      for (const cue of manifest.audioCues) {
        // The manifest's pinned cue list is what assembly renders; each cue asset must still exist
        // with the probed sample count the compiler required.
        const cueAsset = tx.getAsset(cue.assetId);
        if (!cueAsset || cueAsset.audioSamples === null) fail("MEDIA_UNAVAILABLE", `Audio cue ${cue.id} references missing or unprobed asset ${cue.assetId}.`);
      }
    }
    const id = `export-${hashCanonicalJson({ recipe: 1, projectId: command.projectId, idempotencyKey: command.idempotencyKey })}`;
    const existing = tx.getExport(id);
    if (existing) {
      if (existing.manifestId !== command.manifestId) fail("STALE_REVISION", `Idempotency key ${command.idempotencyKey} already produced export ${existing.id} for manifest ${existing.manifestId}; reuse requires the same manifest.`);
      return { exportRecord: existing, created: false, projectId: command.projectId };
    }
    const exportRecord = ExportSchema.parse({ version: 1, id, manifestId: command.manifestId, jobId: null, assetId: null, qcReportId: null, status: "queued", createdAt: now, approvedSha256: null, finalApprovalId: null });
    tx.insertExport(exportRecord);
    return { exportRecord, created: true, projectId: command.projectId };
  });
}

/**
 * Export route handlers following the audio-route convention. Validation order: schema/origin/
 * project match, manifest existence and binding, expected hash, pin re-validation, idempotent
 * record insert; the scheduler trigger is fire-and-forget and never awaited.
 */
export function createExportRouteHandlers(options: ExportRouteHandlerOptions = {}) {
  const withStore: NonNullable<ExportRouteHandlerOptions["withStore"]> = options.withStore ?? (work => withProductionStore(store => work(store)));
  return {
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const { projectId } = await context.params;
        if (!IdSchema.safeParse(projectId).success) fail("INVALID_INPUT", "Invalid project ID");
        const command = await readProductionJson(request, CreateExportCommandSchema);
        if (command.projectId !== projectId) fail("INVALID_INPUT", "Route project ID does not match command project ID");
        const result = await withStore(store => createExportCommand(store, command, options.serviceOptions));
        // Fire-and-forget: the scheduler reclaims stale renders and drains queued exports for the
        // project; it is never awaited by this route and never throws to the caller.
        options.scheduler?.trigger(result.projectId);
        return Response.json(result.exportRecord, { status: result.created ? 202 : 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}
