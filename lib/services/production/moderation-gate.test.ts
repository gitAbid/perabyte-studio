import { describe, expect, it } from 'vitest';
import { assessProposalText } from './moderation-gate';

describe('advisory moderation gate', () => {
  it('allows ordinary story text with no advisories', () => {
    expect(assessProposalText('Luna fixes the lantern while the harbor fog rolls in.')).toEqual({ allowed: true, advisories: [] });
  });

  it('flags nudity and sexual activity as gate-level categories', () => {
    const nudity = assessProposalText('She stands naked on the beach at dawn.');
    expect(nudity.allowed).toBe(false);
    expect(nudity.advisories.map((a) => a.code)).toContain('nudity');
    const activity = assessProposalText('They reunite in an explicit sex scene.');
    expect(activity.allowed).toBe(false);
    expect(activity.advisories.map((a) => a.code)).toContain('sexual_activity');
  });

  it('keeps suggestive wording allowed while still reporting the advisory', () => {
    const assessment = assessProposalText('A sensual dance; she models lingerie at the photo shoot.');
    expect(assessment.allowed).toBe(true);
    expect(assessment.advisories.map((a) => a.code)).toEqual(['suggestive']);
    expect(assessment.advisories[0]?.reason).toContain('stays open');
  });

  it('gives minor-related sexualization the top-priority advisory and fails closed', () => {
    const assessment = assessProposalText('The story follows a schoolgirl. Later there is a nude scene.');
    expect(assessment.allowed).toBe(false);
    expect(assessment.advisories[0]?.code).toBe('underage_sexualization');
    // The same minor wording without sexual content is not flagged.
    const safe = assessProposalText('A schoolgirl walks to school past the harbor.');
    expect(safe.allowed).toBe(true);
    expect(safe.advisories).toEqual([]);
  });

  it('matches whole words only so place names do not false-positive', () => {
    const assessment = assessProposalText('The train passes through Essex and Sussex before Kent.');
    expect(assessment.allowed).toBe(true);
    expect(assessment.advisories).toEqual([]);
  });

  it('never throws: non-string input and hostile text return fail-closed assessments', () => {
    const nonString = assessProposalText(undefined as unknown as string);
    expect(nonString.allowed).toBe(false);
    expect(nonString.advisories[0]?.code).toBe('invalid_input');
    const surrogate = assessProposalText('“\uD800” \u0000 naked');
    expect(surrogate.allowed).toBe(false);
    expect(surrogate.advisories.map((a) => a.code)).toContain('nudity');
    expect(() => assessProposalText('x'.repeat(100_000))).not.toThrow();
  });
});
