import { describe, expect, it } from 'vitest';
import {
  CreateStoryProposalCommandSchema,
  StoryProposalResultSchema,
  TextPlannerChunkOutputSchema,
  chunkBeatId,
  hasUnpairedSurrogates,
  parseScriptSpeech,
  planSpeechChunks,
  validateChunkOutput,
  validateStoryboardProposal,
  type CanonRef,
  type ProposedBeat,
  type ProposedShot,
  type SpeechSegment,
  type TextPlannerChunkOutput,
} from './proposals';

const characters = [
  { entityId: 'pip', name: 'Pip' },
  { entityId: 'moss', name: 'Moss' },
];

const SCRIPT = [
  'NARRATOR: The clearing held its breath.',
  'pip: I found it — the lantern! বাতি 🏮',
  'Plain heading with colon: still narration.',
  'moss: Then we run.',
  '',
  '  ',
].join('\n');

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const sameBytes = (left: string, right: string) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) === 0;

const segment = (overrides: Partial<SpeechSegment> & { segmentId: string; text: string; sourceStart: number; sourceEnd: number }): SpeechSegment => ({
  kind: 'narration', characterId: null, ...overrides,
});

function beatForSegment(item: SpeechSegment, overrides: Record<string, unknown> = {}) {
  const base = item.kind === 'dialogue'
    ? {
      id: chunkBeatId(item.segmentId), speechSegmentId: item.segmentId, action: `Action for ${item.segmentId}`,
      narration: '', sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
      dialogue: [{ speechSegmentId: item.segmentId, characterId: item.characterId!, text: item.text, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd }],
    }
    : {
      id: chunkBeatId(item.segmentId), speechSegmentId: item.segmentId, action: `Action for ${item.segmentId}`,
      narration: item.text, dialogue: [], sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
    };
  return { ...base, ...overrides };
}

const outputFor = (items: readonly SpeechSegment[], overrides: Record<string, unknown> = {}): TextPlannerChunkOutput =>
  ({ schemaVersion: 1, beats: items.map((item) => beatForSegment(item)), ...overrides });

describe('parseScriptSpeech', () => {
  it('parses labeled narration, labeled dialogue and plain narration with exact source ranges', () => {
    const parsed = parseScriptSpeech(SCRIPT, characters);
    expect(parsed.issues).toEqual([]);
    expect(parsed.segments.map((item) => [item.segmentId, item.kind, item.characterId])).toEqual([
      ['speech-1', 'narration', null], ['speech-2', 'dialogue', 'pip'], ['speech-3', 'narration', null], ['speech-4', 'dialogue', 'moss'],
    ]);
    expect(parsed.segments[1]!.text).toBe('I found it — the lantern! বাতি 🏮');
    expect(parsed.segments[2]!.text).toBe('Plain heading with colon: still narration.');
    for (const item of parsed.segments) expect(SCRIPT.slice(item.sourceStart, item.sourceEnd)).toBe(item.text);
    const designated = parsed.segments.map((item) => item.text);
    expect(sameBytes(designated.join('\n'), [
      'The clearing held its breath.', 'I found it — the lantern! বাতি 🏮', 'Plain heading with colon: still narration.', 'Then we run.',
    ].join('\n'))).toBe(true);
  });

  it('matches speaker labels case-insensitively against entity IDs and canon display names', () => {
    const parsed = parseScriptSpeech('Pip: Hi.\nMOSS: Hello.', characters);
    expect(parsed.segments.map((item) => item.characterId)).toEqual(['pip', 'moss']);
  });

  it('keeps unknown or ambiguous labels unmapped with visible issues', () => {
    const unknown = parseScriptSpeech('NARRATOR: quiet.\nLANTERN: glow', characters);
    expect(unknown.segments[1]!.kind).toBe('unmapped');
    expect(unknown.segments[1]!.text).toBe('glow');
    expect(unknown.issues).toEqual([expect.objectContaining({ code: 'UNMAPPED_SPEAKER', segmentId: 'speech-2' })]);

    const ambiguous = parseScriptSpeech('Spark: boom', [{ entityId: 'a', name: 'Spark' }, { entityId: 'b', name: 'Spark' }]);
    expect(ambiguous.segments[0]!.kind).toBe('unmapped');
    expect(ambiguous.issues.map((issue) => issue.code)).toEqual(['AMBIGUOUS_SPEAKER']);
  });

  it('defaults plain narration scripts to narration segments', () => {
    const parsed = parseScriptSpeech('The wind rises.\nIt settles.', characters);
    expect(parsed.issues).toEqual([]);
    expect(parsed.segments.map((item) => item.kind)).toEqual(['narration', 'narration']);
  });

  it('applies explicit human speech mapping overrides and reports unknown mapping IDs', () => {
    const mapped = parseScriptSpeech('NARRATOR: quiet.\nLANTERN: glow', characters, [
      { segmentId: 'speech-2', kind: 'dialogue', characterId: 'moss' },
    ]);
    expect(mapped.segments[1]).toMatchObject({ kind: 'dialogue', characterId: 'moss', text: 'glow' });
    expect(mapped.issues).toEqual([]);

    const toNarration = parseScriptSpeech('pip: Hi.', characters, [{ segmentId: 'speech-1', kind: 'narration', characterId: null }]);
    expect(toNarration.segments[0]).toMatchObject({ kind: 'narration', characterId: null });
    expect(toNarration.issues).toEqual([]);

    const unknownMapping = parseScriptSpeech('pip: Hi.', characters, [{ segmentId: 'speech-9', kind: 'narration', characterId: null }]);
    expect(unknownMapping.issues).toEqual([expect.objectContaining({ code: 'UNKNOWN_SEGMENT_MAPPING', segmentId: 'speech-9' })]);
  });

  it('rejects script text that splits Unicode surrogate boundaries', () => {
    expect(parseScriptSpeech('pip: ok \uD800', characters).issues.map((issue) => issue.code)).toEqual(['SPLIT_UNICODE']);
    expect(parseScriptSpeech('narration \uDC00 tail', characters).issues.map((issue) => issue.code)).toEqual(['SPLIT_UNICODE']);
    expect(hasUnpairedSurrogates('lantern 🏮')).toBe(false);
    expect(hasUnpairedSurrogates('lantern \uD83C')).toBe(true);
  });

  it('skips blank lines while keeping stable segment ordinals', () => {
    const parsed = parseScriptSpeech('first.\n\n  \nsecond.', characters);
    expect(parsed.segments.map((item) => item.segmentId)).toEqual(['speech-1', 'speech-2']);
  });

  it('reconstructs CRLF-separated speech byte-exactly across the CR-LF boundaries', () => {
    const crlf = 'NARRATOR: Dawn breaks.\r\npip: Ready.\r\n';
    const parsed = parseScriptSpeech(crlf, characters);
    expect(parsed.issues).toEqual([]);
    expect(parsed.segments.map((item) => item.kind)).toEqual(['narration', 'dialogue']);
    expect(parsed.segments[1]).toMatchObject({ characterId: 'pip', text: 'Ready.' });
    for (const item of parsed.segments) expect(crlf.slice(item.sourceStart, item.sourceEnd)).toBe(item.text);
    expect(crlf.slice(parsed.segments[0]!.sourceEnd, parsed.segments[0]!.sourceEnd + 2)).toBe('\r\n');
    expect(crlf.slice(parsed.segments[1]!.sourceEnd, parsed.segments[1]!.sourceEnd + 2)).toBe('\r\n');
    expect(sameBytes(parsed.segments.map((item) => crlf.slice(item.sourceStart, item.sourceEnd)).join('|'), 'Dawn breaks.|Ready.')).toBe(true);
  });

  it('rejects dialogue mappings that name a speaker outside the selected canon', () => {
    const unknownSpeaker = parseScriptSpeech('LANTERN: glow', characters, [{ segmentId: 'speech-1', kind: 'dialogue', characterId: 'ghost' }]);
    expect(unknownSpeaker.segments[0]).toMatchObject({ kind: 'unmapped', characterId: null });
    expect(unknownSpeaker.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_CANON_SPEAKER', segmentId: 'speech-1' }),
      expect.objectContaining({ code: 'UNMAPPED_SPEAKER', segmentId: 'speech-1' }),
    ]));
    const knownSpeaker = parseScriptSpeech('LANTERN: glow', characters, [{ segmentId: 'speech-1', kind: 'dialogue', characterId: 'moss' }]);
    expect(knownSpeaker.segments[0]).toMatchObject({ kind: 'dialogue', characterId: 'moss' });
    expect(knownSpeaker.issues).toEqual([]);
  });

  it('rejects a line whose speech exceeds the segment text bound', () => {
    const parsed = parseScriptSpeech(`pip: ${'x'.repeat(20_001)}`, characters);
    expect(parsed.segments).toEqual([]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['SEGMENT_TOO_LONG']);
  });
});

describe('planSpeechChunks', () => {
  const items = [
    segment({ segmentId: 'speech-1', text: 'abcdefgh', sourceStart: 0, sourceEnd: 8 }),
    segment({ segmentId: 'speech-2', text: 'ijklmnop', sourceStart: 9, sourceEnd: 17 }),
    segment({ segmentId: 'speech-3', text: 'qrstuvwxyz', sourceStart: 18, sourceEnd: 28 }),
  ];

  it('bounds chunks by UTF-8 bytes while preserving ordered coverage', () => {
    const chunks = planSpeechChunks(items, 20);
    expect(chunks.map((chunk) => chunk.segments.map((item) => item.segmentId))).toEqual([['speech-1', 'speech-2'], ['speech-3']]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks.flatMap((chunk) => chunk.segments)).toEqual(items);
    for (const chunk of chunks) {
      const total = chunk.segments.reduce((sum, item) => sum + bytes(item.text), 0);
      expect(chunk.segments.length === 1 || total <= 20).toBe(true);
    }
  });

  it('gives an oversized single segment its own chunk without truncation', () => {
    const oversized = [segment({ segmentId: 'speech-1', text: 'x'.repeat(50), sourceStart: 0, sourceEnd: 50 }), ...items];
    const chunks = planSpeechChunks(oversized, 20);
    expect(chunks[0]!.segments.map((item) => item.segmentId)).toEqual(['speech-1']);
    expect(chunks[0]!.segments[0]!.text).toBe('x'.repeat(50));
    expect(chunks).toEqual(planSpeechChunks(oversized, 20));
  });
});

describe('chunkBeatId', () => {
  it('derives stable beat IDs from segment IDs', () => {
    expect(chunkBeatId('speech-3')).toBe('beat-speech-3');
  });
});

describe('validateChunkOutput', () => {
  const parsed = parseScriptSpeech(SCRIPT, characters);
  const chunk = { index: 2, segments: parsed.segments };

  it('accepts byte-exact beat output and binds every segment exactly once in order', () => {
    const result = validateChunkOutput(chunk, outputFor(parsed.segments), { kind: 'story', chunkIndex: 2 });
    expect(result.issues).toEqual([]);
    expect(result.beats.map((beat) => beat.id)).toEqual(parsed.segments.map((item) => chunkBeatId(item.segmentId)));
    expect(result.beats.every((beat) => beat.chunkIndex === 2)).toBe(true);
    expect(sameBytes(result.beats[1]!.dialogue[0]!.text, parsed.segments[1]!.text)).toBe(true);
    expect(result.shots).toEqual([]);
  });

  it('reports omitted, duplicated and invented speech deterministically', () => {
    const omitted = validateChunkOutput(chunk, outputFor(parsed.segments.slice(1)), { kind: 'story', chunkIndex: 0 });
    expect(omitted.issues.map((issue) => issue.code)).toContain('SEGMENT_NOT_FOUND');
    const duplicated = validateChunkOutput(chunk, outputFor([...parsed.segments, parsed.segments[1]!]), { kind: 'story', chunkIndex: 0 });
    expect(duplicated.issues.map((issue) => issue.code)).toContain('SEGMENT_DUPLICATED');
    const invented = validateChunkOutput(chunk, outputFor([...parsed.segments, segment({ segmentId: 'speech-9', text: 'invented', sourceStart: 0, sourceEnd: 8 })]), { kind: 'story', chunkIndex: 0 });
    expect(invented.issues.map((issue) => issue.code)).toContain('SEGMENT_INVENTED');
  });

  it('rejects wrong beat IDs, altered speech, wrong ranges, speaker mismatches and stray dialogue', () => {
    const wrongId = validateChunkOutput(chunk, outputFor(parsed.segments, { beats: [beatForSegment(parsed.segments[0]!, { id: 'beat-other' }), ...parsed.segments.slice(1).map((item) => beatForSegment(item))] }), { kind: 'story', chunkIndex: 0 });
    expect(wrongId.issues.map((issue) => issue.code)).toContain('BEAT_ID_MISMATCH');

    const alteredNarration = validateChunkOutput(chunk, outputFor(parsed.segments, { beats: [beatForSegment(parsed.segments[0]!, { narration: 'changed' }), ...parsed.segments.slice(1).map((item) => beatForSegment(item))] }), { kind: 'story', chunkIndex: 0 });
    expect(alteredNarration.issues.map((issue) => issue.code)).toContain('SPEECH_TEXT_MISMATCH');

    const dialogue = parsed.segments[1]!;
    const wrongRange = validateChunkOutput(chunk, outputFor(parsed.segments, {
      beats: [beatForSegment(parsed.segments[0]!), beatForSegment(dialogue, { dialogue: [{ speechSegmentId: dialogue.segmentId, characterId: dialogue.characterId, text: dialogue.text, sourceStart: dialogue.sourceStart + 1, sourceEnd: dialogue.sourceEnd }] }), ...parsed.segments.slice(2).map((item) => beatForSegment(item))],
    }), { kind: 'story', chunkIndex: 0 });
    expect(wrongRange.issues.map((issue) => issue.code)).toContain('SPEECH_RANGE_MISMATCH');

    const wrongSpeaker = validateChunkOutput(chunk, outputFor(parsed.segments, {
      beats: [beatForSegment(parsed.segments[0]!), beatForSegment(dialogue, { dialogue: [{ speechSegmentId: dialogue.segmentId, characterId: 'moss', text: dialogue.text, sourceStart: dialogue.sourceStart, sourceEnd: dialogue.sourceEnd }] }), ...parsed.segments.slice(2).map((item) => beatForSegment(item))],
    }), { kind: 'story', chunkIndex: 0 });
    expect(wrongSpeaker.issues.map((issue) => issue.code)).toContain('SPEAKER_MISMATCH');

    const alteredDialogue = validateChunkOutput(chunk, outputFor(parsed.segments, {
      beats: [beatForSegment(parsed.segments[0]!), beatForSegment(dialogue, { dialogue: [{ speechSegmentId: dialogue.segmentId, characterId: dialogue.characterId, text: `${dialogue.text}!`, sourceStart: dialogue.sourceStart, sourceEnd: dialogue.sourceEnd }] }), ...parsed.segments.slice(2).map((item) => beatForSegment(item))],
    }), { kind: 'story', chunkIndex: 0 });
    expect(alteredDialogue.issues.map((issue) => issue.code)).toContain('SPEECH_TEXT_MISMATCH');

    const extraLine = validateChunkOutput(chunk, outputFor(parsed.segments, {
      beats: [beatForSegment(parsed.segments[0]!), beatForSegment(dialogue, { dialogue: [
        { speechSegmentId: dialogue.segmentId, characterId: dialogue.characterId, text: dialogue.text, sourceStart: dialogue.sourceStart, sourceEnd: dialogue.sourceEnd },
        { speechSegmentId: dialogue.segmentId, characterId: dialogue.characterId, text: 'invented', sourceStart: dialogue.sourceStart, sourceEnd: dialogue.sourceEnd },
      ] }), ...parsed.segments.slice(2).map((item) => beatForSegment(item))],
    }), { kind: 'story', chunkIndex: 0 });
    expect(extraLine.issues.map((issue) => issue.code)).toContain('INVENTED_DIALOGUE_LINE');

    const narrationBeat = parsed.segments[0]!;
    const strayDialogue = validateChunkOutput(chunk, outputFor(parsed.segments, { beats: [beatForSegment(narrationBeat, { dialogue: [{ speechSegmentId: narrationBeat.segmentId, characterId: 'pip', text: 'line', sourceStart: narrationBeat.sourceStart, sourceEnd: narrationBeat.sourceEnd }] }), ...parsed.segments.slice(1).map((item) => beatForSegment(item))] }), { kind: 'story', chunkIndex: 0 });
    expect(strayDialogue.issues.map((issue) => issue.code)).toContain('DIALOGUE_ON_NARRATION');

    const missingLine = validateChunkOutput(chunk, outputFor(parsed.segments, { beats: [beatForSegment(parsed.segments[0]!), beatForSegment(dialogue, { dialogue: [] }), ...parsed.segments.slice(2).map((item) => beatForSegment(item))] }), { kind: 'story', chunkIndex: 0 });
    expect(missingLine.issues.map((issue) => issue.code)).toContain('MISSING_DIALOGUE_LINE');
  });

  it('requires shot inputs for storyboard chunks and forbids them on story chunks', () => {
    const missingShots = validateChunkOutput(chunk, outputFor(parsed.segments), { kind: 'storyboard', chunkIndex: 0 });
    expect(missingShots.issues.map((issue) => issue.code)).toContain('SHOT_INPUTS_MISSING');
    const storyShots = validateChunkOutput(chunk, { ...outputFor(parsed.segments), shots: [shotFor(parsed.segments[0]!)] }, { kind: 'story', chunkIndex: 0 });
    expect(storyShots.issues.map((issue) => issue.code)).toContain('SHOTS_NOT_PERMITTED');
  });
});

function shotFor(item: SpeechSegment, overrides: Record<string, unknown> = {}): ProposedShot {
  return {
    shotId: `shot-${item.segmentId}`, beatIds: [chunkBeatId(item.segmentId)], visualIntent: 'Show the clearing', motionIntent: 'Slow push in',
    castBindings: item.kind === 'dialogue' ? [{ characterId: item.characterId!, canonRevisionId: item.characterId === 'pip' ? 'char-r1' : 'char-r2', wardrobe: 'travel cloak' }] : [],
    locationRevisionId: 'location-r1', propRevisionIds: [], styleRevisionId: 'style-r1', framing: 'medium', targetFrames: 124, continuation: null,
    ...overrides,
  };
}

describe('validateStoryboardProposal', () => {
  const canonById = new Map<string, CanonRef>([
    ['char-r1', { canonRevisionId: 'char-r1', entityId: 'pip', entityKind: 'character' }],
    ['char-r2', { canonRevisionId: 'char-r2', entityId: 'moss', entityKind: 'character' }],
    ['location-r1', { canonRevisionId: 'location-r1', entityId: 'clearing', entityKind: 'location' }],
    ['style-r1', { canonRevisionId: 'style-r1', entityId: 'paper', entityKind: 'style' }],
  ]);
  const lines = [
    'NARRATOR: The forest road opens beneath a paper sky.',
    'pip: The lantern is ready — follow me!',
    'NARRATOR: Moss steadies the pack and listens.',
    'moss: Then we run before the light fails.',
    'NARRATOR: Branches close behind them like water.',
    'pip: Keep to the stones; the moss remembers.',
    'NARRATOR: The clearing breathes once and waits.',
  ];
  const parsed = parseScriptSpeech(lines.join('\n'), characters);
  const chunk = { index: 0, segments: parsed.segments };
  const validated = validateChunkOutput(chunk, outputFor(parsed.segments), { kind: 'story', chunkIndex: 0 });
  const shots = parsed.segments.map((item) => shotFor(item, { targetFrames: 124 }));

  it('accepts more than six fully covered shots on the selected canon', () => {
    const result = validateStoryboardProposal({ beats: validated.beats, shots, canonById, maxShots: 10_000 });
    expect(result.issues).toEqual([]);
    expect(result.advisories).toEqual([]);
    expect(shots.length).toBeGreaterThan(6);
  });

  it('reports unknown canon references and speaker coverage gaps with exact IDs', () => {
    const unknown = validateStoryboardProposal({ beats: validated.beats, shots: [shotFor(parsed.segments[0]!, { locationRevisionId: 'location-unknown' }), ...shots.slice(1)], canonById, maxShots: 10_000 });
    expect(unknown.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_CANON_REFERENCE', shotId: `shot-${parsed.segments[0]!.segmentId}` }));

    const wrongKind = validateStoryboardProposal({ beats: validated.beats, shots: [shotFor(parsed.segments[0]!, { locationRevisionId: 'char-r1' }), ...shots.slice(1)], canonById, maxShots: 10_000 });
    expect(wrongKind.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_CANON_REFERENCE' }));

    const unmappedSpeaker = validateChunkOutput(chunk, {
      schemaVersion: 1,
      beats: parsed.segments.map((item) => beatForSegment(item)),
      shots: parsed.segments.map((item) => shotFor(item, { castBindings: [], targetFrames: 124 })),
    }, { kind: 'storyboard', chunkIndex: 0 });
    const withShots = validateStoryboardProposal({ beats: unmappedSpeaker.beats, shots: unmappedSpeaker.shots, canonById, maxShots: 10_000 });
    expect(withShots.issues.filter((issue) => issue.code === 'SPEAKER_NOT_IN_COVERING_SHOT').length).toBe(3);
  });

  it('reports frame-grid adjustments as advisories without altering proposed timing', () => {
    const adjusted = shots.map((shot, index) => (index === 0 ? { ...shot, targetFrames: 130 } : shot));
    const result = validateStoryboardProposal({ beats: validated.beats, shots: adjusted, canonById, maxShots: 10_000 });
    expect(result.issues).toEqual([]);
    expect(result.advisories).toEqual([expect.objectContaining({ shotId: adjusted[0]!.shotId })]);
    expect(result.advisories[0]!.note).toContain('124 + 17');
    expect(adjusted[0]!.targetFrames).toBe(130);
  });

  it('enforces missing beat coverage and the configured shot maximum', () => {
    const uncovered = validateStoryboardProposal({ beats: validated.beats, shots: shots.slice(0, 6), canonById, maxShots: 10_000 });
    expect(uncovered.issues.some((issue) => issue.code === 'SHOT_PLAN_INVALID' && issue.message.includes('no shot coverage'))).toBe(true);
    const overMax = validateStoryboardProposal({ beats: validated.beats, shots, canonById, maxShots: 6 });
    expect(overMax.issues.some((issue) => issue.code === 'SHOT_PLAN_INVALID' && issue.message.includes('maximum'))).toBe(true);
  });
});

describe('strict versioned DTOs', () => {
  it('rejects unknown fields on the proposal command', () => {
    expect(CreateStoryProposalCommandSchema.safeParse({
      schemaVersion: 1, projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptText: 'Narration only.', expectedCanonRevisionIds: [], expectedStoryRevisionId: null, price: 1,
    }).success).toBe(false);
    expect(CreateStoryProposalCommandSchema.safeParse({
      schemaVersion: 2, projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptText: 'Narration only.', expectedCanonRevisionIds: [], expectedStoryRevisionId: null,
    }).success).toBe(false);
    expect(CreateStoryProposalCommandSchema.safeParse({
      schemaVersion: 1, projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptText: 'Narration only.', expectedCanonRevisionIds: [], expectedStoryRevisionId: null, chunkMaxBytes: 10,
    }).success).toBe(false);
  });

  it('rejects narration mappings that name a character and dialogue mappings that do not', () => {
    expect(CreateStoryProposalCommandSchema.safeParse({
      schemaVersion: 1, projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptText: 'Narration only.', expectedCanonRevisionIds: [], expectedStoryRevisionId: null,
      speechMap: [{ segmentId: 'speech-1', kind: 'narration', characterId: 'pip' }],
    }).success).toBe(false);
    expect(CreateStoryProposalCommandSchema.safeParse({
      schemaVersion: 1, projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptText: 'Narration only.', expectedCanonRevisionIds: [], expectedStoryRevisionId: null,
      speechMap: [{ segmentId: 'speech-1', kind: 'dialogue', characterId: null }],
    }).success).toBe(false);
  });

  it('rejects unknown fields and wrong schema versions on chunk output and results', () => {
    expect(TextPlannerChunkOutputSchema.safeParse({ schemaVersion: 1, beats: [], stray: true }).success).toBe(false);
    expect(TextPlannerChunkOutputSchema.safeParse({ schemaVersion: 2, beats: [] }).success).toBe(false);
    const parsed = parseScriptSpeech('pip: Hi.', characters);
    const result = {
      schemaVersion: 1, proposalId: 'proposal-1', projectId: 'p1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
      scriptSha256: 'a'.repeat(64),
      canonPins: [], expectedStoryRevisionId: null, segments: parsed.segments,
      chunks: { planned: 1, completed: 0 }, beats: [], shots: [], advisories: [],
      issues: [{ code: 'SEGMENT_NOT_FOUND', message: 'missing', chunkIndex: 0, segmentId: 'speech-1', beatId: null, shotId: null }],
      completeness: false, contentHash: 'b'.repeat(64), createdAt: 1,
    };
    expect(StoryProposalResultSchema.safeParse(result).success).toBe(true);
    expect(StoryProposalResultSchema.safeParse({ ...result, completeness: true }).success).toBe(false);
    expect(StoryProposalResultSchema.safeParse({ ...result, costMinor: 5 }).success).toBe(false);
    expect(StoryProposalResultSchema.safeParse({ ...result, beats: validatedBeats(parsed.segments) }).success).toBe(true);
  });
});

function validatedBeats(items: readonly SpeechSegment[]): ProposedBeat[] {
  return items.map((item, index) => ({
    id: chunkBeatId(item.segmentId),
    action: `Action for ${item.segmentId}`,
    narration: item.kind === 'dialogue' ? '' : item.text,
    dialogue: item.kind === 'dialogue'
      ? [{ characterId: item.characterId!, text: item.text, speechSegmentId: item.segmentId, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd }]
      : [],
    chunkIndex: index,
  }));
}
