import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProductionStore } from '../../repositories/production/sqlite';
import { hashCanonicalJson } from '../../production/hash';
import { REVISION_INSTRUCTION_MARKER } from '../../production/story-view-model';
import { SceneSchema, type CreateStoryRevisionCommand, type Scene } from '../../production/contracts';
import type { ProductionStore } from '../../repositories/production/ports';
import { createCanonRevision, createProject, createStoryRevision } from './revisions';
import { applyStoryRevise, locateReviseTargets } from './story-revise';

const directories: string[] = [];
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'perabyte-story-revise-')); directories.push(dataDir);
  let id = 0;
  const options = { now: () => 100 + id, idFactory: () => `generated-${++id}` };
  const store = openProductionStore({ dataDir });
  return { store, options, dataDir };
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** Command-shaped beat (no order): createStoryRevision assigns order by array position. */
const beat = (id: string, action: string): CreateStoryRevisionCommand['beats'][number] => ({ id, action, narration: '', dialogue: [] });
const SCRIPT = 'LUNA: The tide is turning.\nNarration: The harbor wakes before anyone else.';

function insertScene(store: ProductionStore, input: { id: string; projectId: string; storyRevisionId: string; order: number; title: string; action: string; dialogue: Scene['dialogue'] }): Scene {
  const content = { projectId: input.projectId, storyRevisionId: input.storyRevisionId, order: input.order, title: input.title, action: input.action, dialogue: input.dialogue, durationTargetMs: null, characterStates: [], environmentState: null };
  const scene = SceneSchema.parse({ version: 1, ...content, id: input.id, contentHash: hashCanonicalJson(content), createdAt: 1000 });
  store.transaction((tx) => tx.upsertScene(scene));
  return scene;
}

describe('deterministic story revise', () => {
  it('applies an instruction as a new child revision with provenance and locates the referenced scene', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Tide', profileId: 'storybook-short-v1' }, options);
    const luna = createCanonRevision(store, { projectId: project.id, entityId: 'luna', expectedRevisionId: null, entityKind: 'character', description: 'Luna', attributes: {}, assetIds: [] }, options);
    const base = createStoryRevision(store, {
      projectId: project.id, expectedStoryRevisionId: null, scriptText: SCRIPT,
      beats: [beat('beat-speech-1', 'Luna watches the harbor.'), beat('beat-speech-2', 'The harbor wakes.')],
      canonRevisionIds: [luna.id],
    }, options);
    const scene = insertScene(store, { id: 'scene-harbor', projectId: project.id, storyRevisionId: base.id, order: 0, title: 'Harbor dawn', action: 'Luna watches the harbor.', dialogue: [{ characterCanonRevisionId: luna.id, text: 'The tide is turning.' }] });
    insertScene(store, { id: 'scene-market', projectId: project.id, storyRevisionId: base.id, order: 1, title: 'Market street', action: 'Vendors unpack crates.', dialogue: [] });

    const result = applyStoryRevise(store, {
      projectId: project.id, baseStoryRevisionId: base.id, expectedBaseContentHash: base.contentHash,
      instruction: 'Keep the harbor line but quote it softer: "The tide is turning."',
    }, options);

    expect(result.storyRevision.id).not.toBe(base.id);
    expect(result.storyRevision.parentRevisionId).toBe(base.id);
    expect(result.storyRevision.projectId).toBe(project.id);
    expect(result.storyRevision.scriptText).toContain(`${REVISION_INSTRUCTION_MARKER}\nKeep the harbor line`);
    expect(result.storyRevision.scriptText.startsWith(base.scriptText)).toBe(true);
    expect(result.storyRevision.beats).toEqual(base.beats);
    expect(result.storyRevision.contentHash).not.toBe(base.contentHash);
    expect(result.changedSceneIds).toEqual(['scene-harbor']);
    expect(store.read.getProject(project.id)?.activeStoryRevisionId).toBe(result.storyRevision.id);
    // Chain integrity: the parent still resolves, and the child is discoverable from it.
    expect(store.read.getStoryRevision(result.storyRevision.parentRevisionId ?? '')?.id).toBe(base.id);
  });

  it('rejects a stale base hash, a moved active revision, and an unknown project with STALE_REVISION or UNKNOWN_REFERENCE', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Tide', profileId: 'storybook-short-v1' }, options);
    const base = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: 'A calm day.', beats: [beat('beat-1', 'Nothing happens yet.')], canonRevisionIds: [] }, options);
    const staleHash = () => applyStoryRevise(store, { projectId: project.id, baseStoryRevisionId: base.id, expectedBaseContentHash: 'a'.repeat(64), instruction: 'Add a storm.' }, options);
    expect(staleHash).toThrow(/changed since you loaded it/);
    expect(() => applyStoryRevise(store, { projectId: 'missing-project', baseStoryRevisionId: base.id, expectedBaseContentHash: base.contentHash, instruction: 'Add a storm.' }, options)).toThrow(/Project not found/);
    // The first apply moves the active pointer; the old base is no longer appliable even with the right hash.
    const applied = applyStoryRevise(store, { projectId: project.id, baseStoryRevisionId: base.id, expectedBaseContentHash: base.contentHash, instruction: 'Add a storm.' }, options);
    expect(applied.storyRevision.parentRevisionId).toBe(base.id);
    expect(() => applyStoryRevise(store, { projectId: project.id, baseStoryRevisionId: base.id, expectedBaseContentHash: base.contentHash, instruction: 'Add a storm.' }, options)).toThrow(/active story moved on/);
  });

  it('resolves an exact replay of the same instruction to the applied revision instead of stacking children', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Tide', profileId: 'storybook-short-v1' }, options);
    const base = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: 'A calm day.', beats: [beat('beat-1', 'Nothing happens yet.')], canonRevisionIds: [] }, options);
    const command = { projectId: project.id, baseStoryRevisionId: base.id, expectedBaseContentHash: base.contentHash, instruction: 'Add a storm.' };
    const first = applyStoryRevise(store, command, options);
    expect(first.storyRevision.id).not.toBe(base.id);
    // A double press targets the applied revision with the same instruction — no second child.
    const replay = applyStoryRevise(store, { ...command, expectedBaseContentHash: first.storyRevision.contentHash, baseStoryRevisionId: first.storyRevision.id }, options);
    expect(replay.storyRevision.id).toBe(first.storyRevision.id);
    expect(replay.changedSceneIds).toEqual([]);
    // A different instruction still chains a new child onto the applied revision.
    const second = applyStoryRevise(store, { ...command, expectedBaseContentHash: first.storyRevision.contentHash, baseStoryRevisionId: first.storyRevision.id, instruction: 'Add a rainbow.' }, options);
    expect(second.storyRevision.id).not.toBe(first.storyRevision.id);
    expect(second.storyRevision.parentRevisionId).toBe(first.storyRevision.id);
  });

  it('locates segments and scenes deterministically: quoted spans, beat references and title mentions, nothing else', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Tide', profileId: 'storybook-short-v1' }, options);
    const luna = createCanonRevision(store, { projectId: project.id, entityId: 'luna', expectedRevisionId: null, entityKind: 'character', description: 'Luna', attributes: {}, assetIds: [] }, options);
    const base = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: SCRIPT, beats: [beat('beat-speech-1', 'Luna watches.')], canonRevisionIds: [luna.id] }, options);
    const harbor = insertScene(store, { id: 'scene-harbor', projectId: project.id, storyRevisionId: base.id, order: 0, title: 'Harbor dawn', action: 'Luna watches the harbor.', dialogue: [{ characterCanonRevisionId: luna.id, text: 'The tide is turning.' }] });
    const market = insertScene(store, { id: 'scene-market', projectId: project.id, storyRevisionId: base.id, order: 1, title: 'Market street', action: 'Vendors unpack crates.', dialogue: [] });
    const characters = [{ entityId: 'luna', name: null }];

    const quoted = locateReviseTargets({ baseStory: base, instruction: 'Soften: “The tide is turning.”', characters, scenes: [harbor, market] });
    expect(quoted.referencedSegmentIds).toEqual(['speech-1']);
    expect(quoted.changedSceneIds).toEqual(['scene-harbor']);

    const byBeat = locateReviseTargets({ baseStory: base, instruction: 'Rework beat-speech-1 entirely.', characters, scenes: [harbor, market] });
    expect(byBeat.referencedSegmentIds).toEqual(['speech-1']);
    // The beat reference reaches the harbor scene through the segment's stored dialogue line.
    expect(byBeat.changedSceneIds).toEqual(['scene-harbor']);

    // A referenced segment whose text no scene stores locates the segment but no scene — no guessing.
    const unstored = locateReviseTargets({ baseStory: base, instruction: 'Cut beat-speech-2 from the script.', characters, scenes: [harbor, market] });
    expect(unstored.referencedSegmentIds).toEqual(['speech-2']);
    expect(unstored.changedSceneIds).toEqual([]);

    const byTitle = locateReviseTargets({ baseStory: base, instruction: 'Market street needs more crowd noise.', characters, scenes: [harbor, market] });
    expect(byTitle.referencedSegmentIds).toEqual([]);
    expect(byTitle.changedSceneIds).toEqual(['scene-market']);

    const noReference = locateReviseTargets({ baseStory: base, instruction: 'Make the whole thing funnier.', characters, scenes: [harbor, market] });
    expect(noReference.referencedSegmentIds).toEqual([]);
    expect(noReference.changedSceneIds).toEqual([]);

    // Never throws on hostile text content.
    const hostile = locateReviseTargets({ baseStory: base, instruction: '“\uD800” beat-speech-999', characters, scenes: [harbor, market] });
    expect(hostile.changedSceneIds).toEqual([]);
  });
});
