import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IdSchema, StoryBeatSchema, type StoryRevision } from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import type { ProductionStore } from "../../repositories/production/ports";
import { createStoryRevision } from "./revisions";

/**
 * Music Video Mode (spec 18, M6-3). Constraints honored by construction:
 * - "Music sections may act as narrative beats, but should not introduce a
 *   separate Story data model" — sections become ORDINARY StoryRevision beats
 *   through the existing story service; every downstream lane (storyboard,
 *   takes, manifest, first cut) is the normal shared path.
 * - "Narration-driven timing is disabled" — shots derive targetFrames from
 *   SECTION durations (the song), never from narration length.
 * - "Manual section markers can replace failed analysis" — the analysis here
 *   is deterministic equal-splitting of the decoded duration; explicit
 *   `sections` in the command replace it wholesale.
 * - "No separate media-generation stack exists" — nothing here generates; the
 *   song is an already-imported audio asset with rights.
 * Beat-sync claims stay absent (the detector is a later spike per spec).
 */

export const ManualSectionSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  durationMs: z.number().int().safe().positive(),
});

export interface MusicVideoSection {
  readonly label: string;
  readonly startMs: number;
  readonly durationMs: number;
}

/** Deterministic equal split of the song into N sections (analysis v0). */
export function analyzeSections(songDurationMs: number, sectionCount: number, direction: string | null): MusicVideoSection[] {
  if (!Number.isSafeInteger(songDurationMs) || songDurationMs <= 0) return [];
  if (!Number.isSafeInteger(sectionCount) || sectionCount < 1 || sectionCount > 50) return [];
  const base = Math.floor(songDurationMs / sectionCount);
  const remainder = songDurationMs - base * sectionCount;
  const sections: MusicVideoSection[] = [];
  let cursor = 0;
  for (let index = 0; index < sectionCount; index += 1) {
    const durationMs = base + (index < remainder ? 1 : 0);
    sections.push({
      label: direction && index === 0 ? direction : `Section ${index + 1}`,
      startMs: cursor,
      durationMs,
    });
    cursor += durationMs;
  }
  return sections;
}

/** Section → shot frame timing at the studio's 24 fps (song-driven, never narration-driven). */
export function sectionTargetFrames(section: MusicVideoSection, fps = 24): number {
  return Math.max(24, Math.min(240 * 10, Math.round((section.durationMs / 1000) * fps)));
}

export const CreateMusicVideoStoryCommandSchema = z.strictObject({
  projectId: IdSchema,
  expectedStoryRevisionId: z.string().nullable(),
  /** The song: an already-imported audio asset with declared rights. */
  songAssetId: IdSchema,
  sectionCount: z.number().int().safe().positive().max(50).optional(),
  /** Manual markers replace the deterministic split wholesale when present. */
  sections: z.array(ManualSectionSchema).min(1).max(50).optional(),
  visualDirection: z.string().trim().max(2000).optional(),
  canonRevisionIds: z.array(IdSchema).max(500),
});

export interface MusicVideoStoryResult {
  readonly storyRevision: StoryRevision;
  readonly sections: readonly MusicVideoSection[];
  readonly targetFrames: readonly number[];
  readonly songDurationMs: number;
}

export function createMusicVideoStory(store: ProductionStore, rawCommand: unknown, options: { now?: () => number; idFactory?: () => string } = {}): MusicVideoStoryResult {
  const parsed = CreateMusicVideoStoryCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw new ProductionApplicationError("INVALID_INPUT", `Invalid music video command: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const command = parsed.data;
  const project = store.read.getProject(command.projectId);
  if (!project) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Project not found");
  if (project.activeStoryRevisionId !== command.expectedStoryRevisionId) {
    throw new ProductionApplicationError("STALE_REVISION", "Expected story revision is stale; reload the project and retry");
  }
  const song = store.read.getAsset(command.songAssetId);
  if (!song || !song.mime.startsWith("audio/")) {
    throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "The song asset is missing or is not audio.");
  }
  if (song.rightsStatus === "unknown") {
    throw new ProductionApplicationError("INVALID_INPUT", "The song's rights are undeclared; re-import it with a rights attestation before building a video on it.", { action: "Import the song again with rights declared." });
  }
  if (song.audioSamples === null || song.audioSamples <= 0) {
    throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "The song asset has no decoded duration; re-import it so the studio can measure it.");
  }
  const songDurationMs = Math.round((song.audioSamples / 48_000) * 1000);

  const sections: MusicVideoSection[] = command.sections
    ? (() => {
        let cursor = 0;
        return command.sections.map((section) => {
          const built = { label: section.label, startMs: cursor, durationMs: section.durationMs };
          cursor += section.durationMs;
          return built;
        });
      })()
    : analyzeSections(songDurationMs, command.sectionCount ?? Math.max(3, Math.min(12, Math.round(songDurationMs / 15_000))), command.visualDirection ?? null);
  if (sections.length === 0) {
    throw new ProductionApplicationError("INVALID_INPUT", "No music sections could be derived for this song.", { action: "Provide manual section markers instead." });
  }

  const beats = sections.map((section, order) => StoryBeatSchema.parse({
    id: `beat-mv-${order + 1}-${randomUUID().slice(0, 6)}`,
    action: section.label,
    narration: "",
    dialogue: [],
    order,
  }));
  const scriptText = sections
    .map((section) => `BEAT: ${section.label} [${(section.startMs / 1000).toFixed(1)}s +${(section.durationMs / 1000).toFixed(1)}s]`)
    .join("\n");
  const revision = createStoryRevision(store, {
    projectId: command.projectId,
    expectedStoryRevisionId: command.expectedStoryRevisionId,
    scriptText,
    beats: beats.map(({ order: _order, ...beat }) => beat),
    canonRevisionIds: command.canonRevisionIds,
  }, options);
  return {
    storyRevision: revision,
    sections,
    targetFrames: sections.map((section) => sectionTargetFrames(section)),
    songDurationMs,
  };
}
