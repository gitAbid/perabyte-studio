/**
 * Server-page payload for the advanced edit view (spec 13 §6, `/production/[projectId]/edit`).
 * A serializable snapshot derived once per request from the production read model; the client
 * re-derives ALL timeline state from the working manifest after every applied op, so nothing
 * here is a feature-local timeline model.
 */
import type { FirstCutExportSnapshot, FirstCutManifest, FirstCutTakeOption } from "@/lib/production/first-cut-view-model";

export interface EditViewData {
  projectId: string;
  projectName: string;
  /** The last persisted manifest behind the playable build; the working cut starts as this. */
  builtManifest: FirstCutManifest;
  crossfadeFrames: number;
  exportRecord: FirstCutExportSnapshot | null;
  /** Asset ids missing from local records (a rebuild would fail on them). */
  missingAssetIds: string[];
  /** Ordered shot revision ids of the project's active shot plan (planned-but-absent notice). */
  plannedShotRevisionIds: string[];
  /** Human labels by base shot revision id (visual intent). */
  shotLabels: Record<string, string>;
  /** Replacement candidates per base shot revision id (C10 replaceTake). */
  takesByBaseShot: Record<string, FirstCutTakeOption[]>;
  /** Pinned source length (frames) per manifest shot id — bounds the trim form honestly. */
  sourceFramesByShot: Record<string, number>;
  /** Known cast names (canon characters) for the NL delivery-direction router. */
  characterNames: string[];
  /** False when the compile pins needed by the C10 ops are incomplete; edits stay read-only. */
  editsAvailable: boolean;
  editsUnavailableReason: string | null;
}
