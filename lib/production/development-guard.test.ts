import { describe, expect, it } from 'vitest';
import * as guard from './development-guard';

const evaluateUsageSnapshot = (...args: Parameters<typeof guard.evaluateUsageSnapshot>) =>
  guard.evaluateUsageSnapshot(...args);
const validateHandoverState = (...args: Parameters<typeof guard.validateHandoverState>) =>
  guard.validateHandoverState(...args);

describe('evaluateUsageSnapshot', () => {
  it.each([
    ['weekly 1.5% remains above its configured stop', 98.5, 50, 'continue', 1.5],
    ['weekly 1% reaches its configured stop', 99, 50, 'stop', 1],
    ['five-hour 2% reaches its configured stop', 50, 98, 'stop', 2],
    ['used 2% means 98% remains', 2, 50, 'continue', 50],
  ])('applies explicit per-duration usage policy: %s', (_caseName, weeklyUsed, fiveHourUsed, decision, minimumRemaining) => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        model: {
          primary: { usedPercent: weeklyUsed, windowDurationMins: 10080 },
          secondary: { usedPercent: fiveHourUsed, windowDurationMins: 300 },
        },
      },
    }, {
      weeklyStopRemainingPercent: 1,
      fiveHourStopRemainingPercent: 2,
    });

    expect(result.decision).toBe(decision);
    expect(result.minimumRemainingPercent).toBe(minimumRemaining);
  });

  it('returns unknown when explicit policy windows have an unknown duration', () => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        model: {
          primary: { usedPercent: 99, windowDurationMins: 10080 },
          secondary: { usedPercent: 20 },
        },
      },
    }, {
      weeklyStopRemainingPercent: 1,
      fiveHourStopRemainingPercent: 2,
    });

    expect(result.decision).toBe('unknown');
    expect(result.reasons.join(' ')).toMatch(/duration/i);
  });

  it('stops at exactly two percent and reports the minimum across every bucket', () => {
    expect(guard.evaluateUsageSnapshot).toBeTypeOf('function');
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        model: {
          primary: { usedPercent: 98, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 95, resetsAt: null },
        },
        coding: {
          primary: { usedPercent: 91 },
          secondary: { usedPercent: 94 },
        },
      },
      rateLimits: {
        primary: { usedPercent: 10 },
        secondary: { usedPercent: 10 },
      },
    });

    expect(result.decision).toBe('stop');
    expect(result.minimumRemainingPercent).toBe(2);
    expect(result.windows).toHaveLength(4);
    expect(result.windows[0]).toEqual({
      limitId: 'model',
      window: 'primary',
      remainingPercent: 2,
      resetAt: 1_800_000_000,
    });
    expect(result.reasons.join(' ')).toMatch(/2%/);
  });

  it('checkpoints at five percent but continues above the reserve', () => {
    const checkpoint = evaluateUsageSnapshot({
      rateLimits: {
        primary: { usedPercent: 95 },
        secondary: { usedPercent: 80 },
      },
    });
    const proceed = evaluateUsageSnapshot({
      rateLimits: {
        primary: { usedPercent: 94.99 },
        secondary: { usedPercent: 75 },
      },
    });

    expect(checkpoint.decision).toBe('checkpoint');
    expect(checkpoint.minimumRemainingPercent).toBe(5);
    expect(proceed.decision).toBe('continue');
    expect(proceed.minimumRemainingPercent).toBeCloseTo(5.01);
  });

  it('falls back to legacy rateLimits when the newer map is empty', () => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: {},
      rateLimits: {
        primary: { usedPercent: 20, resetAt: 123 },
        secondary: { usedPercent: 80, resetsAt: 456 },
      },
    });

    expect(result.decision).toBe('continue');
    expect(result.minimumRemainingPercent).toBe(20);
    expect(result.windows).toEqual([
      { limitId: 'legacy', window: 'primary', remainingPercent: 80, resetAt: 123 },
      { limitId: 'legacy', window: 'secondary', remainingPercent: 20, resetAt: 456 },
    ]);
  });

  it('returns unknown when no windows or required window percentages are available', () => {
    const noWindows = evaluateUsageSnapshot({ rateLimitsByLimitId: {}, rateLimits: {} });
    const missingBucket = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        model: { primary: { usedPercent: 40 }, secondary: null },
      },
    });
    const malformedBuckets = evaluateUsageSnapshot({
      rateLimits: {
        primary: { usedPercent: '99' },
        secondary: { usedPercent: 101 },
      },
    });

    expect(noWindows.decision).toBe('unknown');
    expect(noWindows.minimumRemainingPercent).toBeNull();
    expect(noWindows.windows).toEqual([]);
    expect(missingBucket.decision).toBe('unknown');
    expect(missingBucket.minimumRemainingPercent).toBe(60);
    expect(malformedBuckets.decision).toBe('unknown');
    expect(malformedBuckets.minimumRemainingPercent).toBeNull();
  });

  it('lets a known hard stop override unknown windows', () => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        one: {
          primary: { usedPercent: 99 },
          secondary: { usedPercent: null },
        },
        two: { primary: { usedPercent: 40 }, secondary: {} },
      },
    });

    expect(result.decision).toBe('stop');
    expect(result.minimumRemainingPercent).toBe(1);
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/missing|invalid/i), expect.stringMatching(/2%/)]));
  });

  it('stops when explicit usage controls deny work despite percentage headroom', () => {
    const ordinaryDenied = evaluateUsageSnapshot({
      ordinaryUsageAllowed: false,
      rateLimits: {
        primary: { usedPercent: 20 },
        secondary: { usedPercent: 10 },
      },
    });
    const bucketStop = evaluateUsageSnapshot({
      rateLimitsByLimitId: {
        model: {
          primary: { usedPercent: 20, spendControlReached: true },
          secondary: { usedPercent: 10 },
        },
      },
    });
    const reachedType = evaluateUsageSnapshot({
      rateLimits: {
        primary: { usedPercent: 20, rateLimitReachedType: 'window_limit' },
        secondary: { usedPercent: 10 },
      },
    });

    expect(ordinaryDenied.decision).toBe('stop');
    expect(ordinaryDenied.minimumRemainingPercent).toBe(80);
    expect(bucketStop.decision).toBe('stop');
    expect(reachedType.decision).toBe('stop');
  });

  it.each([
    ['root', { rateLimitReached: true }],
    ['bucket', { rateLimitsByLimitId: { model: {
      rateLimitReached: true,
      primary: { usedPercent: 20 },
      secondary: { usedPercent: 10 },
    } } }],
    ['window', { rateLimitsByLimitId: { model: {
      primary: { usedPercent: 20, rateLimitReached: true },
      secondary: { usedPercent: 10 },
    } } }],
  ])('stops when rateLimitReached is true at the %s level', (_level, controls) => {
    const result = evaluateUsageSnapshot({
      rateLimits: {
        primary: { usedPercent: 20 },
        secondary: { usedPercent: 10 },
      },
      ...controls,
    });

    expect(result.decision).toBe('stop');
    expect(result.minimumRemainingPercent).toBe(80);
  });

  it('does not infer headroom from credits when usage windows are unavailable', () => {
    const result = evaluateUsageSnapshot({ creditBalance: 1_000_000 });

    expect(result.decision).toBe('unknown');
    expect(result.minimumRemainingPercent).toBeNull();
    expect(JSON.stringify(result).toLowerCase()).not.toContain('credit');
  });

  it('does not fall back to legacy data when a nonempty newer payload is malformed', () => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: { model: { primary: null, secondary: null } },
      rateLimits: {
        primary: { usedPercent: 10 },
        secondary: { usedPercent: 10 },
      },
    });

    expect(result.decision).toBe('unknown');
  });

  it('accepts array buckets and does not return unrelated credits or account data', () => {
    const result = evaluateUsageSnapshot({
      rateLimitsByLimitId: [
        {
          limitId: 'image',
          primary: { usedPercent: 35 },
          secondary: { usedPercent: 20 },
        },
      ],
      accountId: 'private-account-marker',
      creditBalance: 999,
    });

    expect(result.decision).toBe('continue');
    expect(JSON.stringify(result)).not.toContain('private-account-marker');
    expect(JSON.stringify(result).toLowerCase()).not.toContain('creditbalance');
  });
});

const validPacket = (overrides: Record<string, unknown> = {}) => ({
  id: 'U00',
  owner: 'worker-1',
  branch: 'codex/production-handover-guard',
  worktree: '/Users/example/worktree',
  base_sha: '4d4b6584109d1f09bb9bac8e52d6e88359c9c42f',
  head_sha: 'a'.repeat(40),
  status: 'checkpointing',
  dirty_files: ['lib/production/development-guard.ts'],
  evidence_paths: ['evidence/U00/red.txt'],
  next_command: ['npm', 'test', '--', 'lib/production/development-guard.test.ts'],
  unverified: ['CLI usage snapshot case not yet run'],
  ...overrides,
});

const validState = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  state: 'checkpointing',
  integration: {
    branch: 'codex/production-core',
    worktree: '/Users/example/integration',
  },
  active_packets: [validPacket()],
  ...overrides,
});

describe('validateHandoverState', () => {
  it('requires usage_paused windows to meet their configured duration-specific stops', () => {
    const policy = {
      weekly_stop_remaining_percent: 1,
      five_hour_stop_remaining_percent: 2,
      dispatch_reserve_remaining_percent: null,
    };
    const observation = (weekly: number, fiveHour: number) => ({
      verified: true,
      source: 'Codex account usage tool',
      windows: [
        { limitId: 'model', window: 'secondary', remainingPercent: fiveHour, resetAt: null, windowDurationMins: 300 },
        { limitId: 'model', window: 'primary', remainingPercent: weekly, resetAt: null, windowDurationMins: 10080 },
      ],
    });

    expect(validateHandoverState(validState({
      state: 'usage_paused',
      usage_policy: policy,
      last_usage_observation: observation(1.5, 80),
    })).join(' ')).toMatch(/configured usage stop/i);
    expect(validateHandoverState(validState({
      state: 'usage_paused',
      usage_policy: policy,
      last_usage_observation: observation(1, 80),
    }))).toEqual([]);
  });

  it('accepts a checkpoint with complete packet fields and pending evidence truth', () => {
    const state = validState();

    expect(validateHandoverState(state)).toEqual([]);
    expect((state.active_packets[0] as { unverified: string[] }).unverified).toEqual([
      'CLI usage snapshot case not yet run',
    ]);
  });

  it('allows an empty building state', () => {
    expect(validateHandoverState(validState({ state: 'building', active_packets: [] }))).toEqual([]);
  });

  it('requires unique packet ids and worktrees', () => {
    const duplicateId = validState({ active_packets: [validPacket(), validPacket({ worktree: '/Users/example/other' })] });
    const duplicateWorktree = validState({
      active_packets: [validPacket(), validPacket({ id: 'U01', branch: 'codex/other' })],
    });

    expect(validateHandoverState(duplicateId).join(' ')).toMatch(/unique.*id/i);
    expect(validateHandoverState(duplicateWorktree).join(' ')).toMatch(/unique.*worktree/i);
  });

  it('requires each active packet to have a unique owner', () => {
    const duplicateOwner = validState({
      active_packets: [validPacket(), validPacket({ id: 'U01', branch: 'codex/other', worktree: '/Users/example/other' })],
    });

    expect(validateHandoverState(duplicateOwner).join(' ')).toMatch(/unique.*owner/i);
  });

  it('requires 40-character SHAs, absolute worktrees and safe arrays', () => {
    const invalid = validState({
      integration: { branch: '', worktree: 'relative/path' },
      active_packets: [
        validPacket({
          worktree: 'relative/path',
          base_sha: 'abc',
          head_sha: 'g'.repeat(40),
          dirty_files: ['ok', 3],
          evidence_paths: 'not-an-array',
          next_command: ['npm\nrun'],
          unverified: [null],
        }),
      ],
    });

    expect(validateHandoverState(invalid).length).toBeGreaterThanOrEqual(6);
    expect(validateHandoverState(validState({
      active_packets: [validPacket({ next_command: [] })],
    })).join(' ')).toMatch(/argv/i);
    for (const argv of [['', 'npm'], ['   ', 'npm']]) {
      expect(validateHandoverState(validState({
        active_packets: [validPacket({ next_command: argv })],
      })).join(' ')).toMatch(/argv\[0\]/i);
    }
  });

  it.each(['accepted', 'done'])('requires final evidence and no unverified work for %s packets', (status) => {
    const packet = validPacket({ status, evidence_paths: [], unverified: ['one item remains'] });
    const errors = validateHandoverState(validState({ active_packets: [packet] }));

    expect(errors.join(' ')).toMatch(/evidence/i);
    expect(errors.join(' ')).toMatch(/unverified/i);
  });

  it('requires a verified usage observation at or below two percent when paused for usage', () => {
    const validPaused = validState({
      state: 'usage_paused',
      last_usage_observation: {
        verified: true,
        source: 'Codex account usage tool',
        primary_remaining_percent: 2,
        secondary_remaining_percent: 80,
      },
    });
    const unverifiedPaused = validState({
      state: 'usage_paused',
      last_usage_observation: {
        verified: false,
        source: 'Codex account usage tool',
        primary_remaining_percent: 1,
      },
    });
    const aboveThreshold = validState({
      state: 'usage_paused',
      last_usage_observation: {
        verified: true,
        source: 'Codex account usage tool',
        primary_remaining_percent: 3,
      },
    });

    expect(validateHandoverState(validPaused)).toEqual([]);
    expect(validateHandoverState(unverifiedPaused).join(' ')).toMatch(/verified/i);
    expect(validateHandoverState(aboveThreshold).join(' ')).toMatch(/2%/);
  });

  it('rejects unknown state and schema versions', () => {
    expect(validateHandoverState(validState({ state: 'paused' })).join(' ')).toMatch(/state/i);
    expect(validateHandoverState(validState({ schema_version: 2 })).join(' ')).toMatch(/schema_version/i);
  });
});
