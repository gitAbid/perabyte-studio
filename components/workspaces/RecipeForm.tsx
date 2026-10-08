"use client";

/**
 * Production Recipe editor (feature spec 05 / CONTRACTS-FROZEN C4).
 * Drafts the recipe fields locally; the parent turns a confirmed save into a
 * PATCH with a bumped productionRecipe.version (recipes version only through
 * an explicit save). Language + frame bounds mirror the shared contract.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Button, FieldShell } from "@/components/ui";
import {
  ASPECT_RATIOS,
  ASPECT_RATIO_LABELS,
  LANGUAGE_MAX,
  LANGUAGE_MIN,
  QUALITY_STRATEGIES,
  QUALITY_STRATEGY_LABELS,
} from "./api";
import type { ProductionRecipe } from "@/lib/production/contracts";

export type RecipeDraft = {
  qualityStrategy: ProductionRecipe["qualityStrategy"];
  aspectRatio: ProductionRecipe["aspectRatio"];
  language: string;
  defaultShotTargetFramesText: string;
};

export function draftFromRecipe(recipe: ProductionRecipe): RecipeDraft {
  return {
    qualityStrategy: recipe.qualityStrategy,
    aspectRatio: recipe.aspectRatio,
    language: recipe.language,
    defaultShotTargetFramesText: String(recipe.defaultShotTargetFrames),
  };
}

/** Pure: draft -> recipe fields, or a list of human-readable issues. */
export function deriveRecipeSave(draft: RecipeDraft): { ok: true; value: Omit<ProductionRecipe, "version"> } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const language = draft.language.trim();
  if (language.length < LANGUAGE_MIN || language.length > LANGUAGE_MAX) {
    issues.push(`Language must be ${LANGUAGE_MIN}–${LANGUAGE_MAX} characters.`);
  }
  const frames = Number(draft.defaultShotTargetFramesText);
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    issues.push("Shot length must be a whole number of frames above zero.");
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      qualityStrategy: draft.qualityStrategy,
      aspectRatio: draft.aspectRatio,
      language,
      defaultShotTargetFrames: frames,
    },
  };
}

export function RecipeForm({
  recipe,
  saveState,
  onSave,
  testPrefix = "workspaces.recipe",
}: {
  recipe: ProductionRecipe;
  /** Owned by the parent: which PATCH (if any) is in flight and how it ended. */
  saveState: "idle" | "saving" | "saved" | "failed";
  onSave: (value: Omit<ProductionRecipe, "version">) => void;
  testPrefix?: string;
}) {
  const qualityId = useId();
  const aspectId = useId();
  const languageId = useId();
  const framesId = useId();
  const saving = saveState === "saving";

  const [draft, setDraft] = useState<RecipeDraft>(() => draftFromRecipe(recipe));

  // Follow workspace reloads, but never clobber in-progress edits.
  const dirtyRef = useRef(false);
  const derived = deriveRecipeSave(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromRecipe(recipe));
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromRecipe(recipe));
  }, [recipe]);

  function patch(changes: Partial<RecipeDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted">
        The recipe is how every new episode in this workspace is made: the care level, the video shape, the
        language, and the default shot length. Changing it affects future episodes only — episodes already
        made keep the recipe they were created with.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell label="Quality" htmlFor={qualityId} hint="How much care new episodes get.">
          <select
            id={qualityId}
            value={draft.qualityStrategy}
            onChange={(event) => patch({ qualityStrategy: event.target.value as ProductionRecipe["qualityStrategy"] })}
            className="h-11 w-full appearance-none rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            data-testid={`${testPrefix}.quality`}
          >
            {QUALITY_STRATEGIES.map((option) => (
              <option key={option} value={option}>{QUALITY_STRATEGY_LABELS[option]}</option>
            ))}
          </select>
        </FieldShell>

        <FieldShell label="Shape" htmlFor={aspectId} hint="The video shape new episodes are made in.">
          <select
            id={aspectId}
            value={draft.aspectRatio}
            onChange={(event) => patch({ aspectRatio: event.target.value as ProductionRecipe["aspectRatio"] })}
            className="h-11 w-full appearance-none rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            data-testid={`${testPrefix}.aspect`}
          >
            {ASPECT_RATIOS.map((option) => (
              <option key={option} value={option}>{ASPECT_RATIO_LABELS[option]}</option>
            ))}
          </select>
        </FieldShell>

        <FieldShell label="Language" htmlFor={languageId} hint="Spoken and written language of new episodes.">
          <input
            id={languageId}
            value={draft.language}
            maxLength={LANGUAGE_MAX}
            onChange={(event) => patch({ language: event.target.value })}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
            data-testid={`${testPrefix}.language`}
          />
        </FieldShell>

        <FieldShell
          label="Shot length (frames)"
          htmlFor={framesId}
          hint="Default length of one shot. 24 frames = 1 second."
        >
          <input
            id={framesId}
            type="number"
            min={1}
            step={1}
            value={draft.defaultShotTargetFramesText}
            onChange={(event) => patch({ defaultShotTargetFramesText: event.target.value })}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm tabular-nums text-ink focus:border-primary focus:outline-none"
            data-testid={`${testPrefix}.shotFrames`}
          />
        </FieldShell>
      </div>

      {derived.ok ? null : (
        <ul role="alert" className="space-y-1 text-[12.5px] text-danger" data-testid={`${testPrefix}.issues`}>
          {derived.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={!derived.ok || !dirty || saving}
          loading={saving}
          onClick={() => {
            if (!derived.ok) return;
            onSave(derived.value);
          }}
          data-testid={`${testPrefix}.save`}
        >
          Save recipe
        </Button>
        {saveState === "saved" && !dirty ? (
          <span role="status" className="text-[12.5px] font-semibold text-success" data-testid={`${testPrefix}.saved`}>
            Recipe saved.
          </span>
        ) : null}
        {dirty && !saving ? <span className="text-[12px] text-muted">Unsaved changes</span> : null}
      </div>
    </div>
  );
}
