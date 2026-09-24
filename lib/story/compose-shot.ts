import type { CharacterRow } from "@/lib/repositories/character-row";
import { composeSceneWithCharacters } from "@/lib/character";
import { hasTimeOfDayMention } from "@/lib/domain/enhancement";
import type { Asset, SceneState, StoryScene } from "@/lib/types";

/**
 * Single server-side shot composer — the one place a scene's render prompt is
 * built. It folds, in order: the cast's identity anchors (First/Second/Third,
 * with per-scene outfit overrides), the scene's structured world state
 * (location, time of day, props) and the user's prose prompt. Generate used
 * to snapshot this client-side (`runPrompts`); the runner now composes it so
 * there is exactly one prompt truth.
 *
 * Pure: no repository access — callers resolve the cast and location rows.
 */

export interface ShotLocation {
  id: string;
  name: string;
  description?: string;
  lighting?: string;
}

export interface ShotContext {
  characters: readonly CharacterRow[];
  locations?: readonly ShotLocation[];
}

function locationClause(state: SceneState, locations: readonly ShotLocation[]): string | null {
  const match = state.locationId
    ? locations.find((location) => location.id === state.locationId)
    : undefined;
  const text = match
    ? [match.name, match.description, match.lighting].filter(Boolean).join(" — ")
    : state.locationText?.trim();
  if (!text) return null;
  return `Setting: ${text}.`;
}

function stateClauses(state: SceneState | undefined, prompt: string, ctx: ShotContext): string[] {
  if (!state) return [];
  const clauses: string[] = [];
  const locations = ctx.locations ?? [];
  const location = locationClause(state, locations);
  if (location && !prompt.toLowerCase().includes(locationTextKey(state, locations))) {
    clauses.push(location);
  }
  if (state.timeOfDay && !hasTimeOfDayMention(prompt)) {
    clauses.push(`Time of day: ${state.timeOfDay}.`);
  }
  const props = (state.props ?? []).filter(Boolean).slice(0, 6);
  if (props.length) clauses.push(`Props in scene: ${props.join(", ")}.`);
  return clauses;
}

/** The fragment of the location clause the prompt-mention guard compares. */
function locationTextKey(state: SceneState, locations: readonly ShotLocation[]): string {
  const match = state.locationId
    ? locations.find((location) => location.id === state.locationId)
    : undefined;
  return (match?.name ?? state.locationText ?? "").trim().toLowerCase();
}

/**
 * Cast order and outfits for this scene: `state.characters` wins when present
 * (presence order becomes First/Second/Third, `outfit` overrides the default),
 * otherwise the story cast order applies unchanged. Shared with the keyframe
 * runner so both label people in the same order.
 */
export function sceneCast(state: SceneState | undefined, ctx: ShotContext): CharacterRow[] {
  const byId = new Map(ctx.characters.map((c) => [c.id, c]));
  const ordered = state?.characters?.length
    ? state.characters
        .map((entry) => {
          const row = byId.get(entry.id);
          if (!row) return null;
          if (!entry.outfit?.trim() || entry.outfit === row.spec.outfit) return row;
          return { ...row, spec: { ...row.spec, outfit: entry.outfit.trim() } };
        })
        .filter((row): row is CharacterRow => row !== null)
    : ctx.characters;
  return ordered.slice(0, 3);
}

/** The prompt the runner renders for this scene. */
export function composeShot(story: Asset, scene: StoryScene, ctx: ShotContext): string {
  const uncensored = (story.settings as { safe?: boolean } | undefined)?.safe === false;
  const clauses = stateClauses(scene.state, scene.prompt, ctx);
  const withState = clauses.length ? `${clauses.join(" ")} ${scene.prompt}` : scene.prompt;
  return composeSceneWithCharacters(
    withState,
    sceneCast(scene.state, ctx).map((c) => c.spec),
    uncensored,
  );
}
