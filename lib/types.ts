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
}

export interface GeneratedMedia {
  id: string;
  url: string;
  width: number;
  height: number;
  seed: number;
}

export interface GenerationResponse {
  requestId: string;
  status: "completed";
  kind: GenerationKind;
  elapsedMs: number;
  /** True when the primary render was already produced before we answered. */
  prewarmed?: boolean;
  media: GeneratedMedia[];
}

export interface StoryScene {
  id: string;
  prompt: string;
  url: string | null;
  status: JobStatus;
  kind: GenerationKind;
  error?: string;
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
}