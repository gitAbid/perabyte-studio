import type { StoryScene } from "@/lib/types";

/**
 * Image-story → video-story conversion (spec §9): consecutive images become
 * first/last-frame pairs — clip i animates image i into image i+1.
 * N images yield N-1 clips; every clip carries explicit refs, so the queue's
 * "manual refs make a scene runnable" rule renders them all in parallel.
 */

export interface ConvertSource {
  sceneId: string;
  prompt: string;
  ref: string;
}

/** End-capable preference order (Sogni-native first — see docs/sogni-api-guide.md §5). */
export const END_CAPABLE_MODEL_PREFERENCE = [
  "sogni:ltx23-22b-fp8_i2v_distilled",
  "sogni:minimax-h3-fl2va-fp8_i2v_turbo",
  "sogni:seedance-2-5",
  "sogni:minimax-h3-fl2va-fp8_flf2v_turbo",
];

let clipCounter = 0;

function clipId(): string {
  clipCounter += 1;
  return `clip_${Date.now().toString(36)}_${clipCounter.toString(36)}`;
}

/** "from prompt → to prompt", truncated — the frames carry the look; the
 * prompt carries the motion. */
function motionPrompt(from: string, to: string): string {
  const toPart = to.trim();
  const budget = Math.max(40, 236 - toPart.length);
  const fromPart = from.trim().slice(0, budget);
  return `${fromPart} → ${toPart}`.slice(0, 240);
}

export function buildClipScenes(sources: ConvertSource[]): StoryScene[] {
  const clips: StoryScene[] = [];
  for (let i = 0; i + 1 < sources.length; i += 1) {
    clips.push({
      id: clipId(),
      prompt: motionPrompt(sources[i].prompt, sources[i + 1].prompt),
      url: null,
      status: "queued",
      kind: "video",
      startImageRef: sources[i].ref,
      endImageRef: sources[i + 1].ref,
    });
  }
  return clips;
}

/**
 * The model for a conversion: the user's pick when end-capable, else the first
 * preference present in the end-capable set, else null (the button should not
 * have been offered).
 */
export function resolveEndCapableModel(
  selected: string | undefined,
  endCapableIds: Set<string>,
  availableIds: string[],
): string | null {
  if (selected && endCapableIds.has(selected)) return selected;
  for (const candidate of END_CAPABLE_MODEL_PREFERENCE) {
    if (endCapableIds.has(candidate) && availableIds.includes(candidate)) return candidate;
  }
  return null;
}
