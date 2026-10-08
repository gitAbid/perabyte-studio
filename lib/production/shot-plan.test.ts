import { describe, expect, it } from 'vitest';
import { appendShotPlanChunk, paginateShots, validateShotPlan } from './shot-plan';

const beats = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `beat-${index + 1}` }));
const shots = (count: number) => Array.from({ length: count }, (_, index) => ({
  shotId: `shot-${index + 1}`,
  beatIds: [`beat-${(index % Math.max(count, 1)) + 1}`],
  targetFrames: 24,
}));

describe('validateShotPlan', () => {
  it.each([1, 6, 7, 40, 80])('accepts %i shots without a baked-in six-shot ceiling', (count) => {
    const storyBeats = beats(count);
    const result = validateShotPlan(storyBeats, shots(count), 80);
    expect(result.issues).toEqual([]);
    expect(result.totalFrames).toBe(count * 24);
    expect(result.beatCoverage).toHaveLength(count);
  });

  it('reports invalid durations with the offending stable shot ID', () => {
    const result = validateShotPlan(beats(1), [{ shotId: 'scene-bad-duration', beatIds: ['beat-1'], targetFrames: 0 }], 10);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ shotId: 'scene-bad-duration', code: 'INVALID_DURATION' }),
    ]));
  });

  it('rejects duplicate IDs, unknown beat bindings and uncovered story beats', () => {
    const result = validateShotPlan(beats(2), [
      { shotId: 'same', beatIds: ['beat-1', 'missing'], targetFrames: 24 },
      { shotId: 'same', beatIds: ['beat-1'], targetFrames: 24 },
    ], 10);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'DUPLICATE_SHOT_ID', 'UNKNOWN_BEAT', 'UNCOVERED_BEAT',
    ]));
  });

  it('rejects ambiguous duplicate story beat IDs before computing coverage', () => {
    const result = validateShotPlan([{ id: 'beat-1' }, { id: 'beat-1' }], [
      { shotId: 'shot-1', beatIds: ['beat-1'], targetFrames: 24 },
    ]);
    expect(result.issues.map((issue) => issue.code)).toContain('DUPLICATE_BEAT_ID');
  });

  it('rejects empty approved beats and whitespace-padded beat and shot IDs', () => {
    const empty = validateShotPlan([], [{ shotId: 'shot-1', beatIds: ['beat-1'], targetFrames: 24 }]);
    expect(empty.issues.map((issue) => issue.code)).toContain('NO_BEATS');
    const whitespace = validateShotPlan([{ id: ' beat-1 ' }], [
      { shotId: ' shot-1 ', beatIds: [' beat-1 '], targetFrames: 24 },
    ]);
    expect(whitespace.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INVALID_BEAT_ID', 'INVALID_SHOT_ID']));
    const malformed = validateShotPlan([{ id: 'beat-1' }], [
      { shotId: 'shot 2', beatIds: ['beat-1'], targetFrames: 24 },
    ]);
    expect(malformed.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_SHOT_ID', shotId: 'shot 2' }));
  });

  it('rejects unsafe aggregate frame totals and configured maximum overflow', () => {
    const overflow = validateShotPlan(beats(2), [
      { shotId: 'one', beatIds: ['beat-1'], targetFrames: Number.MAX_SAFE_INTEGER },
      { shotId: 'two', beatIds: ['beat-2'], targetFrames: 1 },
    ], 1);
    expect(overflow.issues.map((issue) => issue.code)).toContain('MAX_SHOTS');
    expect(overflow.issues.map((issue) => issue.code)).toContain('TOTAL_FRAMES_UNSAFE');
  });
});

describe('bounded shot pagination', () => {
  it('keeps stable IDs and order across pages and resumes without duplicates', () => {
    const all = shots(40);
    const first = paginateShots(all, 13);
    const second = paginateShots(all, 13, first.nextCursor);
    const third = paginateShots(all, 13, second.nextCursor);
    const fourth = paginateShots(all, 13, third.nextCursor);
    let collected = appendShotPlanChunk([], first.items);
    collected = appendShotPlanChunk(collected, second.items);
    collected = appendShotPlanChunk(collected, third.items);
    collected = appendShotPlanChunk(collected, fourth.items);
    expect(collected.map((shot) => shot.shotId)).toEqual(all.map((shot) => shot.shotId));
    expect(new Set(collected.map((shot) => shot.shotId)).size).toBe(40);
    expect(fourth.nextCursor).toBeNull();
  });

  it('preserves shot IDs when the same shots are reordered', () => {
    const previous = shots(7);
    const reordered = [previous[4], previous[0], previous[6], previous[1], previous[2], previous[5], previous[3]];
    expect(reordered.map((shot) => shot.shotId)).toEqual([
      'shot-5', 'shot-1', 'shot-7', 'shot-2', 'shot-3', 'shot-6', 'shot-4',
    ]);
    expect(validateShotPlan(beats(7), reordered, 10).issues).toEqual([]);
  });

  it('does not append an already-persisted shot ID from a resumed chunk', () => {
    const page = paginateShots(shots(4), 2);
    expect(() => appendShotPlanChunk(page.items, page.items)).toThrow(/duplicate shot ID/i);
  });
});
