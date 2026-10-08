"use client";

import { Badge, Button, Card } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import {
  describeCharacterState,
  describeEnvironmentState,
  displayLabelForCanonRevision,
  sceneLabel,
  type StoryApprovalFacts,
} from "@/lib/production/story-view-model";
import type { CanonRevision, Scene, StoryBeat, StoryRevision } from "@/lib/production/contracts";

/* ------------------------------------------------------------------ */
/* StoryView — the readable story: beats + scenes (spec 08 §6)         */
/* ------------------------------------------------------------------ */
/* Read-only story surface. Beats come verbatim from the current story */
/* revision; scenes come from GET /api/production/scenes. Every scene  */
/* card opens the structured state editor. Nothing here mutates.       */

export interface StoryViewProps {
  story: StoryRevision;
  scenes: readonly Scene[];
  canonRevisions: readonly CanonRevision[];
  approvalFacts: StoryApprovalFacts;
  /** Opens the scene state editor prefilled from this beat (create mode). */
  onTurnBeatIntoScene: (beat: StoryBeat) => void;
  /** Opens the scene state editor for an existing scene (edit mode). */
  onEditScene: (scene: Scene) => void;
  /** True while the scene list request is in flight (shows a named loading line, not the empty state). */
  scenesPending?: boolean;
}

const DIALOGUE_NOTE = "Dialogue stays word-for-word. To rewrite a line, ask in the change box instead.";

export function StoryView({ story, scenes, canonRevisions, approvalFacts, onTurnBeatIntoScene, onEditScene, scenesPending = false }: StoryViewProps) {
  const canonById = new Map(canonRevisions.map((revision) => [revision.id, revision]));

  return (
    <section aria-label="Your story" data-testid="story.view" className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Your story</h2>
          <p className="mt-1 text-[12px] text-muted">
            Revision <span className="font-mono text-[11.5px]">{story.id}</span> · {story.beats.length} beat{story.beats.length === 1 ? "" : "s"} · {scenes.length} scene{scenes.length === 1 ? "" : "s"}
            {approvalFacts.approvedCurrent ? " · approved" : ""}
          </p>
        </div>
        {approvalFacts.state === "recommended" ? <Badge tone="primary">PeraByte recommends this story</Badge> : null}
      </header>

      <div className="space-y-3">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Story beats</h3>
        <ol data-testid="story.beat.list" className="space-y-3">
          {story.beats.map((beat) => {
            return (
              <li key={beat.id} data-testid="story.beat.item">
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-bold text-ink">{beatLabelFor(beat)}</p>
                      {beat.action.trim().length > 0 ? (
                        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{beat.action}</p>
                      ) : null}
                      {beat.narration.trim().length > 0 ? (
                        <p className="mt-2 whitespace-pre-wrap rounded-[8px] bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink-soft">{beat.narration}</p>
                      ) : null}
                      {beat.dialogue.length > 0 ? (
                        <ul className="mt-2 space-y-1.5">
                          {beat.dialogue.map((line, index) => (
                            <li key={`${beat.id}-${index}`} className="text-[13px] leading-relaxed text-ink">
                              <span className="font-semibold">{line.characterId}:</span> “{line.text}”
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="plus"
                      title="Create a scene from this beat"
                      onClick={() => onTurnBeatIntoScene(beat)}
                      data-testid="story.beat.scene-button"
                    >
                      Turn into scene
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Scenes</h3>
          <span className="text-[12px] text-muted">Scenes carry the structured details shots will use.</span>
        </div>
        {scenes.length === 0 && scenesPending ? (
          <p role="status" className="text-[13px] text-muted">Loading scenes…</p>
        ) : scenes.length === 0 ? (
          <EmptyState
            testId="story.scene.empty"
            icon="video"
            title="No scenes yet"
            body="Scenes pin down who appears, what they wear and where we are — turn a story beat into a scene to get started."
          />
        ) : (
          <ul data-testid="story.scene.list" className="space-y-3">
            {scenes.map((scene) => {
              const characterLabels = scene.characterStates.map((state) => {
                const revision = canonById.get(state.characterCanonRevisionId);
                return describeCharacterState(state, revision ? displayLabelForCanonRevision(revision) : state.characterCanonRevisionId);
              });
              const environmentLine = scene.environmentState
                ? describeEnvironmentState(
                    scene.environmentState,
                    (() => {
                      const revision = canonById.get(scene.environmentState?.environmentCanonRevisionId ?? "");
                      return revision ? displayLabelForCanonRevision(revision) : scene.environmentState?.environmentCanonRevisionId ?? "";
                    })(),
                  )
                : null;
              return (
                <li key={scene.id} data-testid="story.scene.item" data-scene-id={scene.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-bold text-ink">{sceneLabel(scene)}</p>
                        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{scene.action}</p>
                        {scene.dialogue.length > 0 ? (
                          <ul className="mt-2 space-y-1.5">
                            {scene.dialogue.map((line, index) => {
                              const revision = canonById.get(line.characterCanonRevisionId);
                              return (
                                <li key={`${scene.id}-${index}`} className="text-[13px] leading-relaxed text-ink">
                                  <span className="font-semibold">{revision ? displayLabelForCanonRevision(revision) : line.characterCanonRevisionId}:</span> “{line.text}”
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                        <ul className="mt-3 space-y-1" data-testid="story.scene.states">
                          {characterLabels.map((line) => (
                            <li key={line} className="text-[12.5px] leading-snug text-muted">{line}</li>
                          ))}
                          {environmentLine ? <li className="text-[12.5px] leading-snug text-muted">{environmentLine}</li> : null}
                        </ul>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="pen"
                        onClick={() => onEditScene(scene)}
                        data-testid="story.scene.edit"
                      >
                        Edit details
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[12px] text-muted">{DIALOGUE_NOTE}</p>
      </div>
    </section>
  );
}

/** Local beat heading without importing the view-model label (keeps numbering explicit). */
function beatLabelFor(beat: StoryBeat): string {
  const firstLine = beat.action.split("\n", 1)[0]?.trim() || beat.narration.split("\n", 1)[0]?.trim() || `Beat ${beat.id}`;
  return `Beat ${beat.order + 1} — ${firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine}`;
}
