import { describe, expect, it } from 'vitest';
import { buildAnimaticTimeline, recommendShotFrames } from './animatic';

const plannedShots = [
  { id: 'shot-rev-1', shotId: 'shot-1', targetFrames: 100 },
  { id: 'shot-rev-2', shotId: 'shot-2', targetFrames: 120 },
  { id: 'shot-rev-3', shotId: 'shot-3', targetFrames: 80 },
];

describe('buildAnimaticTimeline', () => {
  it('creates labeled placeholders on a contiguous cut timeline', () => {
    const result = buildAnimaticTimeline(plannedShots);
    expect(result.slots).toEqual(plannedShots.map((shot) => ({
      shotRevisionId: shot.id,
      anchorId: null,
      placeholderLabel: `Shot ${shot.shotId}`,
    })));
    expect(result.timingAnnotations.map(({ startFrame, endFrame }) => [startFrame, endFrame]))
      .toEqual([[0, 100], [100, 220], [220, 300]]);
    expect(result.totalFrames).toBe(300);
  });

  it('allows only an explicit exact eight-frame crossfade and counts overlap once', () => {
    const result = buildAnimaticTimeline(plannedShots, {
      transitions: [{ fromShotRevisionId: 'shot-rev-1', toShotRevisionId: 'shot-rev-2', frames: 8 }],
    });
    expect(result.timingAnnotations.slice(0, 2).map(({ startFrame, endFrame }) => [startFrame, endFrame]))
      .toEqual([[0, 100], [92, 212]]);
    expect(result.totalFrames).toBe(292);
    expect(result.timingAnnotations[1]?.note).toMatch(/8-frame crossfade.*approval is required/i);
  });

  it('rejects unannotated duration mismatch, non-adjacent transitions and unsupported transition lengths', () => {
    expect(() => buildAnimaticTimeline([{ ...plannedShots[0]!, targetFrames: 0 }])).toThrow(/positive safe integer/i);
    expect(() => buildAnimaticTimeline(plannedShots, {
      transitions: [{ fromShotRevisionId: 'shot-rev-1', toShotRevisionId: 'shot-rev-3', frames: 8 }],
    })).toThrow(/adjacent/i);
    expect(() => buildAnimaticTimeline(plannedShots, {
      transitions: [{ fromShotRevisionId: 'shot-rev-1', toShotRevisionId: 'shot-rev-2', frames: 10 }],
    })).toThrow(/8-frame/i);
  });
});

describe('recommendShotFrames', () => {
  it('converts narration samples with ceil(samples / 2000) without changing approved frames', () => {
    const recommendation = recommendShotFrames({ targetFrames: 100, narrationSamples: 200_001 });
    expect(recommendation.narrationFrames).toBe(101);
    expect(recommendation.plannedFrames).toBe(101);
    expect(recommendation.requiresCreatorApproval).toBe(true);
    expect(recommendation.approvedTargetFrames).toBe(100);
  });

  it('reports H3 legal-grid timing adjustment explicitly and never silently adopts it', () => {
    const recommendation = recommendShotFrames({
      targetFrames: 190,
      narrationSamples: 190 * 2000,
      legalGrid: { baseFrames: 124, stepFrames: 17, maxFrames: 362 },
    });
    expect(recommendation.plannedFrames).toBe(192);
    expect(recommendation.approvedTargetFrames).toBe(190);
    expect(recommendation.requiresCreatorApproval).toBe(true);
    expect(recommendation.adjustmentNote).toMatch(/124 \+ 17n/i);
  });

  it('rounds narration up to a legal duration so the proposed shot does not truncate speech', () => {
    const recommendation = recommendShotFrames({
      targetFrames: 124,
      narrationSamples: 193 * 2000,
      legalGrid: { baseFrames: 124, stepFrames: 17, maxFrames: 362 },
    });
    expect(recommendation.plannedFrames).toBe(209);
    expect(recommendation.narrationFrames).toBe(193);
    expect(recommendation.narrationShortfallFrames).toBe(0);
    expect(recommendation.adjustmentNote).toMatch(/round up/i);
  });

  it('reports narration that cannot fit the model maximum and requires a split or longer-range model', () => {
    const recommendation = recommendShotFrames({
      targetFrames: 362,
      narrationSamples: 363 * 2000,
      legalGrid: { baseFrames: 124, stepFrames: 17, maxFrames: 362 },
    });
    expect(recommendation.plannedFrames).toBe(362);
    expect(recommendation.narrationShortfallFrames).toBe(1);
    expect(recommendation.requiresCreatorApproval).toBe(true);
    expect(recommendation.adjustmentNote).toMatch(/split|longer-range/i);
  });

  it('rejects invalid samples and impossible legal frame grids', () => {
    expect(() => recommendShotFrames({ targetFrames: 10, narrationSamples: -1 })).toThrow(/samples/i);
    expect(() => recommendShotFrames({
      targetFrames: 10,
      legalGrid: { baseFrames: 124, stepFrames: 17, maxFrames: 123 },
    })).toThrow(/legal frame grid/i);
  });
});
