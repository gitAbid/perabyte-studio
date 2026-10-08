import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CanonRevisionSchema, ProjectSchema, StoryRevisionSchema,
  type CanonRevision, type Project, type StoryRevision,
} from '../../production/contracts';
import {
  chunkBeatId, parseScriptSpeech, planSpeechChunks,
  type SpeechSegment, type StoryProposalResult,
} from '../../production/proposals';
import type { ProductionStore } from '../../repositories/production/ports';
import type { TextGenerationRequest, TextModelDescriptor, TextProvider } from '../../providers/types';
import { generateStoryProposal } from './proposals';

const SCRIPT = [
  'NARRATOR: The clearing held its breath.',
  'pip: I found it — the lantern! বাতি 🏮',
  'Plain heading with colon: still narration.',
  'moss: Then we run.',
].join('\n');

const LONG_SCRIPT = [
  'NARRATOR: The forest road opens beneath a paper sky while lantern light steadies every single frame.',
  'pip: The lantern is ready — follow me before the paper sun falls behind the western hills!',
  'NARRATOR: Moss steadies the pack, listens for the wind and counts the stones along the road.',
  'moss: Then we run before the light fails and the paper sky folds into the dark again.',
  'NARRATOR: Branches close behind them like slow water settling over the road they leave.',
  'pip: Keep to the stones; the moss remembers every step the road has ever taken.',
  'NARRATOR: The clearing breathes once, waits, and lets the lantern light settle.',
].join('\n');

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const sameBytes = (left: string, right: string) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) === 0;

const projectFixture = () => ProjectSchema.parse({
  version: 1, id: 'project-1', name: 'Pilot', profileId: 'short',
  profile: { id: 'short', format: '9:16', language: 'en', ageIntent: '5-8', targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null },
  activeCanonRevisionIds: ['char-r1', 'char-r2', 'location-r1', 'prop-r1', 'style-r1'],
  activeStoryRevisionId: 'story-r1', activeShotPlanRevisionId: null, activeAnimaticRevisionId: null,
  activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1,
});

const canonFixture = (): CanonRevision[] => [
  ['char-r1', 'pip', 'character'], ['char-r2', 'moss', 'character'], ['location-r1', 'clearing', 'location'],
  ['prop-r1', 'lantern', 'prop'], ['style-r1', 'paper', 'style'],
].map(([id, entityId, entityKind]) => CanonRevisionSchema.parse({
  version: 1, id, entityId, entityKind, revision: 1, description: `${entityId} description`,
  attributes: {}, referenceAssetIds: [], contentHash: 'b'.repeat(64), createdAt: 2,
}));

const storyFixture = () => StoryRevisionSchema.parse({
  version: 1, id: 'story-r1', projectId: 'project-1', parentRevisionId: null, scriptText: 'Old draft.',
  beats: [{ id: 'beat-1', action: 'Old.', narration: 'Old.', dialogue: [], order: 0 }],
  canonRevisionIds: ['char-r1', 'char-r2', 'location-r1', 'prop-r1', 'style-r1'],
  contentHash: 'c'.repeat(64), createdAt: 2,
});

function makeStore(options: { project?: Project; canon?: CanonRevision[]; story?: StoryRevision } = {}): ProductionStore {
  const project = options.project ?? projectFixture();
  const canon = options.canon ?? canonFixture();
  const story = options.story ?? storyFixture();
  return {
    read: {
      getProject: (id: string) => (id === project.id ? project : null),
      listCanonRevisions: (ids: string[]) => canon.filter((row) => ids.includes(row.id)),
      getStoryRevision: (id: string) => (id === story.id ? story : null),
    },
    transaction: () => { throw new Error('proposal must not write'); },
  } as unknown as ProductionStore;
}

function fakeTextProvider(responses: Array<string | Error | ((request: TextGenerationRequest) => string)>, options: {
  id?: string; configured?: boolean; models?: TextModelDescriptor[];
} = {}): TextProvider & { calls: TextGenerationRequest[] } {
  const calls: TextGenerationRequest[] = [];
  const provider: TextProvider = {
    id: options.id ?? 'fake-text', label: 'Fake text', isConfigured: () => options.configured ?? true,
    listTextModels: () => options.models ?? [{ id: 'planner-1', label: 'Planner', provider: 'fake-text', contextTokens: 400_000 }],
    generateText: async (request: TextGenerationRequest) => {
      calls.push(request);
      const next = responses[calls.length - 1];
      if (typeof next === 'function') return { text: next(request), model: 'planner-1', provider: 'fake-text' };
      if (typeof next === 'string') return { text: next, model: 'planner-1', provider: 'fake-text' };
      throw next ?? new Error('fake provider exhausted');
    },
  };
  return Object.assign(provider, { calls });
}

const canonRevisionFor = (entityId: string) => ({ pip: 'char-r1', moss: 'char-r2' })[entityId] ?? '';

function beatJson(item: SpeechSegment) {
  const id = chunkBeatId(item.segmentId);
  return item.kind === 'dialogue'
    ? {
      id, speechSegmentId: item.segmentId, action: `Action for ${item.segmentId}`, narration: '',
      sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
      dialogue: [{ speechSegmentId: item.segmentId, characterId: item.characterId, text: item.text, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd }],
    }
    : { id, speechSegmentId: item.segmentId, action: `Action for ${item.segmentId}`, narration: item.text, dialogue: [], sourceStart: item.sourceStart, sourceEnd: item.sourceEnd };
}

function shotJson(item: SpeechSegment, overrides: Record<string, unknown> = {}) {
  return {
    shotId: `shot-${item.segmentId}`, beatIds: [chunkBeatId(item.segmentId)], visualIntent: 'Show the clearing',
    motionIntent: 'Slow push in',
    castBindings: item.kind === 'dialogue' ? [{ characterId: item.characterId, canonRevisionId: canonRevisionFor(item.characterId!), wardrobe: 'travel cloak' }] : [],
    locationRevisionId: 'location-r1', propRevisionIds: ['prop-r1'], styleRevisionId: 'style-r1',
    framing: 'medium', targetFrames: 124, continuation: null, ...overrides,
  };
}

const outputJson = (items: readonly SpeechSegment[], kind: 'story' | 'storyboard', overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, beats: items.map((item) => beatJson(item)), ...(kind === 'storyboard' ? { shots: items.map((item) => shotJson(item)) } : {}), ...overrides });

const command = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, projectId: 'project-1', kind: 'story', providerId: 'fake-text', modelId: 'planner-1',
  scriptText: SCRIPT, expectedCanonRevisionIds: ['char-r1', 'char-r2', 'location-r1', 'prop-r1', 'style-r1'],
  expectedStoryRevisionId: 'story-r1', ...overrides,
});

const options = { now: () => 10, idFactory: () => 'proposal-1' };
function designated(scriptText: string, speechMap: Array<{ segmentId: string; kind: 'dialogue' | 'narration'; characterId: string | null }> = []) {
  const characters = canonFixture().filter((row) => row.entityKind === 'character').map((row) => ({ entityId: row.entityId, name: null }));
  const parsed = parseScriptSpeech(scriptText, characters, speechMap);
  const chunksOf = (maxBytes: number) => planSpeechChunks(parsed.segments.filter((item) => item.kind !== 'unmapped'), maxBytes);
  return { parsed, chunksOf };
}

describe('generateStoryProposal', () => {
  it('proposes byte-exact editable story beats from the selected immutable canon in one shot', async () => {
    const provider = fakeTextProvider([() => outputJson(designated(SCRIPT).chunksOf(4000)[0]!.segments, 'story')]);
    const result = await generateStoryProposal(makeStore(), provider, command(), options);
    expect(result.completeness).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.chunks).toEqual({ planned: 1, completed: 1 });
    expect(result.beats).toHaveLength(4);
    expect(result.beats.map((beat) => beat.id)).toEqual(result.segments.filter((item) => item.kind !== 'unmapped').map((item) => chunkBeatId(item.segmentId)));
    const dialogueBeat = result.beats[1]!.dialogue[0]!;
    expect(sameBytes(dialogueBeat.text, 'I found it — the lantern! বাতি 🏮')).toBe(true);
    expect(SCRIPT.slice(dialogueBeat.sourceStart, dialogueBeat.sourceEnd)).toBe(dialogueBeat.text);
    expect(result.scriptSha256).toBe(sha256(SCRIPT));
    expect(result.canonPins.map((pin) => pin.canonRevisionId)).toEqual(['char-r1', 'char-r2', 'location-r1', 'prop-r1', 'style-r1']);
    expect(result.canonPins.every((pin) => pin.contentHash === 'b'.repeat(64))).toBe(true);
    expect(result.expectedStoryRevisionId).toBe('story-r1');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.modelId).toBe('planner-1');
    expect(provider.calls[0]!.userPrompt).toContain('pip description');
    expect(provider.calls[0]!.userPrompt).not.toContain('clearing description');
    expect(result.shots).toEqual([]);
    expect(Object.keys(result).sort()).not.toContain('price');
  });

  it('replays deterministically with identical content hash and beat IDs', async () => {
    const run = async () => generateStoryProposal(makeStore(), fakeTextProvider([() => outputJson(designated(SCRIPT).chunksOf(4000)[0]!.segments, 'story')]), command(), options);
    const first: StoryProposalResult = await run();
    const second: StoryProposalResult = await run();
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.beats.map((beat) => beat.id)).toEqual(first.beats.map((beat) => beat.id));
  });

  it('plans bounded ordered storyboard chunks with more than six shots', async () => {
    const chunks = designated(LONG_SCRIPT).chunksOf(300);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const provider = fakeTextProvider(chunks.map((chunk) => outputJson(chunk.segments, 'storyboard')));
    const result = await generateStoryProposal(makeStore(), provider, command({ kind: 'storyboard', scriptText: LONG_SCRIPT, chunkMaxBytes: 300 }), options);
    expect(result.completeness).toBe(true);
    expect(result.chunks).toEqual({ planned: chunks.length, completed: chunks.length });
    expect(result.shots).toHaveLength(7);
    expect(result.issues).toEqual([]);
    expect(result.beats.map((beat) => beat.id)).toEqual(chunks.flatMap((chunk) => chunk.segments.map((item) => chunkBeatId(item.segmentId))));
  });

  it('rejects stale expected canon and story snapshots before any provider call', async () => {
    const provider = fakeTextProvider([]);
    await expect(generateStoryProposal(makeStore(), provider, command({ expectedCanonRevisionIds: ['char-r1'] }), options))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(generateStoryProposal(makeStore(), provider, command({ expectedStoryRevisionId: 'story-old' }), options))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(generateStoryProposal(makeStore(), provider, command({ projectId: 'project-unknown' }), options))
      .rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });
    expect(provider.calls).toHaveLength(0);
  });

  it('composes the selected provider without fallback and fails closed on unknown composition', async () => {
    const provider = fakeTextProvider([]);
    await expect(generateStoryProposal(makeStore(), provider, command({ providerId: 'other-text' }), options)).rejects.toMatchObject({ code: 'CAPABILITY_MISMATCH' });
    await expect(generateStoryProposal(makeStore(), provider, command({ modelId: 'unknown-model' }), options)).rejects.toMatchObject({ code: 'CAPABILITY_MISMATCH' });
    const noContext = fakeTextProvider([], { models: [{ id: 'planner-1', label: 'Planner', provider: 'fake-text' }] });
    await expect(generateStoryProposal(makeStore(), noContext, command(), options)).rejects.toMatchObject({ code: 'CAPABILITY_MISMATCH' });
    const unconfigured = fakeTextProvider([], { configured: false });
    await expect(generateStoryProposal(makeStore(), unconfigured, command(), options)).rejects.toMatchObject({ code: 'CAPABILITY_MISMATCH' });
    await expect(generateStoryProposal(makeStore(), { generateText: 1 } as unknown as TextProvider, command(), options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(provider.calls).toHaveLength(0);
  });

  it('uses exactly one structured repair after malformed output, then fails visibly', async () => {
    const malformed = JSON.stringify({ schemaVersion: 1, beats: [], stray: true });
    const repaired = fakeTextProvider([malformed, () => outputJson(designated(SCRIPT).chunksOf(4000)[0]!.segments, 'story')]);
    const fixed = await generateStoryProposal(makeStore(), repaired, command(), options);
    expect(repaired.calls).toHaveLength(2);
    expect(repaired.calls[1]!.userPrompt).toContain('stray');
    expect(fixed.completeness).toBe(true);

    const exhausted = fakeTextProvider([malformed, malformed]);
    const failed = await generateStoryProposal(makeStore(), exhausted, command(), options);
    expect(exhausted.calls).toHaveLength(2);
    expect(failed.completeness).toBe(false);
    expect(failed.issues.map((issue) => issue.code)).toContain('PROVIDER_REPAIR_EXHAUSTED');
  });

  it('repairs missing beat coverage once and reports incorrect source ranges after the failed repair', async () => {
    const segments = designated(SCRIPT).chunksOf(4000)[0]!.segments;
    const recovered = fakeTextProvider([() => outputJson(segments.slice(0, -1), 'story'), () => outputJson(segments, 'story')]);
    const fixed = await generateStoryProposal(makeStore(), recovered, command(), options);
    expect(recovered.calls).toHaveLength(2);
    expect(fixed.completeness).toBe(true);

    const wrongRange = JSON.parse(outputJson(segments, 'story'));
    wrongRange.beats = wrongRange.beats.map((beat: Record<string, number>, index: number) => (index === 1 ? { ...beat, sourceStart: beat.sourceStart + 1 } : beat));
    const ranged = fakeTextProvider([JSON.stringify(wrongRange), JSON.stringify(wrongRange)]);
    const failed = await generateStoryProposal(makeStore(), ranged, command(), options);
    expect(ranged.calls).toHaveLength(2);
    expect(failed.completeness).toBe(false);
    expect(failed.issues.map((issue) => issue.code)).toContain('SPEECH_RANGE_MISMATCH');
    expect(failed.issues.map((issue) => issue.code)).toContain('PROVIDER_REPAIR_EXHAUSTED');
    expect(failed.beats.length).toBeGreaterThan(0);
  });

  it('stops at a hard provider failure, marks later chunks unprocessed and replays stable beat IDs', async () => {
    const chunks = designated(LONG_SCRIPT).chunksOf(200);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const responses = chunks.map((chunk, index): string | Error =>
      (index === 1 ? new Error('socket closed') : outputJson(chunk.segments, 'story')));
    const run = async () => generateStoryProposal(makeStore(),
      fakeTextProvider(responses),
      command({ scriptText: LONG_SCRIPT, chunkMaxBytes: 200 }), options);
    const interrupted = await run();
    expect(interrupted.completeness).toBe(false);
    expect(interrupted.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['PROVIDER_CALL_FAILED', 'CHUNK_NOT_PROCESSED']));
    expect(interrupted.beats.map((beat) => beat.id)).toEqual(chunks[0]!.segments.map((item) => chunkBeatId(item.segmentId)));
    const replayed = await run();
    expect(replayed.beats.map((beat) => beat.id)).toEqual(interrupted.beats.map((beat) => beat.id));
  });

  it('keeps unmapped ambiguous segments visible with completeness false while drafting the mapped speech', async () => {
    const withUnknown = `${SCRIPT}\nLANTERN: glow`;
    const { parsed, chunksOf } = designated(withUnknown);
    expect(parsed.segments.some((item) => item.kind === 'unmapped')).toBe(true);
    const provider = fakeTextProvider(chunksOf(4000).map((chunk) => outputJson(chunk.segments, 'story')));
    const result = await generateStoryProposal(makeStore(), provider, command({ scriptText: withUnknown }), options);
    expect(result.completeness).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNMAPPED_SPEAKER', segmentId: 'speech-5' }));
    expect(result.segments.find((item) => item.segmentId === 'speech-5')).toMatchObject({ kind: 'unmapped' });
    expect(result.beats).toHaveLength(4);
  });

  it('accepts explicit human speech mapping for ambiguous segments before provider invocation', async () => {
    const withUnknown = `${SCRIPT}\nLANTERN: glow`;
    const speechMap = [{ segmentId: 'speech-5', kind: 'narration' as const, characterId: null }];
    const provider = fakeTextProvider(designated(withUnknown, speechMap).chunksOf(4000).map((chunk) => outputJson(chunk.segments, 'story')));
    const result = await generateStoryProposal(makeStore(), provider, command({ scriptText: withUnknown, speechMap }), options);
    expect(result.completeness).toBe(true);
    expect(result.segments.find((item) => item.segmentId === 'speech-5')).toMatchObject({ kind: 'narration' });
  });

  it('rejects dialogue mappings naming speakers outside the selected canon with completeness false', async () => {
    const speechMap = [{ segmentId: 'speech-1', kind: 'dialogue' as const, characterId: 'ghost-not-in-canon' }];
    const storyProvider = fakeTextProvider([() => outputJson(designated(SCRIPT, speechMap).chunksOf(4000)[0]!.segments, 'story')]);
    const story = await generateStoryProposal(makeStore(), storyProvider, command({ speechMap }), options);
    expect(story.completeness).toBe(false);
    expect(story.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_CANON_SPEAKER', segmentId: 'speech-1' }));
    expect(story.segments.find((item) => item.segmentId === 'speech-1')).toMatchObject({ kind: 'narration', characterId: null });

    const storyboardProvider = fakeTextProvider([() => outputJson(designated(SCRIPT, speechMap).chunksOf(4000)[0]!.segments, 'storyboard')]);
    const storyboard = await generateStoryProposal(makeStore(), storyboardProvider, command({ kind: 'storyboard', speechMap }), options);
    expect(storyboard.completeness).toBe(false);
    expect(storyboard.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_CANON_SPEAKER', segmentId: 'speech-1' }));
  });

  it('rejects degenerate scripts beyond the proposal bounds visibly before any provider call', async () => {
    const provider = fakeTextProvider([]);
    const flood = Array.from({ length: 10_001 }, () => 'x').join('\n');
    await expect(generateStoryProposal(makeStore(), provider, command({ scriptText: flood }), options))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(provider.calls).toHaveLength(0);
  });

  it('calls no provider when nothing is designated as speech', async () => {
    const provider = fakeTextProvider([]);
    const result = await generateStoryProposal(makeStore(), provider, command({ scriptText: 'LANTERN: glow' }), options);
    expect(result.completeness).toBe(false);
    expect(result.chunks).toEqual({ planned: 0, completed: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  it('reports unknown canon references in storyboard proposals with visible errors', async () => {
    const chunk = designated(LONG_SCRIPT).chunksOf(4000)[0]!;
    const provider = fakeTextProvider([JSON.stringify({
      schemaVersion: 1,
      beats: chunk.segments.map((item) => beatJson(item)),
      shots: chunk.segments.map((item) => shotJson(item, { locationRevisionId: 'location-unknown' })),
    })]);
    const result = await generateStoryProposal(makeStore(), provider, command({ kind: 'storyboard', scriptText: LONG_SCRIPT }), options);
    expect(result.completeness).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'UNKNOWN_CANON_REFERENCE').length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1);
  });

  it('repairs invalid cast capacity once and reports frame-grid adjustments as advisories without altering timing', async () => {
    const chunk = designated(LONG_SCRIPT).chunksOf(4000)[0]!;
    const dialogue = chunk.segments.find((item) => item.kind === 'dialogue');
    const overCapacity = shotJson(dialogue!, { castBindings: [
      { characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'a' }, { characterId: 'moss', canonRevisionId: 'char-r2', wardrobe: 'b' },
      { characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'c' }, { characterId: 'moss', canonRevisionId: 'char-r2', wardrobe: 'd' },
    ] });
    const repairedProvider = fakeTextProvider([
      () => JSON.stringify({ schemaVersion: 1, beats: chunk.segments.map((item) => beatJson(item)), shots: chunk.segments.map((item) => (item.kind === 'dialogue' ? overCapacity : shotJson(item))) }),
      () => outputJson(chunk.segments, 'storyboard'),
    ]);
    const repaired = await generateStoryProposal(makeStore(), repairedProvider, command({ kind: 'storyboard', scriptText: LONG_SCRIPT }), options);
    expect(repairedProvider.calls).toHaveLength(2);
    expect(repaired.completeness).toBe(true);

    const advisoryProvider = fakeTextProvider([() => JSON.stringify({
      schemaVersion: 1, beats: chunk.segments.map((item) => beatJson(item)),
      shots: chunk.segments.map((item, index) => shotJson(item, index === 0 ? { targetFrames: 130 } : {})),
    })]);
    const advisory = await generateStoryProposal(makeStore(), advisoryProvider, command({ kind: 'storyboard', scriptText: LONG_SCRIPT }), options);
    expect(advisory.completeness).toBe(true);
    expect(advisory.advisories).toEqual([expect.objectContaining({ shotId: `shot-${chunk.segments[0]!.segmentId}` })]);
    expect(advisory.shots[0]!.targetFrames).toBe(130);
    expect(advisory.advisories[0]!.note).toContain('124 + 17');
  });
});
