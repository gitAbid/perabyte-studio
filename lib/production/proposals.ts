import { z } from 'zod';
import { recommendShotFrames, type H3FrameGrid } from './animatic';
import {
  CanonEntityKindSchema, IdSchema, PositiveFramesSchema, SchemaVersionSchema, Sha256Schema,
  ShotCastBindingSchema, UtcMillisSchema, VerbatimTextSchema,
} from './contracts';
import { validateShotPlan } from './shot-plan';

/**
 * I02-PRE script-to-story proposal domain: versioned strict DTOs, the
 * deterministic server-side speech parser and pure proposal validators.
 * Provider output is untrusted; speech ranges and text are server-owned.
 */
export const ProposalKindSchema = z.enum(['story', 'storyboard']);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;
export const SpeechKindSchema = z.enum(['dialogue', 'narration', 'unmapped']);
export type SpeechKind = z.infer<typeof SpeechKindSchema>;

export const ProposalIssueCodeSchema = z.enum([
  'AMBIGUOUS_SPEAKER', 'BEAT_ID_MISMATCH', 'CHUNK_NOT_PROCESSED', 'DIALOGUE_ON_NARRATION', 'INVENTED_DIALOGUE_LINE',
  'MISSING_DIALOGUE_LINE', 'MODEL_LIMIT_EXCEEDED', 'NO_DESIGNATED_SPEECH', 'PROVIDER_CALL_FAILED', 'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_REPAIR_EXHAUSTED', 'SEGMENT_DUPLICATED', 'SEGMENT_INVENTED', 'SEGMENT_NOT_FOUND', 'SEGMENT_TOO_LONG',
  'SHOT_INPUTS_MISSING', 'SHOT_PLAN_INVALID', 'SHOTS_NOT_PERMITTED', 'SPEAKER_MISMATCH', 'SPEAKER_NOT_IN_COVERING_SHOT',
  'SPEECH_RANGE_MISMATCH', 'SPEECH_TEXT_MISMATCH', 'SPLIT_UNICODE', 'UNKNOWN_CANON_REFERENCE', 'UNKNOWN_CANON_SPEAKER',
  'UNKNOWN_SEGMENT_MAPPING', 'UNMAPPED_SPEAKER',
]);
export type ProposalIssueCode = z.infer<typeof ProposalIssueCodeSchema>;

export const ProposalIssueSchema = z.strictObject({
  code: ProposalIssueCodeSchema,
  message: z.string().min(1).max(2000),
  chunkIndex: z.number().int().safe().nonnegative().nullable(),
  segmentId: IdSchema.nullable(),
  beatId: IdSchema.nullable(),
  shotId: IdSchema.nullable(),
});
export type ProposalIssue = z.infer<typeof ProposalIssueSchema>;

export function proposalIssue(code: ProposalIssueCode, message: string, refs: { chunkIndex?: number | null; segmentId?: string | null; beatId?: string | null; shotId?: string | null } = {}): ProposalIssue {
  return ProposalIssueSchema.parse({
    code, message, chunkIndex: refs.chunkIndex ?? null, segmentId: refs.segmentId ?? null, beatId: refs.beatId ?? null, shotId: refs.shotId ?? null,
  });
}

/** A code-unit range splits a Unicode code point when it starts or ends inside a surrogate pair. */
export function hasUnpairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

const SourceRangeFields = {
  sourceStart: z.number().int().safe().nonnegative(),
  sourceEnd: z.number().int().safe().positive(),
};
export const SpeechSegmentSchema = z.strictObject({
  segmentId: IdSchema,
  kind: SpeechKindSchema,
  characterId: IdSchema.nullable(),
  text: VerbatimTextSchema.max(20_000),
  ...SourceRangeFields,
}).refine((item) => item.sourceEnd > item.sourceStart, { path: ['sourceEnd'], message: 'Speech range end must follow its start' })
  .refine((item) => !hasUnpairedSurrogates(item.text), { message: 'Speech text contains an unpaired Unicode surrogate' });
export type SpeechSegment = z.infer<typeof SpeechSegmentSchema>;

export const SpeechMapEntrySchema = z.strictObject({
  segmentId: IdSchema,
  kind: z.enum(['dialogue', 'narration']),
  characterId: IdSchema.nullable(),
}).refine((entry) => (entry.kind === 'dialogue') === (entry.characterId !== null), {
  message: 'Dialogue mapping requires a character ID; narration mapping cannot name one',
});
export type SpeechMapEntry = z.infer<typeof SpeechMapEntrySchema>;

export type CharacterCanonEntry = { entityId: string; name: string | null };

const NARRATION_LABELS = new Set(['NARRATOR', 'NARRATION']);
const ID_SHAPED_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const ParsedScriptSchema = z.strictObject({ segments: z.array(SpeechSegmentSchema).max(10_000), issues: z.array(ProposalIssueSchema).max(10_000) });
export type ParsedScript = z.infer<typeof ParsedScriptSchema>;

/**
 * Deterministic server-side designation of source speech. Labeled
 * `SPEAKER:` lines whose label matches exactly one selected character become
 * dialogue; NARRATOR/NARRATION labels and every unlabeled line become
 * narration. Ambiguous or unknown ID-shaped labels stay unmapped so humans
 * must map them explicitly; the model never chooses what counts as speech.
 */
export function parseScriptSpeech(scriptText: string, characters: readonly CharacterCanonEntry[] = [], speechMap: readonly SpeechMapEntry[] = []): ParsedScript {
  if (hasUnpairedSurrogates(scriptText)) {
    return { segments: [], issues: [proposalIssue('SPLIT_UNICODE', 'Script contains an unpaired Unicode surrogate; boundary-splitting input is rejected')] };
  }
  const segments: SpeechSegment[] = [];
  const issues: ProposalIssue[] = [];
  const matchLabel = (label: string, character: CharacterCanonEntry) =>
    label.toLowerCase() === character.entityId.toLowerCase() || (character.name !== null && label.toLowerCase() === character.name.toLowerCase());
  let cursor = 0;
  let ordinal = 0;
  while (cursor < scriptText.length) {
    const newline = scriptText.indexOf('\n', cursor);
    const carriage = scriptText.indexOf('\r', cursor);
    const cuts = [newline, carriage].filter((index) => index !== -1).sort((left, right) => left - right);
    const cut = cuts[0] ?? -1;
    const lineEnd = cut === -1 ? scriptText.length : cut;
    const nextCursor = cut === -1 ? scriptText.length : scriptText[cut] === '\r' && scriptText[cut + 1] === '\n' ? cut + 2 : cut + 1;
    const line = scriptText.slice(cursor, lineEnd);
    if (line.trim().length > 0) {
      ordinal += 1;
      const segmentId = `speech-${ordinal}`;
      const colon = line.indexOf(':');
      const hasLabel = colon > 0 && colon <= 64;
      const label = hasLabel ? line.slice(0, colon).trim() : '';
      const valueNonEmpty = hasLabel && line.slice(colon + 1).trim().length > 0;
      const valueStart = cursor + colon + 1 + (line[colon + 1] === ' ' ? 1 : 0);
      let kind: SpeechKind = 'narration';
      let characterId: string | null = null;
      let textStart = cursor;
      if (hasLabel && valueNonEmpty && label.length > 0) {
        if (NARRATION_LABELS.has(label.toUpperCase())) {
          kind = 'narration';
          textStart = valueStart;
        } else if (ID_SHAPED_LABEL.test(label)) {
          // Speaker-candidate lines designate the value after the label as the
          // spoken text, even while unmapped, so an explicit human mapping
          // yields the real speech bytes rather than the label prefix.
          textStart = valueStart;
          const matches = characters.filter((character) => matchLabel(label, character));
          if (matches.length === 1) {
            kind = 'dialogue';
            characterId = matches[0]!.entityId;
          } else if (matches.length > 1) {
            kind = 'unmapped';
            issues.push(proposalIssue('AMBIGUOUS_SPEAKER', `Speaker label ${label} matches more than one selected character; map it explicitly`, { segmentId }));
          } else {
            kind = 'unmapped';
            issues.push(proposalIssue('UNMAPPED_SPEAKER', `Speaker label ${label} does not match a selected character; map the segment explicitly`, { segmentId }));
          }
        }
      }
      const text = scriptText.slice(textStart, lineEnd);
      if (text.length > 20_000) issues.push(proposalIssue('SEGMENT_TOO_LONG', `Line ${ordinal} exceeds the 20000-character speech segment bound and is skipped`, { segmentId }));
      else segments.push(SpeechSegmentSchema.parse({ segmentId, kind, characterId, text, sourceStart: textStart, sourceEnd: lineEnd }));
    }
    cursor = nextCursor;
  }
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const appliedMappings = new Set<string>();
  for (const entry of speechMap) {
    const target = byId.get(entry.segmentId);
    if (!target) {
      issues.push(proposalIssue('UNKNOWN_SEGMENT_MAPPING', `Speech mapping references unknown segment ${entry.segmentId}`, { segmentId: entry.segmentId }));
      continue;
    }
    if (entry.kind === 'dialogue' && !characters.some((character) => character.entityId === entry.characterId)) {
      issues.push(proposalIssue('UNKNOWN_CANON_SPEAKER', `Speech mapping names speaker ${entry.characterId}, who has no selected character canon; the segment stays unmapped`, { segmentId: entry.segmentId }));
      continue;
    }
    appliedMappings.add(entry.segmentId);
    byId.set(entry.segmentId, SpeechSegmentSchema.parse({ ...target, kind: entry.kind, characterId: entry.kind === 'dialogue' ? entry.characterId : null }));
  }
  const resolved = appliedMappings.size === 0 ? issues : issues.filter((issue) =>
    !(issue.segmentId !== null && appliedMappings.has(issue.segmentId) && (issue.code === 'UNMAPPED_SPEAKER' || issue.code === 'AMBIGUOUS_SPEAKER')));
  return { segments: segments.map((segment) => byId.get(segment.segmentId) ?? segment), issues: resolved };
}

export const chunkBeatId = (segmentId: string): string => `beat-${segmentId}`;

export type SpeechChunk = { index: number; segments: SpeechSegment[] };

/** Bounded ordered chunking by UTF-8 bytes; an oversized segment gets its own untruncated chunk. */
export function planSpeechChunks(segments: readonly SpeechSegment[], chunkMaxBytes: number): SpeechChunk[] {
  if (!Number.isSafeInteger(chunkMaxBytes) || chunkMaxBytes < 1) throw new RangeError('chunkMaxBytes must be a positive safe integer');
  const chunks: SpeechChunk[] = [];
  let current: SpeechSegment[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, segments: current });
    current = [];
    currentBytes = 0;
  };
  for (const item of segments) {
    const itemBytes = Buffer.byteLength(item.text, 'utf8');
    if (current.length > 0 && currentBytes + itemBytes > chunkMaxBytes) flush();
    current.push(item);
    currentBytes += itemBytes;
  }
  flush();
  return chunks;
}

export const PlannerDialogueLineSchema = z.strictObject({
  speechSegmentId: IdSchema,
  characterId: IdSchema,
  text: z.string().min(1).max(20_000),
  ...SourceRangeFields,
});
export const PlannerBeatSchema = z.strictObject({
  id: IdSchema,
  speechSegmentId: IdSchema,
  action: z.string().trim().min(1).max(2000),
  narration: z.string().max(20_000),
  dialogue: z.array(PlannerDialogueLineSchema).max(100),
  ...SourceRangeFields,
}).refine((beat) => beat.sourceEnd > beat.sourceStart, { path: ['sourceEnd'], message: 'Source range end must follow its start' });
export type PlannerBeat = z.infer<typeof PlannerBeatSchema>;

export const ProposedShotSchema = z.strictObject({
  shotId: IdSchema,
  beatIds: z.array(IdSchema).min(1).max(100),
  visualIntent: z.string().trim().min(1).max(2000),
  motionIntent: z.string().trim().min(1).max(2000),
  castBindings: z.array(ShotCastBindingSchema).max(3),
  locationRevisionId: IdSchema,
  propRevisionIds: z.array(IdSchema).max(100),
  styleRevisionId: IdSchema,
  framing: z.enum(['extreme_wide', 'wide', 'medium_wide', 'medium', 'close', 'extreme_close']),
  targetFrames: PositiveFramesSchema.max(100_000),
  continuation: z.literal(null),
});
export type ProposedShot = z.infer<typeof ProposedShotSchema>;

export const TextPlannerChunkOutputSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  beats: z.array(PlannerBeatSchema).min(1).max(1000),
  shots: z.array(ProposedShotSchema).max(1000).optional(),
});
export type TextPlannerChunkOutput = z.infer<typeof TextPlannerChunkOutputSchema>;

export const ProposedDialogueLineSchema = z.strictObject({
  characterId: IdSchema,
  text: VerbatimTextSchema.max(20_000),
  speechSegmentId: IdSchema,
  ...SourceRangeFields,
});
export const ProposedBeatSchema = z.strictObject({
  id: IdSchema,
  action: z.string().trim().min(1).max(2000),
  narration: z.string().max(20_000),
  dialogue: z.array(ProposedDialogueLineSchema).max(100),
  chunkIndex: z.number().int().safe().nonnegative(),
});
export type ProposedBeat = z.infer<typeof ProposedBeatSchema>;

const sameBytes = (left: string, right: string) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) === 0;

function validateSegmentBeat(item: SpeechSegment, beat: PlannerBeat, chunkIndex: number): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const range = (bound: { sourceStart: number; sourceEnd: number }) =>
    bound.sourceStart === item.sourceStart && bound.sourceEnd === item.sourceEnd;
  if (beat.id !== chunkBeatId(item.segmentId)) {
    issues.push(proposalIssue('BEAT_ID_MISMATCH', `Beat ID must be ${chunkBeatId(item.segmentId)} for segment ${item.segmentId}`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
  }
  if (!range(beat)) {
    issues.push(proposalIssue('SPEECH_RANGE_MISMATCH', `Beat range for segment ${item.segmentId} does not match the designated source range`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
  }
  if (item.kind === 'narration') {
    if (beat.dialogue.length > 0) issues.push(proposalIssue('DIALOGUE_ON_NARRATION', `Segment ${item.segmentId} is designated narration and cannot carry dialogue`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
    if (!sameBytes(beat.narration, item.text)) issues.push(proposalIssue('SPEECH_TEXT_MISMATCH', `Narration for segment ${item.segmentId} must match the designated source speech byte-for-byte`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
    return issues;
  }
  if (beat.dialogue.length === 0) {
    issues.push(proposalIssue('MISSING_DIALOGUE_LINE', `Dialogue segment ${item.segmentId} has no dialogue line`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
    return issues;
  }
  if (beat.dialogue.length > 1) {
    issues.push(proposalIssue('INVENTED_DIALOGUE_LINE', `Dialogue segment ${item.segmentId} allows exactly one line`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
    return issues;
  }
  const line = beat.dialogue[0]!;
  if (line.characterId !== item.characterId) {
    issues.push(proposalIssue('SPEAKER_MISMATCH', `Dialogue line for segment ${item.segmentId} must name speaker ${item.characterId}`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
  }
  if (!sameBytes(line.text, item.text)) {
    issues.push(proposalIssue('SPEECH_TEXT_MISMATCH', `Dialogue line for segment ${item.segmentId} must match the designated source speech byte-for-byte`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
  }
  if (!range(line)) {
    issues.push(proposalIssue('SPEECH_RANGE_MISMATCH', `Dialogue line range for segment ${item.segmentId} does not match the designated source range`, { chunkIndex, segmentId: item.segmentId, beatId: beat.id }));
  }
  return issues;
}

/** Validates one untrusted chunk output against its designated server-parsed speech. */
export function validateChunkOutput(
  chunk: SpeechChunk,
  output: TextPlannerChunkOutput,
  context: { kind: ProposalKind; chunkIndex: number },
): { beats: ProposedBeat[]; shots: ProposedShot[]; issues: ProposalIssue[] } {
  const issues: ProposalIssue[] = [];
  const beats: ProposedBeat[] = [];
  const shots = output.shots ?? [];
  const bySegment = new Map<string, PlannerBeat[]>();
  for (const beat of output.beats) {
    const list = bySegment.get(beat.speechSegmentId) ?? [];
    list.push(beat);
    bySegment.set(beat.speechSegmentId, list);
  }
  for (const [segmentId] of bySegment) {
    if (!chunk.segments.some((item) => item.segmentId === segmentId)) {
      issues.push(proposalIssue('SEGMENT_INVENTED', `Beat binds unknown speech segment ${segmentId}`, { chunkIndex: context.chunkIndex, segmentId, beatId: chunkBeatId(segmentId) }));
    }
  }
  for (const item of chunk.segments) {
    const candidates = bySegment.get(item.segmentId) ?? [];
    if (candidates.length === 0) {
      issues.push(proposalIssue('SEGMENT_NOT_FOUND', `No beat covers speech segment ${item.segmentId}`, { chunkIndex: context.chunkIndex, segmentId: item.segmentId }));
      continue;
    }
    if (candidates.length > 1) {
      issues.push(proposalIssue('SEGMENT_DUPLICATED', `Speech segment ${item.segmentId} is covered by ${candidates.length} beats`, { chunkIndex: context.chunkIndex, segmentId: item.segmentId }));
      continue;
    }
    const beat = candidates[0]!;
    issues.push(...validateSegmentBeat(item, beat, context.chunkIndex));
    beats.push(ProposedBeatSchema.parse({
      id: chunkBeatId(item.segmentId),
      action: beat.action,
      narration: item.kind === 'narration' ? item.text : beat.narration,
      dialogue: item.kind === 'dialogue'
        ? [{ characterId: item.characterId, text: item.text, speechSegmentId: item.segmentId, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd }]
        : [],
      chunkIndex: context.chunkIndex,
    }));
  }
  if (context.kind === 'storyboard' && !output.shots) {
    issues.push(proposalIssue('SHOT_INPUTS_MISSING', `Chunk ${context.chunkIndex} is missing required shot inputs`, { chunkIndex: context.chunkIndex }));
  }
  if (context.kind === 'story' && shots.length > 0) {
    issues.push(proposalIssue('SHOTS_NOT_PERMITTED', 'Story proposals cannot include shot inputs', { chunkIndex: context.chunkIndex }));
  }
  return { beats, shots, issues };
}

export type CanonRef = { canonRevisionId: string; entityId: string; entityKind: z.infer<typeof CanonEntityKindSchema> };
export const ProposalAdvisorySchema = z.strictObject({ shotId: IdSchema, note: z.string().min(1).max(2000) });
export type ProposalAdvisory = z.infer<typeof ProposalAdvisorySchema>;

const H3_LEGAL_FRAME_GRID: H3FrameGrid = { baseFrames: 124, stepFrames: 17, maxFrames: 362 };

/** Validates aggregated storyboard shots with the C05 validator, selected-canon truth and the H3 frame grid. */
export function validateStoryboardProposal(input: {
  beats: readonly ProposedBeat[];
  shots: readonly ProposedShot[];
  canonById: ReadonlyMap<string, CanonRef>;
  maxShots: number;
  frameGrid?: H3FrameGrid | null;
}): { issues: ProposalIssue[]; advisories: ProposalAdvisory[] } {
  const issues: ProposalIssue[] = [];
  const advisories: ProposalAdvisory[] = [];
  const storyBeats = input.beats.map((beat, order) => ({
    id: beat.id, action: beat.action, narration: beat.narration,
    dialogue: beat.dialogue.map((line) => ({ characterId: line.characterId, text: line.text })), order,
  }));
  const coverage = validateShotPlan(storyBeats, input.shots.map((shot) => ({ shotId: shot.shotId, beatIds: shot.beatIds, targetFrames: shot.targetFrames })), input.maxShots);
  for (const issue of coverage.issues) {
    issues.push(proposalIssue('SHOT_PLAN_INVALID', issue.message, { beatId: issue.beatId ?? null, shotId: issue.shotId ?? null }));
  }
  const requireCanon = (expected: CanonRef['entityKind'], shotId: string, id: string) => {
    const ref = input.canonById.get(id);
    if (!ref || ref.entityKind !== expected) {
      issues.push(proposalIssue('UNKNOWN_CANON_REFERENCE', `Shot ${shotId} references unknown or wrong-kind canon revision ${id}; expected ${expected}`, { shotId }));
    }
  };
  for (const shot of input.shots) {
    requireCanon('location', shot.shotId, shot.locationRevisionId);
    requireCanon('style', shot.shotId, shot.styleRevisionId);
    for (const propId of shot.propRevisionIds) requireCanon('prop', shot.shotId, propId);
    for (const binding of shot.castBindings) {
      const ref = input.canonById.get(binding.canonRevisionId);
      if (!ref || ref.entityKind !== 'character' || ref.entityId !== binding.characterId) {
        issues.push(proposalIssue('UNKNOWN_CANON_REFERENCE', `Shot ${shot.shotId} casts ${binding.characterId} through unknown character revision ${binding.canonRevisionId}`, { shotId: shot.shotId }));
      }
    }
  }
  for (const beat of input.beats) {
    for (const line of beat.dialogue) {
      const covering = input.shots.filter((shot) => shot.beatIds.includes(beat.id));
      if (!covering.some((shot) => shot.castBindings.some((binding) => binding.characterId === line.characterId))) {
        issues.push(proposalIssue('SPEAKER_NOT_IN_COVERING_SHOT', `Dialogue speaker ${line.characterId} in beat ${beat.id} has no covering shot cast binding`, { beatId: beat.id, segmentId: line.speechSegmentId }));
      }
    }
  }
  const grid = input.frameGrid === undefined ? H3_LEGAL_FRAME_GRID : input.frameGrid;
  if (grid) {
    for (const shot of input.shots) {
      const recommendation = recommendShotFrames({ targetFrames: shot.targetFrames, legalGrid: grid });
      if (recommendation.plannedFrames !== shot.targetFrames) {
        advisories.push(ProposalAdvisorySchema.parse({ shotId: shot.shotId, note: recommendation.adjustmentNote ?? `Shot ${shot.shotId} requires a visible frame-grid adjustment; creator approval is required.` }));
      }
    }
  }
  return { issues, advisories };
}

export const CanonPinSchema = z.strictObject({
  canonRevisionId: IdSchema,
  entityId: IdSchema,
  entityKind: CanonEntityKindSchema,
  contentHash: Sha256Schema,
});
export type CanonPin = z.infer<typeof CanonPinSchema>;

export const CreateStoryProposalCommandSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  projectId: IdSchema,
  kind: ProposalKindSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  scriptText: z.string().min(1).max(500_000).refine((value) => value.trim().length > 0, 'Script text cannot be whitespace only'),
  expectedCanonRevisionIds: z.array(IdSchema).max(500),
  expectedStoryRevisionId: IdSchema.nullable(),
  speechMap: z.array(SpeechMapEntrySchema).max(10_000).optional(),
  maxShots: z.number().int().safe().min(1).max(10_000).optional(),
  chunkMaxBytes: z.number().int().safe().min(200).max(100_000).optional(),
});
export type CreateStoryProposalCommand = z.infer<typeof CreateStoryProposalCommandSchema>;

export const StoryProposalResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  proposalId: IdSchema,
  projectId: IdSchema,
  kind: ProposalKindSchema,
  providerId: IdSchema,
  modelId: IdSchema,
  scriptSha256: Sha256Schema,
  canonPins: z.array(CanonPinSchema).max(500),
  expectedStoryRevisionId: IdSchema.nullable(),
  segments: z.array(SpeechSegmentSchema).max(10_000),
  chunks: z.strictObject({ planned: z.number().int().safe().nonnegative(), completed: z.number().int().safe().nonnegative() })
    .refine((chunks) => chunks.completed <= chunks.planned, 'Completed chunks cannot exceed planned chunks'),
  beats: z.array(ProposedBeatSchema).max(10_000),
  shots: z.array(ProposedShotSchema).max(10_000),
  advisories: z.array(ProposalAdvisorySchema).max(10_000),
  issues: z.array(ProposalIssueSchema).max(10_000),
  completeness: z.boolean(),
  contentHash: Sha256Schema,
  createdAt: UtcMillisSchema,
}).superRefine((result, ctx) => {
  if (result.completeness && (result.issues.length > 0 || result.chunks.completed !== result.chunks.planned || result.beats.length === 0 || result.segments.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['completeness'], message: 'Completeness requires zero issues, all chunks validated and full designated speech coverage' });
  }
});
export type StoryProposalResult = z.infer<typeof StoryProposalResultSchema>;
