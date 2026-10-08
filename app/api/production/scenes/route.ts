import {
  ListScenesQuerySchema, SceneListResponseSchema, SceneSchema, UpsertSceneCommandSchema, isEnvironmentKind,
  type Scene, type UpsertSceneCommand,
} from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { hashCanonicalJson } from '@/lib/production/hash';
import type { ProductionWritePort } from '@/lib/repositories/production/ports';

// Schema maxima (100 dialogue lines at 20k chars each) exceed the default 2 MiB request limit.
const MAX_SCENE_BODY_BYTES = 16 * 1024 * 1024;

function nowMillis(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ProductionApplicationError('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  return now;
}

function requireCharacterRevisions(tx: ProductionWritePort, revisionIds: readonly string[]): void {
  for (const revisionId of revisionIds) {
    const revision = tx.getCanonRevision(revisionId);
    if (!revision || revision.entityKind !== 'character') throw new ProductionApplicationError('UNKNOWN_REFERENCE', `Scene references an unknown character canon revision: ${revisionId}`);
  }
}

function upsertScene(command: UpsertSceneCommand): Promise<{ scene: Scene; created: boolean }> {
  return withProductionStore((store) => store.transaction((tx) => {
    const project = tx.getProject(command.projectId);
    if (!project) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Project not found');
    if (command.storyRevisionId !== null) {
      const story = tx.getStoryRevision(command.storyRevisionId);
      if (!story || story.projectId !== project.id) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Scene story revision does not belong to this project');
    }
    requireCharacterRevisions(tx, [...command.characterStates.map((state) => state.characterCanonRevisionId), ...command.dialogue.map((line) => line.characterCanonRevisionId)]);
    if (command.environmentState !== null) {
      const revision = tx.getCanonRevision(command.environmentState.environmentCanonRevisionId);
      if (!revision || !isEnvironmentKind(revision.entityKind)) throw new ProductionApplicationError('UNKNOWN_REFERENCE', `Scene references an unknown environment canon revision: ${command.environmentState.environmentCanonRevisionId}`);
    }
    const existing = tx.getScene(command.id);
    const content = {
      projectId: command.projectId,
      storyRevisionId: command.storyRevisionId,
      order: command.order,
      title: command.title,
      action: command.action,
      dialogue: command.dialogue,
      durationTargetMs: command.durationTargetMs,
      characterStates: command.characterStates,
      environmentState: command.environmentState,
    };
    const scene = SceneSchema.parse({ version: 1, ...content, id: command.id, contentHash: hashCanonicalJson(content), createdAt: existing?.createdAt ?? nowMillis() });
    tx.upsertScene(scene);
    return { scene, created: !existing };
  }));
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    const allowedKeys = ['projectId', 'storyRevisionId'];
    if ([...url.searchParams.keys()].some((key) => !allowedKeys.includes(key)) || url.searchParams.getAll('projectId').length > 1 || url.searchParams.getAll('storyRevisionId').length > 1) {
      throw new ProductionApplicationError('INVALID_INPUT', 'Unknown or duplicate scene list query parameter');
    }
    const parsed = ListScenesQuerySchema.safeParse({ projectId: url.searchParams.get('projectId'), storyRevisionId: url.searchParams.get('storyRevisionId') });
    if (!parsed.success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid scene list query');
    const query = parsed.data;
    const scenes = await withProductionStore((store) => url.searchParams.has('storyRevisionId')
      ? store.read.listScenes(query.projectId, query.storyRevisionId)
      : store.read.listProjectScenes(query.projectId));
    return Response.json(SceneListResponseSchema.parse({ scenes }), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, UpsertSceneCommandSchema, { maxBytes: MAX_SCENE_BODY_BYTES });
    const { scene, created } = await upsertScene(command);
    return Response.json(SceneSchema.parse(scene), { status: created ? 201 : 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
