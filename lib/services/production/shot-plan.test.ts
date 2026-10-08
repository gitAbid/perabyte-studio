import { describe, expect, it } from 'vitest';
import {
  ApprovalSchema,
  CanonRevisionSchema,
  ProjectSchema,
  SceneSchema,
  StoryRevisionSchema,
  type Approval,
  type CanonRevision,
  type CreateShotPlanCommand,
  type Project,
  type Scene,
  type StoryRevision,
} from '../../production/contracts';
import type { ProductionStore, ProductionWritePort } from '../../repositories/production/ports';
import { createShotPlan } from './shot-plan';

const projectFixture = (overrides: Partial<Project> = {}) => ProjectSchema.parse({
  version: 1, id: 'project-1', name: 'Pilot', profileId: 'short',
  profile: { id: 'short', format: '9:16', language: 'en', ageIntent: 'all ages', targetFrames: 500,
    projectCapMinor: null, dailyCapMinor: null },
  activeCanonRevisionIds: ['char-r1', 'location-r1', 'prop-r1', 'style-r1'],
  activeStoryRevisionId: 'story-r1', activeShotPlanRevisionId: null, activeAnimaticRevisionId: null,
  activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0,
  createdAt: 1, updatedAt: 1, saveVersion: 1,
  ...overrides,
});

const storyFixture = () => StoryRevisionSchema.parse({
  version: 1, id: 'story-r1', projectId: 'project-1', parentRevisionId: null,
  scriptText: 'Pip finds a lantern.\nMoss helps.',
  beats: [
    { id: 'beat-1', action: 'Pip finds the lantern.', narration: 'Pip finds the lantern.', dialogue: [], order: 0 },
    { id: 'beat-2', action: 'Moss helps Pip.', narration: 'Moss helps Pip.', dialogue: [{ characterId: 'pip', text: 'I have it!' }], order: 1 },
  ], canonRevisionIds: ['char-r1', 'location-r1', 'prop-r1', 'style-r1'],
  contentHash: 'a'.repeat(64), createdAt: 2,
});

const canonFixture = (): CanonRevision[] => [
  ['char-r1', 'pip', 'character'], ['location-r1', 'clearing', 'location'],
  ['prop-r1', 'lantern', 'prop'], ['style-r1', 'paper', 'style'],
].map(([id, entityId, entityKind]) => CanonRevisionSchema.parse({
  version: 1, id, entityId, entityKind, revision: 1, description: `${entityId} description`,
  attributes: {}, referenceAssetIds: [], contentHash: 'b'.repeat(64), createdAt: 2,
}));

const approvedStory = (story: StoryRevision): Approval => ApprovalSchema.parse({
  version: 1, id: 'story-approval', targetKind: 'story', targetId: story.id, targetHash: story.contentHash,
  decision: 'approved', actorId: 'creator', createdAt: 3, checklist: [{ id: 'story-reviewed', passed: true, note: '' }],
  notes: '', advisoryAcknowledgements: [],
});

const sceneFixture = (overrides: Partial<Scene> = {}): Scene => SceneSchema.parse({
  version: 1, id: 'scene-1', projectId: 'project-1', storyRevisionId: 'story-r1', order: 0,
  title: 'Opening', action: 'Pip finds the lantern.', dialogue: [], durationTargetMs: null,
  characterStates: [], environmentState: null, contentHash: 'd'.repeat(64), createdAt: 4,
  ...overrides,
});

const command = (overrides: Partial<CreateShotPlanCommand> = {}): CreateShotPlanCommand => ({
  projectId: 'project-1', storyRevisionId: 'story-r1', approvedStoryHash: 'a'.repeat(64),
  shots: [
    { shotId: 'shot-1', beatIds: ['beat-1'], visualIntent: 'Pip finds the lantern', motionIntent: 'Pip reaches down',
      castBindings: [{ characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'teal scarf' }],
      locationRevisionId: 'location-r1', propRevisionIds: ['prop-r1'], styleRevisionId: 'style-r1',
      framing: 'medium', targetFrames: 120, continuation: null },
    { shotId: 'shot-2', beatIds: ['beat-2'], visualIntent: 'Moss helps Pip', motionIntent: 'Moss steadies the lantern',
      castBindings: [{ characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'teal scarf' }],
      locationRevisionId: 'location-r1', propRevisionIds: ['prop-r1'], styleRevisionId: 'style-r1',
      framing: 'medium', targetFrames: 120, continuation: null },
  ],
  ...overrides,
});

function makeStore(options: { project?: Project; story?: StoryRevision; canon?: CanonRevision[]; approvals?: Approval[]; scenes?: Scene[]; casFails?: boolean } = {}) {
  const project = options.project ?? projectFixture();
  const story = options.story ?? storyFixture();
  const stories = new Map([[story.id, story]]);
  const canon = options.canon ?? canonFixture();
  const approvals = options.approvals ?? [approvedStory(story)];
  const approvalRows = [...approvals];
  const scenes = [...(options.scenes ?? [])];
  const shotRevisions: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];
  const animatics: Array<Record<string, unknown>> = [];
  const dependencies: Array<{ revisionId: string; dependencyIds: string[] }> = [];
  const reads = {
    getProject: () => project,
    getStoryRevision: (id: string) => stories.get(id) ?? null,
    listApprovals: (kind: Approval['targetKind'], id: string) => approvalRows.filter((approval) => approval.targetKind === kind && approval.targetId === id),
    listCanonRevisions: (ids: string[]) => canon.filter((revision) => ids.includes(revision.id)),
    getShotPlanRevision: (id: string) => plans.find((plan) => plan.id === id) ?? null,
    getShotRevision: (id: string) => shotRevisions.find((revision) => revision.id === id) ?? null,
    getAsset: () => null,
    getScene: (id: string) => scenes.find((scene) => scene.id === id) ?? null,
    listScenes: (projectId: string, storyRevisionId: string | null) =>
      scenes.filter((scene) => scene.projectId === projectId && scene.storyRevisionId === storyRevisionId),
  };
  const writes = {
    ...reads,
    compareAndSetProject: (next: Project, expectedVersion: number) => {
      if (options.casFails || project.saveVersion !== expectedVersion) return false;
      Object.assign(project, next);
      return true;
    },
    insertShotRevisions: (values: unknown[]) => shotRevisions.push(...values as Array<Record<string, unknown>>),
    insertShotPlanRevision: (value: unknown) => plans.push(value as Record<string, unknown>),
    insertAnimaticRevision: (value: unknown) => animatics.push(value as Record<string, unknown>),
    insertRevisionDependencies: (revisionId: string, dependencyIds: string[]) => dependencies.push({ revisionId, dependencyIds }),
  };
  const store = {
    read: reads,
    transaction: <T>(work: (tx: ProductionWritePort) => T) => {
      const projectBefore = structuredClone(project);
      const lengths = { shotRevisions: shotRevisions.length, plans: plans.length, animatics: animatics.length, dependencies: dependencies.length };
      try {
        return work(writes as unknown as ProductionWritePort);
      } catch (error) {
        Object.assign(project, projectBefore);
        shotRevisions.length = lengths.shotRevisions;
        plans.length = lengths.plans;
        animatics.length = lengths.animatics;
        dependencies.length = lengths.dependencies;
        throw error;
      }
    },
  } as unknown as ProductionStore;
  return { store, project, story, stories, approvals: approvalRows, canon, scenes, shotRevisions, plans, animatics, dependencies };
}

function deps(ids = ['shotrev-1', 'shotrev-2', 'plan-1', 'animatic-1']) {
  let index = 0;
  return { now: () => 10, idFactory: () => ids[index++] ?? `generated-${index}`, maxShots: 10 };
}

describe('createShotPlan', () => {
  it('persists shot, plan and placeholder animatic revisions together after matching story approval', () => {
    const fixture = makeStore();
    const result = createShotPlan(fixture.store, command(), deps());
    expect(result.shotRevisions.map((shot) => shot.shotId)).toEqual(['shot-1', 'shot-2']);
    expect(result.shotPlanRevision.orderedShotRevisionIds).toEqual(['shotrev-1', 'shotrev-2']);
    expect(result.animaticRevision.slots).toHaveLength(2);
    expect(result.animaticRevision.totalFrames).toBe(240);
    expect(fixture.shotRevisions).toHaveLength(2);
    expect(fixture.plans).toHaveLength(1);
    expect(fixture.animatics).toHaveLength(1);
    expect(fixture.project.activeShotPlanRevisionId).toBe('plan-1');
    expect(fixture.project.activeAnimaticRevisionId).toBe('animatic-1');
    expect(fixture.story).toEqual(storyFixture());
    expect(fixture.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: 'shotrev-1', dependencyIds: expect.arrayContaining(['story-r1', 'char-r1', 'location-r1', 'prop-r1', 'style-r1']) }),
      expect.objectContaining({ revisionId: 'plan-1', dependencyIds: ['shotrev-1', 'shotrev-2'] }),
      expect.objectContaining({ revisionId: 'animatic-1', dependencyIds: ['plan-1'] }),
    ]));
  });

  it('stamps scene ids by order correspondence when the story has scenes', () => {
    const fixture = makeStore({ scenes: [sceneFixture({ id: 'scene-1', order: 0 }), sceneFixture({ id: 'scene-2', order: 1 })] });
    const result = createShotPlan(fixture.store, command(), deps());
    expect(result.shotRevisions.map((shot) => shot.sceneId)).toEqual(['scene-1', 'scene-2']);
  });

  it('leaves surplus shots unassociated when scenes run out', () => {
    const fixture = makeStore({ scenes: [sceneFixture({ id: 'scene-1', order: 0 })] });
    const result = createShotPlan(fixture.store, command(), deps());
    expect(result.shotRevisions.map((shot) => shot.sceneId)).toEqual(['scene-1', undefined]);
  });

  it('honors explicit per-shot scene ids over the order default', () => {
    const fixture = makeStore({
      scenes: [sceneFixture({ id: 'scene-1', order: 0 }), sceneFixture({ id: 'scene-2', order: 1 }), sceneFixture({ id: 'scene-loose', storyRevisionId: null, order: 2 })],
    });
    const shots = command().shots;
    shots[0] = { ...shots[0]!, sceneId: 'scene-loose' };
    const result = createShotPlan(fixture.store, command({ shots }), deps());
    expect(result.shotRevisions.map((shot) => shot.sceneId)).toEqual(['scene-loose', 'scene-2']);
  });

  it('rejects unknown and foreign-project scene ids before writing anything', () => {
    const unknown = makeStore();
    const unknownCommand = command({ shots: [{ ...command().shots[0]!, sceneId: 'scene-missing' }, command().shots[1]!] });
    expect(() => createShotPlan(unknown.store, unknownCommand, deps())).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(unknown.shotRevisions).toHaveLength(0);
    expect(unknown.plans).toHaveLength(0);
    expect(unknown.animatics).toHaveLength(0);

    const foreign = makeStore({ scenes: [sceneFixture({ id: 'scene-foreign', projectId: 'another-project' })] });
    const foreignCommand = command({ shots: [{ ...command().shots[0]!, sceneId: 'scene-foreign' }, command().shots[1]!] });
    expect(() => createShotPlan(foreign.store, foreignCommand, deps())).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(foreign.shotRevisions).toHaveLength(0);
    expect(foreign.plans).toHaveLength(0);
    expect(foreign.animatics).toHaveLength(0);
  });

  it('keeps sceneless plans unchanged: no scene pin is stamped and prior-shot reuse still holds', () => {
    const fixture = makeStore();
    const first = createShotPlan(fixture.store, command(), deps());
    for (const shot of first.shotRevisions) expect(shot.sceneId).toBeUndefined();
    const replay = createShotPlan(fixture.store, command(), deps(['plan-2', 'animatic-2']));
    expect(replay.shotRevisions.map((shot) => shot.id)).toEqual(first.shotRevisions.map((shot) => shot.id));
    expect(fixture.shotRevisions).toHaveLength(2);
  });

  it('creates fresh shot revisions to introduce scene pins when scenes appear between plans', () => {
    const fixture = makeStore();
    const first = createShotPlan(fixture.store, command(), deps());
    expect(first.shotRevisions.map((shot) => shot.sceneId)).toEqual([undefined, undefined]);
    fixture.scenes.push(sceneFixture({ id: 'scene-1', order: 0 }), sceneFixture({ id: 'scene-2', order: 1 }));
    const second = createShotPlan(fixture.store, command(), deps(['shotrev-3', 'shotrev-4', 'plan-2', 'animatic-2']));
    expect(second.shotRevisions.map((shot) => shot.sceneId)).toEqual(['scene-1', 'scene-2']);
    expect(second.shotRevisions.map((shot) => shot.id)).toEqual(['shotrev-3', 'shotrev-4']);
  });

  it('rejects pending or stale story approval before any write', () => {
    const story = storyFixture();
    const pending = ApprovalSchema.parse({ ...approvedStory(story), decision: 'rejected' });
    const fixture = makeStore({ approvals: [pending] });
    expect(() => createShotPlan(fixture.store, command(), deps())).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
    expect(fixture.animatics).toHaveLength(0);
  });

  it('lets a newer rejection override an earlier approval for the same story hash', () => {
    const story = storyFixture();
    const rejected = ApprovalSchema.parse({ ...approvedStory(story), id: 'story-rejection', decision: 'rejected', createdAt: 4 });
    const fixture = makeStore({ approvals: [approvedStory(story), rejected] });
    expect(() => createShotPlan(fixture.store, command(), deps())).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
    expect(fixture.animatics).toHaveLength(0);
  });

  it('fails closed when approval and rejection decisions share a timestamp', () => {
    const story = storyFixture();
    const approved = approvedStory(story);
    const rejected = ApprovalSchema.parse({ ...approved, id: 'story-rejection', decision: 'rejected' });
    const fixture = makeStore({ approvals: [approved, rejected] });
    expect(() => createShotPlan(fixture.store, command(), deps())).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
    expect(fixture.animatics).toHaveLength(0);
  });

  it('rejects an approval hash that no longer matches the approved story', () => {
    const fixture = makeStore();
    expect(() => createShotPlan(fixture.store, command({ approvedStoryHash: 'c'.repeat(64) }), deps())).toThrowError(
      expect.objectContaining({ code: 'STALE_REVISION' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
    expect(fixture.animatics).toHaveLength(0);
  });

  it('rejects stale story selection, unknown canon bindings and missing beat coverage', () => {
    const stale = makeStore({ project: projectFixture({ activeStoryRevisionId: 'story-other' }) });
    expect(() => createShotPlan(stale.store, command(), deps())).toThrowError(
      expect.objectContaining({ code: 'STALE_REVISION' }),
    );

    const badCanon = makeStore();
    const badReference = command({ shots: [
      { ...command().shots[0], locationRevisionId: 'unknown-location' },
      command().shots[1],
    ] });
    expect(() => createShotPlan(badCanon.store, badReference, deps())).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_REFERENCE' }),
    );
    expect(badCanon.shotRevisions).toHaveLength(0);

    const missingCoverage = makeStore();
    expect(() => createShotPlan(missingCoverage.store, command({ shots: [command().shots[0]] }), deps())).toThrow(/beat coverage/i);
    expect(missingCoverage.plans).toHaveLength(0);
  });

  it('keeps stable shot IDs and prior immutable plan/animatic history when the new plan is shortened', () => {
    const fixture = makeStore();
    const original = createShotPlan(fixture.store, command(), deps());
    const oldPlan = structuredClone(original.shotPlanRevision);
    const shortened = createShotPlan(fixture.store, command({
      shots: [{ ...command().shots[0], beatIds: ['beat-1', 'beat-2'] }],
    }), deps(['shotrev-3', 'plan-2', 'animatic-2']));
    expect(shortened.shotRevisions.map((shot) => shot.shotId)).toEqual(['shot-1']);
    expect(shortened.shotPlanRevision.orderedShotRevisionIds).toHaveLength(1);
    expect(fixture.plans[0]).toEqual(oldPlan);
    expect(fixture.animatics).toHaveLength(2);
    expect(fixture.project.activeShotPlanRevisionId).toBe('plan-2');
  });

  it('reuses untouched shot revisions when creating a new plan', () => {
    const fixture = makeStore();
    const original = createShotPlan(fixture.store, command(), deps());
    const next = createShotPlan(fixture.store, command(), deps(['plan-2', 'animatic-2']));
    expect(next.shotRevisions.map((shot) => shot.id)).toEqual(original.shotRevisions.map((shot) => shot.id));
    expect(fixture.shotRevisions).toHaveLength(2);
    expect(fixture.plans).toHaveLength(2);
    expect(fixture.animatics).toHaveLength(2);
  });

  it('reuses a valid establishing shot without cast when another covering shot carries the dialogue speaker', () => {
    const fixture = makeStore();
    const input = command().shots;
    input[0] = { ...input[0], beatIds: ['beat-1', 'beat-2'], castBindings: [] };
    const first = createShotPlan(fixture.store, command({ shots: input }), deps());
    const sameStory = createShotPlan(fixture.store, command({ shots: input }), deps(['plan-2', 'animatic-2']));
    expect(sameStory.shotRevisions.map((shot) => shot.id)).toEqual(first.shotRevisions.map((shot) => shot.id));
    const successor = StoryRevisionSchema.parse({ ...fixture.story, id: 'story-r-dialogue-successor', parentRevisionId: fixture.story.id,
      canonRevisionIds: [...fixture.story.canonRevisionIds, 'prop-extra'], contentHash: 'f'.repeat(64), createdAt: 25 });
    fixture.stories.set(successor.id, successor);
    fixture.canon.push(CanonRevisionSchema.parse({ version: 1, id: 'prop-extra', entityId: 'extra', entityKind: 'prop', revision: 1,
      description: 'Unrelated prop', attributes: {}, referenceAssetIds: [], contentHash: 'e'.repeat(64), createdAt: 25 }));
    fixture.project.activeCanonRevisionIds.push('prop-extra');
    fixture.project.activeStoryRevisionId = successor.id;
    fixture.project.saveVersion += 1;
    fixture.approvals.push(approvedStory(successor));
    const next = createShotPlan(fixture.store, command({ storyRevisionId: successor.id, approvedStoryHash: successor.contentHash, shots: input }), deps(['plan-3', 'animatic-3']));
    expect(next.shotRevisions.map((shot) => shot.id)).toEqual(first.shotRevisions.map((shot) => shot.id));
  });

  it.each(['visualIntent', 'wardrobe'] as const)('preserves byte-distinct NFC-equivalent %s across same-story and canon-only successor plans', (field) => {
    const fixture = makeStore();
    const shotsFor = (text: 'Café' | 'Cafe\u0301') => {
      const shots = command().shots;
      if (field === 'visualIntent') shots[0] = { ...shots[0], visualIntent: `${text} sees the lantern` };
      else shots[0] = { ...shots[0], castBindings: shots[0].castBindings.map((binding) => ({ ...binding, wardrobe: `${text} coat` })) };
      return shots;
    };
    const first = createShotPlan(fixture.store, command({ shots: shotsFor('Café') }), deps());
    const sameStory = createShotPlan(fixture.store, command({ shots: shotsFor('Cafe\u0301') }), deps(['shotrev-3', 'same-plan', 'same-animatic']));
    expect(sameStory.shotRevisions[0].id).not.toBe(first.shotRevisions[0].id);
    expect(sameStory.shotRevisions[0].contentHash).toBe(first.shotRevisions[0].contentHash);
    if (field === 'visualIntent') expect(sameStory.shotRevisions[0].visualIntent).toBe('Cafe\u0301 sees the lantern');
    else expect(sameStory.shotRevisions[0].castBindings[0].wardrobe).toBe('Cafe\u0301 coat');

    const successor = StoryRevisionSchema.parse({ ...fixture.story, id: 'story-unicode-successor', parentRevisionId: fixture.story.id,
      canonRevisionIds: [...fixture.story.canonRevisionIds, 'prop-extra'], contentHash: 'f'.repeat(64), createdAt: 25 });
    fixture.stories.set(successor.id, successor);
    fixture.canon.push(CanonRevisionSchema.parse({ version: 1, id: 'prop-extra', entityId: 'extra', entityKind: 'prop', revision: 1,
      description: 'Unrelated prop', attributes: {}, referenceAssetIds: [], contentHash: 'e'.repeat(64), createdAt: 25 }));
    fixture.project.activeCanonRevisionIds.push('prop-extra');
    fixture.project.activeStoryRevisionId = successor.id;
    fixture.project.saveVersion += 1;
    fixture.approvals.push(approvedStory(successor));
    const canonSuccessor = createShotPlan(fixture.store, command({ storyRevisionId: successor.id, approvedStoryHash: successor.contentHash, shots: shotsFor('Café') }),
      deps(['shotrev-4', 'successor-plan', 'successor-animatic']));
    expect(canonSuccessor.shotRevisions[0].id).not.toBe(sameStory.shotRevisions[0].id);
    expect(canonSuccessor.shotRevisions[0].storyRevisionId).toBe(successor.id);
    if (field === 'visualIntent') expect(canonSuccessor.shotRevisions[0].visualIntent).toBe('Café sees the lantern');
    else expect(canonSuccessor.shotRevisions[0].castBindings[0].wardrobe).toBe('Café coat');
  });

  it('retains exact originating shots across repeated approved canon-only story successors', () => {
    const fixture = makeStore();
    const first = createShotPlan(fixture.store, command(), deps());
    const editedStory = StoryRevisionSchema.parse({ ...fixture.story, id: 'story-r-script', parentRevisionId: fixture.story.id,
      scriptText: 'Pip finds a lantern in the rain.\nMoss helps.', contentHash: 'd'.repeat(64), createdAt: 15 });
    fixture.stories.set(editedStory.id, editedStory);
    fixture.project.activeStoryRevisionId = editedStory.id;
    fixture.project.saveVersion += 1;
    fixture.approvals.push(approvedStory(editedStory));
    const editedPlan = createShotPlan(fixture.store, command({ storyRevisionId: editedStory.id, approvedStoryHash: editedStory.contentHash }), deps(['shotrev-3', 'shotrev-4', 'plan-2', 'animatic-2']));
    expect(editedPlan.shotRevisions.map((shot) => shot.id)).toEqual(['shotrev-3', 'shotrev-4']);
    const sameStoryPlan = createShotPlan(fixture.store, command({ storyRevisionId: editedStory.id, approvedStoryHash: editedStory.contentHash }), deps(['plan-3', 'animatic-3']));
    expect(sameStoryPlan.shotRevisions.map((shot) => shot.id)).toEqual(editedPlan.shotRevisions.map((shot) => shot.id));
    const addSuccessor = (id: string, parent: StoryRevision) => {
      const successor = StoryRevisionSchema.parse({ ...parent, id, parentRevisionId: parent.id,
        canonRevisionIds: [...parent.canonRevisionIds, `prop-${id}`], contentHash: id === 'story-r2' ? 'd'.repeat(64) : 'e'.repeat(64), createdAt: 20 });
      fixture.stories.set(successor.id, successor);
      fixture.canon.push(CanonRevisionSchema.parse({ version: 1, id: `prop-${id}`, entityId: `unrelated-${id}`, entityKind: 'prop', revision: 1,
        description: 'Unrelated prop', attributes: {}, referenceAssetIds: [], contentHash: 'c'.repeat(64), createdAt: 20 }));
      fixture.project.activeCanonRevisionIds.push(`prop-${id}`);
      fixture.project.activeStoryRevisionId = successor.id;
      fixture.project.saveVersion += 1;
      fixture.approvals.push(approvedStory(successor));
      return successor;
    };
    const secondStory = addSuccessor('story-r2', editedStory);
    const second = createShotPlan(fixture.store, command({ storyRevisionId: secondStory.id, approvedStoryHash: secondStory.contentHash }), deps(['plan-4', 'animatic-4']));
    const thirdStory = addSuccessor('story-r3', secondStory);
    const third = createShotPlan(fixture.store, command({ storyRevisionId: thirdStory.id, approvedStoryHash: thirdStory.contentHash }), deps(['plan-5', 'animatic-5']));
    expect(second.shotRevisions.map((shot) => shot.id)).toEqual(editedPlan.shotRevisions.map((shot) => shot.id));
    expect(third.shotRevisions.map((shot) => shot.id)).toEqual(editedPlan.shotRevisions.map((shot) => shot.id));
    expect(fixture.shotRevisions).toHaveLength(4);
    expect(fixture.plans.map((plan) => (plan as { storyRevisionId: string }).storyRevisionId)).toEqual(['story-r1', 'story-r-script', 'story-r-script', 'story-r2', 'story-r3']);
    const changedStory = StoryRevisionSchema.parse({ ...thirdStory, id: 'story-r4', parentRevisionId: thirdStory.id,
      beats: [{ ...thirdStory.beats[0], action: 'Pip drops the lantern.' }, thirdStory.beats[1]], contentHash: 'f'.repeat(64), createdAt: 30 });
    fixture.stories.set(changedStory.id, changedStory);
    fixture.project.activeStoryRevisionId = changedStory.id;
    fixture.project.saveVersion += 1;
    fixture.approvals.push(approvedStory(changedStory));
    const changed = createShotPlan(fixture.store, command({ storyRevisionId: changedStory.id, approvedStoryHash: changedStory.contentHash }), deps(['new-shot-1', 'new-shot-2', 'plan-6', 'animatic-6']));
    expect(changed.shotRevisions.map((shot) => shot.id)).toEqual(['new-shot-1', 'new-shot-2']);
    expect(fixture.shotRevisions).toHaveLength(6);
  });

  it('rejects a canon revision with the wrong entity kind for a cast binding', () => {
    const fixture = makeStore();
    const mismatched = command({ shots: [
      { ...command().shots[0], castBindings: [{ characterId: 'pip', canonRevisionId: 'location-r1', wardrobe: 'teal scarf' }] },
      command().shots[1],
    ] });
    expect(() => createShotPlan(fixture.store, mismatched, deps())).toThrow(/character/i);
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
  });

  it('rejects duplicate character bindings before creating revisions', () => {
    const fixture = makeStore();
    const duplicate = command({ shots: [
      { ...command().shots[0], castBindings: [
        { characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'teal scarf' },
        { characterId: 'pip', canonRevisionId: 'char-r1', wardrobe: 'teal scarf' },
      ] },
      command().shots[1],
    ] });
    expect(() => createShotPlan(fixture.store, duplicate, deps())).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
  });

  it('requires every dialogue speaker to appear in a shot covering that beat', () => {
    const fixture = makeStore();
    const invalid = command({ shots: [
      { ...command().shots[0], beatIds: ['beat-1', 'beat-2'], castBindings: [] },
    ] });
    expect(() => createShotPlan(fixture.store, invalid, deps())).toThrow(/dialogue speaker pip.*covering shot/i);
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
  });

  it('rejects a story revision owned by another project before writing a plan', () => {
    const foreign = StoryRevisionSchema.parse({ ...storyFixture(), projectId: 'another-project' });
    const fixture = makeStore({ story: foreign, project: projectFixture({ activeStoryRevisionId: foreign.id }) });
    expect(() => createShotPlan(fixture.store, command({ approvedStoryHash: foreign.contentHash }), deps())).toThrow(/does not belong to this project/i);
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
  });

  it('rejects continuations that reference an unknown prior shot or end-frame asset', () => {
    const fixture = makeStore();
    const original = createShotPlan(fixture.store, command(), deps());
    const invalid = command({ shots: [
      command().shots[0],
      { ...command().shots[1], continuation: { previousShotRevisionId: original.shotRevisions[0]!.id, endFrameAssetId: 'missing-asset' } },
    ] });
    expect(() => createShotPlan(fixture.store, invalid, deps(['shotrev-3', 'plan-2', 'animatic-2']))).toThrow(/end-frame asset/i);
    expect(fixture.shotRevisions).toHaveLength(2);
    expect(fixture.plans).toHaveLength(1);
  });

  it('rejects a continuation that does not name the immediately preceding shot revision', () => {
    const fixture = makeStore();
    createShotPlan(fixture.store, command(), deps());
    const invalid = command({ shots: [
      command().shots[0],
      { ...command().shots[1], continuation: { previousShotRevisionId: 'missing-shot', endFrameAssetId: 'missing-asset' } },
    ] });
    expect(() => createShotPlan(fixture.store, invalid, deps(['shotrev-3', 'plan-2', 'animatic-2']))).toThrow(/continuation/i);
    expect(fixture.shotRevisions).toHaveLength(2);
    expect(fixture.plans).toHaveLength(1);
  });

  it('rolls back all inserted revisions and dependencies when project CAS fails', () => {
    const fixture = makeStore({ casFails: true });
    const projectBefore = structuredClone(fixture.project);
    expect(() => createShotPlan(fixture.store, command(), deps())).toThrowError(
      expect.objectContaining({ code: 'STALE_REVISION' }),
    );
    expect(fixture.shotRevisions).toHaveLength(0);
    expect(fixture.plans).toHaveLength(0);
    expect(fixture.animatics).toHaveLength(0);
    expect(fixture.dependencies).toHaveLength(0);
    expect(fixture.project).toEqual(projectBefore);
  });
});
