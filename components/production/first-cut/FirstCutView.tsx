"use client";

/**
 * FirstCutView — the /first-cut screen body (spec 13 Alpha slice).
 *
 * Playback stage (native controls, ratio-locked to the manifest's render profile), the ordered
 * take-strip with per-shot status (selected / skipped / missing / failed — failed shots read
 * "Skipped in this cut"), the Rebuild button that re-runs assembly through the existing export
 * API, and the "Ask for a change" panel whose confirmed ops run through the frozen C10
 * manifest-ops pure functions (via the page's server action).
 *
 * Speaks HTTP only for build state: POST /api/production/projects/:id/exports to (re)queue the
 * assembly, GET /api/production/exports/:id?projectId= to follow it. Nothing here fabricates a
 * success: queued/running/failed are named states, and an edited-but-unsaved working cut is
 * always labeled as a preview.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, LinkButton } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { GenerationStatus, type GenerationPhase } from "@/components/production/primitives/status";
import { ExportDetailResponseSchema } from "@/lib/production/qc";
import {
  buildFirstCutViewModel, formatDurationLabel,
  type FirstCutApplyChangeCommand, type FirstCutApplyResult, type FirstCutExportSnapshot,
  type FirstCutOpInput, type FirstCutViewData,
} from "@/lib/production/first-cut-view-model";
import { ChangePanel } from "./ChangePanel";

export interface FirstCutViewProps {
  data: FirstCutViewData;
  /** Server action: applies ONE confirmed op through the pure C10 manifest-ops functions. */
  onApplyChange: (command: FirstCutApplyChangeCommand) => Promise<FirstCutApplyResult>;
}

const TRANSIENT_STATUSES = new Set(["queued", "rendering"]);
const DRAFT_STATUSES = new Set(["qc_pending", "qc_failed", "ready_for_review"]);
const POLL_MS = 2000;

interface HttpFailureEnvelope {
  error?: { code?: unknown; message?: unknown };
  requestId?: unknown;
}

/** Plain-language rendering of a failed API call (same convention as the export workspace). */
function describeHttpFailure(status: number, payload: unknown, fallback: string): string {
  const envelope = typeof payload === "object" && payload !== null ? (payload as HttpFailureEnvelope) : null;
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : "UNKNOWN";
  const message = typeof envelope?.error?.message === "string" ? envelope.error.message : fallback;
  const requestId = typeof envelope?.requestId === "string" ? envelope.requestId : "unknown";
  return `${code}: ${message} (requestId ${requestId})`;
}

export function FirstCutView({ data, onApplyChange }: FirstCutViewProps) {
  const { projectId, projectName } = data;
  const builtManifest = data.builtManifest;

  const [workingManifest, setWorkingManifest] = useState(builtManifest);
  const [exportSnapshot, setExportSnapshot] = useState<FirstCutExportSnapshot | null>(data.exportRecord);
  const [failedShotIds, setFailedShotIds] = useState<string[]>(data.failedShotRevisionIds);
  const [failureStage, setFailureStage] = useState<string | null>(data.failureStage);
  const [buildKey, setBuildKey] = useState(0);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  const view = useMemo(
    () =>
      builtManifest && workingManifest
        ? buildFirstCutViewModel({
            workingManifest,
            builtManifest,
            crossfadeFrames: data.crossfadeFrames,
            missingAssetIds: data.missingAssetIds,
            failedShotRevisionIds: failedShotIds,
            plannedShotRevisionIds: data.plannedShotRevisionIds,
            shotLabels: data.shotLabels,
          })
        : null,
    [builtManifest, workingManifest, data.crossfadeFrames, data.missingAssetIds, data.plannedShotRevisionIds, data.shotLabels, failedShotIds],
  );

  const applyChange = useCallback(
    async (op: FirstCutOpInput): Promise<FirstCutApplyResult> => {
      if (!workingManifest) return { ok: false, code: "INVALID_INPUT", error: "There is no cut to change yet." };
      const result = await onApplyChange({ projectId, manifest: workingManifest, op });
      if (result.ok) setWorkingManifest(result.manifest);
      return result;
    },
    [onApplyChange, projectId, workingManifest],
  );

  // Follow a transient build (queued → rendering → terminal) through the existing export API.
  useEffect(() => {
    if (!exportSnapshot || !TRANSIENT_STATUSES.has(exportSnapshot.status)) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/production/exports/${encodeURIComponent(exportSnapshot.id)}?projectId=${encodeURIComponent(projectId)}`,
            { cache: "no-store" },
          );
          if (!response.ok) return; // transient network/server hiccups: the next tick retries
          const parsed = ExportDetailResponseSchema.safeParse(await response.json().catch(() => undefined));
          if (!parsed.success) return;
          setExportSnapshot({
            id: parsed.data.export.id,
            status: parsed.data.export.status,
            assetId: parsed.data.export.assetId,
            manifestId: parsed.data.export.manifestId,
            createdAt: parsed.data.export.createdAt,
          });
          setFailedShotIds(parsed.data.failure?.shotRevisionId ? [parsed.data.failure.shotRevisionId] : []);
          setFailureStage(parsed.data.failure?.stage ?? null);
          setBuildKey((key) => key + 1);
        } catch {
          /* keep polling; the interval restarts on the next effect run */
        }
      })();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [exportSnapshot, projectId]);

  const rebuild = useCallback(async (): Promise<void> => {
    if (!builtManifest || rebuildBusy) return;
    setRebuildBusy(true);
    setRebuildError(null);
    try {
      const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          manifestId: builtManifest.id,
          expectedManifestHash: builtManifest.inputsHash,
          idempotencyKey: `first-cut-rebuild-${Date.now().toString(36)}`,
        }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (response.status !== 202 && response.status !== 200) {
        setRebuildError(describeHttpFailure(response.status, payload, "The build could not be queued."));
        return;
      }
      const record = typeof payload === "object" && payload !== null ? (payload as { id?: unknown; status?: unknown; assetId?: unknown }) : null;
      if (typeof record?.id === "string") {
        setExportSnapshot({
          id: record.id,
          status: typeof record.status === "string" ? (record.status as FirstCutExportSnapshot["status"]) : "queued",
          assetId: typeof record.assetId === "string" ? record.assetId : null,
          manifestId: builtManifest.id,
          createdAt: Date.now(),
        });
      }
      setBuildKey((key) => key + 1);
    } catch {
      setRebuildError("The build could not be queued: network error — the local studio server may be offline.");
    } finally {
      setRebuildBusy(false);
    }
  }, [builtManifest, projectId, rebuildBusy]);

  const playbackUrl = useMemo(() => {
    if (!exportSnapshot?.assetId) return null;
    const bust = `${encodeURIComponent(exportSnapshot.assetId)}-${buildKey}`;
    if (exportSnapshot.status === "approved") {
      return `/api/production/exports/${encodeURIComponent(exportSnapshot.id)}/download?projectId=${encodeURIComponent(projectId)}&v=${bust}`;
    }
    if (DRAFT_STATUSES.has(exportSnapshot.status)) {
      return `/api/production/exports/${encodeURIComponent(exportSnapshot.id)}/draft?projectId=${encodeURIComponent(projectId)}&v=${bust}`;
    }
    return null;
  }, [exportSnapshot, buildKey, projectId]);

  if (!builtManifest || !workingManifest || !view) {
    // Teaching empty state: no manifest/exports exist yet for this production.
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" data-testid="first-cut.empty">
        <Header projectId={projectId} projectName={projectName} />
        <EmptyState
          icon="play"
          title="No first cut yet"
          body="A first cut appears once every scene has an approved take and the cut is compiled into a render manifest, then queued for assembly from the export page. Your story, storyboard and takes are all safe."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href={`/production/${projectId}/storyboard`} size="sm" icon="grid">
                Open the storyboard
              </LinkButton>
              <LinkButton href={`/production/${projectId}/export`} size="sm" variant="secondary" icon="download">
                Open export &amp; QC
              </LinkButton>
            </div>
          }
          testId="first-cut.empty-state"
        />
      </main>
    );
  }

  const build = buildPhase({ exportSnapshot, failureStage, enabledCount: view.enabledCount });
  const hasArtifact = playbackUrl !== null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
      <Header projectId={projectId} projectName={projectName} />

      {/* Playback stage — ratio-locked to the manifest's render profile. */}
      <section data-testid="first-cut.stage" className="overflow-hidden rounded-[12px] border border-border bg-black shadow-card">
        <div className="mx-auto w-full" style={{ aspectRatio: view.aspectCss, maxHeight: "72vh" }}>
          {hasArtifact && playbackUrl ? (
            <video
              key={playbackUrl}
              data-testid="first-cut.player"
              src={playbackUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={`First cut of ${projectName} — ${view.aspect} preview`}
              className="h-full w-full bg-black"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon name="play" size={28} className="text-white/60" />
              <p className="max-w-sm text-[13px] text-white/80" data-testid="first-cut.stage.placeholder">
                {stagePlaceholder(exportSnapshot)}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Build state + Rebuild (assembly trigger via the existing export API). */}
      <section className="flex flex-col gap-3" aria-label="Build state">
        <GenerationStatus
          testId="first-cut.build-status"
          phase={build.phase}
          stage={build.stage}
          failureMessage={build.failureMessage}
          onRetry={build.retryable ? () => { void rebuild(); } : undefined}
          retryInFlight={rebuildBusy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            icon="refresh"
            loading={rebuildBusy}
            onClick={() => { void rebuild(); }}
            data-testid="first-cut.rebuild"
          >
            {exportSnapshot ? "Rebuild first cut" : "Build first cut"}
          </Button>
          {exportSnapshot && (
            <LinkButton href={`/production/${projectId}/export`} size="md" variant="ghost" iconRight="arrow-right" data-testid="first-cut.export-link">
              Export &amp; QC
            </LinkButton>
          )}
        </div>
        {!view.matchesBuilt && (
          <p role="status" data-testid="first-cut.dirty-note" className="rounded-[8px] border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[13px] text-ink">
            Your changes are a preview of the working cut. Saving edited manifests needs the production manifest save API, which is not wired into this slice yet — so{" "}
            <strong>Rebuild</strong> re-renders the cut exactly as last saved, and the player keeps showing that saved build.
          </p>
        )}
        {rebuildError && (
          <p role="alert" data-testid="first-cut.rebuild-error" className="rounded-[8px] border border-danger/40 bg-danger-soft/60 px-3.5 py-2.5 text-[13px] text-danger">
            {rebuildError}
          </p>
        )}
      </section>

      <ChangePanel
        view={view}
        takesByBaseShot={data.takesByBaseShot}
        sourceFramesByShot={data.sourceFramesByShot}
        editsAvailable={data.editsAvailable}
        editsUnavailableReason={data.editsUnavailableReason}
        onApply={applyChange}
      />

      {/* Take-strip: selected takes in order with per-shot status. */}
      <section aria-label="Shots in this cut" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-bold text-ink">Shots in this cut</h2>
          <p className="text-[13px] text-muted" data-testid="first-cut.runtime">
            Runtime {view.runtimeLabel} · {view.enabledCount} shot{view.enabledCount === 1 ? "" : "s"} playing
            {view.skippedCount > 0 ? ` · ${view.skippedCount} skipped` : ""}
            {view.outsideCut.length > 0 ? ` · ${view.outsideCut.length} planned shot${view.outsideCut.length === 1 ? "" : "s"} not in this cut` : ""}
          </p>
        </div>
        <p className="text-[12px] text-muted" data-testid="first-cut.delta-line">{view.delta.summary}</p>
        <ol className="flex flex-col gap-2" data-testid="first-cut.strip">
          {view.shots.map((shot) => (
            <li
              key={shot.shotRevisionId}
              data-testid="first-cut.shot"
              data-position={shot.position}
              data-status={shot.status}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-[10px] border px-4 py-3 ${
                shot.status === "selected" ? "border-border bg-raised" : shot.status === "missing" ? "border-warning/40 bg-warning-soft/40" : "border-border bg-surface"
              }`}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">
                  Shot {shot.position}
                  {shot.isCopy ? " (repeat)" : ""}
                  {data.shotLabels[shot.baseShotRevisionId] ? ` — ${data.shotLabels[shot.baseShotRevisionId]}` : ""}
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {shot.disabled
                    ? shot.statusDetail
                    : `Take ${shot.takeId.slice(0, 14)} · ${formatDurationLabel(shot.durationMs)}${shot.startMs !== null ? ` · starts at ${formatDurationLabel(shot.startMs)}` : ""}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {shot.changedSinceBuild && <Badge tone="primary">changed</Badge>}
                <span data-testid="first-cut.shot.status" title={shot.statusDetail}>
                  <Badge tone={shot.status === "selected" ? "success" : shot.status === "missing" ? "warning" : shot.status === "failed" ? "danger" : "neutral"}>
                    {shot.statusLabel}
                  </Badge>
                </span>
              </div>
            </li>
          ))}
          {view.outsideCut.length > 0 && (
            <li className="rounded-[10px] border border-dashed border-border-strong bg-surface px-4 py-3 text-[13px] text-muted" data-testid="first-cut.outside-cut">
              {view.outsideCut.length} planned shot{view.outsideCut.length === 1 ? " is" : "s are"} not in this cut yet — the storyboard moved on since the last build.{" "}
              <Link href={`/production/${projectId}/storyboard`} className="font-semibold text-primary hover:underline">
                Open the storyboard
              </Link>{" "}
              to bring them in.
            </li>
          )}
        </ol>
        <p className="text-[12px] text-muted" data-testid="first-cut.captions-line">
          {view.captions.length === 0
            ? "No captions on this cut."
            : `Captions: ${view.captions.length} line${view.captions.length === 1 ? "" : "s"} — “${view.captions[0]!.text.slice(0, 80)}”${view.captions.length > 1 ? "…" : ""}`}
        </p>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

function Header({ projectId, projectName }: { projectId: string; projectName: string }) {
  return (
    <header className="flex flex-col gap-1" data-testid="first-cut.header">
      <nav className="flex flex-wrap items-center gap-1 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
        <Link href={`/production/${projectId}`} className="hover:underline" data-testid="first-cut.breadcrumb-project">
          Studio / Production / {projectName}
        </Link>
        <span aria-hidden="true">/</span>
        <span>First Cut</span>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">First Cut</h1>
          <p className="mt-1 text-[12px] text-muted">
            Watch the assembled cut, ask for a change in plain words, and rebuild only what changed.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/production/${projectId}/storyboard`} size="sm" variant="ghost" icon="grid" data-testid="first-cut.storyboard-link">
            Storyboard
          </LinkButton>
        </div>
      </div>
    </header>
  );
}

function buildPhase(input: {
  exportSnapshot: FirstCutExportSnapshot | null;
  failureStage: string | null;
  enabledCount: number;
}): { phase: GenerationPhase; stage: string; failureMessage?: string; retryable?: boolean } {
  const { exportSnapshot, failureStage, enabledCount } = input;
  if (!exportSnapshot) {
    return { phase: "ready", stage: "Ready when you are — queue the first build of this cut below." };
  }
  switch (exportSnapshot.status) {
    case "queued":
      return { phase: "queued", stage: "Waiting for a free render slot…" };
    case "rendering":
      return { phase: "running", stage: `Assembling ${enabledCount} shot${enabledCount === 1 ? "" : "s"} with the local renderer…` };
    case "qc_pending":
      return { phase: "completed", stage: "Rendered. Technical QC has not run yet — the draft is watchable above." };
    case "qc_failed":
      return { phase: "completed", stage: "Rendered, but technical QC flagged blockers. The draft above is watchable; details live in Export & QC." };
    case "ready_for_review":
      return { phase: "completed", stage: "Rendered and QC-passed. Watch it above, then review it in Export & QC." };
    case "approved":
      return { phase: "completed", stage: "Approved build — the player above shows the approved bytes." };
    case "failed":
      return {
        phase: "failed",
        stage: "This build didn't finish.",
        failureMessage: `The render stopped at the ${failureStage ?? "assembly"} stage. The previous cut is untouched — retry the build.`,
        retryable: true,
      };
    case "canceled":
      return {
        phase: "failed",
        stage: "This build didn't finish.",
        failureMessage: "The build was canceled before it finished. Nothing was deleted — retry when you're ready.",
        retryable: true,
      };
  }
}

function stagePlaceholder(exportSnapshot: FirstCutExportSnapshot | null): string {
  if (!exportSnapshot) return "Nothing rendered yet — queue the first build below and the picture appears here.";
  switch (exportSnapshot.status) {
    case "queued":
      return "The build is queued — the picture appears here once the render finishes.";
    case "rendering":
      return "Rendering right now — the picture appears here when the render commits.";
    case "failed":
    case "canceled":
      return "No playable build yet — queue a rebuild below.";
    default:
      return "The rendered file is not available right now — queue a rebuild below.";
  }
}
