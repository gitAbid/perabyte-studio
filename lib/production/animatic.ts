import { hashCanonicalJson } from './hash';

export type AnimaticShotInput = { id: string; shotId: string; targetFrames: number };
export type AnimaticTransition = { fromShotRevisionId: string; toShotRevisionId: string; frames: number };
export type AnimaticTimeline = {
  slots: Array<{ shotRevisionId: string; anchorId: null; placeholderLabel: string }>;
  timingAnnotations: Array<{ id: string; shotRevisionId: string; startFrame: number; endFrame: number; note: string }>;
  totalFrames: number;
};

/** Builds an annotated placeholder-first timeline. Cuts are gapless; only explicit 8-frame overlaps are accepted. */
export function buildAnimaticTimeline(
  shots: readonly AnimaticShotInput[],
  options: { transitions?: readonly AnimaticTransition[] } = {},
): AnimaticTimeline {
  if (shots.length === 0) throw new RangeError('Animatic requires at least one shot');
  const byId = new Map<string, number>();
  shots.forEach((shot, index) => {
    if (!shot.id || byId.has(shot.id)) throw new Error('Animatic shot revision IDs must be unique and nonblank');
    byId.set(shot.id, index);
    if (!Number.isSafeInteger(shot.targetFrames) || shot.targetFrames <= 0 || shot.targetFrames > 100_000) {
      throw new RangeError(`Shot ${shot.shotId} must have a positive safe integer frame duration no greater than 100000`);
    }
  });

  const transitions = new Map<number, AnimaticTransition>();
  for (const transition of options.transitions ?? []) {
    const from = byId.get(transition.fromShotRevisionId);
    const to = byId.get(transition.toShotRevisionId);
    if (from === undefined || to !== from + 1) throw new Error('Animatic transitions must connect adjacent shots in order');
    if (transition.frames !== 8) throw new Error('Only an explicitly annotated 8-frame crossfade is supported');
    if (transition.frames >= shots[from]!.targetFrames || transition.frames >= shots[to]!.targetFrames) {
      throw new RangeError('Crossfade duration must be shorter than both adjacent shots');
    }
    if (transitions.has(to)) throw new Error('Only one transition may connect an adjacent shot pair');
    transitions.set(to, transition);
  }

  let previousEnd = 0;
  const timingAnnotations: AnimaticTimeline['timingAnnotations'] = [];
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]!;
    const transition = transitions.get(index);
    const startFrame = previousEnd - (transition?.frames ?? 0);
    const endFrame = startFrame + shot.targetFrames;
    if (!Number.isSafeInteger(endFrame) || endFrame <= startFrame) throw new RangeError('Animatic total frame count exceeds safe integer range');
    const note = transition ? `Intentional 8-frame crossfade from ${transition.fromShotRevisionId}; creator approval is required.` : 'Planned shot duration.';
    timingAnnotations.push({
      id: `timing-${hashCanonicalJson({ shotRevisionId: shot.id, startFrame, endFrame }).slice(0, 24)}`,
      shotRevisionId: shot.id,
      startFrame,
      endFrame,
      note,
    });
    previousEnd = endFrame;
  }

  const totalFrames = previousEnd;
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) throw new RangeError('Animatic total frame count is invalid');
  return {
    slots: shots.map((shot) => ({
      shotRevisionId: shot.id,
      anchorId: null,
      placeholderLabel: `Shot ${shot.shotId}`.slice(0, 200),
    })),
    timingAnnotations,
    totalFrames,
  };
}

export type H3FrameGrid = { baseFrames: number; stepFrames: number; maxFrames: number };
export type ShotFrameRecommendation = {
  approvedTargetFrames: number;
  narrationFrames: number | null;
  plannedFrames: number;
  narrationShortfallFrames: number;
  requiresCreatorApproval: boolean;
  adjustmentNote: string | null;
};

/** Narration and model limits produce a visible proposal; approved shot timing is never mutated. */
export function recommendShotFrames(input: {
  targetFrames: number;
  narrationSamples?: number;
  legalGrid?: H3FrameGrid;
}): ShotFrameRecommendation {
  const { targetFrames, narrationSamples, legalGrid } = input;
  if (!Number.isSafeInteger(targetFrames) || targetFrames <= 0) throw new RangeError('targetFrames must be a positive safe integer');
  if (narrationSamples !== undefined && (!Number.isSafeInteger(narrationSamples) || narrationSamples <= 0)) {
    throw new RangeError('Narration samples must be a positive safe integer sample count');
  }

  const narrationFrames = narrationSamples === undefined ? null : Math.ceil(narrationSamples / 2000);
  let plannedFrames = narrationFrames ?? targetFrames;
  const notes: string[] = [];
  let narrationShortfallFrames = 0;
  if (legalGrid) {
    if (legalGrid.baseFrames !== 124 || legalGrid.stepFrames !== 17 || legalGrid.maxFrames !== 362 || legalGrid.maxFrames < legalGrid.baseFrames) {
      throw new RangeError('H3 legal frame grid must be 124 + 17n, with a 362-frame maximum');
    }
    const count = Math.floor((legalGrid.maxFrames - legalGrid.baseFrames) / legalGrid.stepFrames);
    const maxLegal = legalGrid.baseFrames + count * legalGrid.stepFrames;
    if (plannedFrames > maxLegal) {
      narrationShortfallFrames = narrationFrames === null ? 0 : narrationFrames - maxLegal;
      plannedFrames = maxLegal;
      if (narrationShortfallFrames > 0) {
        notes.push(`Narration requires ${narrationFrames} frames, exceeding the H3 maximum ${maxLegal} by ${narrationShortfallFrames}; split the narration or choose a longer-range model. The ${plannedFrames}-frame value is only a proposal and cannot cover the full narration.`);
      } else {
        notes.push(`Requested duration exceeds the H3 maximum ${maxLegal}; split the shot, shorten it with creator approval, or choose a longer-range model.`);
      }
    } else {
      const requested = Math.max(plannedFrames, legalGrid.baseFrames);
      const steps = Math.max(0, Math.ceil((requested - legalGrid.baseFrames) / legalGrid.stepFrames));
      const legalFrames = Math.min(maxLegal, legalGrid.baseFrames + steps * legalGrid.stepFrames);
      if (legalFrames !== plannedFrames) {
        const direction = legalFrames > plannedFrames ? 'round up' : 'adjust';
        notes.push(`Proposed ${legalFrames} frames to ${direction} to the H3 124 + 17n legal frame grid (maximum 362); creator approval is required.`);
        plannedFrames = legalFrames;
      }
    }
  }

  if (narrationFrames !== null && narrationFrames !== targetFrames) {
    notes.push(`Narration duration suggests ${narrationFrames} frames using ceil(samples / 2000); creator approval is required.`);
  }
  return {
    approvedTargetFrames: targetFrames,
    narrationFrames,
    plannedFrames,
    narrationShortfallFrames,
    requiresCreatorApproval: plannedFrames !== targetFrames || narrationFrames !== null && narrationFrames !== targetFrames || narrationShortfallFrames > 0,
    adjustmentNote: notes.length > 0 ? notes.join(' ') : null,
  };
}
