"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";
import type { ProjectReadModel, Scene, StoryBeat, StoryRevision, UpsertSceneCommand } from "@/lib/production/contracts";
import { deriveSceneDraftFromBeat, deriveSceneDraftFromScene, deriveStoryApprovalFacts } from "@/lib/production/story-view-model";
import { fetchScenes, fetchStoryReadModel, freshSceneId } from "@/components/production/story/client";
import { LoadingPanel, ReadModelLoadError } from "@/components/production/story/shared";
import { IdeaComposer } from "@/components/production/story/IdeaComposer";
import { StoryView } from "@/components/production/story/StoryView";
import { RevisionDiffPanel } from "@/components/production/story/RevisionDiffPanel";
import { SceneStateEditor } from "@/components/production/story/SceneStateEditor";
import { ApproveBar } from "@/components/production/story/ApproveBar";

/* ------------------------------------------------------------------ */
/* StoryStudioPanel — /production/[projectId]/story (spec 08)          */
/* ------------------------------------------------------------------ */
/* Layout per the spec screen: the readable story (beats + scenes) on  */
/* the left, the "Ask for a change" rail on the right, the approve bar */
/* across the bottom. Loads the project read model (project, current   */
/* story revision, approvals) plus the scene list over HTTP and reports*/
/* every generation or apply decision exactly as the server returns it.*/

type ReadModelState =
  | { phase: "loading" }
  | { phase: "error"; error: ErrorEnvelopeView }
  | { phase: "ready"; readModel: ProjectReadModel };

type ScenesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: ErrorEnvelopeView }
  | { phase: "ready"; scenes: Scene[] };

type EditorState =
  | { mode: "closed" }
  | { mode: "create"; draft: UpsertSceneCommand; unmappedSpeakers: { characterId: string; text: string }[] }
  | { mode: "edit"; draft: UpsertSceneCommand };

export function StoryStudioPanel({ projectId }: { projectId: string }) {
  const [readModelState, setReadModelState] = useState<ReadModelState>({ phase: "loading" });
  const [scenesState, setScenesState] = useState<ScenesState>({ phase: "idle" });
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  /** The "before" side of the session diff: captured on first sight of a story. */
  const baseStoryRef = useRef<StoryRevision | null>(null);

  const loadReadModel = useCallback(async () => {
    setReadModelState({ phase: "loading" });
    const result = await fetchStoryReadModel(projectId);
    if (!result.ok) {
      setReadModelState({ phase: "error", error: result.view });
      return;
    }
    const story = result.value.storyRevision;
    if (!baseStoryRef.current && story) baseStoryRef.current = story;
    setReadModelState({ phase: "ready", readModel: result.value });
  }, [projectId]);

  const loadScenes = useCallback(async (storyRevisionId: string | null) => {
    if (storyRevisionId === null) {
      setScenesState({ phase: "idle" });
      return;
    }
    setScenesState({ phase: "loading" });
    const result = await fetchScenes({ projectId, storyRevisionId });
    if (result.ok) setScenesState({ phase: "ready", scenes: result.value });
    else setScenesState({ phase: "error", error: result.view });
  }, [projectId]);

  useEffect(() => {
    void loadReadModel();
  }, [loadReadModel]);

  const story = readModelState.phase === "ready" ? readModelState.readModel.storyRevision : null;
  const activeStoryId = story?.id ?? null;

  useEffect(() => {
    if (readModelState.phase !== "ready") return;
    void loadScenes(activeStoryId);
  }, [readModelState.phase, activeStoryId, loadScenes]);

  function reloadAll() {
    baseStoryRef.current = null;
    void loadReadModel();
  }

  function turnBeatIntoScene(beat: StoryBeat) {
    if (!story) return;
    const scenes = scenesState.phase === "ready" ? scenesState.scenes : [];
    const nextOrder = scenes.reduce((max, scene) => Math.max(max, scene.order + 1), 0);
    const draftResult = deriveSceneDraftFromBeat({
      sceneId: freshSceneId(),
      beat,
      order: nextOrder,
      projectId,
      storyRevisionId: story.id,
      canonRevisions: readModelState.phase === "ready" ? readModelState.readModel.canonRevisions : [],
    });
    if (!draftResult.ok) return;
    setEditor({ mode: "create", draft: draftResult.draft, unmappedSpeakers: draftResult.unmappedSpeakers });
  }

  function editScene(scene: Scene) {
    setEditor({ mode: "edit", draft: deriveSceneDraftFromScene(scene) });
  }

  async function handleSceneSaved() {
    setEditor({ mode: "closed" });
    await loadScenes(activeStoryId);
  }

  const canonRevisions = readModelState.phase === "ready" ? readModelState.readModel.canonRevisions : [];
  const scenes = scenesState.phase === "ready" ? scenesState.scenes : [];
  const baseStory = baseStoryRef.current;
  const approvalFacts = deriveStoryApprovalFacts(readModelState.phase === "ready" ? readModelState.readModel.revisionApprovals : [], story);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6" data-testid="story.page" data-project-id={projectId}>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
            Studio / Production / {readModelState.phase === "ready" ? readModelState.readModel.project.name : "…"}
          </p>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Story</h1>
          <p className="mt-1 text-[12px] text-muted">
            {story
              ? <>Current revision <span className="font-mono text-[11.5px]">{story.id}</span> · written {new Date(story.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
              : "Every story starts as one idea — draft, revise, then approve."}
          </p>
        </div>
        <div className="flex gap-2">
          <LinkButton href={`/production/${projectId}`} size="sm" variant="ghost" icon="arrow-left">Overview</LinkButton>
          <LinkButton href={`/production/${projectId}/canon`} size="sm" variant="secondary" icon="character">Canon editor</LinkButton>
        </div>
      </header>

      {readModelState.phase === "error" ? <div className="mt-6"><ReadModelLoadError error={readModelState.error} onRetry={() => void loadReadModel()} /></div> : null}

      {!story ? (
        <div className="mt-8 space-y-6">
          <EmptyState
            testId="story.empty"
            icon="story"
            title="No story yet"
            body="Write one or two sentences about what happens. PeraByte turns the idea into a full story you can review, change and approve."
          />
          <IdeaComposer projectId={projectId} canonRevisionIds={readModelState.phase === "ready" ? readModelState.readModel.project.activeCanonRevisionIds : []} />
          <p className="text-[12px] text-muted" data-testid="story.approve.empty-note">
            The approve bar appears here once a story draft exists — approval is always your call.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-6">
              {scenesState.phase === "loading" ? <LoadingPanel label="Loading scenes…" testId="story.scenes.loading" /> : null}
              {scenesState.phase === "error" ? (
                <div role="alert" data-testid="story.scenes.error" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
                  <p className="text-[13px] font-bold text-ink">The scene list could not be loaded.</p>
                  <p className="mt-1 text-[12px] text-muted">{scenesState.error.message}</p>
                  <button
                    type="button"
                    className="mt-2 text-[13px] font-semibold text-primary underline underline-offset-2"
                    onClick={() => void loadScenes(activeStoryId)}
                    data-testid="story.scenes.retry"
                  >
                    Try again
                  </button>
                </div>
              ) : null}
              <StoryView
                story={story}
                scenes={scenes}
                canonRevisions={canonRevisions}
                approvalFacts={approvalFacts}
                onTurnBeatIntoScene={turnBeatIntoScene}
                onEditScene={editScene}
                scenesPending={scenesState.phase === "loading"}
              />
              {editor.mode === "create" && editor.unmappedSpeakers.length > 0 ? (
                <div role="alert" data-testid="story.scene.unmapped-speakers" className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
                  <p className="text-[13px] font-bold text-ink">
                    {editor.unmappedSpeakers.length} spoken line{editor.unmappedSpeakers.length === 1 ? "" : "s"} could not be cast.
                  </p>
                  <p className="mt-1 text-[13px] leading-snug text-ink">
                    No active character canon matches {editor.unmappedSpeakers.map((line) => line.characterId).join(", ")}. Those lines were left out of the scene rather than guessed — add the cast in the Canon editor, then create the scene again.
                  </p>
                </div>
              ) : null}
              {editor.mode !== "closed" ? (
                <SceneStateEditor
                  key={editor.draft.id}
                  projectId={projectId}
                  storyRevisionId={editor.draft.storyRevisionId}
                  initialDraft={editor.draft}
                  canonRevisions={canonRevisions}
                  canonHref={`/production/${projectId}/canon`}
                  mode={editor.mode}
                  onSaved={() => { void handleSceneSaved(); }}
                  onCancel={() => setEditor({ mode: "closed" })}
                />
              ) : null}
            </div>
            <div className="min-w-0">
              {baseStory ? (
                <RevisionDiffPanel
                  projectId={projectId}
                  story={story}
                  baseRevision={baseStory}
                  canonRevisionIds={readModelState.phase === "ready" ? readModelState.readModel.project.activeCanonRevisionIds : []}
                  onApplied={() => { void loadReadModel(); }}
                />
              ) : null}
            </div>
          </div>

          <div className="mt-8 border-t border-border pt-6">
            <ApproveBar projectId={projectId} story={story} approvalFacts={approvalFacts} onRecorded={reloadAll} />
          </div>
        </>
      )}
    </div>
  );
}
