import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProductionStore } from '../../repositories/production/sqlite';
import type { ProductionStore } from '../../repositories/production/ports';
import { ApprovalSchema, AssetSchema, CanonRevisionSchema, ProjectSchema, type CreateShotPlanCommand } from '../../production/contracts';
import { createCanonRevision, createProject, createStoryRevision, getProjectReadModel, selectCanonRevision } from './revisions';
import { createShotPlan } from './shot-plan';

const directories: string[] = [];
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'perabyte-revisions-')); directories.push(dataDir);
  let id = 0;
  const options = { now: () => 100 + id, idFactory: () => `generated-${++id}` };
  const store = openProductionStore({ dataDir });
  return { store, options, dataDir };
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('revision services', () => {
  it('allocates global canon revisions atomically, reuses content and preserves project bindings after reopen', () => {
    const { store, options, dataDir } = setup();
    const first = createProject(store, { name: 'One', profileId: 'storybook-short-v1' }, options);
    const second = createProject(store, { name: 'Two', profileId: 'storybook-short-v1' }, options);
    const seed = createCanonRevision(store, { projectId: first.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Red scarf', attributes: {}, assetIds: [] }, options);
    expect(seed.revision).toBe(1);
    expect(createCanonRevision(store, { projectId: second.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Red scarf', attributes: {}, assetIds: [] }, options).id).toBe(seed.id);
    selectCanonRevision(store, { projectId: second.id, entityId: 'hero', expectedRevisionId: seed.id, canonRevisionId: seed.id }, options);
    const two = createCanonRevision(store, { projectId: second.id, entityId: 'hero', expectedRevisionId: seed.id, entityKind: 'character', description: 'Blue scarf', attributes: {}, assetIds: [] }, options);
    const three = createCanonRevision(store, { projectId: first.id, entityId: 'hero', expectedRevisionId: seed.id, entityKind: 'character', description: 'Green scarf', attributes: {}, assetIds: [] }, options);
    expect([two.revision, three.revision]).toEqual([2, 3]);
    expect(store.read.getLatestCanonRevision('hero')?.id).toBe(three.id);
    expect(store.read.getCanonRevisionByHash('hero', seed.contentHash)?.id).toBe(seed.id);
    expect(store.read.listProjects(null, 24).projects.map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    store.close();
    const reopened = openProductionStore({ dataDir });
    expect(reopened.read.getProject(first.id)?.activeCanonRevisionIds).toContain(three.id);
    expect(reopened.read.getProject(second.id)?.activeCanonRevisionIds).toContain(two.id);
    reopened.close();
  });

  it('fingerprints ordered canon references by checksum and keeps project selections isolated from another project library head', () => {
    const { store, options } = setup();
    const first = createProject(store, { name: 'One', profileId: 'storybook-short-v1' }, options);
    const second = createProject(store, { name: 'Two', profileId: 'storybook-short-v1' }, options);
    const asset = (id: string) => AssetSchema.parse({ version: 1, id, sha256: 'f'.repeat(64), mime: 'image/png', byteSize: 1, vaultRef: id,
      width: 1, height: 1, frames: null, fps: null, audioSamples: null, sourceKind: 'upload', sourceJobId: null, rightsStatus: 'licensed', createdAt: 1 });
    store.transaction((tx) => { tx.insertAsset({ asset: asset('image-a'), checksumVerified: true, verifiedAt: 1 }); tx.insertAsset({ asset: asset('image-b'), checksumVerified: true, verifiedAt: 1 }); });
    const canon1 = createCanonRevision(store, { projectId: first.id, entityId: 'place', expectedRevisionId: null, entityKind: 'location', description: 'Room', attributes: {}, assetIds: ['image-a'] }, options);
    const canonReuse = createCanonRevision(store, { projectId: second.id, entityId: 'place', expectedRevisionId: null, entityKind: 'location', description: 'Room', attributes: {}, assetIds: ['image-b'] }, options);
    expect(canonReuse.id).toBe(canon1.id);
    createCanonRevision(store, { projectId: second.id, entityId: 'place', expectedRevisionId: canon1.id, entityKind: 'location', description: 'New room', attributes: {}, assetIds: [] }, options);
    expect(getProjectReadModel(store, first.id).dependencyIssues).toEqual([]);
    store.close();
  });

  it('rejects kind changes, stale project selection and duplicate story canon pins without partial writes', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Story', profileId: 'storybook-short-v1' }, options);
    const canon = createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Hero', attributes: {}, assetIds: [] }, options);
    const place = createCanonRevision(store, { projectId: project.id, entityId: 'place', expectedRevisionId: null, entityKind: 'location', description: 'Room', attributes: {}, assetIds: [] }, options);
    expect(() => selectCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: canon.id, canonRevisionId: place.id }, options)).toThrow(/requested entity/i);
    expect(() => selectCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: null, canonRevisionId: canon.id }, options)).toThrow(/changed/i);
    expect(() => selectCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: canon.id, canonRevisionId: 'missing-canon' }, options)).toThrow(/requested entity/i);
    expect(() => createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'prop', description: 'No', attributes: {}, assetIds: [] }, options)).toThrow();
    expect(() => createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: '', beats: [{ id: 'b', action: 'go', narration: '', dialogue: [{ characterId: 'unknown', text: 'Hi' }] }], canonRevisionIds: [canon.id, canon.id] }, options)).toThrow();
    expect(() => createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: '', beats: [{ id: 'b', action: 'go', narration: '', dialogue: [] }], canonRevisionIds: ['missing-canon'] }, options)).toThrow(/unknown canon/i);
    expect(store.read.getProject(project.id)?.activeStoryRevisionId).toBeNull();
    expect(store.read.getLatestCanonRevision('hero')?.revision).toBe(1);
    store.close();
  });

  it('keeps parent provenance outside story fingerprints and never copies an earlier approval to a successor', () => {
    const { store, options, dataDir } = setup();
    const project = createProject(store, { name: 'Story', profileId: 'storybook-short-v1' }, options);
    const canon1 = createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Red scarf', attributes: {}, assetIds: [] }, options);
    const first = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: 'Exact line', beats: [{ id: 'beat-1', action: 'Walks', narration: 'Exact line', dialogue: [] }], canonRevisionIds: [canon1.id] }, options);
    store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: 'approval-first', targetKind: 'story', targetId: first.id,
      targetHash: first.contentHash, decision: 'approved', actorId: 'creator', createdAt: 2, checklist: [{ id: 'read', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] })));
    const sameStory = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: first.id, scriptText: 'Exact line', beats: [{ id: 'beat-1', action: 'Walks', narration: 'Exact line', dialogue: [] }], canonRevisionIds: [canon1.id] }, options);
    expect(sameStory.id).toBe(first.id);
    expect(sameStory.contentHash).toBe(first.contentHash);
    const canon2 = createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: canon1.id, entityKind: 'character', description: 'Blue scarf', attributes: {}, assetIds: [] }, options);
    const afterCanonChange = getProjectReadModel(store, project.id);
    expect(afterCanonChange.dependencyIssues).toContainEqual({ targetKind: 'story', targetId: first.id, dependencyKind: 'canon', pinnedDependencyId: canon1.id, activeDependencyId: canon2.id, code: 'DEPENDENCY_REPLACED' });
    expect(store.read.getStoryRevision(first.id)).toEqual(first);
    const canonStory = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: sameStory.id, scriptText: 'Exact line', beats: [{ id: 'beat-1', action: 'Walks', narration: 'Exact line', dialogue: [] }], canonRevisionIds: [canon2.id] }, options);
    expect(canonStory.contentHash).not.toBe(sameStory.contentHash);
    expect(getProjectReadModel(store, project.id).revisionApprovals).toEqual([]);
    store.close();
    const reopened = openProductionStore({ dataDir });
    expect(reopened.read.getStoryRevision(first.id)).toEqual(first);
    expect(reopened.read.getStoryRevision(canonStory.id)).toEqual(canonStory);
    reopened.close();
  });

  it('returns v2 read model with bounded, derived dependency issue arrays', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Empty', profileId: 'storybook-short-v1' }, options);
    expect(getProjectReadModel(store, project.id)).toMatchObject({ schemaVersion: 2, dependencyIssues: [], project });
    store.close();
  });

  it('preserves byte-distinct Unicode story text when normalized fingerprints match', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Unicode text', profileId: 'storybook-short-v1' }, options);
    const decomposed = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: 'Cafe\u0301',
      beats: [{ id: 'beat-1', action: 'Says Cafe\u0301', narration: 'Cafe\u0301', dialogue: [] }], canonRevisionIds: [] }, options);
    const composed = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: decomposed.id, scriptText: 'Café',
      beats: [{ id: 'beat-1', action: 'Says Café', narration: 'Café', dialogue: [] }], canonRevisionIds: [] }, options);
    expect(composed.id).not.toBe(decomposed.id);
    expect(composed.parentRevisionId).toBe(decomposed.id);
    expect(composed.contentHash).toBe(decomposed.contentHash);
    expect(composed.scriptText).toBe('Café');
    expect(composed.beats[0].narration).toBe('Café');
    expect(store.read.getStoryRevision(decomposed.id)).toEqual(decomposed);
    store.close();
  });

  it('does not mark reused shot origins changed after a canon-only successor plan', () => {
    const { store, options, dataDir } = setup();
    const project = createProject(store, { name: 'Reuse read model', profileId: 'storybook-short-v1' }, options);
    const canon = (entityId: string, entityKind: 'character' | 'location' | 'prop' | 'style', expectedRevisionId: string | null = null, description = entityId) =>
      createCanonRevision(store, { projectId: project.id, entityId, expectedRevisionId, entityKind, description, attributes: {}, assetIds: [] }, options);
    const character = canon('hero', 'character');
    const location = canon('room', 'location');
    const prop = canon('lantern', 'prop');
    const unrelatedProp = canon('extra', 'prop');
    const style = canon('paper', 'style');
    const story = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: null, scriptText: 'Hello.',
      beats: [{ id: 'beat-1', action: 'Waves.', narration: 'Hello.', dialogue: [] }],
      canonRevisionIds: [character.id, location.id, prop.id, unrelatedProp.id, style.id] }, options);
    store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: 'approval-origin', targetKind: 'story', targetId: story.id,
      targetHash: story.contentHash, decision: 'approved', actorId: 'creator', createdAt: 2,
      checklist: [{ id: 'reviewed', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] })));
    const shotInput: CreateShotPlanCommand['shots'][number] = { shotId: 'stable-shot', beatIds: ['beat-1'], visualIntent: 'A wave', motionIntent: 'Waves once',
      castBindings: [{ characterId: 'hero', canonRevisionId: character.id, wardrobe: 'blue' }], locationRevisionId: location.id,
      propRevisionIds: [prop.id], styleRevisionId: style.id, framing: 'medium', targetFrames: 24, continuation: null };
    const planOptions = { now: () => 200, maxShots: 10, idFactory: (() => { let id = 0; return () => `plan-id-${++id}`; })() };
    const firstPlan = createShotPlan(store, { projectId: project.id, storyRevisionId: story.id, approvedStoryHash: story.contentHash, shots: [shotInput] }, planOptions);
    const originShot = firstPlan.shotRevisions[0];
    const job = { version: 1 as const, id: 'render-job', projectId: project.id, operation: 'anchor' as const, status: 'queued' as const,
      idempotencyKey: 'render-key', requestSnapshot: {}, requestHash: 'a'.repeat(64), providerId: null, modelId: null, providerRef: null,
      quoteId: null, receiptId: null, resultId: null, resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null,
      attempt: 0, errorCode: null, errorMessage: null, createdAt: 201, updatedAt: 202 };
    const asset = AssetSchema.parse({ version: 1, id: 'take-asset', sha256: 'b'.repeat(64), mime: 'video/mp4', byteSize: 10, vaultRef: 'take.mp4',
      width: 1080, height: 1920, frames: 24, fps: 24, audioSamples: null, sourceKind: 'fixture', sourceJobId: job.id, rightsStatus: 'creator_attested', createdAt: 203 });
    const anchor = { version: 1 as const, id: 'anchor-origin', shotRevisionId: originShot.id, assetId: asset.id, inputsHash: originShot.contentHash,
      jobId: job.id, visionAssessment: null, receiptId: null, createdAt: 204 };
    const receipt = { version: 1 as const, id: 'render-receipt', jobId: job.id, capabilityProvenance: 'unknown' as const,
      capabilityObservedAt: 202, inputs: [], createdAt: 205 };
    const approval = ApprovalSchema.parse({ version: 1, id: 'approval-anchor', targetKind: 'anchor', targetId: anchor.id,
      targetHash: anchor.inputsHash, decision: 'approved', actorId: 'creator', createdAt: 206,
      checklist: [{ id: 'reviewed', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] });
    const take = { version: 1 as const, id: 'take-origin', shotRevisionId: originShot.id, anchorId: anchor.id, approvalId: approval.id,
      jobId: job.id, assetId: asset.id, actualFrames: 24, inputsHash: originShot.contentHash, receiptId: receipt.id, createdAt: 207 };
    store.transaction((tx) => {
      tx.insertJob(job, { id: 'render-outbox', jobId: job.id, createdAt: 201, claimedAt: null, claimToken: null });
      tx.insertAsset({ asset, checksumVerified: true, verifiedAt: 203 });
      tx.insertHonoredInputsReceipt(receipt);
      tx.insertAnchor(anchor);
      tx.appendApproval(approval);
      tx.insertTake(take);
      expect(tx.compareAndSetSelectedTake(project.id, originShot.shotId, take.id, 0)).toBe(true);
    });
    const nextProp = canon('extra', 'prop', unrelatedProp.id, 'Updated unrelated prop');
    const successor = createStoryRevision(store, { projectId: project.id, expectedStoryRevisionId: story.id, scriptText: story.scriptText,
      beats: story.beats.map(({ id, action, narration, dialogue }) => ({ id, action, narration, dialogue })), canonRevisionIds: [character.id, location.id, prop.id, nextProp.id, style.id] }, options);
    store.transaction((tx) => tx.appendApproval(ApprovalSchema.parse({ version: 1, id: 'approval-successor', targetKind: 'story', targetId: successor.id,
      targetHash: successor.contentHash, decision: 'approved', actorId: 'creator', createdAt: 3,
      checklist: [{ id: 'reviewed', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] })));
    const nextPlan = createShotPlan(store, { projectId: project.id, storyRevisionId: successor.id, approvedStoryHash: successor.contentHash, shots: [shotInput] }, planOptions);
    expect(nextPlan.shotPlanRevision.orderedShotRevisionIds).toEqual(firstPlan.shotPlanRevision.orderedShotRevisionIds);
    const selectedShot = nextPlan.shotRevisions[0];
    expect(selectedShot.id).toBe(originShot.id);
    expect(selectedShot.contentHash).toBe(originShot.contentHash);
    store.close();
    const reopened = openProductionStore({ dataDir });
    const readModel = getProjectReadModel(reopened, project.id);
    expect(readModel.dependencyIssues.filter((issue) => issue.targetKind === 'shot' && issue.code === 'STORY_CHANGED')).toEqual([]);
    expect(readModel.shots[0]).toMatchObject({
      shotRevision: { id: originShot.id, contentHash: originShot.contentHash },
      selectedAnchor: { id: anchor.id },
      selectedTake: { id: take.id, anchorId: anchor.id, approvalId: approval.id, inputsHash: originShot.contentHash },
      takeSelection: { takeId: take.id, version: 1 },
      approvals: [approval],
    });
    expect(readModel.revisionApprovals).toContainEqual(ApprovalSchema.parse({ version: 1, id: 'approval-successor', targetKind: 'story', targetId: successor.id,
      targetHash: successor.contentHash, decision: 'approved', actorId: 'creator', createdAt: 3,
      checklist: [{ id: 'reviewed', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] }));
    expect(reopened.read.listApprovals('story', story.id)).toContainEqual(ApprovalSchema.parse({ version: 1, id: 'approval-origin', targetKind: 'story', targetId: story.id,
      targetHash: story.contentHash, decision: 'approved', actorId: 'creator', createdAt: 2,
      checklist: [{ id: 'reviewed', passed: true, note: '' }], notes: '', advisoryAcknowledgements: [] }));
    reopened.close();
  });

  it('rejects an oversized job read model instead of silently truncating it', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Bounded', profileId: 'storybook-short-v1' }, options);
    const oversized = { read: { ...store.read, listProjectJobs: () => Array(100_001).fill(null) }, transaction: store.transaction } as unknown as ProductionStore;
    expect(() => getProjectReadModel(oversized, project.id)).toThrow(/job history exceeds the response limit/i);
    store.close();
  });

  it('guards global canon revision overflow and rolls back the attempted project update', () => {
    const { store, options } = setup();
    const project = createProject(store, { name: 'Overflow', profileId: 'storybook-short-v1' }, options);
    const first = createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Hero', attributes: {}, assetIds: [] }, options);
    const overflow = CanonRevisionSchema.parse({ ...first, id: 'canon-huge', revision: Number.MAX_SAFE_INTEGER, description: 'Large', contentHash: 'e'.repeat(64) });
    const current = store.read.getProject(project.id)!;
    store.transaction((tx) => { tx.insertCanonRevision(overflow); tx.compareAndSetProject(ProjectSchema.parse({ ...current, activeCanonRevisionIds: [overflow.id], saveVersion: current.saveVersion + 1 }), current.saveVersion); });
    const selectedProject = store.read.getProject(project.id)!;
    expect(() => createCanonRevision(store, { projectId: project.id, entityId: 'hero', expectedRevisionId: overflow.id, entityKind: 'character', description: 'Overflow', attributes: {}, assetIds: [] }, options)).toThrow(/safe integer/i);
    expect(store.read.getProject(project.id)).toEqual(selectedProject);
    expect(store.read.getLatestCanonRevision('hero')?.id).toBe(overflow.id);
    store.close();
  });

  it('rejects a foreign project story parent even when a corrupted selection points to it', () => {
    const { store, options } = setup();
    const owner = createProject(store, { name: 'Owner', profileId: 'storybook-short-v1' }, options);
    const other = createProject(store, { name: 'Other', profileId: 'storybook-short-v1' }, options);
    const canon = createCanonRevision(store, { projectId: owner.id, entityId: 'hero', expectedRevisionId: null, entityKind: 'character', description: 'Hero', attributes: {}, assetIds: [] }, options);
    const parent = createStoryRevision(store, { projectId: owner.id, expectedStoryRevisionId: null, scriptText: 'A', beats: [{ id: 'b', action: 'Acts', narration: '', dialogue: [] }], canonRevisionIds: [canon.id] }, options);
    const current = store.read.getProject(other.id)!;
    store.transaction((tx) => { tx.compareAndSetProject(ProjectSchema.parse({ ...current, activeStoryRevisionId: parent.id, saveVersion: current.saveVersion + 1 }), current.saveVersion); });
    expect(() => createStoryRevision(store, { projectId: other.id, expectedStoryRevisionId: parent.id, scriptText: 'B', beats: [{ id: 'b2', action: 'Acts', narration: '', dialogue: [] }], canonRevisionIds: [] }, options)).toThrow(/does not belong to this project/i);
    expect(store.read.getProject(other.id)?.activeStoryRevisionId).toBe(parent.id);
    store.close();
  });
});
