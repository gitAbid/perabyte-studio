"use client";

import type { ScenePlan } from "@/lib/domain/writer";
import type { SceneState } from "@/lib/types";

/**
 * Client access to the writer's scene-plan action: one call turns a story's
 * scene prompts into structured per-scene state (location, time of day, cast
 * with outfits, props). Degrades silently — an un-planned story renders fine,
 * it just keeps today's prose-only behavior.
 */

export interface ScenePlanRequest {
  scenes: string[];
  characterNames: string[];
  uncensored: boolean;
}

export async function requestScenePlan(
  request: ScenePlanRequest,
  signal?: AbortSignal,
): Promise<ScenePlan[]> {
  const response = await fetch("/api/writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "plan",
      scenes: request.scenes,
      characterNames: request.characterNames,
      uncensored: request.uncensored,
    }),
    signal,
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { scenes?: ScenePlan[] };
  return Array.isArray(data.scenes) ? data.scenes : [];
}

/**
 * Map plan entries onto scene states: plan indexes (1-based) line up with the
 * scenes sent; character names resolve against the story cast (case-insensitive)
 * so states carry cast ids the runner can use. Unknown names are dropped.
 */
export function plansToSceneStates(
  plans: ScenePlan[],
  sceneIds: string[],
  cast: { id: string; name: string }[],
): Record<string, SceneState> {
  const byName = new Map(
    cast.map((row) => [row.name.trim().toLowerCase(), row.id]),
  );
  const states: Record<string, SceneState> = {};
  type CastEntry = { id: string; outfit?: string };
  for (const plan of plans) {
    const sceneId = sceneIds[plan.index - 1];
    if (!sceneId) continue;
    const characters = (plan.characters ?? [])
      .map((entry): CastEntry | null => {
        const id = byName.get(entry.name.trim().toLowerCase());
        return id ? { id, outfit: entry.outfit } : null;
      })
      .filter((entry): entry is CastEntry => entry !== null);
    const state: SceneState = {
      locationText: plan.location,
      timeOfDay: plan.timeOfDay ?? undefined,
      ...(characters.length ? { characters } : {}),
      ...(plan.props?.length ? { props: plan.props } : {}),
    };
    if (state.locationText || state.timeOfDay || state.characters || state.props) {
      states[sceneId] = state;
    }
  }
  return states;
}
