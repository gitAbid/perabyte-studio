import type { ModerationCategory } from '../../domain/moderation';

/**
 * F3 advisory moderation pre-check for creator-submitted proposal text (spec 08 §6 revise
 * instructions, story ideas). Purely deterministic keyword/category matching over the legacy
 * 18+ gate categories (lib/domain/moderation.ts: nudity, sexual_activity, suggestive) with the
 * same rubric: nudity and explicit sexual activity are gate-level, suggestive posing alone
 * stays open, and any sexualization of minors is the top-priority rule.
 *
 * ADVISORY ONLY: this module never throws on text content, never mutates anything and is not
 * wired into any route yet — the controller integrates it as a pre-check beside the future
 * provider pass. `allowed` is the fail-closed gate signal (false when a gate-level category or
 * an internal matching error is seen); `advisories` carries every deterministic finding so a
 * caller can show reasons without re-running the match.
 */

export type ModerationGateCode = ModerationCategory | 'underage_sexualization' | 'invalid_input' | 'gate_error';

export interface ModerationAdvisory {
  readonly code: ModerationGateCode;
  readonly reason: string;
}

export interface ProposalTextAssessment {
  readonly allowed: boolean;
  readonly advisories: readonly ModerationAdvisory[];
}

/** Keyword table for the three legacy categories; matching is lowercase whole-word based. */
const CATEGORY_KEYWORDS: Readonly<Record<ModerationCategory, readonly string[]>> = {
  nudity: ['nude', 'nudity', 'naked', 'topless', 'bottomless', 'unclothed', 'exposed breast', 'genitals', 'genitalia', 'nipple'],
  sexual_activity: [
    'sex scene', 'sexual act', 'sexual activity', 'explicit sex', 'erotic', 'masturbat', 'orgasm',
    'fetish', 'sex toy', 'porn', 'hardcore', 'intercourse', 'blowjob', 'handjob',
  ],
  suggestive: [
    'suggestive', 'sensual', 'seductive', 'lingerie', 'provocative', 'steamy', 'make out',
    'making out', 'passionate kiss', 'cleavage', 'striptease', 'strip tease',
  ],
};

/** Terms that mark a span as describing a minor; combined with a sexual keyword in one sentence span it is the top-priority advisory. */
const UNDERAGE_TERMS = [
  'child', 'children', 'kid', 'kids', 'teen', 'teenager', 'preteen', 'pre-teen', 'underage',
  'minor', 'schoolgirl', 'schoolboy', 'loli', 'shota', 'toddler', 'infant',
] as const;

const SENTENCE_SPLIT = /[.!?;\n]+/;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word-ish containment: word boundaries where the keyword edge is a word character. */
function containsKeyword(haystack: string, keyword: string): boolean {
  const first = keyword[0] ?? '';
  const last = keyword[keyword.length - 1] ?? '';
  const lead = /[a-z0-9]/.test(first) ? '\\b' : '';
  const tail = /[a-z0-9]/.test(last) ? '\\b' : '';
  return new RegExp(`${lead}${escapeRegExp(keyword)}${tail}`).test(haystack);
}

const categoryHits = (text: string, category: ModerationCategory): string[] =>
  CATEGORY_KEYWORDS[category].filter((keyword) => containsKeyword(text, keyword));

const underageTermHits = (span: string): string[] => UNDERAGE_TERMS.filter((term) => containsKeyword(span, term));

const anySexualHit = (span: string): boolean =>
  categoryHits(span, 'nudity').length > 0 || categoryHits(span, 'sexual_activity').length > 0;

/**
 * Deterministic keyword/category pre-check. Never throws on text content: a non-string input
 * is reported as `invalid_input`, an internal matching failure as `gate_error`, and both fail
 * closed (`allowed: false`) without leaking an exception into the caller's flow.
 */
export function assessProposalText(text: string): ProposalTextAssessment {
  try {
    if (typeof text !== 'string') {
      return { allowed: false, advisories: [{ code: 'invalid_input', reason: 'Proposal text must be a string; refusing to assess non-text content.' }] };
    }
    const normalized = text.toLowerCase();
    const advisories: ModerationAdvisory[] = [];
    // Top priority (legacy rubric): a minor described in the same or the immediately adjacent
    // sentence span as sexual/nudity content. Single spans and two-span windows are checked so
    // "follows a schoolgirl. Later, a nude scene." is caught while isolated minor wording is not.
    const spans = normalized.split(SENTENCE_SPLIT);
    const underage = new Set<string>();
    for (let index = 0; index < spans.length; index += 1) {
      const window = `${spans[index]} ${spans[index + 1] ?? ''}`.trim();
      const terms = underageTermHits(window);
      if (terms.length === 0 || !anySexualHit(window)) continue;
      for (const term of terms) underage.add(term);
    }
    if (underage.size > 0) {
      advisories.push({ code: 'underage_sexualization', reason: `Text combines minor-related wording (${[...underage].sort().join(', ')}) with sexual or nudity content — the top-priority 18+ gate rule.` });
    }
    for (const category of ['nudity', 'sexual_activity', 'suggestive'] as const) {
      const hits = categoryHits(normalized, category);
      if (hits.length === 0) continue;
      const gateLevel = category !== 'suggestive';
      advisories.push({
        code: category,
        reason: `Text mentions ${category} wording (${hits.join(', ')})${gateLevel ? ' — gate-level category under the 18+ preview rule.' : ' — suggestive only; stays open under the 18+ preview rule.'}`,
      });
    }
    const allowed = !advisories.some((advisory) => advisory.code !== 'suggestive');
    return { allowed, advisories };
  } catch (error) {
    return {
      allowed: false,
      advisories: [{ code: 'gate_error', reason: `The moderation pre-check could not complete (${error instanceof Error ? error.message : 'unknown error'}); failing closed.` }],
    };
  }
}
