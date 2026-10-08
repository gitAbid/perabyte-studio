export type ShotPlanShot = {
  shotId: string;
  beatIds: string[];
  targetFrames: number;
};

export type ShotPlanIssueCode =
  | 'NO_SHOTS' | 'NO_BEATS' | 'MAX_SHOTS' | 'INVALID_BEAT_ID' | 'DUPLICATE_BEAT_ID' | 'INVALID_SHOT_ID' | 'DUPLICATE_SHOT_ID'
  | 'INVALID_BEAT_BINDINGS' | 'UNKNOWN_BEAT' | 'UNCOVERED_BEAT'
  | 'INVALID_DURATION' | 'TOTAL_FRAMES_UNSAFE';

export type ShotPlanIssue = {
  code: ShotPlanIssueCode;
  message: string;
  shotId?: string;
  beatId?: string;
};

export type ShotPlanValidation = {
  issues: ShotPlanIssue[];
  totalFrames: number | null;
  beatCoverage: Array<{ beatId: string; shotIds: string[] }>;
};

const isValidStableId = (value: string) => value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);

/** Validate bounded plan structure and return coverage in approved story-beat order. */
export function validateShotPlan(
  beats: readonly { id: string }[],
  shots: readonly ShotPlanShot[],
  maxShots = 10_000,
): ShotPlanValidation {
  const issues: ShotPlanIssue[] = [];
  const beatIds = new Set(beats.map((beat) => beat.id));
  const shotIds = new Set<string>();
  const seenBeatIds = new Set<string>();
  const coverage = new Map<string, string[]>();
  let totalFrames = 0;

  for (const beat of beats) {
    if (typeof beat.id !== 'string' || !isValidStableId(beat.id)) {
      issues.push({ code: 'INVALID_BEAT_ID', message: 'Story beat ID must be nonblank' });
    } else if (seenBeatIds.has(beat.id)) {
      issues.push({ code: 'DUPLICATE_BEAT_ID', message: `Story beat ID ${beat.id} is repeated`, beatId: beat.id });
    }
    seenBeatIds.add(beat.id);
  }

  if (!Number.isSafeInteger(maxShots) || maxShots < 1) {
    issues.push({ code: 'MAX_SHOTS', message: 'Configured maximum shots must be a positive safe integer' });
  }
  if (beats.length === 0) issues.push({ code: 'NO_BEATS', message: 'An approved story must contain at least one beat' });
  if (shots.length === 0) issues.push({ code: 'NO_SHOTS', message: 'A shot plan must contain at least one shot' });
  if (Number.isSafeInteger(maxShots) && maxShots >= 1 && shots.length > maxShots) {
    issues.push({ code: 'MAX_SHOTS', message: `Shot count exceeds configured maximum of ${maxShots}` });
  }

  for (const shot of shots) {
    const validShotId = typeof shot.shotId === 'string' && isValidStableId(shot.shotId);
    if (!validShotId) issues.push({ code: 'INVALID_SHOT_ID', message: 'Shot ID must be a canonical stable ID', shotId: shot.shotId });
    if (validShotId) {
      if (shotIds.has(shot.shotId)) issues.push({ code: 'DUPLICATE_SHOT_ID', message: 'Shot IDs must be unique', shotId: shot.shotId });
      shotIds.add(shot.shotId);
    }

    if (!Array.isArray(shot.beatIds) || shot.beatIds.length === 0) {
      issues.push({ code: 'INVALID_BEAT_BINDINGS', message: 'Each shot must bind at least one story beat', shotId: shot.shotId });
    } else {
      const perShot = new Set<string>();
      for (const beatId of shot.beatIds) {
        if (perShot.has(beatId)) issues.push({ code: 'INVALID_BEAT_BINDINGS', message: 'Beat IDs cannot repeat within a shot', shotId: shot.shotId, beatId });
        perShot.add(beatId);
        if (!beatIds.has(beatId)) issues.push({ code: 'UNKNOWN_BEAT', message: `Shot references unknown story beat ${beatId}`, shotId: shot.shotId, beatId });
        const shotList = coverage.get(beatId) ?? [];
        if (validShotId && !shotList.includes(shot.shotId)) shotList.push(shot.shotId);
        coverage.set(beatId, shotList);
      }
    }

    const hasPositiveSafeDuration = Number.isSafeInteger(shot.targetFrames) && shot.targetFrames > 0;
    if (!hasPositiveSafeDuration || shot.targetFrames > 100_000) {
      issues.push({ code: 'INVALID_DURATION', message: 'Shot duration must be a positive safe integer frame count no greater than 100000', shotId: shot.shotId });
    }
    if (hasPositiveSafeDuration && !Number.isSafeInteger(totalFrames + shot.targetFrames)) {
      issues.push({ code: 'TOTAL_FRAMES_UNSAFE', message: 'Total planned frame count exceeds safe integer range', shotId: shot.shotId });
    } else if (hasPositiveSafeDuration) {
      totalFrames += shot.targetFrames;
    }
  }

  for (const beat of beats) {
    if ((coverage.get(beat.id)?.length ?? 0) === 0) {
      issues.push({ code: 'UNCOVERED_BEAT', message: `Story beat ${beat.id} has no shot coverage`, beatId: beat.id });
    }
  }

  return {
    issues,
    totalFrames: issues.some((issue) => issue.code === 'INVALID_DURATION' || issue.code === 'TOTAL_FRAMES_UNSAFE')
      ? null
      : totalFrames,
    beatCoverage: beats.map((beat) => ({ beatId: beat.id, shotIds: coverage.get(beat.id) ?? [] })),
  };
}

export type ShotPage<T extends ShotPlanShot> = { items: T[]; nextCursor: string | null };

/** Deterministic offset paging; the immutable source order is retained by the cursor. */
export function paginateShots<T extends ShotPlanShot>(
  shots: readonly T[],
  pageSize: number,
  cursor: string | null = null,
): ShotPage<T> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive safe integer');
  const offset = cursor === null ? 0 : /^offset:(0|[1-9]\d*)$/.test(cursor) ? Number(cursor.slice(7)) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > shots.length) throw new RangeError('cursor is invalid for this shot list');
  const items = shots.slice(offset, offset + pageSize);
  const nextOffset = offset + items.length;
  return { items: [...items], nextCursor: nextOffset < shots.length ? `offset:${nextOffset}` : null };
}

/** Append a resumed chunk while refusing duplicate stable shot IDs. */
export function appendShotPlanChunk<T extends ShotPlanShot>(existing: readonly T[], chunk: readonly T[]): T[] {
  const ids = new Set(existing.map((shot) => shot.shotId));
  for (const shot of chunk) {
    if (ids.has(shot.shotId)) throw new Error(`Cannot resume shot plan: duplicate shot ID ${shot.shotId}`);
    ids.add(shot.shotId);
  }
  return [...existing, ...chunk];
}
