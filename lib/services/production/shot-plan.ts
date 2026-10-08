import {
  AnimaticRevisionSchema,
  CreateShotPlanCommandSchema,
  IdSchema,
  ProjectSchema,
  ShotPlanRevisionSchema,
  ShotRevisionSchema,
  type AnimaticRevision,
  type CanonRevision,
  type CreateShotPlanCommand,
  type Project,
  type ShotPlanRevision,
  type ShotRevision,
} from '../../production/contracts';
import { ProductionApplicationError, type ProductionErrorCode } from '../../production/errors';
import { hashCanonicalJson } from '../../production/hash';
import { validateShotPlan } from '../../production/shot-plan';
import type { ProductionStore, ProductionWritePort } from '../../repositories/production/ports';
import { buildAnimaticTimeline } from '../../production/animatic';
import { shotsCompatibleWithStory } from '../../production/revisions';

export type ShotPlanServiceOptions = {
  now: () => number;
  idFactory: () => string;
  maxShots: number;
};

export type CreatedShotPlan = {
  shotRevisions: ShotRevision[];
  shotPlanRevision: ShotPlanRevision;
  animaticRevision: AnimaticRevision;
};

function nextId(options: ShotPlanServiceOptions): string {
  const id = options.idFactory();
  if (!IdSchema.safeParse(id).success) fail('INVALID_INPUT', 'ID factory must return a valid production ID');
  return id;
}

function fail(code: ProductionErrorCode, message: string): never {
  throw new ProductionApplicationError(code, message);
}

function requireCanon(
  revisions: Map<string, CanonRevision>,
  id: string,
  expectedKind: CanonRevision['entityKind'],
  activeIds: Set<string>,
  storyIds: Set<string>,
): CanonRevision {
  const revision = revisions.get(id);
  if (!revision || !activeIds.has(id) || !storyIds.has(id)) {
    fail('UNKNOWN_REFERENCE', `Shot plan references unknown canon revision ${id}`);
  }
  if (revision.entityKind !== expectedKind) {
    fail('INVALID_INPUT', `Canon revision ${id} must be a ${expectedKind} revision`);
  }
  return revision;
}

function shotContent(shot: CreateShotPlanCommand['shots'][number], storyRevisionId: string, order: number, sceneId: string | null) {
  return {
    version: 1 as const,
    shotId: shot.shotId,
    storyRevisionId,
    beatIds: [...shot.beatIds],
    order,
    visualIntent: shot.visualIntent,
    motionIntent: shot.motionIntent,
    castBindings: shot.castBindings.map((binding) => ({ ...binding })),
    locationRevisionId: shot.locationRevisionId,
    propRevisionIds: [...shot.propRevisionIds],
    styleRevisionId: shot.styleRevisionId,
    framing: shot.framing,
    targetFrames: shot.targetFrames,
    continuation: shot.continuation ? { ...shot.continuation } : null,
    // Scene pin (C7) enters the hashed content only when set, so sceneless plans keep
    // byte-identical content hashes (and prior-shot reuse) across this field's introduction.
    ...(sceneId === null ? {} : { sceneId }),
  };
}

/**
 * Resolves each shot's scene pin: an explicit command `sceneId` is honored (fail-closed on
 * unknown or foreign-project scenes); omitted pins fall back to deterministic order
 * correspondence — the k-th scene of the planned story (by `order`, id tiebreak) pins to the
 * k-th shot, and surplus shots or scenes stay unassociated.
 */
function planSceneIds(tx: ProductionWritePort, command: CreateShotPlanCommand, projectId: string, storyRevisionId: string): (string | null)[] {
  const planScenes = tx.listScenes(projectId, storyRevisionId)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  for (const shot of command.shots) {
    if (shot.sceneId == null) continue;
    const scene = tx.getScene(shot.sceneId);
    if (!scene) fail('INVALID_INPUT', `Shot plan references unknown scene ${shot.sceneId}`);
    if (scene.projectId !== projectId) fail('INVALID_INPUT', `Shot plan scene ${shot.sceneId} belongs to another project`);
  }
  return command.shots.map((shot, index) => shot.sceneId ?? planScenes[index]?.id ?? null);
}

/** Creates an immutable plan and placeholder animatic in one synchronous store transaction. */
export function createShotPlan(
  store: ProductionStore,
  rawCommand: CreateShotPlanCommand,
  options: ShotPlanServiceOptions,
): CreatedShotPlan {
  const parsed = CreateShotPlanCommandSchema.safeParse(rawCommand);
  if (!parsed.success) fail('INVALID_INPUT', `Invalid shot plan command: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  const command = parsed.data;
  if (!Number.isSafeInteger(options.maxShots) || options.maxShots < 1) {
    fail('INVALID_INPUT', 'Configured maximum shots must be a positive safe integer');
  }
  const createdAt = options.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  const allocatedIds = new Set<string>();
  const allocateId = () => {
    const id = nextId(options);
    if (allocatedIds.has(id)) fail('INVALID_INPUT', `ID factory returned duplicate ID ${id}`);
    allocatedIds.add(id);
    return id;
  };

  return store.transaction((tx) => {
    const project = tx.getProject(command.projectId);
    if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
    if (project.activeStoryRevisionId !== command.storyRevisionId) fail('STALE_REVISION', 'Cannot create shot plan from a stale story revision');
    const story = tx.getStoryRevision(command.storyRevisionId);
    if (!story) fail('UNKNOWN_REFERENCE', 'Story revision not found');
    if (story.projectId !== project.id) fail('UNKNOWN_REFERENCE', 'Story revision does not belong to this project');
    if (story.contentHash !== command.approvedStoryHash) fail('STALE_REVISION', 'Approved story hash does not match the current story');
    const matchingApprovals = tx.listApprovals('story', story.id).filter((approval) =>
      approval.targetId === story.id && approval.targetHash === story.contentHash &&
      approval.targetKind === 'story');
    const latestApprovalAt = matchingApprovals.reduce((latest, approval) => Math.max(latest, approval.createdAt), -1);
    const latestApprovals = matchingApprovals.filter((approval) => approval.createdAt === latestApprovalAt);
    const hasApproval = latestApprovals.length > 0 && latestApprovals.every((approval) => approval.decision === 'approved');
    if (!hasApproval) fail('APPROVAL_REQUIRED', 'An approved story revision is required before creating a shot plan');

    const validation = validateShotPlan(story.beats, command.shots, options.maxShots);
    if (validation.issues.length > 0) {
      const uncovered = validation.issues.filter((issue) => issue.code === 'UNCOVERED_BEAT');
      if (uncovered.length > 0) fail('INVALID_INPUT', `Invalid beat coverage: ${uncovered.map((issue) => issue.message).join('; ')}`);
      const unknownBeat = validation.issues.filter((issue) => issue.code === 'UNKNOWN_BEAT');
      if (unknownBeat.length > 0) fail('UNKNOWN_REFERENCE', `Invalid shot plan: ${unknownBeat.map((issue) => issue.message).join('; ')}`);
      fail('INVALID_INPUT', `Invalid shot plan: ${validation.issues.map((issue) => issue.message).join('; ')}`);
    }
    if (validation.totalFrames === null || !Number.isSafeInteger(validation.totalFrames)) {
      fail('INVALID_INPUT', 'Shot plan total frame count is unsafe');
    }

    const canonIds = new Set([...project.activeCanonRevisionIds, ...story.canonRevisionIds]);
    const canonRows = tx.listCanonRevisions([...canonIds]);
    const canonById = new Map(canonRows.map((revision) => [revision.id, revision]));
    const activeCanonIds = new Set(project.activeCanonRevisionIds);
    const storyCanonIds = new Set(story.canonRevisionIds);
    for (const beat of story.beats) {
      const coveringShots = command.shots.filter((shot) => shot.beatIds.includes(beat.id));
      for (const line of beat.dialogue) {
        if (!coveringShots.some((shot) => shot.castBindings.some((binding) => binding.characterId === line.characterId))) {
          fail('INVALID_INPUT', `Dialogue speaker ${line.characterId} for beat ${beat.id} must appear in a covering shot`);
        }
      }
    }
    for (const input of command.shots) {
      requireCanon(canonById, input.locationRevisionId, 'location', activeCanonIds, storyCanonIds);
      requireCanon(canonById, input.styleRevisionId, 'style', activeCanonIds, storyCanonIds);
      if (new Set(input.propRevisionIds).size !== input.propRevisionIds.length) fail('INVALID_INPUT', 'Shot plan contains duplicate prop revisions');
      for (const id of input.propRevisionIds) requireCanon(canonById, id, 'prop', activeCanonIds, storyCanonIds);
      const characterIds = input.castBindings.map((binding) => binding.characterId);
      if (new Set(characterIds).size !== characterIds.length) fail('INVALID_INPUT', `Shot ${input.shotId} contains duplicate character bindings`);
      for (const binding of input.castBindings) {
        const character = requireCanon(canonById, binding.canonRevisionId, 'character', activeCanonIds, storyCanonIds);
        if (character.entityId !== binding.characterId) fail('INVALID_INPUT', `Character binding ${binding.characterId} does not match canon revision ${binding.canonRevisionId}`);
      }
    }
    const sceneIds = planSceneIds(tx, command, project.id, story.id);

    const priorPlan = project.activeShotPlanRevisionId
      ? tx.getShotPlanRevision(project.activeShotPlanRevisionId)
      : null;
    const priorShots = new Map<string, ShotRevision>();
    for (const revisionId of priorPlan?.orderedShotRevisionIds ?? []) {
      const revision = tx.getShotRevision(revisionId);
      if (revision) priorShots.set(revision.shotId, revision);
    }
    const storyLineage = [story];
    let lineageCursor = story;
    while (lineageCursor.parentRevisionId && storyLineage.length <= 10_000) {
      const parent = tx.getStoryRevision(lineageCursor.parentRevisionId);
      if (!parent) break;
      storyLineage.push(parent);
      lineageCursor = parent;
    }

    const persistedShots: ShotRevision[] = [];
    const insertedShots: ShotRevision[] = [];
    for (const [order, input] of command.shots.entries()) {
      const content = shotContent(input, story.id, order, sceneIds[order] ?? null);
      const contentHash = hashCanonicalJson(content);
      const existing = priorShots.get(input.shotId);
      const originStory = existing ? tx.getStoryRevision(existing.storyRevisionId) : null;
      const continuationIsValid = !content.continuation || (!!tx.getShotRevision(content.continuation.previousShotRevisionId) && !!tx.getAsset(content.continuation.endFrameAssetId));
      if (existing && originStory && shotsCompatibleWithStory(existing, originStory, story, {
        projectId: project.id,
        storyLineage,
        selectedCanonRevisions: tx.listCanonRevisions(project.activeCanonRevisionIds),
        candidate: content,
        continuationIsValid,
      }) && existing.order === order &&
        existing.beatIds.length === content.beatIds.length && existing.beatIds.every((id, index) => id === content.beatIds[index])) {
        persistedShots.push(existing);
        continue;
      }
      const revision = ShotRevisionSchema.parse({
        ...content,
        id: allocateId(),
        contentHash,
        createdAt,
      });
      insertedShots.push(revision);
      persistedShots.push(revision);
    }
    for (const [index, shot] of persistedShots.entries()) {
      if (!shot.continuation) continue;
      const previous = persistedShots[index - 1];
      if (!previous || shot.continuation.previousShotRevisionId !== previous.id || !tx.getShotRevision(previous.id)) {
        fail('UNKNOWN_REFERENCE', `Shot ${shot.shotId} continuation must reference the immediately preceding persisted shot revision`);
      }
      if (!tx.getAsset(shot.continuation.endFrameAssetId)) {
        fail('UNKNOWN_REFERENCE', `Shot ${shot.shotId} continuation references an unknown end-frame asset`);
      }
    }

    const shotPlanRevision = ShotPlanRevisionSchema.parse({
      version: 1,
      id: allocateId(),
      projectId: project.id,
      storyRevisionId: story.id,
      orderedShotRevisionIds: persistedShots.map((shot) => shot.id),
      beatCoverage: validation.beatCoverage.map(({ beatId }) => ({
        beatId,
        shotRevisionIds: persistedShots.filter((shot) => shot.beatIds.includes(beatId)).map((shot) => shot.id),
      })),
      contentHash: hashCanonicalJson({
        projectId: project.id,
        storyRevisionId: story.id,
        orderedShotRevisionIds: persistedShots.map((shot) => shot.id),
        beatCoverage: validation.beatCoverage.map(({ beatId }) => ({
          beatId,
          shotRevisionIds: persistedShots.filter((shot) => shot.beatIds.includes(beatId)).map((shot) => shot.id),
        })),
      }),
      createdAt,
    });
    const timeline = buildAnimaticTimeline(persistedShots.map((shot) => ({
      id: shot.id,
      shotId: shot.shotId,
      targetFrames: shot.targetFrames,
    })));
    const animaticRevision = AnimaticRevisionSchema.parse({
      version: 1,
      id: allocateId(),
      projectId: project.id,
      shotPlanRevisionId: shotPlanRevision.id,
      slots: timeline.slots,
      timingAnnotations: timeline.timingAnnotations,
      totalFrames: timeline.totalFrames,
      contentHash: hashCanonicalJson({
        shotPlanRevisionId: shotPlanRevision.id,
        slots: timeline.slots,
        timingAnnotations: timeline.timingAnnotations,
        totalFrames: timeline.totalFrames,
      }),
      createdAt,
    });

    if (insertedShots.length > 0) {
      tx.insertShotRevisions(insertedShots);
      for (const shot of insertedShots) {
        tx.insertRevisionDependencies(shot.id, [...new Set([
          shot.storyRevisionId,
          ...shot.castBindings.map((binding) => binding.canonRevisionId),
          shot.locationRevisionId,
          ...shot.propRevisionIds,
          shot.styleRevisionId,
          ...(shot.continuation ? [shot.continuation.previousShotRevisionId, shot.continuation.endFrameAssetId] : []),
        ])]);
      }
    }
    tx.insertShotPlanRevision(shotPlanRevision);
    tx.insertRevisionDependencies(shotPlanRevision.id, shotPlanRevision.orderedShotRevisionIds);
    tx.insertAnimaticRevision(animaticRevision);
    tx.insertRevisionDependencies(animaticRevision.id, [shotPlanRevision.id]);
    if (!Number.isSafeInteger(project.saveVersion + 1)) fail('INVALID_INPUT', 'Project save version exceeds the safe integer range');
    const nextProject: Project = ProjectSchema.parse({
      ...project,
      activeShotPlanRevisionId: shotPlanRevision.id,
      activeAnimaticRevisionId: animaticRevision.id,
      updatedAt: createdAt,
      saveVersion: project.saveVersion + 1,
    });
    if (!tx.compareAndSetProject(nextProject, project.saveVersion)) fail('STALE_REVISION', 'Project changed while creating shot plan; retry from the latest revision');

    return { shotRevisions: persistedShots, shotPlanRevision, animaticRevision };
  });
}
