import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { IdSchema, type ExportRecord, type RenderManifest } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import type { ProductionStore } from "@/lib/repositories/production/ports";
import {
  disableShot, duplicateShot, retimeShot, replaceTake, setCaptions,
  type ManifestEditPins, type ManifestEditResult, type ManifestReplacementTake, type ManifestShotRenderPins,
} from "@/lib/production/manifest-ops";
import { MANIFEST_CROSSFADE_FRAMES } from "@/lib/production/manifest";
import { resolveProductionDataDir, withProductionStore } from "@/lib/production/runtime";
import {
  baseShotRevisionId, firstCutApplyFailure, formatDurationLabel, workingTimeline,
  type FirstCutApplyChangeCommand, type FirstCutApplyResult, type FirstCutExportSnapshot,
  type FirstCutManifest, type FirstCutOpInput, type FirstCutTakeOption, type FirstCutViewData,
} from "@/lib/production/first-cut-view-model";
import { FirstCutView } from "@/components/production/first-cut/FirstCutView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "First Cut — PeraByte",
  description: "Watch the assembled first cut, ask for a change in plain words, and rebuild only what changed.",
};

/* ================================================================== */
/* Server action: apply ONE confirmed change through the frozen C10 ops */
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
 * The C10 edit pins (CONTRACTS-FROZEN C10): the same compile facts the manifest compiler pinned,
 * re-derived from local records for the caller's CURRENT working manifest. Duplicated copies have
 * no shot revision of their own, so their `shotHash` resolves through the `-copy-N` chain to the
 * source revision — exactly the "pins must cover copies" caller contract proven in
 * lib/production/manifest-ops.test.ts.
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

/**
 * The one mutation surface of this slice, and it writes NOTHING: the confirmed op runs through
 * the frozen C10 pure functions and the resulting working manifest returns to the caller as
 * preview state. Persisting edited manifests stays with the integrator-owned manifest save API
 * (spec 13 §11), so this action can never fork the editing model.
 */
async function applyFirstCutChange(command: FirstCutApplyChangeCommand): Promise<FirstCutApplyResult> {
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
 * Read-only load of the latest build for one production: the newest export whose manifest is
 * still resolvable defines the built manifest, the playable artifact and the failure artifact.
 * Everything the C10 ops need on the client (take options, source lengths, pin completeness)
 * is derived here so the client stays pure.
 */
async function loadFirstCut(store: ProductionStore, projectId: string): Promise<FirstCutViewData | null> {
  const project = store.read.getProject(projectId);
  if (!project) return null;

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

  const missingAssetIds: string[] = [];
  const sourceFramesByShot: Record<string, number> = {};
  const shotLabels: Record<string, string> = {};
  const takesByBaseShot: Record<string, FirstCutTakeOption[]> = {};
  let editsAvailable = false;
  let editsUnavailableReason: string | null = null;

  if (builtManifest) {
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
  }

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

  let failedShotRevisionIds: string[] = [];
  let failureStage: string | null = null;
  if (chosen) {
    try {
      const raw = JSON.parse(
        await readFile(join(resolveProductionDataDir(), "exports", chosen.id, "failure.json"), "utf8"),
      ) as { shotRevisionId?: unknown; stage?: unknown };
      if (typeof raw.shotRevisionId === "string" && IdSchema.safeParse(raw.shotRevisionId).success) failedShotRevisionIds = [raw.shotRevisionId];
      if (typeof raw.stage === "string") failureStage = raw.stage;
    } catch {
      /* no failure artifact recorded for this export */
    }
  }

  const exportRecord: FirstCutExportSnapshot | null = chosen
    ? { id: chosen.id, status: chosen.status, assetId: chosen.assetId, manifestId: chosen.manifestId, createdAt: chosen.createdAt }
    : null;

  return {
    projectId,
    projectName: project.name,
    builtManifest,
    crossfadeFrames: MANIFEST_CROSSFADE_FRAMES,
    exportRecord,
    missingAssetIds,
    failedShotRevisionIds,
    failureStage,
    plannedShotRevisionIds,
    shotLabels,
    takesByBaseShot,
    sourceFramesByShot,
    editsAvailable,
    editsUnavailableReason,
  };
}

interface PickerCandidate {
  projectId: string;
  name: string;
  updatedAt: number;
  shotCount: number;
  runtimeLabel: string;
  status: FirstCutExportSnapshot["status"];
  aspect: string;
}

/** Productions whose newest export still resolves to a stored render manifest. */
function loadPickerCandidates(store: ProductionStore): PickerCandidate[] {
  const page = store.read.listProjects(null, 24);
  const candidates: PickerCandidate[] = [];
  for (const project of page.projects) {
    const exports = [...store.read.listProjectExports(project.id)].sort(byNewestExport);
    for (const record of exports) {
      const manifest = store.read.getManifest(record.manifestId);
      if (!manifest) continue;
      candidates.push({
        projectId: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        shotCount: manifest.shots.length,
        runtimeLabel: formatDurationLabel(workingTimeline(manifest, MANIFEST_CROSSFADE_FRAMES).runtimeMs),
        status: record.status,
        aspect: manifest.profile.aspect,
      });
      break;
    }
  }
  return candidates;
}

/* ================================================================== */
/* Picker surface (server-rendered)                                    */
/* ================================================================== */

const STATUS_TONES: Record<FirstCutExportSnapshot["status"], "neutral" | "primary" | "success" | "warning" | "danger"> = {
  queued: "primary",
  rendering: "primary",
  qc_pending: "success",
  qc_failed: "warning",
  ready_for_review: "success",
  approved: "success",
  failed: "danger",
  canceled: "danger",
};

function PickerScreen({ candidates, showMissingNotice }: { candidates: PickerCandidate[]; showMissingNotice: boolean }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" data-testid="first-cut.picker">
      <header className="flex flex-col gap-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / First Cut</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">First Cut</h1>
        <p className="mt-1 text-[12px] text-muted">
          {candidates.length > 0
            ? "Pick the production whose cut you want to watch and change."
            : "The screening room for your assembled cuts."}
        </p>
      </header>

      {showMissingNotice && (
        <p role="status" data-testid="first-cut.picker.missing" className="mt-4 rounded-[8px] border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[13px] text-ink">
          That production doesn&apos;t have a first cut yet — pick one below.
        </p>
      )}

      {candidates.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="play"
            title="No production has a first cut yet"
            body="A first cut appears once a production's approved takes compile into a render manifest and get queued for assembly. Open a production's export page to queue its first build."
            action={<LinkButton href="/studio" size="sm" icon="home">Go to the studio</LinkButton>}
            testId="first-cut.picker.empty"
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2" aria-label="Productions with a first cut">
          {candidates.map((candidate) => (
            <li key={candidate.projectId}>
              <Link
                href={`/first-cut?projectId=${encodeURIComponent(candidate.projectId)}`}
                data-testid="first-cut.picker.project"
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-raised px-4 py-3.5 transition-colors hover:border-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-ink">{candidate.name}</span>
                  <span className="mt-0.5 block text-[12px] text-muted">
                    {candidate.shotCount} shot{candidate.shotCount === 1 ? "" : "s"} · {candidate.runtimeLabel} · {candidate.aspect}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={STATUS_TONES[candidate.status]}>{candidate.status.replace(/_/g, " ")}</Badge>
                  <span aria-hidden="true" className="text-muted">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/* ================================================================== */
/* Route                                                               */
/* ================================================================== */

export default async function FirstCutPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const resolved = await searchParams;
  const raw = resolved.projectId;
  const requestedId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  const requested = requestedId && IdSchema.safeParse(requestedId).success ? requestedId : null;

  if (requested) {
    const data = await withProductionStore((store) => loadFirstCut(store, requested));
    if (!data) return <PickerScreen candidates={[]} showMissingNotice />;
    return <FirstCutView data={data} onApplyChange={applyFirstCutChange} />;
  }

  const candidates = await withProductionStore((store) => loadPickerCandidates(store));
  if (candidates.length === 1) redirect(`/first-cut?projectId=${encodeURIComponent(candidates[0]!.projectId)}`);
  return <PickerScreen candidates={candidates} showMissingNotice={Boolean(requestedId)} />;
}
