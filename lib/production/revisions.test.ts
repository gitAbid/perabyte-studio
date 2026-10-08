import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from './hash';
import { shotsCompatibleWithStory, type ShotRevisionCandidate } from './revisions';
import { CanonRevisionSchema, type CanonRevision, type StoryRevision } from './contracts';

const origin: StoryRevision = {
  id: 'story-1', projectId: 'project-1', parentRevisionId: null, scriptText: 'A line.',
  beats: [{ id: 'beat-1', order: 0, action: 'A', narration: 'A line.', dialogue: [] }],
  canonRevisionIds: ['character-r1', 'location-r1', 'style-r1'], contentHash: 'a'.repeat(64), version: 1 as const, createdAt: 1,
};
const shot = {
  id: 'shotrev-1', shotId: 'shot-1', storyRevisionId: origin.id, beatIds: ['beat-1'], order: 0,
  visualIntent: 'A', motionIntent: 'still', castBindings: [], locationRevisionId: 'location-r1',
  propRevisionIds: [], styleRevisionId: 'style-r1', framing: 'wide' as const, targetFrames: 24,
  continuation: null, contentHash: '', version: 1 as const, createdAt: 1,
};
const { id: _shotId, createdAt: _created, contentHash: _hash, ...shotContent } = shot;
shot.contentHash = hashCanonicalJson(shotContent);
const canonRows: CanonRevision[] = [
  ['character-r1', 'character', 'character'], ['location-r1', 'location', 'location'], ['style-r1', 'style', 'style'],
].map(([id, entityId, entityKind]) => CanonRevisionSchema.parse({ version: 1, id, entityId, entityKind, revision: 1,
  description: 'Pinned canon', attributes: {}, referenceAssetIds: [], contentHash: 'c'.repeat(64), createdAt: 1 }));
const context = (successor: StoryRevision, lineage: StoryRevision[] = [successor, ...(successor.id === origin.id ? [] : [origin])]) => ({
  projectId: origin.projectId,
  storyLineage: lineage,
  selectedCanonRevisions: canonRows,
  candidate: { ...shotContent, storyRevisionId: successor.id } as ShotRevisionCandidate,
  continuationIsValid: true,
});

describe('revision identity and successor shot compatibility', () => {
  it('fingerprints normalized inputs independent of object key order', () => {
    expect(hashCanonicalJson({ z: 'é', a: 1 })).toBe(hashCanonicalJson({ a: 1, z: 'e\u0301' }));
  });

  it('allows a byte-equivalent shot to survive a canon-only story successor', () => {
    const second = { ...origin, id: 'story-2', parentRevisionId: origin.id, canonRevisionIds: [...origin.canonRevisionIds, 'prop-r2'] };
    const successor = { ...second, id: 'story-3', parentRevisionId: second.id, canonRevisionIds: [...second.canonRevisionIds, 'prop-r3'] };
    expect(shotsCompatibleWithStory(shot, origin, successor, context(successor, [successor, second, origin]))).toBe(true);
  });

  it('allows a current story shot after an older ancestor changed its script', () => {
    const edited: StoryRevision = { ...origin, id: 'story-2', parentRevisionId: origin.id, scriptText: 'Edited line.' };
    const successor: StoryRevision = { ...edited, id: 'story-3', parentRevisionId: edited.id, canonRevisionIds: [...edited.canonRevisionIds, 'prop-r3'] };
    const shotAtEditedStory = { ...shot, storyRevisionId: edited.id, contentHash: hashCanonicalJson({ ...shotContent, storyRevisionId: edited.id }) };
    const shotContext = context(successor, [successor, edited, origin]);
    expect(shotsCompatibleWithStory(shotAtEditedStory, edited, edited, context(edited, [edited, origin]))).toBe(true);
    expect(shotsCompatibleWithStory(shotAtEditedStory, edited, successor, shotContext)).toBe(true);
  });

  it('rejects NFC-equivalent but byte-distinct shot inputs on the same story and a canon-only successor', () => {
    const successor = { ...origin, id: 'story-2', parentRevisionId: origin.id, canonRevisionIds: [...origin.canonRevisionIds, 'prop-r2'] };
    const cases = [
      { origin: { ...shot, visualIntent: 'Cafe\u0301' }, candidate: { visualIntent: 'Café' } },
      { origin: { ...shot, castBindings: [{ characterId: 'character', canonRevisionId: 'character-r1', wardrobe: 'Cafe\u0301' }] },
        candidate: { castBindings: [{ characterId: 'character', canonRevisionId: 'character-r1', wardrobe: 'Café' }] } },
    ];
    for (const variant of cases) {
      const originShot = { ...variant.origin };
      const { id: _id, createdAt: _createdAt, contentHash: _contentHash, ...originContent } = originShot;
      originShot.contentHash = hashCanonicalJson(originContent);
      const sameStory = context(origin, [origin]);
      const successorContext = context(successor, [successor, origin]);
      const sameStoryCandidate = { ...sameStory.candidate, ...variant.candidate };
      const successorCandidate = { ...successorContext.candidate, ...variant.candidate, storyRevisionId: successor.id };
      expect(hashCanonicalJson({ ...originContent, storyRevisionId: origin.id, version: 1 })).toBe(
        hashCanonicalJson({ ...sameStoryCandidate, storyRevisionId: origin.id, version: 1 }),
      );
      expect(shotsCompatibleWithStory(originShot, origin, origin, { ...sameStory, candidate: sameStoryCandidate })).toBe(false);
      expect(shotsCompatibleWithStory(originShot, origin, successor, { ...successorContext, candidate: successorCandidate })).toBe(false);
    }
  });

  it('rejects changed beats, changed shot inputs and changed continuation pins', () => {
    const successor = { ...origin, id: 'story-2', parentRevisionId: origin.id, canonRevisionIds: [...origin.canonRevisionIds, 'prop-r2'] };
    const candidate = context(successor);
    expect(shotsCompatibleWithStory(shot, origin, { ...successor, beats: [{ ...origin.beats[0], action: 'B' }] }, candidate)).toBe(false);
    expect(shotsCompatibleWithStory(shot, origin, successor, { ...candidate, candidate: { ...candidate.candidate, targetFrames: 25 } })).toBe(false);
    expect(shotsCompatibleWithStory(shot, origin, successor, { ...candidate, continuationIsValid: false })).toBe(false);
    expect(shotsCompatibleWithStory(shot, origin, successor, { ...candidate, selectedCanonRevisions: [] })).toBe(false);
    expect(shotsCompatibleWithStory(shot, origin, { ...successor, id: 'story-3', parentRevisionId: 'other' }, { ...candidate, storyLineage: [{ ...successor, id: 'story-3', parentRevisionId: 'other' }] })).toBe(false);
  });

  it('rejects every changed shot input, including a valid but different canon pin', () => {
    const successor = { ...origin, id: 'story-2', parentRevisionId: origin.id, canonRevisionIds: [...origin.canonRevisionIds, 'prop-r2'] };
    const base = context(successor);
    const changedInputs: ShotRevisionCandidate[] = [
      { ...base.candidate, order: 1 },
      { ...base.candidate, visualIntent: 'Different' },
      { ...base.candidate, motionIntent: 'Different' },
      { ...base.candidate, framing: 'close' },
      { ...base.candidate, targetFrames: 25 },
      { ...base.candidate, castBindings: [{ characterId: 'character', canonRevisionId: 'character-r1', wardrobe: 'blue coat' }] },
      { ...base.candidate, continuation: { previousShotRevisionId: 'prior-shot', endFrameAssetId: 'end-frame' } },
    ];
    for (const candidate of changedInputs) expect(shotsCompatibleWithStory(shot, origin, successor, { ...base, candidate })).toBe(false);
    const location2 = CanonRevisionSchema.parse({ ...canonRows[1], id: 'location-r2', revision: 2 });
    const successorWithNewLocation = { ...successor, canonRevisionIds: successor.canonRevisionIds.filter((id) => id !== 'location-r1').concat('location-r2') };
    expect(shotsCompatibleWithStory(shot, origin, successorWithNewLocation, {
      ...base,
      selectedCanonRevisions: [canonRows[0], location2, canonRows[2]],
      candidate: { ...base.candidate, locationRevisionId: location2.id },
    })).toBe(false);
  });
});
