/**
 * Per-scene settings overrides (pure). A scene may pin a sparse subset of the
 * composer's render settings; everything it doesn't override keeps following
 * the story-level settings at render time. The same merge runs on the server
 * runner (sceneRequestBody) and in the console UI (tiles + scene edit mode),
 * so the preview can never disagree with what renders.
 */
import type { GenerationSettings, StoryScene } from "@/lib/types";

/** The fields a scene may override. Kind and frames are first-class scene
 * fields; count/seed never applied to story scenes (the runner forces
 * count 1 and sends no seed); safe/enhance follow the content gate. */
const OVERRIDE_KEYS = [
  "aspect",
  "resolution",
  "style",
  "duration",
  "negativePrompt",
  "modelId",
  "loras",
] as const satisfies readonly (keyof GenerationSettings)[];

export type SceneSettingsOverride = Pick<GenerationSettings, (typeof OVERRIDE_KEYS)[number]>;

/** The settings a scene renders with: story settings, then its overrides. */
export function mergedSceneSettings(
  story: GenerationSettings,
  scene: Pick<StoryScene, "settings">,
): GenerationSettings {
  return { ...story, ...(scene.settings ?? {}) };
}

/** Fields changed between the edit-mode entry baseline and the exit buffer —
 * the sparse override Update stores. Touched keys are pinned even when they
 * equal the story value; untouched keys never enter the patch. */
export function diffSettingsBaseline(
  baseline: GenerationSettings,
  buffer: GenerationSettings,
): SceneSettingsOverride {
  const patch: Record<string, unknown> = {};
  for (const key of OVERRIDE_KEYS) {
    if (!settingsEqual(baseline[key], buffer[key])) patch[key] = buffer[key];
  }
  return patch as SceneSettingsOverride;
}

function settingsEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

/** Final override set for a scene: keys touched this session replace (or add
 * to) whatever the scene already overrode. */
export function applySceneOverrides(
  existing: Partial<GenerationSettings> | undefined,
  patch: SceneSettingsOverride,
): SceneSettingsOverride {
  return { ...(existing ?? {}), ...patch };
}
