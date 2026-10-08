import { z } from 'zod';
import { IdSchema, Sha256Schema, type Scene, type StoryRevision } from '../../production/contracts';
import { ProductionApplicationError, type ProductionErrorCode } from '../../production/errors';
import { chunkBeatId, parseScriptSpeech, type CharacterCanonEntry } from '../../production/proposals';
import { composeRevisionScriptText, splitRevisionInstruction } from '../../production/story-view-model';
import type { ProductionStore } from '../../repositories/production/ports';
import { createStoryRevision, type RevisionServiceOptions } from './revisions';

/**
 * F3 deterministic story revise (spec 08 §6). Composes one revise proposal from the creator's
 * instruction WITHOUT any AI provider call — the provider pass lands later through the frozen
 * proposals route — and applies it as a NEW StoryRevision child in the existing content-hash
 * chain via the accepted `createStoryRevision` service. Provenance rides the frozen convention:
 * `parentRevisionId` plus the instruction carried in `scriptText` behind the visible
 * `[revision request]` marker (lib/production/story-view-model.ts), so every revision stays
 * auditable inside the frozen contract.
 *
 * Optimistic concurrency is fail-closed on both pins: the caller must name the exact base
 * revision AND its content hash (`expectedBaseContentHash`), and the base must still be the
 * project's active revision. Any mismatch is STALE_REVISION — nothing partial is written.
 *
 * `changedSceneIds` locates the scenes whose stored content the instruction touches, so a later
 * provider pass (or the creator) knows what to re-pin to the new revision. Matching is purely
 * deterministic: quoted instruction spans, `beat-speech-N` references resolved through the
 * frozen speech parser, and exact scene-title mentions. It never guesses beyond exact text.
 */

export const StoryReviseCommandSchema = z.strictObject({
  projectId: IdSchema,
  baseStoryRevisionId: IdSchema,
  expectedBaseContentHash: Sha256Schema,
  instruction: z.string().max(2000).refine((value) => value.trim().length > 0, 'Instruction cannot be whitespace only'),
});
export type StoryReviseCommand = z.infer<typeof StoryReviseCommandSchema>;

export type StoryReviseResult = Readonly<{
  /** The applied revision: a NEW child of the base, or the base itself when the exact instruction was already applied (idempotent replay). */
  storyRevision: StoryRevision;
  /** Scenes pinned to the base revision whose content the instruction deterministically references. */
  changedSceneIds: string[];
}>;

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }

function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('INVALID_INPUT', `Invalid ${label}: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  return result.data;
}

const QUOTE_PATTERNS = [/“([^”]{1,300})”/g, /"([^"]{1,300})"/g, /«([^»]{1,300})»/g] as const;
const BEAT_REFERENCE = /\bbeat-(speech-\d+)\b/g;
const MIN_NEEDLE_CHARS = 4;
/** Segment text below this length is a locator but never a scene needle (too easy to collide). */
const MIN_SCENE_NEEDLE_CHARS = 8;

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

export type ReviseTargets = Readonly<{ referencedSegmentIds: string[]; changedSceneIds: string[] }>;

/**
 * Deterministic instruction→content locator. Quoted instruction spans (curly, straight and
 * guillemet quotes) and `beat-speech-N` references select speech segments of the base script
 * through the frozen parser; a scene changes when a quoted span, a referenced segment's text,
 * or the scene's own title appears in its stored content. Never throws on text content —
 * unparsable input simply locates nothing.
 */
export function locateReviseTargets(input: {
  baseStory: Pick<StoryRevision, 'scriptText'>;
  instruction: string;
  characters: readonly CharacterCanonEntry[];
  scenes: readonly Scene[];
}): ReviseTargets {
  const instruction = typeof input.instruction === 'string' ? input.instruction : '';
  const instructionText = normalizeText(instruction);
  const quoted = new Set<string>();
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of instruction.matchAll(pattern)) {
      const span = normalizeText(match[1] ?? '');
      if (span.length >= MIN_NEEDLE_CHARS) quoted.add(span);
    }
  }
  const beatRefs = new Set<string>();
  for (const match of instruction.matchAll(BEAT_REFERENCE)) beatRefs.add(match[1] ?? '');
  let segments: ReturnType<typeof parseScriptSpeech>['segments'] = [];
  try {
    segments = parseScriptSpeech(input.baseStory.scriptText, [...input.characters]).segments;
  } catch {
    segments = [];
  }
  const referenced = new Set<string>();
  const sceneNeedles = new Set<string>();
  for (const segment of segments) {
    const text = normalizeText(segment.text);
    if (text.length === 0) continue;
    const hit = beatRefs.has(segment.segmentId) || [...quoted].some((span) => span.includes(text) || text.includes(span));
    if (!hit) continue;
    referenced.add(segment.segmentId);
    if (text.length >= MIN_SCENE_NEEDLE_CHARS) sceneNeedles.add(text);
  }
  const changedSceneIds: string[] = [];
  for (const scene of input.scenes) {
    const title = normalizeText(scene.title);
    const content = normalizeText([scene.title, scene.action, ...scene.dialogue.map((line) => line.text)].join('\n'));
    const titleHit = title.length >= MIN_NEEDLE_CHARS && instructionText.includes(title);
    const hit = titleHit || [...quoted].some((span) => content.includes(span)) || [...sceneNeedles].some((needle) => content.includes(needle));
    if (hit) changedSceneIds.push(scene.id);
  }
  return { referencedSegmentIds: [...referenced], changedSceneIds };
}

/**
 * Applies one deterministic revise: locates the referenced scenes/segments, composes the marked
 * script text and hands the exact child revision to the accepted `createStoryRevision` service
 * (which re-validates the active-revision pin inside its own transaction). An exact replay —
 * the base revision was itself produced by this very instruction — resolves to the base
 * revision instead of stacking identical children, so a double press stays one revision.
 * Returns the applied revision plus the located scene ids.
 */
export function applyStoryRevise(store: ProductionStore, raw: StoryReviseCommand, options: RevisionServiceOptions = {}): StoryReviseResult {
  const command = parsed(StoryReviseCommandSchema, raw, 'story revise command');
  const read = store.read;
  const project = read.getProject(command.projectId);
  if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
  const base = read.getStoryRevision(command.baseStoryRevisionId);
  if (!base || base.projectId !== project.id) fail('UNKNOWN_REFERENCE', 'Base story revision does not belong to this project');
  if (base.contentHash !== command.expectedBaseContentHash) fail('STALE_REVISION', 'The story revision changed since you loaded it; reload and retry');
  if (project.activeStoryRevisionId !== base.id) fail('STALE_REVISION', 'The active story moved on since you loaded it; reload and retry');
  const characters = read.listCanonRevisions(base.canonRevisionIds)
    .filter((revision) => revision.entityKind === 'character')
    .map((revision) => ({ entityId: revision.entityId, name: null }));
  const scenes = read.listScenes(project.id, base.id);
  const targets = locateReviseTargets({ baseStory: base, instruction: command.instruction, characters, scenes });
  if (splitRevisionInstruction(base.scriptText).instruction === command.instruction) {
    return { storyRevision: base, changedSceneIds: targets.changedSceneIds };
  }
  const composed = composeRevisionScriptText({ baseScript: base.scriptText, instruction: command.instruction });
  if (!composed.ok) fail('INVALID_INPUT', composed.reason);
  const storyRevision = createStoryRevision(store, {
    projectId: project.id,
    expectedStoryRevisionId: base.id,
    scriptText: composed.text,
    beats: base.beats.map(({ order: _order, ...beat }) => beat),
    canonRevisionIds: [...base.canonRevisionIds],
  }, options);
  return { storyRevision, changedSceneIds: targets.changedSceneIds };
}

/** The beat id the frozen proposals vocabulary assigns to one parsed speech segment. */
export const reviseBeatIdForSegment = chunkBeatId;
