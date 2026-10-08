import { createHash } from "node:crypto";
import {
  AssetSchema, AudioMixRevisionSchema, IdSchema, ImportAssetMetadataSchema, ImportProvenanceSchema,
  SaveAudioMixCommandSchema, type Asset, type AudioMixRevision, type SaveAudioMixCommand,
} from "../../production/contracts";
import {
  AudioProbeError, DEFAULT_AUDIO_OVERLAP_POLICY, MAX_IMPORT_AUDIO_BYTES, audioAssetId, audioMixContentHash,
  audioMixRevisionId, buildAudioCue, narrationAlignmentIssues, probeAudioBytes, validateCueOverlaps,
  type AudioOverlapPolicy,
} from "../../production/audio";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { withProductionStore } from "../../production/runtime";
import type { VaultStoredMedia } from "../../media/production/vault";
import type { ProductionStore } from "../../repositories/production/ports";

export interface AudioServiceOptions { now?: () => number; overlapPolicy?: AudioOverlapPolicy }
type StatusedError = ProductionApplicationError & { status?: number };

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }
function parsedClock(options: { now?: () => number }): number {
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_INPUT", "Clock must return a nonnegative safe integer timestamp");
  return now;
}
function probeFailure(error: AudioProbeError): StatusedError {
  const mapped: StatusedError = new ProductionApplicationError("INVALID_INPUT", error.message, { details: { reason: `audio_${error.reason}` } });
  if (error.reason === "oversize") mapped.status = 413;
  return mapped;
}

export interface AudioMixSaveResult { revision: AudioMixRevision; created: boolean; active: boolean }

/**
 * Saves an immutable audio mix revision bound to the exact current story revision and selects it
 * with a compare-and-set. Identical inputs resolve to the same content-derived revision ID, so
 * retries never duplicate cues or revisions. Every validation happens before any write.
 */
export function saveAudioMix(store: ProductionStore, rawCommand: SaveAudioMixCommand, options: AudioServiceOptions = {}): AudioMixSaveResult {
  const parsedCommand = SaveAudioMixCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) fail("INVALID_INPUT", `Invalid audio mix command: ${parsedCommand.error.issues.map((issue) => issue.message).join("; ")}`);
  const command = parsedCommand.data;
  const now = parsedClock(options);
  const overlapPolicy = options.overlapPolicy ?? DEFAULT_AUDIO_OVERLAP_POLICY;
  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId);
    if (!project) fail("UNKNOWN_REFERENCE", "Project not found");
    const story = tx.getStoryRevision(command.expectedStoryRevisionId);
    if (!story || story.projectId !== project.id) fail("UNKNOWN_REFERENCE", "Story revision not found");
    if (project.activeStoryRevisionId !== command.expectedStoryRevisionId) {
      fail("STALE_REVISION", "The script changed; audio cues must be bound to the current story revision");
    }
    const assets = new Map<string, Asset>();
    for (const cue of command.cues) {
      if (assets.has(cue.assetId)) continue;
      const asset = tx.getAsset(cue.assetId);
      if (!asset) fail("UNKNOWN_REFERENCE", `Audio cue references unknown asset ${cue.assetId}`);
      if (!asset.mime.startsWith("audio/")) fail("INVALID_INPUT", `Asset ${cue.assetId} is not audio media`);
      if (asset.audioSamples === null) fail("INVALID_INPUT", `Asset ${cue.assetId} has no decoded audio sample count; import it through the audio importer`);
      assets.set(asset.id, asset);
    }
    const cues = command.cues.map((cue, ordinal) => buildAudioCue({ ...cue, assetAudioSamples: assets.get(cue.assetId)!.audioSamples! }, ordinal));
    const alignment = narrationAlignmentIssues({ storyRevisionId: story.id, cues }, story);
    if (alignment.length > 0) fail("INVALID_INPUT", `Narration alignment issues: ${alignment.map((issue) => issue.message).join("; ")}`);
    validateCueOverlaps(cues, overlapPolicy);
    const assetChecksums: Record<string, string> = {};
    for (const asset of assets.values()) assetChecksums[asset.id] = asset.sha256;
    const contentHash = audioMixContentHash({ projectId: project.id, storyRevisionId: story.id, mixSettings: command.mixSettings, overlapPolicy, cues, assetChecksums });
    const revisionId = audioMixRevisionId(contentHash);
    const existing = tx.getAudioMixRevision(revisionId);
    if (existing) {
      if (project.activeAudioMixRevisionId !== revisionId &&
          !tx.compareAndSetAudioMix(project.id, revisionId, command.expectedAudioVersion)) {
        fail("STALE_REVISION", "The audio mix changed concurrently; reload the project and retry");
      }
      return { revision: existing, created: false, active: true };
    }
    const revision = AudioMixRevisionSchema.parse({ version: 1, id: revisionId, projectId: project.id, storyRevisionId: story.id, cues, mixSettings: command.mixSettings, contentHash, createdAt: now });
    tx.insertAudioMixRevision(revision);
    if (!tx.compareAndSetAudioMix(project.id, revisionId, command.expectedAudioVersion)) {
      fail("STALE_REVISION", "The audio mix changed concurrently; reload the project and retry");
    }
    return { revision, created: true, active: true };
  });
}

export interface ImportAudioAssetCommand {
  bytes: Uint8Array;
  source: string;
  rightsAttestation: string;
  rightsStatus: Asset["rightsStatus"];
  actorId?: string;
}
export interface AudioImportOptions {
  now?: () => number;
  maxProbeBytes?: number;
  putMedia: (bytes: Uint8Array, options: { mime: string; sourceKind: Asset["sourceKind"]; rightsStatus: Asset["rightsStatus"]; maxBytes: number }) => Promise<VaultStoredMedia>;
}

/**
 * Imports local narration/music/SFX bytes as a durable uploaded asset with retained rights
 * provenance. Bytes are strictly header-validated before any storage or database write, and the
 * resulting asset ID is content-derived so retries do not duplicate records. No generation
 * provider is involved.
 */
export async function importAudioAsset(store: ProductionStore, command: ImportAudioAssetCommand, options: AudioImportOptions): Promise<{ asset: Asset; created: boolean }> {
  const now = parsedClock(options);
  let probe: ReturnType<typeof probeAudioBytes>;
  try {
    probe = probeAudioBytes(command.bytes, { maxBytes: options.maxProbeBytes ?? MAX_IMPORT_AUDIO_BYTES });
  } catch (error) {
    if (error instanceof AudioProbeError) throw probeFailure(error);
    throw error;
  }
  const metadata = ImportAssetMetadataSchema.safeParse({ kind: "audio", mime: probe.mime, byteSize: command.bytes.byteLength, source: command.source, rightsAttestation: command.rightsAttestation });
  if (!metadata.success) fail("INVALID_INPUT", `Invalid audio import metadata: ${metadata.error.issues.map((issue) => issue.message).join("; ")}`);
  if (!["creator_attested", "licensed", "public_domain"].includes(command.rightsStatus)) {
    fail("INVALID_INPUT", "Audio import requires creator-attested, licensed, or public-domain rights");
  }
  const provenance = ImportProvenanceSchema.parse({ source: command.source, rightsAttestation: command.rightsAttestation, actorId: command.actorId ?? "local_creator", createdAt: now });
  let media: VaultStoredMedia;
  try {
    media = await options.putMedia(command.bytes, { mime: probe.mime, sourceKind: "upload", rightsStatus: command.rightsStatus, maxBytes: MAX_IMPORT_AUDIO_BYTES });
  } catch (error) {
    throw new ProductionApplicationError("MEDIA_UNAVAILABLE", `Audio media could not be stored: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const digest = createHash("sha256").update(command.bytes).digest("hex");
  if (media.asset.sha256 !== digest) fail("MEDIA_UNAVAILABLE", "Stored audio bytes do not match the imported checksum");
  const asset = AssetSchema.parse({
    ...media.asset,
    id: audioAssetId(digest),
    mime: probe.mime,
    byteSize: command.bytes.byteLength,
    audioSamples: probe.audioSamples,
    rightsStatus: command.rightsStatus,
    importProvenance: provenance,
  });
  return store.transaction((tx) => {
    const existing = tx.getAsset(asset.id);
    if (existing) return { asset: existing, created: false };
    tx.insertAsset({ asset, verifiedAt: now, checksumVerified: true });
    return { asset, created: true };
  });
}

export interface AudioRouteHandlerOptions {
  withStore?: <T>(work: (store: ProductionStore) => T | Promise<T>) => Promise<T>;
  serviceOptions?: AudioServiceOptions;
}

export function createAudioRouteHandlers(options: AudioRouteHandlerOptions = {}) {
  const withStore: NonNullable<AudioRouteHandlerOptions["withStore"]> = options.withStore ?? (work => withProductionStore(store => work(store)));
  return {
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const requestId = getRequestId(request);
      try {
        assertSameOriginMutation(request);
        const { projectId } = await context.params;
        if (!IdSchema.safeParse(projectId).success) fail("INVALID_INPUT", "Invalid project ID");
        const command = await readProductionJson(request, SaveAudioMixCommandSchema);
        if (command.projectId !== projectId) fail("INVALID_INPUT", "Route project ID does not match command project ID");
        const result = await withStore(store => saveAudioMix(store, command, options.serviceOptions));
        return Response.json(result, { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } });
      } catch (error) {
        return productionErrorResponse(error, requestId);
      }
    },
  };
}
