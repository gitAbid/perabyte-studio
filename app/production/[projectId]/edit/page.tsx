import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { IdSchema, type CanonRevision, type ExportRecord, type RenderManifest } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import type { ProductionStore } from "@/lib/repositories/production/ports";
import {
  disableShot, duplicateShot, retimeShot, replaceTake, setCaptions,
  type ManifestEditPins, type ManifestEditResult, type ManifestReplacementTake, type ManifestShotRenderPins,
} from "@/lib/production/manifest-ops";
import { MANIFEST_CROSSFADE_FRAMES } from "@/lib/production/manifest";
import { resolveProductionDataDir, withProductionStore } from "@/lib/production/runtime";
import {
  baseShotRevisionId, firstCutApplyFailure,
  type FirstCutApplyChangeCommand, type FirstCutApplyResult, type FirstCutManifest, type FirstCutOpInput,
  type FirstCutTakeOption,
} from "@/lib/production/first-cut-view-model";
import { EditView } from "@/components/production/edit/EditView";
import type { EditViewData } from "@/components/production/edit/edit-view-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Advanced edit — PeraByte",
  description: "A track-style view of the production manifest: trim, skip, repeat and take-swap scenes; scene order, retakes and delivery live in their panels.",
};

/* ================================================================== */
/* Server action: apply ONE confirmed change through the frozen C10 ops */
/*                                                                      */
/* This mirrors the /first-cut page action exactly (same ops, same      */
/* pins, same wire contract) because that action is defined inline in   */
/* its page module; mirroring keeps the routes decoupled while both     */
/* surfaces speak the identical FirstCutApplyChangeCommand contract.    */
/* ================================================================== */

function isWellFormedOp(op: unknown): op is FirstCutOpInput {
  if (!op || typeof op !== "object") return false;
  const candidate = op as Record<string, unknown>;
  const isId = (value: unknown): value is string => typeof value === "string" && IdSchema.safeParse(value).success;
  const isCue = (cue: unknown): boolean =>
    !!cue && typeof cue === "object" &&
    typeof (cue as Record<string, unknown>).text === "string" &&
    typeof (cue as Record<string, unknown>).startFrame === "number" &&
    typeof (cue as Record<string, unknown>).endFrame === "number";
  switch (candidate.kind) {
    case "retime":
      return isId(candidate.shotId) && typeof candidate.durationMs === "number" && Number.isSafeInteger(candidate.durationMs) && candidate.durationMs > 0;
    case "disable":
    case "duplicate":
      return isId(candidate.shotId);
    case "replaceTake":
      return isId(candidate.shotId) && isId(candidate.takeId);
    case "setCaptions":
      return Array.isArray(candidate.cues) && candidate.cues.length <= 100_000 && candidate.cues.every(isCue);
    default:
      return false;
  }
}

/**
 * The C10 edit pins, re-derived from local records for the caller's CURRENT working manifest —
 * the same derivation /first-cut uses, including the `-copy-N` chain resolution for duplicates.
 */
function deriveManifestEditPins(store: ProductionStore, projectId: string, manifest: FirstCutManifest): { ok: true; pins: ManifestEditPins } | { ok: false; reason: string } {
  const project = store.read.getProject(projectId);
  if (!project) return { ok: false, reason: "That production no longer exists locally." };
  const story = store.read.getStoryRevision(manifest.storyRevisionId);
  if (!story) return { ok: false, reason: "The story revision this cut was compiled from is missing locally, so edits can't be validated." };
  const plan = store.read.getShotPlanRevision(manifest.shotPlanRevisionId);
  if (!plan) return { ok: false, reason: "The shot plan this cut was compiled from is missing locally, so edits can't be validated." };
  const animatic = store.read.getAnimaticRevision(manifest.animaticRevisionId);
  if (!animatic) return { ok: false, reason: "The animatic this cut was compiled from is missing locally, so edits can't be validated." };
  const mix = manifest.audioMixRevisionId ? store.read.getAudioMixRevision(manifest.audioMixRevisionId) : null;
  if (manifest.audioMixRevisionId && !mix) return { ok: false, reason: "The audio mix this cut was compiled from is missing locally, so edits can't be validated." };

  const resolveShotHash = (shotRevisionId: string): string | null => {
    let cursor = shotRevisionId;
    for (let depth = 0; depth < 8; depth += 1) {
      const revision = store.read.getShotRevision(cursor);
      if (revision) return revision.contentHash;
      const stripped = baseShotRevisionId(cursor);
      if (stripped === cursor) return null;
      cursor = stripped;
    }
    return null;
  };

  const shots: Record<string, ManifestShotRenderPins> = {};
  for (const entry of manifest.shots) {
    const take = store.read.getTake(entry.takeId);
    const asset = store.read.getAsset(entry.assetId);
    const shotHash = resolveShotHash(entry.shotRevisionId);
    if (!take || !asset || asset.width === null || asset.height === null || !shotHash) {
      return { ok: false, reason: `The pinned media facts for shot ${baseShotRevisionId(entry.shotRevisionId)} are incomplete locally, so edits can't be validated.` };
    }
    shots[entry.shotRevisionId] = {
      shotHash,
      takeInputsHash: take.inputsHash,
      assetSha256: asset.sha256,
      assetWidth: asset.width,
      assetHeight: asset.height,
      actualFrames: take.actualFrames,
    };
  }
  return {
    ok: true,
    pins: {
      storyHash: story.contentHash,
      shotPlanHash: plan.contentHash,
      animaticHash: animatic.contentHash,
      audioMixHash: mix ? mix.contentHash : null,
      selectionVersion: project.takeSelectionVersion,
      shots,
    },
  };
}

function applyOneOp(store: ProductionStore, projectId: string, manifest: FirstCutManifest, op: FirstCutOpInput): ManifestEditResult {
  const pins = deriveManifestEditPins(store, projectId, manifest);
  if (!pins.ok) throw new ProductionApplicationError("INVALID_INPUT", pins.reason);
  switch (op.kind) {
    case "retime":
      return retimeShot(manifest, op.shotId, op.durationMs, pins.pins);
    case "disable":
      return disableShot(manifest, op.shotId, pins.pins);
    case "duplicate":
      return duplicateShot(manifest, op.shotId, pins.pins);
    case "replaceTake": {
      const base = baseShotRevisionId(op.shotId);
      const take = store.read.getTake(op.takeId);
      if (!take || take.shotRevisionId !== base) {
        throw new ProductionApplicationError("INVALID_INPUT", "That take doesn't belong to this shot, so it can't be swapped in.");
      }
      const asset = store.read.getAsset(take.assetId);
      if (!asset || asset.width === null || asset.height === null) {
        throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "The replacement take's media is missing locally, so it can't be swapped in.");
      }
      const replacement: ManifestReplacementTake = {
        takeId: take.id,
        takeInputsHash: take.inputsHash,
        assetSha256: asset.sha256,
        assetWidth: asset.width,
        assetHeight: asset.height,
        actualFrames: take.actualFrames,
      };
      return replaceTake(manifest, op.shotId, asset.id, replacement, pins.pins);
    }
    case "setCaptions":
      return setCaptions(manifest, op.cues, pins.pins);
  }
}

/** Writes NOTHING: the confirmed op runs through the frozen C10 pure functions and the fresh working manifest returns as preview state. */
async function applyEditChange(command: FirstCutApplyChangeCommand): Promise<FirstCutApplyResult> {
  "use server";
  try {
    if (!command || typeof command !== "object") return firstCutApplyFailure("INVALID_INPUT", "That change request was malformed.");
    if (!IdSchema.safeParse(command.projectId).success) return firstCutApplyFailure("INVALID_INPUT", "That production link is not valid.");
    const manifest = command.manifest;
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.shots) || manifest.shots.length === 0) {
      return firstCutApplyFailure("INVALID_INPUT", "The working cut is malformed — reload the page and try again.");
    }
    if (!isWellFormedOp(command.op)) return firstCutApplyFailure("INVALID_INPUT", "That change doesn't match any of the five supported edits.");
    const op = command.op;
    return await withProductionStore((store) => {
      try {
        const result = applyOneOp(store, command.projectId, manifest, op);
        return { ok: true, manifest: result.manifest, inputsHash: result.inputsHash } satisfies FirstCutApplyResult;
      } catch (error) {
        if (error instanceof ProductionApplicationError) return firstCutApplyFailure(error.code, error.message);
        throw error;
      }
    });
  } catch {
    return firstCutApplyFailure("INTERNAL_ERROR", "The change could not be applied on the server. Your working cut is unchanged.");
  }
}

/* ================================================================== */
/* Server data loading (read-only store access)                        */
/* ================================================================== */

const truncateLabel = (text: string, max = 48): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const byNewestExport = (left: ExportRecord, right: ExportRecord): number =>
  right.createdAt - left.createdAt || right.id.localeCompare(left.id);

/**
 * Cast names for the NL delivery-direction router, gathered deterministically from canon
 * character revisions: a string `attributes.name` when present, else the name-like head of the
 * description ("Luna — a curious scout" → "Luna"). Only used for intent name matching; the
 * router's capitalized-subject fallback covers casts this cannot resolve.
 */
function collectCharacterNames(store: ProductionStore, manifest: RenderManifest): string[] {
  const names = new Set<string>();
  const consider = (revision: CanonRevision | null): void => {
    if (!revision || revision.entityKind !== "character") return;
    const attributes = revision.attributes && typeof revision.attributes === "object" && !Array.isArray(revision.attributes)
      ? (revision.attributes as Record<string, unknown>)
      : {};
    const attrName = typeof attributes.name === "string" ? attributes.name.trim() : "";
    if (attrName && attrName.length <= 40) {
      names.add(attrName);
      return;
    }
    const head = revision.description.split(/[—–:,]|\s+-\s+/)[0]?.trim() ?? "";
    if (head && head.length <= 40 && /^[\p{L}][\p{L}' -]*$/u.test(head)) names.add(head);
  };
  const story = store.read.getStoryRevision(manifest.storyRevisionId);
  if (story) {
    for (const revision of store.read.listCanonRevisions(story.canonRevisionIds)) consider(revision);
  }
  for (const entry of manifest.shots) {
    const revision = store.read.getShotRevision(baseShotRevisionId(entry.shotRevisionId));
    if (!revision) continue;
    for (const binding of revision.castBindings) consider(store.read.getCanonRevision(binding.canonRevisionId));
  }
  return [...names].slice(0, 24);
}

/**
 * Read-only load of the newest build for one production: everything the timeline and the C10 ops
 * need, derived server-side. Returns "no-project" when the production itself is gone and
 * "no-manifest" when nothing was ever built (the edit surface edits a manifest, it doesn't create one).
 */
async function loadEditData(store: ProductionStore, projectId: string): Promise<EditViewData | "no-project" | "no-manifest"> {
  const project = store.read.getProject(projectId);
  if (!project) return "no-project";

  const exports = [...store.read.listProjectExports(projectId)].sort(byNewestExport);
  let builtManifest: RenderManifest | null = null;
  let chosen: ExportRecord | null = null;
  for (const record of exports) {
    const manifest = store.read.getManifest(record.manifestId);
    if (manifest) {
      builtManifest = manifest;
      chosen = record;
      break;
    }
  }
  if (!builtManifest) return "no-manifest";

  const missingAssetIds: string[] = [];
  const sourceFramesByShot: Record<string, number> = {};
  const shotLabels: Record<string, string> = {};
  const takesByBaseShot: Record<string, FirstCutTakeOption[]> = {};
  let editsAvailable = false;
  let editsUnavailableReason: string | null = null;

  const seenBases = new Set<string>();
  for (const entry of builtManifest.shots) {
    const base = baseShotRevisionId(entry.shotRevisionId);
    if (!store.read.getAsset(entry.assetId)) missingAssetIds.push(entry.assetId);
    sourceFramesByShot[entry.shotRevisionId] = store.read.getTake(entry.takeId)?.actualFrames ?? 0;
    if (!seenBases.has(base)) {
      seenBases.add(base);
      const revision = store.read.getShotRevision(base);
      if (revision) shotLabels[base] = truncateLabel(revision.visualIntent);
      takesByBaseShot[base] = store.read
        .listTakesForShot(base)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map((take, index) => ({ id: take.id, label: `Take ${index + 1} · ${take.actualFrames} frames` }));
    }
  }
  const pins = deriveManifestEditPins(store, projectId, builtManifest);
  if (pins.ok) editsAvailable = true;
  else editsUnavailableReason = pins.reason;

  const plannedShotRevisionIds: string[] = [];
  if (project.activeShotPlanRevisionId) {
    const plan = store.read.getShotPlanRevision(project.activeShotPlanRevisionId);
    if (plan) {
      for (const shotRevisionId of plan.orderedShotRevisionIds) {
        plannedShotRevisionIds.push(shotRevisionId);
        if (!shotLabels[shotRevisionId]) {
          const revision = store.read.getShotRevision(shotRevisionId);
          if (revision) shotLabels[shotRevisionId] = truncateLabel(revision.visualIntent);
        }
      }
    }
  }

  return {
    projectId,
    projectName: project.name,
    builtManifest,
    crossfadeFrames: MANIFEST_CROSSFADE_FRAMES,
    exportRecord: chosen
      ? { id: chosen.id, status: chosen.status, assetId: chosen.assetId, manifestId: chosen.manifestId, createdAt: chosen.createdAt }
      : null,
    missingAssetIds,
    plannedShotRevisionIds,
    shotLabels,
    takesByBaseShot,
    sourceFramesByShot,
    characterNames: collectCharacterNames(store, builtManifest),
    editsAvailable,
    editsUnavailableReason,
  };
}

/* ================================================================== */
/* Route                                                               */
/* ================================================================== */

function NoCutScreen({ projectId }: { projectId: string }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" data-testid="edit.empty">
      <header className="flex flex-col gap-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Advanced Edit</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Advanced edit</h1>
      </header>
      <div className="mt-6">
        <EmptyState
          icon="layers"
          title="No cut to edit yet"
          body="The advanced edit timeline works on a compiled render manifest, and this production hasn't built one yet. Queue a first build from the export page — once the cut exists, its scenes, voice, music, SFX and captions show up here as editable tracks."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href={`/production/${projectId}/export`} size="sm" icon="download">
                Open export &amp; QC
              </LinkButton>
              <LinkButton href={`/first-cut?projectId=${encodeURIComponent(projectId)}`} size="sm" variant="secondary" icon="play">
                First cut
              </LinkButton>
            </div>
          }
          testId="edit.empty.state"
        />
        <p className="mt-4 text-center text-[12px] text-muted">
          Looking for scene order, retakes or delivery? Those live in the{" "}
          <Link href={`/production/${projectId}/storyboard`} className="font-semibold text-primary hover:underline">
            storyboard
          </Link>{" "}
          and{" "}
          <Link href={`/production/${projectId}/audio`} className="font-semibold text-primary hover:underline">
            audio
          </Link>{" "}
          panels.
        </p>
      </div>
    </main>
  );
}

export default async function ProductionEditPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!IdSchema.safeParse(projectId).success) notFound();
  const data = await withProductionStore((store) => loadEditData(store, projectId));
  if (data === "no-project") notFound();
  if (data === "no-manifest") return <NoCutScreen projectId={projectId} />;
  return <EditView data={data} onApplyOp={applyEditChange} />;
}
