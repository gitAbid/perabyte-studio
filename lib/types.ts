import type {
  AspectKey,
  DurationKey,
  GenerationKind,
  ImageStyleKey,
  ResolutionKey,
  VideoStyleKey,
} from "./constants";

export type JobStatus =
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "canceled";

/**
 * One attached LoRA adapter. `strength` is a bipolar slider value — negative
 * applies the inverse effect, 0 disables — bounded by that LoRA's own
 * `ui.min`/`ui.max` in the provider catalog.
 */
export interface LoraSelection {
  loraId: string;
  strength: number;
}

export interface GenerationSettings {
  kind: GenerationKind;
  aspect: AspectKey;
  resolution: ResolutionKey;
  /** Style preset name — validated server-side against the preset tables. */
  style: string;
  duration: DurationKey;
  count: number;
  seed: string;
  negativePrompt: string;
  enhance: boolean;
  /** Provider safety checker. Regular Mode forces this on; Uncensored Mode turns it off. */
  safe?: boolean;
  /** Selected model id (`<provider>:<model>`). Falls back to the kind's default. */
  modelId?: string;
  /** Chain preset override (video stories): the model frame-carrying scenes
   * (chained or manual start frame) render with. Unset = Auto — the service
   * swaps chained scenes to the picked model's family i2v sibling. */
  chainModelId?: string;
  /** Sogni LoRA adapters (order = application order). Ignored by models
   * without LoRA support; story scenes inherit them with the settings. */
  loras?: LoraSelection[];
}

export interface GeneratedMedia {
  id: string;
  url: string;
  width: number;
  height: number;
  seed: number;
  /** Real content type when known — lets the UI pick a true video player. */
  mime?: string;
  /** Exact final-frame image (Seedance 2.5 `returnLastFrame`), cache-backed. */
  endFrameUrl?: string;
}

export interface GenerationResponse {
  requestId: string;
  status: "completed";
  kind: GenerationKind;
  elapsedMs: number;
  /** True when the primary render was already produced before we answered. */
  prewarmed?: boolean;
  media: GeneratedMedia[];
  /** Set when the service swapped the model for frame capability. */
  effectiveModelId?: string;
  effectiveModelLabel?: string;
  /** True when a provided start frame actually conditioned the render. */
  frameUsed?: boolean;
}

/** Live progress tick for a story scene while its render is in flight. */
export interface StorySceneProgress {
  stage: "submitted" | "rendering" | "downloading";
  message: string;
  percent?: number;
}

export interface StoryScene {
  id: string;
  prompt: string;
  url: string | null;
  status: JobStatus;
  kind: GenerationKind;
  error?: string;
  /** Real content type when known — lets the UI pick a true video player. */
  mime?: string;
  /** In-flight render progress; cleared once the scene completes. */
  progress?: StorySceneProgress;
  /** Manual reference frame uploaded by the user (media-cache ref). */
  startImageRef?: string;
  endImageRef?: string;
  /** Derived final frame of this scene, chaining to the next scene. */
  endFrameRef?: string;
  /** Model actually used when the service swapped for frame capability. */
  effectiveModelId?: string;
  /** Display label for `effectiveModelId` — the hidden i2v sibling isn't in
   * the picker catalog, so the tile needs the label the server resolved. */
  effectiveModelLabel?: string;
  frameUsed?: boolean;
  /** Provider safety-checker state used for this scene's render — drives 18+ masking. */
  safe?: boolean;
}

export interface Asset {
  id: string;
  kind: GenerationKind | "story";
  title: string;
  prompt: string;
  /** Primary media. For video assets this is the rendered poster frame. */
  url: string;
  variants: string[];
  posterUrl?: string;
  settings: GenerationSettings;
  createdAt: number;
  favorite: boolean;
  mode: string;
  scenes?: StoryScene[];
  meta?: Record<string, string | number | boolean>;
}

export interface ApiError {
  error: string;
  field?: string;
  retryable?: boolean;
  /** True when the render was detached, not lost — it will be attached later. */
  pending?: boolean;
}