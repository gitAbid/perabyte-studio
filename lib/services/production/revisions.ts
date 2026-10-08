import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CanonRevisionSchema, CreateCanonRevisionCommandSchema, CreateProjectCommandSchema,
  CreateStoryRevisionCommandSchema, IdSchema, ProjectReadModelSchema, ProjectSchema,
  SceneSchema, SelectCanonRevisionCommandSchema, StoryRevisionSchema, UpdateProjectCommandSchema,
  type CanonRevision, type CreateCanonRevisionCommand, type CreateProjectCommand,
  type CreateStoryRevisionCommand, type DependencyIssue, type Project, type ProjectReadModel,
  type ProductionProfile, type Scene, type SelectCanonRevisionCommand, type UpdateProjectCommand,
} from '../../production/contracts';
import { ProductionApplicationError, type ProductionErrorCode } from '../../production/errors';
import { hashCanonicalJson } from '../../production/hash';
import { resolveProductionProfile } from '../../production/profiles';
import { shotsCompatibleWithStory } from '../../production/revisions';
import type { ProductionStore, ProductionWritePort } from '../../repositories/production/ports';
import type { ZodType } from 'zod';

export interface RevisionServiceOptions { now?: () => number; idFactory?: () => string; profiles?: (id: string) => ProductionProfile | null; }
const defaults = { now: Date.now, idFactory: randomUUID, profiles: (id: string) => resolveProductionProfile(id) };
function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }
function setup(options: RevisionServiceOptions) {
  const configured = { ...defaults, ...options };
  const now = configured.now();
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  const ids = new Set<string>();
  const id = () => { const value = configured.idFactory(); if (!IdSchema.safeParse(value).success || ids.has(value)) fail('INVALID_INPUT', 'ID factory must return unique valid production IDs'); ids.add(value); return value; };
  return { ...configured, now, id };
}
function parsed<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value); if (!result.success) fail('INVALID_INPUT', `Invalid ${label}: ${result.error.issues.map((issue) => issue.message).join('; ')}`); return result.data;
}
function bindCanon(tx: ProductionWritePort, project: Project, entityId: string, revisionId: string): string[] {
  const rows = tx.listCanonRevisions(project.activeCanonRevisionIds);
  const current = rows.find((row) => row.entityId === entityId);
  const next = [...project.activeCanonRevisionIds];
  if (!current) next.push(revisionId);
  else next[next.indexOf(current.id)] = revisionId;
  return next;
}
function assertExpectedCanon(tx: ProductionWritePort, project: Project, entityId: string, expectedRevisionId: string | null): void {
  const rows = tx.listCanonRevisions(project.activeCanonRevisionIds);
  if (rows.length !== project.activeCanonRevisionIds.length) fail('UNKNOWN_REFERENCE', 'Project has a missing selected canon revision');
  if (new Set(rows.map((row) => row.entityId)).size !== rows.length) fail('INVALID_INPUT', 'Project contains duplicate canon entity selections');
  const current = rows.find((row) => row.entityId === entityId)?.id ?? null;
  if (current !== expectedRevisionId) fail('STALE_REVISION', 'Selected canon revision changed; reload the project and retry');
}
function saveProject(tx: ProductionWritePort, project: Project, now: number, patch: Partial<Project>): Project {
  if (!Number.isSafeInteger(project.saveVersion + 1)) fail('INVALID_INPUT', 'Project save version exceeds the safe integer range');
  const next = ProjectSchema.parse({ ...project, ...patch, updatedAt: now, saveVersion: project.saveVersion + 1 });
  if (!tx.compareAndSetProject(next, project.saveVersion)) fail('STALE_REVISION', 'Project changed while saving; reload and retry');
  return next;
}

export function createProject(store: ProductionStore, raw: CreateProjectCommand, options: RevisionServiceOptions = {}): Project {
  const command = parsed(CreateProjectCommandSchema, raw, 'project command');
  const config = setup(options);
  const profile = config.profiles(command.profileId);
  if (!profile) fail('INVALID_INPUT', `Unknown profile ${command.profileId}`);
  const project = ProjectSchema.parse({ version: 1, id: config.id(), name: command.name, profileId: profile.id, profile,
    activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null,
    activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: config.now, updatedAt: config.now, saveVersion: 1 });
  store.transaction((tx) => tx.insertProject(project));
  return project;
}

export function updateProject(store: ProductionStore, projectId: string, raw: UpdateProjectCommand, options: RevisionServiceOptions = {}): Project {
  const command = parsed(UpdateProjectCommandSchema, raw, 'project update'); const config = setup(options);
  return store.transaction((tx) => {
    const project = tx.getProject(projectId); if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
    if (project.saveVersion !== command.expectedSaveVersion) fail('STALE_REVISION', 'Project changed; reload and retry');
    const profile = command.profileId ? config.profiles(command.profileId) : project.profile;
    if (!profile) fail('INVALID_INPUT', `Unknown profile ${command.profileId}`);
    return saveProject(tx, project, config.now, { ...(command.name ? { name: command.name } : {}), profileId: profile.id, profile });
  });
}

export function createCanonRevision(store: ProductionStore, raw: CreateCanonRevisionCommand, options: RevisionServiceOptions = {}): CanonRevision {
  const command = parsed(CreateCanonRevisionCommandSchema, raw, 'canon command'); const config = setup(options);
  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId); if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
    assertExpectedCanon(tx, project, command.entityId, command.expectedRevisionId);
    const latest = tx.getLatestCanonRevision(command.entityId);
    if (latest && latest.entityKind !== command.entityKind) fail('INVALID_INPUT', `Canon entity ${command.entityId} is already established as ${latest.entityKind}`);
    const assets = command.assetIds.map((assetId) => tx.getAsset(assetId));
    if (assets.some((asset) => !asset)) fail('UNKNOWN_REFERENCE', 'Canon references an unknown asset');
    const content = { version: 1 as const, entityId: command.entityId, entityKind: command.entityKind, description: command.description,
      attributes: command.attributes, referenceAssetIds: command.assetIds };
    const hashContent = { version: content.version, entityId: content.entityId, entityKind: content.entityKind,
      description: content.description, attributes: content.attributes, referenceAssetChecksums: assets.map((asset) => asset!.sha256) };
    const contentHash = hashCanonicalJson(hashContent);
    let revision = tx.getCanonRevisionByHash(command.entityId, contentHash);
    if (!revision) {
      const number = latest ? latest.revision + 1 : 1;
      if (!Number.isSafeInteger(number)) fail('INVALID_INPUT', 'Canon revision number exceeds the safe integer range');
      revision = CanonRevisionSchema.parse({ ...content, id: config.id(), revision: number, contentHash, createdAt: config.now });
      tx.insertCanonRevision(revision);
    }
    const activeCanonRevisionIds = bindCanon(tx, project, command.entityId, revision.id);
    saveProject(tx, project, config.now, { activeCanonRevisionIds });
    return revision;
  });
}

export function selectCanonRevision(store: ProductionStore, raw: SelectCanonRevisionCommand, options: RevisionServiceOptions = {}): Project {
  const command = parsed(SelectCanonRevisionCommandSchema, raw, 'canon selection command'); const config = setup(options);
  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId); if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
    assertExpectedCanon(tx, project, command.entityId, command.expectedRevisionId);
    const revision = tx.getCanonRevision(command.canonRevisionId);
    if (!revision || revision.entityId !== command.entityId) fail('UNKNOWN_REFERENCE', 'Canon revision does not belong to the requested entity');
    const entityHead = tx.getLatestCanonRevision(command.entityId);
    if (!entityHead || entityHead.entityKind !== revision.entityKind) fail('INVALID_INPUT', 'Canon revision entity kind does not match the established library entity');
    return saveProject(tx, project, config.now, { activeCanonRevisionIds: bindCanon(tx, project, command.entityId, revision.id) });
  });
}

export function createStoryRevision(store: ProductionStore, raw: CreateStoryRevisionCommand, options: RevisionServiceOptions = {}) {
  const command = parsed(CreateStoryRevisionCommandSchema, raw, 'story command'); const config = setup(options);
  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId); if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
    if (project.activeStoryRevisionId !== command.expectedStoryRevisionId) fail('STALE_REVISION', 'Active story changed; reload and retry');
    const parent = command.expectedStoryRevisionId ? tx.getStoryRevision(command.expectedStoryRevisionId) : null;
    if (command.expectedStoryRevisionId && (!parent || parent.projectId !== project.id)) fail('UNKNOWN_REFERENCE', 'Parent story revision does not belong to this project');
    if (new Set(command.canonRevisionIds).size !== command.canonRevisionIds.length) fail('INVALID_INPUT', 'Story contains duplicate canon pins');
    const canon = tx.listCanonRevisions(command.canonRevisionIds);
    if (canon.length !== command.canonRevisionIds.length) fail('UNKNOWN_REFERENCE', 'Story references unknown canon revisions');
    const activeCanon = new Set(project.activeCanonRevisionIds);
    if (command.canonRevisionIds.some((id) => !activeCanon.has(id))) fail('UNKNOWN_REFERENCE', 'Story canon pins must be selected by this project');
    if (new Set(canon.map((row) => row.entityId)).size !== canon.length) fail('INVALID_INPUT', 'Story contains duplicate canon entity pins');
    if (new Set(command.beats.map((beat) => beat.id)).size !== command.beats.length) fail('INVALID_INPUT', 'Story contains duplicate beat IDs');
    const characterIds = new Set(canon.filter((row) => row.entityKind === 'character').map((row) => row.entityId));
    for (const beat of command.beats) for (const line of beat.dialogue) if (!characterIds.has(line.characterId)) fail('UNKNOWN_REFERENCE', `Dialogue speaker ${line.characterId} has no pinned character canon`);
    const content = { projectId: project.id, parentRevisionId: parent?.id ?? null, scriptText: command.scriptText,
      beats: command.beats.map((beat, order) => ({ ...beat, order })), canonRevisionIds: [...command.canonRevisionIds] };
    const semanticContent = { version: 1 as const, scriptText: content.scriptText, beats: content.beats, canonRevisionIds: content.canonRevisionIds };
    const contentHash = hashCanonicalJson(semanticContent);
    const exactSemanticInputs = parent?.scriptText === content.scriptText &&
      JSON.stringify(parent.beats) === JSON.stringify(content.beats) &&
      JSON.stringify(parent.canonRevisionIds) === JSON.stringify(content.canonRevisionIds);
    if (parent?.contentHash === contentHash && exactSemanticInputs) return parent;
    const revision = StoryRevisionSchema.parse({ version: 1, id: config.id(), ...content, contentHash, createdAt: config.now });
    tx.insertStoryRevision(revision);
    tx.insertRevisionDependencies(revision.id, [...revision.canonRevisionIds, ...(parent ? [parent.id] : [])]);
    saveProject(tx, project, config.now, { activeStoryRevisionId: revision.id });
    return revision;
  });
}

function appendIssue(issues: DependencyIssue[], issue: DependencyIssue) {
  const key = JSON.stringify(issue); if (!issues.some((entry) => JSON.stringify(entry) === key)) issues.push(issue);
  if (issues.length > 100_000) fail('INVALID_INPUT', 'Project dependency issue list exceeds the response limit');
}
function bounded<T>(values: T[], limit: number, label: string): T[] {
  if (values.length > limit) fail('INVALID_INPUT', `Project ${label} exceeds the response limit`);
  return values;
}
/**
 * Read-model options: `includeScenes` projects the production's structured scenes (C13) as an
 * additive `scenes` array. It is opt-in because the frozen `ProjectReadModelSchema` is a strict
 * object: clients of `GET /api/production/projects/:id` re-validate the response with it and
 * would reject the extra key, so the default projection keeps the wire shape unchanged.
 */
export interface ReadModelOptions { readonly includeScenes?: boolean }
/** The v2 read model plus the production's scenes; `scenes` is additive and never reorders the base fields. */
export const ProjectReadModelWithScenesSchema = ProjectReadModelSchema.extend({ scenes: z.array(SceneSchema).max(10_000) });
export type ProjectReadModelWithScenes = z.infer<typeof ProjectReadModelWithScenesSchema> & { scenes: Scene[] };

export function getProjectReadModel(store: ProductionStore, projectId: string): ProjectReadModel;
export function getProjectReadModel(store: ProductionStore, projectId: string, options: ReadModelOptions & { includeScenes: true }): ProjectReadModelWithScenes;
export function getProjectReadModel(store: ProductionStore, projectId: string, options: ReadModelOptions = {}): ProjectReadModel | ProjectReadModelWithScenes {
  const read = store.read; const project = read.getProject(projectId); if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
  const canonRevisions = bounded(read.listCanonRevisions(project.activeCanonRevisionIds), 500, 'canon revisions');
  const selectedCanonByEntity = new Map(canonRevisions.map((revision) => [revision.entityId, revision]));
  const storyRevision = project.activeStoryRevisionId ? read.getStoryRevision(project.activeStoryRevisionId) : null;
  const shotPlanRevision = project.activeShotPlanRevisionId ? read.getShotPlanRevision(project.activeShotPlanRevisionId) : null;
  const animaticRevision = project.activeAnimaticRevisionId ? read.getAnimaticRevision(project.activeAnimaticRevisionId) : null;
  const audioMixRevision = project.activeAudioMixRevisionId ? read.getAudioMixRevision(project.activeAudioMixRevisionId) : null;
  const issues: DependencyIssue[] = [];
  const activeFor = (id: string) => { const row = read.getCanonRevision(id); return row ? selectedCanonByEntity.get(row.entityId) ?? null : null; };
  const inspectCanonPins = (targetKind: DependencyIssue['targetKind'], targetId: string, ids: string[]) => ids.forEach((id) => {
    const pinned = read.getCanonRevision(id); const active = activeFor(id);
    if (!pinned || !active) appendIssue(issues, { targetKind, targetId, dependencyKind: 'canon', pinnedDependencyId: id, activeDependencyId: active?.id ?? null, code: 'DEPENDENCY_MISSING' });
    else if (active.id !== id) appendIssue(issues, { targetKind, targetId, dependencyKind: 'canon', pinnedDependencyId: id, activeDependencyId: active.id, code: 'DEPENDENCY_REPLACED' });
  });
  if (shotPlanRevision && storyRevision && shotPlanRevision.storyRevisionId !== storyRevision.id) appendIssue(issues, { targetKind: 'shotplan', targetId: shotPlanRevision.id, dependencyKind: 'story', pinnedDependencyId: shotPlanRevision.storyRevisionId, activeDependencyId: storyRevision.id, code: 'STORY_CHANGED' });
  if (storyRevision) inspectCanonPins('story', storyRevision.id, storyRevision.canonRevisionIds);
  const shotRows = shotPlanRevision?.orderedShotRevisionIds.map((id) => read.getShotRevision(id)).filter((row): row is NonNullable<typeof row> => !!row) ?? [];
  for (const [shotIndex, shot] of shotRows.entries()) {
    if (storyRevision && shot.storyRevisionId !== storyRevision.id) {
      const origin = read.getStoryRevision(shot.storyRevisionId);
      const lineage: NonNullable<typeof origin>[] = [];
      let cursor = storyRevision;
      while (lineage.length <= 10_000) {
        lineage.push(cursor);
        if (!cursor.parentRevisionId) break;
        const parent = read.getStoryRevision(cursor.parentRevisionId); if (!parent) break; cursor = parent;
      }
      const compatible = !!origin && shotsCompatibleWithStory(shot, origin, storyRevision, {
        projectId: project.id,
        storyLineage: lineage,
        selectedCanonRevisions: canonRevisions,
        candidate: (() => {
          const { id: _id, contentHash: _contentHash, createdAt: _createdAt, ...candidate } = shot;
          return { ...candidate, storyRevisionId: storyRevision.id };
        })(),
        continuationIsValid: !shot.continuation || (shotIndex > 0 && shotRows[shotIndex - 1].id === shot.continuation.previousShotRevisionId && !!read.getShotRevision(shot.continuation.previousShotRevisionId) && !!read.getAsset(shot.continuation.endFrameAssetId)),
      });
      if (!compatible) appendIssue(issues, { targetKind: 'shot', targetId: shot.id, dependencyKind: 'story', pinnedDependencyId: shot.storyRevisionId, activeDependencyId: storyRevision.id, code: 'STORY_CHANGED' });
    }
    inspectCanonPins('shot', shot.id, [...shot.castBindings.map((binding) => binding.canonRevisionId), shot.locationRevisionId, ...shot.propRevisionIds, shot.styleRevisionId]);
    if (shot.continuation) {
      const prior = read.getShotRevision(shot.continuation.previousShotRevisionId);
      const selectedPrior = shotIndex > 0 ? shotRows[shotIndex - 1] : null;
      const frame = read.getAsset(shot.continuation.endFrameAssetId);
      if (!prior || !frame) appendIssue(issues, { targetKind: 'shot', targetId: shot.id, dependencyKind: 'continuation', pinnedDependencyId: shot.continuation.previousShotRevisionId, activeDependencyId: null, code: 'DEPENDENCY_MISSING' });
      else if (selectedPrior?.id !== prior.id) appendIssue(issues, { targetKind: 'shot', targetId: shot.id, dependencyKind: 'continuation', pinnedDependencyId: shot.continuation.previousShotRevisionId, activeDependencyId: selectedPrior?.id ?? null, code: 'DEPENDENCY_REPLACED' });
    }
  }
  const shots = shotRows.map((shotRevision) => {
    const takeSelection = read.getTakeSelection(project.id, shotRevision.shotId);
    const selectedTake = takeSelection.takeId ? read.getTake(takeSelection.takeId) : null;
    const take = selectedTake?.shotRevisionId === shotRevision.id ? selectedTake : null;
    const takeHistory = bounded(read.listTakesForShot(shotRevision.id), 100_000, 'shot take history');
    const anchorHistory = bounded(read.listAnchorsForShot(shotRevision.id), 100_000, 'shot anchor history');
    const animaticAnchorId = animaticRevision?.slots.find((slot) => slot.shotRevisionId === shotRevision.id)?.anchorId ?? null;
    const anchorCandidate = take ? read.getAnchor(take.anchorId) : animaticAnchorId ? read.getAnchor(animaticAnchorId) : null;
    const anchor = anchorCandidate?.shotRevisionId === shotRevision.id ? anchorCandidate : null;
    const approvals = [...anchorHistory.flatMap((candidate) => read.listApprovals('anchor', candidate.id)),
      ...takeHistory.flatMap((candidate) => read.listApprovals('take', candidate.id))];
    return { shotRevision, selectedTake: take, selectedAnchor: anchor, takeSelection, anchorHistory, takeHistory, approvals: bounded(approvals, 100_000, 'shot approval history') };
  });
  const jobs = bounded(read.listProjectJobs(project.id), 100_000, 'job history');
  const activeJobs = jobs.filter((job) => !['completed', 'failed', 'canceled'].includes(job.status));
  const revisionApprovals = [
    ...canonRevisions.flatMap((revision) => read.listApprovals('canon', revision.id)),
    ...(storyRevision ? read.listApprovals('story', storyRevision.id) : []),
    ...(shotPlanRevision ? read.listApprovals('shotplan', shotPlanRevision.id) : []),
    ...(animaticRevision ? read.listApprovals('animatic', animaticRevision.id) : []),
    ...(audioMixRevision ? read.listApprovals('audio', audioMixRevision.id) : []),
  ];
  const exports = read.listProjectExports(project.id);
  const model = { schemaVersion: 2 as const, dependencyIssues: bounded(issues, 100_000, 'dependency issues'), revisionApprovals: bounded(revisionApprovals, 100_000, 'approval history'), project, canonRevisions, storyRevision, shotPlanRevision, animaticRevision, audioMixRevision, shots: bounded(shots, 10_000, 'shots'), activeJobs: bounded(activeJobs, 1000, 'active jobs'), jobs, exports: bounded(exports, 1000, 'exports') };
  if (!options.includeScenes) return ProjectReadModelSchema.parse(model);
  return ProjectReadModelWithScenesSchema.parse({ ...model, scenes: bounded(read.listProjectScenes(project.id), 10_000, 'scenes') });
}
