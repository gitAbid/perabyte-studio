"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, FieldShell } from "@/components/ui";
import { UpsertSceneCommandSchema, type CanonRevision, type Scene, type UpsertSceneCommand } from "@/lib/production/contracts";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";
import {
  characterCanonRevisions,
  characterStateDraft,
  deriveSceneDraftFromScene,
  displayLabelForCanonRevision,
  environmentCanonRevisions,
  environmentStateDraft,
} from "@/lib/production/story-view-model";
import { upsertScene } from "@/components/production/story/client";
import { ErrorAlert } from "@/components/production/story/shared";

/* ------------------------------------------------------------------ */
/* SceneStateEditor — structured Character/Environment state (C6/C7)   */
/* ------------------------------------------------------------------ */
/* One scene's structured fields: cast state (outfit, hair, carried    */
/* items…) and environment state (zone, light, time, weather), written */
/* through POST /api/production/scenes (Zod-valid UpsertSceneCommand). */
/* Dialogue is displayed verbatim and never edited here.               */

export interface SceneStateEditorProps {
  projectId: string;
  /** Base revision the scene belongs to (null only for project-wide scenes). */
  storyRevisionId: string | null;
  /** Initial command values: derived from a beat (create) or the stored scene (edit). */
  initialDraft: UpsertSceneCommand;
  canonRevisions: readonly CanonRevision[];
  onSaved: (scene: Scene, created: boolean) => void;
  onCancel: () => void;
  /** Whether the scene is new (never saved) or an edit of a stored scene. */
  mode: "create" | "edit";
  /** Route to the Canon editor for honest empty-canon pointers. */
  canonHref: string;
}

const MAX_CHARACTER_STATES = 10;

/** "a, b, c" → ["a","b","c"]; trims, drops empties, respects the contract bound. */
function parseListValue(raw: string, max: number): { items: string[]; truncated: boolean } {
  const items = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (items.length > max) return { items: items.slice(0, max), truncated: true };
  return { items, truncated: false };
}

export function SceneStateEditor({ projectId, storyRevisionId, initialDraft, canonRevisions, onSaved, onCancel, mode, canonHref }: SceneStateEditorProps) {
  const characters = useMemo(() => characterCanonRevisions(canonRevisions), [canonRevisions]);
  const environments = useMemo(() => environmentCanonRevisions(canonRevisions), [canonRevisions]);

  const [title, setTitle] = useState(initialDraft.title);
  const [action, setAction] = useState(initialDraft.action);
  const [durationRaw, setDurationRaw] = useState(initialDraft.durationTargetMs === null ? "" : String(initialDraft.durationTargetMs));
  const [stateRows, setStateRows] = useState(initialDraft.characterStates.length > 0
    ? initialDraft.characterStates
    : characters.length > 0
      ? [characterStateDraft(characters[0]!.id)]
      : []);
  const [environment, setEnvironment] = useState(initialDraft.environmentState ?? null);

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ErrorEnvelopeView | null>(null);
  const [localIssues, setLocalIssues] = useState<string[]>([]);

  const dialogueLocked = initialDraft.dialogue;

  function updateRow(index: number, patch: Partial<(typeof stateRows)[number]>) {
    setStateRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateEnvironment(patch: Partial<NonNullable<typeof environment>>) {
    setEnvironment((current) => (current === null ? null : { ...current, ...patch }));
  }

  async function handleSave() {
    if (saving) return;
    setFailure(null);
    setLocalIssues([]);
    const issues: string[] = [];
    if (title.trim().length === 0) issues.push("Give the scene a title.");
    if (action.trim().length === 0) issues.push("Describe what happens in the scene.");
    let durationTargetMs: number | null = null;
    if (durationRaw.trim().length > 0) {
      const parsed = Number(durationRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) issues.push("Target length must be a whole number of milliseconds (or left empty).");
      else durationTargetMs = parsed;
    }
    if (issues.length > 0) {
      setLocalIssues(issues);
      return;
    }
    const command = UpsertSceneCommandSchema.safeParse({
      id: initialDraft.id,
      projectId,
      storyRevisionId,
      order: initialDraft.order,
      title: title.trim(),
      action: action.trim(),
      dialogue: dialogueLocked,
      durationTargetMs,
      characterStates: stateRows,
      environmentState: environment,
    });
    if (!command.success) {
      setLocalIssues(command.error.issues.slice(0, 8).map((issue) => `${issue.path.map(String).join(".") || "scene"}: ${issue.message}`));
      return;
    }
    setSaving(true);
    try {
      const result = await upsertScene(command.data);
      if (!result.ok) {
        setFailure(result.view);
        return;
      }
      onSaved(result.scene, result.created);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-primary/30">
      <form
        data-testid="story.scene.form"
        aria-label={mode === "create" ? "New scene details" : "Edit scene details"}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[13px] font-bold uppercase tracking-[0.08em] text-accent">
            {mode === "create" ? `New scene — ${title || "untitled"}` : `Scene details — ${title || "untitled"}`}
          </h4>
          <span className="text-[12px] text-muted">ID <span className="font-mono text-[11.5px]">{initialDraft.id}</span></span>
        </div>

        {failure ? <ErrorAlert view={failure} lead="The scene could not be saved." testId="story.scene.error" /> : null}
        {localIssues.length > 0 ? (
          <div role="alert" data-testid="story.scene.issues" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
            <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-danger">Fix before saving</p>
            <ul className="mt-1.5 space-y-1">
              {localIssues.map((issue) => (
                <li key={issue} className="text-[13px] leading-snug text-ink">{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell label="Scene title" htmlFor="scene-title">
            <input
              id="scene-title"
              data-testid="story.scene.title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <FieldShell label="Target length (milliseconds)" htmlFor="scene-duration" hint="Optional pacing goal, e.g. 8000 for about 8 seconds.">
            <input
              id="scene-duration"
              data-testid="story.scene.duration"
              value={durationRaw}
              inputMode="numeric"
              onChange={(event) => setDurationRaw(event.target.value)}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
        </div>

        <FieldShell label="What happens" htmlFor="scene-action" hint="Stage directions and narration for this scene.">
          <textarea
            id="scene-action"
            data-testid="story.scene.action"
            value={action}
            rows={4}
            maxLength={20_000}
            onChange={(event) => setAction(event.target.value)}
            className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 text-sm leading-relaxed text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>

        {dialogueLocked.length > 0 ? (
          <fieldset className="rounded-[8px] border border-border bg-surface p-3.5">
            <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Dialogue (locked word-for-word)</legend>
            <ul className="space-y-1.5" data-testid="story.scene.dialogue">
              {dialogueLocked.map((line, index) => {
                const revision = canonRevisions.find((candidate) => candidate.id === line.characterCanonRevisionId);
                return (
                  <li key={index} className="text-[13px] leading-relaxed text-ink">
                    <span className="font-semibold">{revision ? displayLabelForCanonRevision(revision) : line.characterCanonRevisionId}:</span> “{line.text}”
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[12px] text-muted">Dialogue is never rewritten by this form — ask in the change box instead.</p>
          </fieldset>
        ) : null}

        <fieldset className="rounded-[8px] border border-border bg-surface p-3.5" data-testid="story.scene.cast">
          <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Who appears (cast state)</legend>
          {characters.length === 0 ? (
            <p className="text-[13px] text-muted">
              No cast canon is selected for this production. <Link href={canonHref} className="font-medium text-ink underline underline-offset-2">Add cast in the Canon editor</Link> first.
            </p>
          ) : (
            <div className="space-y-3">
              {stateRows.map((row, index) => {
                const revision = canonRevisions.find((candidate) => candidate.id === row.characterCanonRevisionId);
                return (
                  <div key={index} className="grid gap-2.5 rounded-[8px] border border-border bg-raised p-3 sm:grid-cols-2" data-testid="story.scene.cast.row">
                    <FieldShell label="Character" htmlFor={`scene-cast-${index}`}>
                      <select
                        id={`scene-cast-${index}`}
                        data-testid="story.scene.cast.character"
                        value={row.characterCanonRevisionId}
                        onChange={(event) => updateRow(index, { characterCanonRevisionId: event.target.value })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                      >
                        {characters.map((character) => (
                          <option key={character.id} value={character.id}>{displayLabelForCanonRevision(character)}</option>
                        ))}
                        {!characters.some((character) => character.id === row.characterCanonRevisionId) ? (
                          <option value={row.characterCanonRevisionId}>{row.characterCanonRevisionId} (not in active canon)</option>
                        ) : null}
                      </select>
                    </FieldShell>
                    <FieldShell label="Outfit" htmlFor={`scene-outfit-${index}`}>
                      <input
                        id={`scene-outfit-${index}`}
                        data-testid="story.scene.cast.outfit"
                        value={row.outfit ?? ""}
                        maxLength={500}
                        placeholder="e.g. yellow raincoat"
                        onChange={(event) => updateRow(index, { outfit: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Hair" htmlFor={`scene-hair-${index}`}>
                      <input
                        id={`scene-hair-${index}`}
                        data-testid="story.scene.cast.hair"
                        value={row.hairState ?? ""}
                        maxLength={500}
                        placeholder="e.g. windswept"
                        onChange={(event) => updateRow(index, { hairState: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Looks (age presentation)" htmlFor={`scene-age-${index}`}>
                      <input
                        id={`scene-age-${index}`}
                        data-testid="story.scene.cast.age"
                        value={row.agePresentation ?? ""}
                        maxLength={200}
                        placeholder="e.g. tired, older"
                        onChange={(event) => updateRow(index, { agePresentation: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Accessories (comma separated)" htmlFor={`scene-accessories-${index}`}>
                      <input
                        id={`scene-accessories-${index}`}
                        data-testid="story.scene.cast.accessories"
                        value={row.accessories.join(", ")}
                        onChange={(event) => updateRow(index, { accessories: parseListValue(event.target.value, 20).items })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Carrying (comma separated)" htmlFor={`scene-carrying-${index}`}>
                      <input
                        id={`scene-carrying-${index}`}
                        data-testid="story.scene.cast.carrying"
                        value={row.carriedObjects.join(", ")}
                        onChange={(event) => updateRow(index, { carriedObjects: parseListValue(event.target.value, 20).items })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Condition (comma separated)" htmlFor={`scene-condition-${index}`}>
                      <input
                        id={`scene-condition-${index}`}
                        data-testid="story.scene.cast.condition"
                        value={row.condition.join(", ")}
                        placeholder="e.g. soaked, exhausted"
                        onChange={(event) => updateRow(index, { condition: parseListValue(event.target.value, 20).items })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <FieldShell label="Notes" htmlFor={`scene-notes-${index}`}>
                      <input
                        id={`scene-notes-${index}`}
                        data-testid="story.scene.cast.notes"
                        value={row.notes ?? ""}
                        maxLength={2000}
                        onChange={(event) => updateRow(index, { notes: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                        className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      />
                    </FieldShell>
                    <div className="sm:col-span-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        onClick={() => setStateRows((rows) => rows.filter((_, i) => i !== index))}
                        data-testid="story.scene.cast.remove"
                      >
                        Remove from this scene
                      </Button>
                    </div>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon="plus"
                disabled={stateRows.length >= MAX_CHARACTER_STATES || characters.length === 0}
                onClick={() => setStateRows((rows) => [...rows, characterStateDraft(characters[0]!.id)])}
                data-testid="story.scene.cast.add"
              >
                Add cast member
              </Button>
              {stateRows.length >= MAX_CHARACTER_STATES ? (
                <p className="text-[12px] text-muted">A scene can hold at most {MAX_CHARACTER_STATES} cast states.</p>
              ) : null}
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-[8px] border border-border bg-surface p-3.5" data-testid="story.scene.environment">
          <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Where we are (environment state)</legend>
          {environments.length === 0 ? (
            <p className="text-[13px] text-muted">
              No environment canon is selected for this production. <Link href={canonHref} className="font-medium text-ink underline underline-offset-2">Add environments in the Canon editor</Link> first.
            </p>
          ) : environment === null ? (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">This scene has no environment pinned. Choose one to lock the place, light and weather.</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon="plus"
                onClick={() => setEnvironment(environmentStateDraft(environments[0]!.id))}
                data-testid="story.scene.environment.add"
              >
                Set environment
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <FieldShell label="Environment" htmlFor="scene-env-character">
                  <select
                    id="scene-env-character"
                    data-testid="story.scene.environment.place"
                    value={environment.environmentCanonRevisionId}
                    onChange={(event) => updateEnvironment({ environmentCanonRevisionId: event.target.value })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                  >
                    {environments.map((option) => (
                      <option key={option.id} value={option.id}>{displayLabelForCanonRevision(option)}</option>
                    ))}
                    {!environments.some((option) => option.id === environment.environmentCanonRevisionId) ? (
                      <option value={environment.environmentCanonRevisionId}>{environment.environmentCanonRevisionId} (not in active canon)</option>
                    ) : null}
                  </select>
                </FieldShell>
                <FieldShell label="Area / zone" htmlFor="scene-env-zone">
                  <input
                    id="scene-env-zone"
                    data-testid="story.scene.environment.zone"
                    value={environment.zone ?? ""}
                    maxLength={200}
                    placeholder="e.g. the pier"
                    onChange={(event) => updateEnvironment({ zone: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <FieldShell label="Lighting" htmlFor="scene-env-lighting">
                  <input
                    id="scene-env-lighting"
                    data-testid="story.scene.environment.lighting"
                    value={environment.lighting ?? ""}
                    maxLength={200}
                    placeholder="e.g. lantern light"
                    onChange={(event) => updateEnvironment({ lighting: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <FieldShell label="Time of day" htmlFor="scene-env-time">
                  <input
                    id="scene-env-time"
                    data-testid="story.scene.environment.time"
                    value={environment.timeOfDay ?? ""}
                    maxLength={200}
                    placeholder="e.g. dusk"
                    onChange={(event) => updateEnvironment({ timeOfDay: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <FieldShell label="Weather" htmlFor="scene-env-weather">
                  <input
                    id="scene-env-weather"
                    data-testid="story.scene.environment.weather"
                    value={environment.weather ?? ""}
                    maxLength={200}
                    placeholder="e.g. light fog"
                    onChange={(event) => updateEnvironment({ weather: event.target.value.trim().length > 0 ? event.target.value : undefined })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <FieldShell label="Always present (comma separated)" htmlFor="scene-env-props">
                  <input
                    id="scene-env-props"
                    data-testid="story.scene.environment.props"
                    value={environment.persistentProps.join(", ")}
                    onChange={(event) => updateEnvironment({ persistentProps: parseListValue(event.target.value, 50).items })}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="trash"
                onClick={() => setEnvironment(null)}
                data-testid="story.scene.environment.remove"
              >
                Remove environment from this scene
              </Button>
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" icon="check" loading={saving} data-testid="story.scene.save">
            {mode === "create" ? "Create scene" : "Save scene"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid="story.scene.cancel">
            Cancel
          </Button>
          <span className="text-[12px] text-muted">
            Saving writes this scene only — the story text itself is never changed here.
          </span>
        </div>
      </form>
    </Card>
  );
}
