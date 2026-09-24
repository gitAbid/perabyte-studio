import type {
  AspectKey,
  DurationKey,
  GenerationKind,
  ImageStyleKey,
  ResolutionKey,
  VideoStyleKey,
} from "./constants";
import type { TimeOfDay } from "./domain/enhancement";

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
  /** Server-created History asset id (durable jobs) — clients reuse it so
   * the optimistic row and the server row are the same record. */
  assetId?: string;
  /** True when the primary render was already produced before we answered. */
  prewarmed?: boolean;
  media: GeneratedMedia[];
  /** Set when the service swapped the model for frame capability. */
  effectiveModelId?: string;
  effectiveModelLabel?: string;
  /** True when a provided start frame actually conditioned the render. */
  frameUsed?: boolean;
}

/** Live progress tick for a story scene while its render is in flight.
 * `keyframe` is the pre-animation anchoring stage the runner sets while the
 * scene's keyframe still renders. */
export interface StorySceneProgress {
  stage: "submitted" | "rendering" | "downloading" | "keyframe";
  message: string;
  percent?: number;
}

/**
 * Structured per-scene world state (what the Writer's `plan` pass emits).
 * The prompt stays prose; this is the machine-readable half the runner
 * composes into the shot prompt and, later, resolves to reference assets.
 */
export interface SceneState {
  /** Resolved location asset; unset while only prose is known. */
  locationId?: string;
  /** Free-text location when no location asset matches yet. */
  locationText?: string;
  timeOfDay?: TimeOfDay;
  /** Who is present, keyed to the story cast; `outfit` overrides the
   * character's default for this scene only. */
  characters?: { id: string; outfit?: string }[];
  props?: string[];
}

/** Keyframe quality-gate verdict (0–1 per dimension) + free-text notes. */
export interface SceneScore {
  identity: number;
  outfit: number;
  location: number;
  notes?: string;
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
  /** Composed render prompt (anchors + state clauses) — server-side truth
   * since the runner composes it; the tile keeps the clean prompt. */
  runPrompt?: string;
  endImageRef?: string;
  /** Sparse per-scene settings overrides, merged over the story's settings at
   * render time (lib/story/scene-settings.ts). Absent = the scene follows
   * story settings exactly. */
  settings?: Partial<GenerationSettings>;
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
  /** Structured world state (location/time/cast/props) from the Writer plan. */
  state?: SceneState;
  /** Deterministic seed for this scene — derived from the story's base seed
   * once and reused across re-runs so retries differ only when asked to. */
  seed?: number;
  /** Rendered keyframe still (media-cache ref) this scene animates from. */
  keyframeRef?: string;
  /** Keyframe attempts so far (gate retries included). */
  attempts?: number;
  /** Latest quality-gate verdict for the keyframe. */
  score?: SceneScore;
}

/** Story-level consistency world: one base seed all scene seeds derive from,
 * plus the location assets this story may cut between. */
export interface StoryWorld {
  baseSeed?: number;
  locationIds?: string[];
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
  /** Free-form asset metadata; `characterIds` carries the attached cast. */
  meta?: Record<string, string | number | boolean | string[]>;
  /** Consistency world (typed — `meta` cannot hold nested objects). */
  world?: StoryWorld;
}

export interface ApiError {
  error: string;
  field?: string;
  retryable?: boolean;
  /** True when the render was detached, not lost — it will be attached later. */
  pending?: boolean;
}