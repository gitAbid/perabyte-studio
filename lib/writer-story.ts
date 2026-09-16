import { DEFAULT_IMAGE_SETTINGS, titleFromPrompt } from "@/lib/constants";
import type { Asset, StoryScene } from "@/lib/types";

/**
 * Builds the story asset the Writer hands to Story Mode. Same id scheme,
 * settings defaults and scene shape the story page uses, so the record is
 * indistinguishable from one created there (chain, cast anchors and convert
 * all apply unchanged downstream).
 */
export function createWriterStoryAsset(input: {
  title: string;
  prose: string;
  scenes: string[];
  characterIds: string[];
}): Asset {
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const scenes: StoryScene[] = input.scenes.map((prompt, index) => ({
    // The story page numbers scenes by position (`sc_<n>_<rand>`); match it
    // so a later "Add scene" on the story page never collides with these.
    id: `sc_${index + 1}_${Math.random().toString(36).slice(2, 5)}`,
    prompt,
    url: null,
    status: "queued",
    kind: "image",
  }));
  return {
    id,
    kind: "story",
    title: input.title || titleFromPrompt(input.prose),
    prompt: input.prose,
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS },
    createdAt: Date.now(),
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta: {
      continuity: true,
      running: false,
      style: DEFAULT_IMAGE_SETTINGS.style,
      characterIds: input.characterIds,
    },
  };
}
