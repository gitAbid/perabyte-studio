"use client";

/**
 * StoryboardView — the primary visual planning surface (spec 09, /production/[projectId]/storyboard).
 *
 * Reads via GET /api/production/projects/[projectId] and GET /api/production/scenes (the same
 * HTTP helpers the story screen uses) and shapes everything through the frozen Wave-2 domain
 * signatures: deriveStoryboard (board + stale), deriveShotDraft (add-shot prefill) and
 * buildAnchorGenerationCommand + recommendAnchorCandidate (generation + recommendation).
 *
 * Fail-closed throughout: a failed read or a failed board derivation renders an explicit
 * error with retry; an unapproved story or missing scenes render teaching empty states; a
 * domain derivation that throws is caught and reported. Nothing here creates shots, anchors
 * or approvals by itself — every mutation behind an explicit button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { deriveStoryApprovalState, type ErrorEnvelopeView } from "@/components/production/project-canon";
import type { DecisionIssue } from "@/components/production/storyboard";
import { fetchScenes, fetchStoryReadModel } from "./client";
import {
  DEFAULT_ANCHOR_SETTINGS, anchorCommandForShot, deriveBoard, deriveShotCardView, draftShotForScene,
  hasApprovedAnchor, anchorGenerationGate, staleShotsByShotId, storyboardShotInputs, framingLabel,
  shotDurationLine,
  type AnchorTargetView, type ShotCardView,
} from "./view-model";
import { SceneCard } from "./SceneCard";
import { StoryboardToolbar } from "./StoryboardToolbar";
import { ErrorAlert, LoadingPanel, RetryRow } from "./feedback";
import type { ProjectReadModel, Scene } from "@/lib/production/contracts";
import type { ShotPlanShotDraft, StoryboardModel, StoryboardSceneRow } from "@/lib/production/storyboard";

type BoardState =
  | { phase: "loading" }
  | { phase: "error"; error: ErrorEnvelopeView }
  | { phase: "ready"; readModel: ProjectReadModel; scenes: Scene[] };

export function StoryboardView({ projectId }: { projectId: string }) {
  const [state, setState] = useState<BoardState>({ phase: "loading" });
  const [reloading, setReloading] = useState(false);
  const [continueMovement, setContinueMovement] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ShotPlanShotDraft[]>>({});
  const [draftError, setDraftError] = useState<{ sceneId: string; message: string } | null>(null);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    const readModelResult = await fetchStoryReadModel(projectId);
    if (token !== loadToken.current) return;
    if (!readModelResult.ok) {
      setState({ phase: "error", error: readModelResult.view });
      return;
    }
    const scenesResult = await fetchScenes({ projectId, storyRevisionId: readModelResult.value.storyRevision?.id ?? null });
    if (token !== loadToken.current) return;
    if (!scenesResult.ok) {
      setState({ phase: "error", error: scenesResult.view });
      return;
    }
    setState({ phase: "ready", readModel: readModelResult.value, scenes: scenesResult.value });
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const reload = useCallback(() => {
    setReloading(true);
    void load().finally(() => setReloading(false));
  }, [load]);

  const ready = state.phase === "ready";
  const readModel = ready ? state.readModel : null;
  const story = readModel?.storyRevision ?? null;

  const board = useMemo<{ ok: true; model: StoryboardModel } | { ok: false; message: string } | null>(() => {
    if (!readModel || !story) return null;
    return deriveBoard({ story, scenes: state.phase === "ready" ? state.scenes : [], shots: storyboardShotInputs(readModel.shots) });
  }, [readModel, story, state]);

  const entryByRevisionId = useMemo(() => {
    const byId = new Map<string, ProjectReadModel["shots"][number]>();
    if (readModel) for (const entry of readModel.shots) byId.set(entry.shotRevision.id, entry);
    return byId;
  }, [readModel]);

  const staleByShotId = useMemo(() => (board?.ok ? staleShotsByShotId(board.model) : new Map()), [board]);

  const gateReasonsByShotId = useMemo(() => {
    const reasons = new Map<string, readonly DecisionIssue[]>();
    if (readModel) {
      for (const entry of readModel.shots) {
        reasons.set(entry.shotRevision.id, anchorGenerationGate(readModel, entry).reasons);
      }
    }
    return reasons;
  }, [readModel]);

  const shotViewsFor = useCallback((row: StoryboardSceneRow): ShotCardView[] => {
    if (!readModel) return [];
    return row.shots.flatMap((shot, index) => {
      const entry = entryByRevisionId.get(shot.id);
      if (!entry) return [];
      return [deriveShotCardView({ entry, number: index + 1, stale: staleByShotId.get(shot.id) ?? null, readModel })];
    });
  }, [readModel, entryByRevisionId, staleByShotId]);

  const batchTargetsFor = useCallback((row: StoryboardSceneRow): AnchorTargetView[] => {
    if (!readModel) return [];
    return row.shots.flatMap((boardShot) => {
      const stale = staleByShotId.has(boardShot.id);
      const entry = entryByRevisionId.get(boardShot.id);
      // The command builder reads the pristine read-model shot: board rows carry the coverage
      // markers (selectedAnchorId/selectedTakeId) that the strict anchor input schema rejects.
      if (!entry || (!stale && hasApprovedAnchor(entry))) return [];
      const shot = entry.shotRevision;
      return [{
        label: shot.shotId,
        shotId: shot.shotId,
        shotRevisionId: shot.id,
        command: anchorCommandForShot(shot, readModel.canonRevisions, DEFAULT_ANCHOR_SETTINGS),
      }];
    });
  }, [readModel, staleByShotId, entryByRevisionId]);

  const batchGateReasonsFor = useCallback((row: StoryboardSceneRow): DecisionIssue[] => {
    const seen = new Set<string>();
    const merged: DecisionIssue[] = [];
    for (const shot of row.shots) {
      for (const reason of gateReasonsByShotId.get(shot.id) ?? []) {
        const key = `${reason.code}-${reason.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(reason);
        }
      }
    }
    return merged;
  }, [gateReasonsByShotId]);

  function addShot(row: StoryboardSceneRow) {
    const existing = drafts[row.scene.id] ?? [];
    const result = draftShotForScene(row.scene, row.shots.length + existing.length);
    if (!result.ok) {
      setDraftError({ sceneId: row.scene.id, message: result.reason });
      return;
    }
    setDraftError((current) => (current?.sceneId === row.scene.id ? null : current));
    setDrafts((previous) => ({ ...previous, [row.scene.id]: [...(previous[row.scene.id] ?? []), result.draft] }));
  }

  function removeDraft(sceneId: string, index: number) {
    setDrafts((previous) => ({
      ...previous,
      [sceneId]: (previous[sceneId] ?? []).filter((_, candidate) => candidate !== index),
    }));
  }

  const storyApproval = state.phase === "ready" ? deriveStoryApprovalState(state.readModel.revisionApprovals, story) : null;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6" data-testid="storyboard.page">
      {state.phase === "loading" ? <LoadingPanel label="Loading the storyboard…" testId="storyboard.loading" /> : null}

      {state.phase === "error" ? (
        <div className="space-y-4">
          <ErrorAlert view={state.error} lead="The storyboard could not be loaded." testId="storyboard.error" />
          <RetryRow onRetry={reload} testId="storyboard.error.retry" />
        </div>
      ) : null}

      {ready && readModel ? (
        <>
          <StoryboardToolbar
            projectId={projectId}
            projectName={readModel.project.name}
            staleCount={board?.ok ? board.model.staleShots.length : 0}
            continueMovement={continueMovement}
            onContinueMovementChange={setContinueMovement}
            onReload={reload}
            reloading={reloading}
          />

          {!story ? (
            <div className="mt-8" data-testid="storyboard.empty">
              <EmptyState
                testId="storyboard.empty.no-story"
                icon="story"
                title="No story yet"
                body="The storyboard plans the film scene by scene from an approved story. Write and approve the story first, then come back to plan the shots."
                action={<LinkButton href={`/production/${projectId}/story`} icon="story">Open the story studio</LinkButton>}
              />
            </div>
          ) : board && !board.ok ? (
            <div className="mt-8 space-y-4" data-testid="storyboard.board-error">
              <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
                <p className="text-[13px] font-bold text-ink">The board could not be derived from the project data.</p>
                <p className="mt-1 text-[13px] leading-snug text-ink">{board.message}</p>
                <p className="mt-1 text-[12px] text-muted">Nothing was changed. Reload to try again.</p>
              </div>
              <RetryRow onRetry={reload} testId="storyboard.board-error.retry" />
            </div>
          ) : board?.ok ? (
            <>
              {!storyApproval?.approvedCurrent ? (
                <div role="status" className="mt-6 rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3" data-testid="storyboard.story-unapproved">
                  <p className="text-[13px] font-bold text-ink">The current story revision is not approved yet</p>
                  <p className="mt-1 text-[13px] leading-snug text-ink">
                    You can look around, but generating anchors stays locked until the story is approved in the story studio.
                  </p>
                  <div className="mt-2">
                    <LinkButton href={`/production/${projectId}/story`} size="sm" variant="secondary" icon="story">Review the story</LinkButton>
                  </div>
                </div>
              ) : null}

              {board.model.scenes.length === 0 && readModel.shots.length === 0 ? (
                <div className="mt-8" data-testid="storyboard.empty">
                  <EmptyState
                    testId="storyboard.empty.no-scenes"
                    icon="grid"
                    title="No scenes yet"
                    body="Scenes pin down who appears, where we are and what happens — the storyboard turns them into shots. Turn a story beat into a scene to get started."
                    action={<LinkButton href={`/production/${projectId}/story`} icon="story">Create scenes from the story</LinkButton>}
                  />
                </div>
              ) : null}

              {board.model.scenes.length > 0 ? (
                <ol className="mt-6 space-y-5" data-testid="storyboard.scene.list">
                  {board.model.scenes.map((row, index) => (
                    <li key={row.scene.id}>
                      <SceneCard
                        projectId={projectId}
                        sceneNumber={index + 1}
                        row={row}
                        shotViews={shotViewsFor(row)}
                        canonRevisions={readModel.canonRevisions}
                        batchTargets={batchTargetsFor(row)}
                        batchGateReasons={batchGateReasonsFor(row)}
                        gateReasonsByShotId={gateReasonsByShotId}
                        drafts={drafts[row.scene.id] ?? []}
                        draftError={draftError?.sceneId === row.scene.id ? draftError.message : null}
                        continueMovement={continueMovement}
                        onAddShot={() => addShot(row)}
                        onRemoveDraft={(index2) => removeDraft(row.scene.id, index2)}
                        onReload={reload}
                      />
                    </li>
                  ))}
                </ol>
              ) : null}

              <UnassignedShots shots={board.model.unassignedShots} />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unassigned shots — legacy plan shots not attached to a scene yet    */
/* ------------------------------------------------------------------ */

function UnassignedShots({ shots }: { shots: StoryboardModel["unassignedShots"] }) {
  if (shots.length === 0) return null;
  return (
    <section className="mt-8" data-testid="storyboard.unassigned" aria-label="Shots not attached to a scene">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Shots without a scene ({shots.length})</h2>
        <Badge tone="neutral">still valid</Badge>
      </div>
      <p className="mt-1 text-[12.5px] text-muted">
        These shots come from the current shot plan and are not attached to a scene yet. They stay valid storyboard entries;
        attaching shots to scenes happens through a plan revision.
      </p>
      <ul className="mt-2.5 space-y-2">
        {shots.map((shot) => (
          <li key={shot.id} className="rounded-[8px] border border-border bg-raised px-3.5 py-2.5" data-testid="storyboard.unassigned.shot" data-shot-id={shot.shotId}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-ink">{shot.shotId}</span>
              <Badge tone="neutral">{framingLabel(shot.framing)}</Badge>
              <span className="text-[12px] tabular-nums text-muted">{shotDurationLine(shot)}</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">{shot.visualIntent}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
