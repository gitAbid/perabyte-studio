import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveProjectCreationFlow, deriveRevisionProvenance, deriveScriptImport, deriveScriptSaveFacts,
  deriveStaleDependencyNotices, serializeDisplay,
} from './project-canon';
import {
  deriveCanonSaveBanner, deriveMutationFailure, deriveProposalOutcome, deriveScriptBeats, deriveScriptSaveReadiness,
  formatEnvelope, scopeIssues, STORY_BEAT_NARRATION_MAX_CHARS,
} from '../../components/production/project-canon';
import type { CanonRevision, DependencyIssue, StoryRevision } from './contracts';

const hash = (seed: string) => createHash('sha256').update(seed).digest('hex');
const canonRevision = (over: Partial<CanonRevision> = {}): CanonRevision => ({
  version: 1, id: 'canon_1', entityId: 'char_ayo', entityKind: 'character', revision: 1,
  description: 'Ayo, a rooftop courier', attributes: {}, referenceAssetIds: ['asset_ref_1'],
  contentHash: hash('canon_1'), createdAt: 1, ...over,
});
const storyRevision = (over: Partial<StoryRevision> = {}): StoryRevision => ({
  version: 1, id: 'story_1', projectId: 'project_1', parentRevisionId: null,
  scriptText: 'INT. ROOFTOP - DAWN\nAyo sprints across the rails.', beats: [{ id: 'beat_1', action: 'Ayo runs', narration: '', dialogue: [], order: 0 }],
  canonRevisionIds: ['canon_1'], contentHash: hash('story_1'), createdAt: 1, ...over,
});
const issue = (over: Partial<DependencyIssue> = {}): DependencyIssue => ({
  targetKind: 'shot', targetId: 'shot_1', dependencyKind: 'canon',
  pinnedDependencyId: 'canon_old', activeDependencyId: 'canon_new', code: 'DEPENDENCY_REPLACED', ...over,
});
const characterDraft = (over: Record<string, unknown> = {}) => ({
  entityId: 'char_ayo', entityKind: 'character', description: 'Ayo, a rooftop courier', attributes: {}, assetIds: [], ...over,
});
const locationDraft = (over: Record<string, unknown> = {}) => ({
  entityId: 'loc_rooftop', entityKind: 'location', description: 'Lagos rooftop at dawn', attributes: {}, assetIds: [], ...over,
});
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

describe('deriveProjectCreationFlow', () => {
  it('derives a ready project command from valid details, trimming the name', () => {
    const flow = deriveProjectCreationFlow({ name: '  Portrait Session  ', profileId: 'profile_portrait_v1' });
    expect(flow.issues).toEqual([]);
    expect(flow.projectCommand).toEqual({ name: 'Portrait Session', profileId: 'profile_portrait_v1' });
    expect(flow.stepComplete.details).toBe(true);
    expect(flow.nextStep).toBe('cast');
  });

  it('keeps the flow incomplete with issues for blank, oversized or misbound details', () => {
    for (const name of ['   ', 'x'.repeat(161), 7]) {
      const flow = deriveProjectCreationFlow({ name, profileId: 'profile_portrait_v1' });
      expect(flow.projectCommand).toBeNull();
      expect(flow.stepComplete.details).toBe(false);
      expect(flow.issues.length).toBeGreaterThan(0);
    }
    const flow = deriveProjectCreationFlow({ name: 'Portrait', profileId: 'bad id!' });
    expect(flow.projectCommand).toBeNull();
    expect(flow.issues.some((entry) => entry.field === 'profileId')).toBe(true);
  });

  it('advances only after one valid cast and one valid world entity', () => {
    const base = { name: 'Portrait', profileId: 'profile_portrait_v1' };
    expect(deriveProjectCreationFlow(base).nextStep).toBe('cast');
    const withCast = { ...base, cast: [characterDraft()] };
    expect(deriveProjectCreationFlow(withCast).nextStep).toBe('world');
    const flow = deriveProjectCreationFlow({ ...withCast, world: [locationDraft()] });
    expect(flow.stepComplete.cast).toBe(true);
    expect(flow.stepComplete.world).toBe(true);
    expect(flow.nextStep).toBe('script');
    expect(flow.canonDrafts).toHaveLength(2);
  });

  it('rejects misplaced entity kinds, duplicate entity pins and out-of-bounds drafts', () => {
    const flow = deriveProjectCreationFlow({
      name: 'Portrait', profileId: 'profile_portrait_v1',
      cast: [characterDraft({ description: '   ' }), locationDraft({ entityId: 'loc_dup' })],
      world: [locationDraft({ entityId: 'loc_dup' }), { ...locationDraft(), assetIds: Array.from({ length: 101 }, (_, index) => `asset_${index}`) }, characterDraft({ entityId: 'char_in_world' })],
    });
    expect(flow.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(['ENTITY_KIND_MISMATCH', 'DUPLICATE_ENTITY', 'INVALID_ENTITY_DRAFT']));
    expect(flow.issues.filter((entry) => entry.code === 'INVALID_ENTITY_DRAFT')).toHaveLength(2);
    expect(flow.issues.filter((entry) => entry.code === 'ENTITY_KIND_MISMATCH')).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'cast[1]', message: 'location entities belong in the world list, not cast' }),
      expect.objectContaining({ field: 'world[2]', message: 'character entities belong in the cast list, not world' }),
    ]));
    expect(flow.canonDrafts).toHaveLength(0);
    expect(flow.stepComplete.cast).toBe(false);
    expect(flow.stepComplete.world).toBe(false);
  });

  it('fails closed on a non-object draft without mutating the prior draft', () => {
    const frozen = deepFreeze({ name: 'Portrait', profileId: 'profile_portrait_v1', cast: [characterDraft()] });
    const before = JSON.stringify(frozen);
    expect(deriveProjectCreationFlow(null).issues.length).toBeGreaterThan(0);
    expect(deriveProjectCreationFlow('draft').issues.length).toBeGreaterThan(0);
    const flow = deriveProjectCreationFlow(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(flow.issues).toEqual([]);
  });
});

describe('deriveScriptImport', () => {
  it('accepts bounded plain text and derives display facts', () => {
    const result = deriveScriptImport({ text: 'INT. DAWN\nAction.', mediaType: 'text/plain' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ scriptText: 'INT. DAWN\nAction.', mediaType: 'text/plain', charCount: 17, lineCount: 2 });
      expect(result.value.byteLength).toBeGreaterThan(result.value.charCount - 17);
    }
  });

  it('enforces type and size bounds fail-closed', () => {
    expect(deriveScriptImport({ text: 'ok', mediaType: 'application/json' }).ok).toBe(false);
    expect(deriveScriptImport({ text: '   ' }).ok).toBe(false);
    expect(deriveScriptImport({ text: 'a'.repeat(500_001) }).ok).toBe(false);
    expect(deriveScriptImport({ text: 42 }).ok).toBe(false);
    expect(deriveScriptImport('raw').ok).toBe(false);
    expect(deriveScriptImport({ text: 'a'.repeat(500_000) }).ok).toBe(true);
  });

  it('never mutates the prior import payload on failure', () => {
    const frozen = deepFreeze({ text: '   ', mediaType: 'application/json' });
    const result = deriveScriptImport(frozen);
    expect(result.ok).toBe(false);
    expect(frozen).toEqual({ text: '   ', mediaType: 'application/json' });
  });
});

describe('deriveScriptSaveFacts', () => {
  it('derives append-new-immutable-revision semantics from an active revision', () => {
    const result = deriveScriptSaveFacts({ activeStoryRevisionId: 'story_1', scriptText: 'INT. DAWN' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ baseRevisionId: 'story_1', createsNewRevision: true, immutable: true, priorRevisionPreserved: true });
      expect(result.value.label).toContain('immutable');
    }
  });

  it('reports a first save when no story revision is active yet', () => {
    const result = deriveScriptSaveFacts({ activeStoryRevisionId: null, scriptText: 'INT. DAWN' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ baseRevisionId: null, priorRevisionPreserved: false, createsNewRevision: true });
  });

  it('rejects invalid active revision IDs and unbounded script text', () => {
    expect(deriveScriptSaveFacts({ activeStoryRevisionId: '', scriptText: 'x' }).ok).toBe(false);
    expect(deriveScriptSaveFacts({ activeStoryRevisionId: 'story_1', scriptText: 'a'.repeat(500_001) }).ok).toBe(false);
    expect(deriveScriptSaveFacts({ activeStoryRevisionId: 'story_1', scriptText: '  ' }).ok).toBe(false);
    expect(deriveScriptSaveFacts(null).ok).toBe(false);
  });
});

describe('deriveStaleDependencyNotices', () => {
  it('maps the C02 schemaVersion-2 dependencyIssues into human-readable notices', () => {
    const result = deriveStaleDependencyNotices({ schemaVersion: 2, dependencyIssues: [issue()] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        code: 'DEPENDENCY_REPLACED', targetKind: 'shot', targetId: 'shot_1',
        pinnedDependencyId: 'canon_old', activeDependencyId: 'canon_new',
      });
      expect(result.value[0].message).toContain('shot_1');
      expect(result.value[0].message).toContain('canon_old');
      expect(result.value[0].message).toContain('canon_new');
    }
  });

  it('describes replaced, changed and missing dependencies distinctly', () => {
    const result = deriveStaleDependencyNotices([
      issue({ code: 'DEPENDENCY_MISSING', targetId: 'shot_2', activeDependencyId: null }),
      issue({ code: 'STORY_CHANGED', targetKind: 'shotplan', targetId: 'plan_1', dependencyKind: 'story', pinnedDependencyId: 'story_7', activeDependencyId: 'story_9' }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const noticeFor = (targetId: string) => result.value.find((notice) => notice.targetId === targetId);
      expect(noticeFor('shot_2')?.message).toContain('no longer exists');
      expect(noticeFor('plan_1')?.message).toContain('story_7');
      expect(noticeFor('plan_1')?.message).toContain('story_9');
      expect(result.value.map((notice) => notice.targetId)).toEqual(['plan_1', 'shot_2']);
    }
  });

  it('reports which selected anchor and take are stale for a shot target', () => {
    const shots = [{ shotRevision: { id: 'shot_1' }, selectedAnchor: { id: 'anchor_9' }, selectedTake: { id: 'take_3' } }];
    const result = deriveStaleDependencyNotices([issue()], shots);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({ anchorId: 'anchor_9', takeId: 'take_3' });
      expect(result.value[0].message).toContain('anchor_9');
      expect(result.value[0].message).toContain('take_3');
    }
    expect(deriveStaleDependencyNotices([issue()], [{ shotRevision: { id: 'other' }, selectedAnchor: null, selectedTake: null }]).ok).toBe(true);
    expect(deriveStaleDependencyNotices([issue()], [{ shotRevision: {} }]).ok).toBe(false);
  });

  it('fails closed on schema version drift, malformed issues and non-list input', () => {
    expect(deriveStaleDependencyNotices({ schemaVersion: 1, dependencyIssues: [issue()] }).ok).toBe(false);
    expect(deriveStaleDependencyNotices([{ ...issue(), code: 'SOMETHING_ELSE' }]).ok).toBe(false);
    expect(deriveStaleDependencyNotices([issue({ targetId: '' })]).ok).toBe(false);
    expect(deriveStaleDependencyNotices('issues').ok).toBe(false);
    expect(deriveStaleDependencyNotices([issue()], 'shots').ok).toBe(false);
  });

  it('serializes deterministically regardless of input order or duplicates', () => {
    const first = [issue(), issue({ targetId: 'shot_2' })];
    const second = [issue({ targetId: 'shot_2' }), issue(), issue()];
    const left = deriveStaleDependencyNotices({ schemaVersion: 2, dependencyIssues: first });
    const right = deriveStaleDependencyNotices({ schemaVersion: 2, dependencyIssues: second });
    expect(left.ok && right.ok).toBe(true);
    if (left.ok && right.ok) {
      expect(serializeDisplay(left.value)).toBe(serializeDisplay(right.value));
      expect(left.value).toHaveLength(2);
    }
  });
});

describe('deriveRevisionProvenance', () => {
  it('derives source-revision facts and dependencies for a story revision', () => {
    const result = deriveRevisionProvenance({ kind: 'story', revision: storyRevision({ parentRevisionId: 'story_0', canonRevisionIds: ['canon_1', 'canon_2'] }) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ kind: 'story', revisionId: 'story_1', parentRevisionId: 'story_0', dependencies: ['canon_1', 'canon_2'] });
      expect(result.value.saveSemantics).toMatchObject({ createsNewRevision: true, immutable: true });
      expect(result.value.contentHash).toBe(hash('story_1'));
    }
  });

  it('derives provenance for canon and shot-plan revisions', () => {
    const canon = deriveRevisionProvenance({ kind: 'canon', revision: canonRevision() });
    expect(canon.ok && canon.value.dependencies).toEqual(['asset_ref_1']);
    const plan = deriveRevisionProvenance({ kind: 'shotplan', revision: {
      version: 1, id: 'plan_1', projectId: 'project_1', storyRevisionId: 'story_1',
      orderedShotRevisionIds: ['shot_1'], beatCoverage: [{ beatId: 'beat_1', shotRevisionIds: ['shot_1'] }],
      contentHash: hash('plan_1'), createdAt: 1,
    } });
    expect(plan.ok && plan.value.dependencies).toEqual(['story_1']);
  });

  it('fails closed on malformed revisions without mutating inputs', () => {
    const bad = deepFreeze({ kind: 'story', revision: storyRevision({ contentHash: 'nothex' }) });
    expect(deriveRevisionProvenance(bad).ok).toBe(false);
    expect(deriveRevisionProvenance({ kind: 'unknown', revision: {} }).ok).toBe(false);
    expect(deriveRevisionProvenance(null).ok).toBe(false);
  });
});

describe('serializeDisplay', () => {
  it('is key-order independent for identical display structures', () => {
    expect(serializeDisplay({ a: 1, b: { c: 2, d: 3 } })).toBe(serializeDisplay({ b: { d: 3, c: 2 }, a: 1 }));
    expect(serializeDisplay([issue(), issue({ targetId: 'shot_2' })])).toBe(serializeDisplay([issue(), issue({ targetId: 'shot_2' })]));
  });
});

/* C07-FULL-UI additive cases: the new-UI view-model helpers in
 * components/production/project-canon.tsx are plain functions consumed by the
 * canon/script pages; these cases pin their contract on top of the accepted
 * domain derivations above. No existing case is modified. */
describe('C07-FULL-UI creation-flow view-model (additive)', () => {
  it('a successful full flow yields the POST projects command, canon commands and script import', () => {
    const flow = deriveProjectCreationFlow({
      name: 'Canon Session', profileId: 'storybook-short-v1',
      cast: [characterDraft()], world: [locationDraft()],
      script: { text: 'INT. DAWN\n\nAyo runs.', mediaType: 'text/plain' },
    });
    expect(flow.issues).toEqual([]);
    expect(flow.projectCommand).toEqual({ name: 'Canon Session', profileId: 'storybook-short-v1' });
    expect(flow.canonDrafts).toEqual([characterDraft(), locationDraft()]);
    expect(flow.script).toMatchObject({ scriptText: 'INT. DAWN\n\nAyo runs.', mediaType: 'text/plain', charCount: 20 });
    expect(flow.stepComplete).toEqual({ details: true, cast: true, world: true, script: true });
    expect(flow.nextStep).toBeNull();
  });

  it('maps derivation issues onto wizard steps and field paths via scopeIssues', () => {
    const flow = deriveProjectCreationFlow({
      name: '   ', profileId: 'storybook-short-v1',
      cast: [characterDraft(), characterDraft()],
      world: [characterDraft({ entityId: 'char_misplaced' })],
      script: { text: '   ' },
    });
    expect(scopeIssues(flow.issues, 'details').map((entry) => entry.code)).toContain('INVALID_PROJECT_DETAILS');
    expect(scopeIssues(flow.issues, 'details').some((entry) => entry.field === 'name')).toBe(true);
    expect(scopeIssues(flow.issues, 'cast').map((entry) => entry.code)).toContain('DUPLICATE_ENTITY');
    expect(scopeIssues(flow.issues, 'cast').some((entry) => entry.field === 'cast[1]')).toBe(true);
    expect(scopeIssues(flow.issues, 'world').map((entry) => entry.code)).toContain('ENTITY_KIND_MISMATCH');
    expect(scopeIssues(flow.issues, 'script').map((entry) => entry.code)).toContain('EMPTY_SCRIPT');
    // 101 asset IDs surface as a per-field invalid-draft issue on the owning step.
    const overAssets = deriveProjectCreationFlow({
      name: 'Canon Session', profileId: 'storybook-short-v1',
      cast: [characterDraft({ assetIds: Array.from({ length: 101 }, (_, index) => `asset_${index}`) })],
      world: [locationDraft()],
    });
    expect(scopeIssues(overAssets.issues, 'cast').some((entry) => entry.field === 'assetIds')).toBe(true);
  });

  it('deriveScriptBeats chunks blank-line paragraphs within the per-beat bound deterministically', () => {
    const beats = deriveScriptBeats('INT. DAWN\nAyo sprints.\n\nAyo breathes.');
    expect(beats).toEqual([
      { id: 'beat_1', action: 'INT. DAWN', narration: 'INT. DAWN\nAyo sprints.', dialogue: [] },
      { id: 'beat_2', action: 'Ayo breathes.', narration: 'Ayo breathes.', dialogue: [] },
    ]);
    const chunked = deriveScriptBeats('x'.repeat(25_000));
    expect(chunked).toHaveLength(2);
    expect(chunked.every((beat) => beat.narration.length <= STORY_BEAT_NARRATION_MAX_CHARS)).toBe(true);
    expect(chunked[0].narration.length + chunked[1].narration.length).toBe(25_000);
    expect(chunked.map((beat) => beat.id)).toEqual(['beat_1', 'beat_2']);
    expect(deriveScriptBeats('   \n\n  ')).toEqual([]);
  });

  it('deriveScriptSaveReadiness combines the accepted save facts with the beat-count bound', () => {
    const ready = deriveScriptSaveReadiness({ activeStoryRevisionId: 'story_1', scriptText: 'INT. DAWN\n\nAyo runs.' });
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      expect(ready.facts).toMatchObject({ baseRevisionId: 'story_1', createsNewRevision: true, immutable: true, priorRevisionPreserved: true });
      expect(ready.beats).toHaveLength(2);
      expect(ready.import.charCount).toBe('INT. DAWN\n\nAyo runs.'.length);
    }
    const tooManyBeats = deriveScriptSaveReadiness({
      activeStoryRevisionId: null,
      scriptText: Array.from({ length: 10_001 }, (_, index) => `p${index}`).join('\n\n'),
    });
    expect(tooManyBeats.ok).toBe(false);
    if (!tooManyBeats.ok) expect(tooManyBeats.issues.some((entry) => entry.code === 'TOO_MANY_BEATS')).toBe(true);
    expect(deriveScriptSaveReadiness({ activeStoryRevisionId: null, scriptText: '   ' }).ok).toBe(false);
  });

  it('deriveProposalOutcome renders the 403 envelope as not-yet-entitled and never fakes success', () => {
    const blocked = deriveProposalOutcome(403, {
      error: { code: 'BUDGET_BLOCKED', message: 'Text proposal generation is not authorized', retryable: false },
      requestId: 'req_1',
    }, false);
    expect(blocked).toMatchObject({ state: 'not_entitled', envelope: { code: 'BUDGET_BLOCKED', requestId: 'req_1', status: 403 } });
    expect(deriveProposalOutcome(null, null, true).state).toBe('network');
    expect(deriveProposalOutcome(500, { error: { code: 'INTERNAL_ERROR', message: 'x', retryable: false }, requestId: 'req_2' }, false).state).toBe('failed');
    expect(deriveProposalOutcome(201, { unexpected: true }, false).state).toBe('invalid_success');
    expect(deriveProposalOutcome(201, { proposalId: 'prop_1' }, false)).toMatchObject({ state: 'saved', proposalId: 'prop_1' });
  });

  it('deriveMutationFailure and formatEnvelope surface code, message, action and request id', () => {
    const envelope = deriveMutationFailure(409, {
      error: { code: 'STALE_REVISION', message: 'Active story changed; reload and retry', action: 'Reload the project', retryable: true },
      requestId: 'req_9',
    }, false);
    expect(envelope).toMatchObject({ code: 'STALE_REVISION', requestId: 'req_9', status: 409, shape: 'envelope', action: 'Reload the project' });
    const rendered = formatEnvelope(envelope);
    expect(rendered).toContain('STALE_REVISION');
    expect(rendered).toContain('Active story changed');
    expect(rendered).toContain('req_9');
    expect(deriveMutationFailure(null, null, true)).toMatchObject({ code: 'NETWORK_ERROR', shape: 'network' });
    expect(deriveMutationFailure(502, { not: 'an envelope' }, false)).toMatchObject({ code: 'UNKNOWN_RESPONSE', shape: 'unparseable' });
  });
});

/* Review follow-up pins for the C07-FULL-UI canon banner honesty and the
 * creation-flow beats gate; still strictly additive. */
describe('C07-FULL-UI review follow-ups (additive)', () => {
  it('deriveCanonSaveBanner claims creation only when the pin actually moved', () => {
    const created = deriveCanonSaveBanner({ entityId: 'char_ayo', revisionId: 'canon_new', expectedRevisionId: 'canon_old' });
    expect(created.created).toBe(true);
    expect(created.text).toContain('created a new immutable revision');
    expect(created.text).toContain('canon_new');
    const firstPin = deriveCanonSaveBanner({ entityId: 'char_ayo', revisionId: 'canon_first', expectedRevisionId: null });
    expect(firstPin.created).toBe(true);
    const deduped = deriveCanonSaveBanner({ entityId: 'char_ayo', revisionId: 'canon_old', expectedRevisionId: 'canon_old' });
    expect(deduped.created).toBe(false);
    expect(deduped.text).toContain('content identical');
    expect(deduped.text).toContain('no new revision needed');
  });

  it('the creation-flow script preflight rejects beat-bound overflow that the import bounds alone accept', () => {
    const scriptText = Array.from({ length: 10_001 }, (_, index) => `p${index}`).join('\n\n');
    expect(deriveScriptImport({ text: scriptText, mediaType: 'text/plain' }).ok).toBe(true);
    const readiness = deriveScriptSaveReadiness({ activeStoryRevisionId: null, scriptText });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.issues.map((entry) => entry.code)).toContain('TOO_MANY_BEATS');
  });
});
