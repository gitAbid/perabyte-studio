"use client";

/**
 * SceneCard — one ordered scene on the storyboard (spec 09 §6): title, action, coverage
 * badge, cast/environment chips, its shots as ShotCards, "Add shot" (frozen deriveShotDraft
 * prefill) and the per-scene "Generate anchors" batch with a CostEstimateCard preflight.
 *
 * Shots sit in a disclosure so a beginner can plan scene-by-scene without expanding them
 * (spec 09 §10.6). Added drafts are honest previews: they are not saved from this screen —
 * shot creation belongs to the shot-plan service, so the panel hands off to the plan builder.
 */

import { Badge, Button, Card, LinkButton } from "@/components/ui";
import { AnchorWorkflowPanel } from "./AnchorWorkflowPanel";
import { ShotCard } from "./ShotCard";
import {
  COVERAGE_META, canonLabel, framingLabel, sceneDurationLabel, shotDurationLine,
  type AnchorTargetView, type ShotCardView,
} from "./view-model";
import type { ShotPlanShotDraft, StoryboardSceneRow } from "@/lib/production/storyboard";
import type { CanonRevision, Scene } from "@/lib/production/contracts";
import type { DecisionIssue } from "@/components/production/storyboard";

export interface SceneCardProps {
  projectId: string;
  sceneNumber: number;
  row: StoryboardSceneRow;
  shotViews: readonly ShotCardView[];
  canonRevisions: readonly CanonRevision[];
  batchTargets: readonly AnchorTargetView[];
  batchGateReasons: readonly DecisionIssue[];
  gateReasonsByShotId: ReadonlyMap<string, readonly DecisionIssue[]>;
  drafts: readonly ShotPlanShotDraft[];
  draftError: string | null;
  continueMovement: boolean;
  onAddShot: () => void;
  onRemoveDraft: (index: number) => void;
  onReload: () => void;
}

export function SceneCard({
  projectId,
  sceneNumber,
  row,
  shotViews,
  canonRevisions,
  batchTargets,
  batchGateReasons,
  gateReasonsByShotId,
  drafts,
  draftError,
  continueMovement,
  onAddShot,
  onRemoveDraft,
  onReload,
}: SceneCardProps) {
  const scene: Scene = row.scene;
  const coverage = COVERAGE_META[row.coverage];
  const duration = sceneDurationLabel(scene.durationTargetMs);
  const revisionById = new Map(canonRevisions.map((revision) => [revision.id, revision]));
  const characterLabels = scene.characterStates.map((state) =>
    canonLabel(revisionById.get(state.characterCanonRevisionId), state.characterCanonRevisionId));
  const environmentLabel = scene.environmentState === null
    ? null
    : canonLabel(revisionById.get(scene.environmentState.environmentCanonRevisionId), scene.environmentState.environmentCanonRevisionId);
  const staleShots = shotViews.filter((view) => view.stale !== null);
  const anchorless = batchTargets.filter((target) => target.command.ok);

  return (
    <Card as="article" className="p-4">
      <div data-testid="storyboard.scene.card" data-scene-id={scene.id} data-index={sceneNumber}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold tabular-nums text-primary">
            {sceneNumber}
          </span>
          <h3 className="text-[15px] font-semibold text-ink">Scene {sceneNumber} — {scene.title}</h3>
          <span data-testid="storyboard.scene.coverage" data-coverage={row.coverage}>
            <Badge tone={coverage.tone}>{coverage.label}</Badge>
          </span>
          {duration ? <span className="text-[12px] tabular-nums text-muted">target {duration}</span> : null}
          {scene.dialogue.length > 0 ? (
            <span className="text-[12px] text-muted">{scene.dialogue.length} spoken line{scene.dialogue.length === 1 ? "" : "s"}</span>
          ) : null}
        </div>

        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft" title={scene.action}>
          {scene.action.length > 320 ? `${scene.action.slice(0, 319)}…` : scene.action}
        </p>

        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {characterLabels.length > 0 ? (
            <li>Characters: {characterLabels.join(" · ")}</li>
          ) : null}
          {environmentLabel ? <li>Environment: {environmentLabel}</li> : null}
        </ul>

        {staleShots.length > 0 ? (
          <p role="note" className="mt-2 text-[12.5px] text-warning" data-testid="storyboard.scene.stale-summary">
            {staleShots.length} shot{staleShots.length === 1 ? "" : "s"} need{staleShots.length === 1 ? "s" : ""} re-anchoring:{" "}
            {staleShots.map((view) => view.entry.shotRevision.shotId).join(", ")}.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon="plus" onClick={onAddShot} data-testid="storyboard.scene.add-shot">
            Add shot
          </Button>
          <span className="text-[12px] text-muted">
            {anchorless.length === 0
              ? "Every shot here has an approved anchor."
              : `Generate anchors fills every shot that needs one (${anchorless.length} ready).`}
          </span>
        </div>
        {draftError ? (
          <p role="alert" data-testid="storyboard.draft.error" className="mt-2 rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-2.5 text-[12.5px] text-ink">
            The new shot draft could not be created — {draftError}
          </p>
        ) : null}

        <div className="mt-3">
          <AnchorWorkflowPanel
            projectId={projectId}
            scopeLabel={`Scene ${sceneNumber} — ${scene.title}`}
            targets={batchTargets}
            gateReasons={batchGateReasons}
            onDone={onReload}
            testIdBase="storyboard.scene.generate"
          />
        </div>

        {drafts.length > 0 ? (
          <div className="mt-3 rounded-[10px] border border-border bg-surface p-3.5" data-testid="storyboard.draft.tray">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
                New shot drafts ({drafts.length}) — not saved yet
              </p>
              <LinkButton href={`/production/${projectId}/plan`} size="sm" variant="secondary" icon="pen" data-testid="storyboard.draft.plan-link">
                Open the plan builder to save
              </LinkButton>
            </div>
            <ul className="mt-2 space-y-2">
              {drafts.map((draft, index) => (
                <li key={`${draft.sceneId}-${draft.index}`} data-testid="storyboard.draft.card" data-draft-index={draft.index}>
                  <div className="rounded-[8px] border border-border bg-raised p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="primary">Draft</Badge>
                      <span className="text-[13px] font-semibold text-ink">Shot {row.shots.length + index + 1}</span>
                      <Badge tone="neutral">{framingLabel(draft.framing)}</Badge>
                      <span className="text-[12px] tabular-nums text-muted">{shotDurationLine({ targetFrames: draft.targetFrames })}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        className="ml-auto"
                        onClick={() => onRemoveDraft(index)}
                        data-testid={`storyboard.draft.remove-${index}`}
                      >
                        Remove draft
                      </Button>
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-snug text-ink-soft" title={draft.visualIntent}>
                      {draft.visualIntent.length > 220 ? `${draft.visualIntent.slice(0, 219)}…` : draft.visualIntent}
                    </p>
                    <p className="mt-1 text-[12px] text-muted">Motion: {draft.motionIntent}</p>
                    {continueMovement ? (
                      <p className="mt-1 text-[12px] text-ink-soft">
                        Continue movement is on — the plan builder completes the pin of the previous scene’s final frame.
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">
              Shots are saved through a shot plan revision, not from this board. The plan builder shows what a new plan changes before anything is saved —
              a new plan re-points the project and resets downstream approvals.
            </p>
          </div>
        ) : null}

        <details className="mt-3" open data-testid="storyboard.scene.shots" data-shot-count={row.shots.length}>
          <summary className="cursor-pointer text-[13px] font-semibold text-ink">
            Shots ({row.shots.length})
          </summary>
          {row.shots.length === 0 ? (
            <p role="status" className="mt-2 rounded-[8px] border border-dashed border-border-strong bg-surface px-3.5 py-3 text-[13px] text-muted">
              No shots yet for this scene. “Add shot” drafts one from the scene, or the plan builder can plan the whole story.
            </p>
          ) : (
            <ol className="mt-2.5 space-y-3">
              {shotViews.map((view) => (
                <li key={view.entry.shotRevision.id}>
                  <ShotCard
                    projectId={projectId}
                    view={view}
                    canonRevisions={canonRevisions}
                    gateReasons={gateReasonsByShotId.get(view.entry.shotRevision.id) ?? []}
                    onReload={onReload}
                  />
                </li>
              ))}
            </ol>
          )}
        </details>
      </div>
    </Card>
  );
}
