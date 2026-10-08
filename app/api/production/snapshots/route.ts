import { randomUUID } from 'node:crypto';
import {
  CreateProductionSnapshotCommandSchema, ProductionSnapshotSchema, ProjectSchema, isEnvironmentKind,
  type CreateProductionSnapshotCommand, type ProductionSnapshot,
} from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import type { ProductionWritePort } from '@/lib/repositories/production/ports';

const KIND_LABELS = { character: 'character', environment: 'environment', style: 'style' } as const;
type PinKind = keyof typeof KIND_LABELS;

function requirePinnedRevisions(tx: ProductionWritePort, command: CreateProductionSnapshotCommand): void {
  const pins: readonly (readonly [readonly string[], PinKind])[] = [
    [command.characterRevisionIds, 'character'],
    [command.environmentRevisionIds, 'environment'],
    [command.styleRevisionIds, 'style'],
  ];
  const union = pins.flatMap(([ids]) => [...ids]);
  if (new Set(union).size !== union.length) throw new ProductionApplicationError('INVALID_INPUT', 'Snapshot contains duplicate canon revision pins');
  for (const [revisionIds, kind] of pins) {
    for (const revisionId of revisionIds) {
      const revision = tx.getCanonRevision(revisionId);
      const kindMatches = revision !== undefined && revision !== null && (kind === 'environment' ? isEnvironmentKind(revision.entityKind) : revision.entityKind === kind);
      if (!kindMatches) throw new ProductionApplicationError('UNKNOWN_REFERENCE', `Snapshot pins an unknown ${KIND_LABELS[kind]} canon revision: ${revisionId}`);
    }
  }
}

function createSnapshot(command: CreateProductionSnapshotCommand): Promise<ProductionSnapshot> {
  return withProductionStore((store) => store.transaction((tx) => {
    const project = tx.getProject(command.projectId);
    if (!project) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Project not found');
    if (!tx.getWorkspace(command.workspaceId)) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Workspace not found');
    requirePinnedRevisions(tx, command);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ProductionApplicationError('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
    const snapshot = ProductionSnapshotSchema.parse({ ...command, id: randomUUID(), createdAt: now });
    tx.insertProductionSnapshot(snapshot);
    // C5: writers bind the project to the workspace and its active snapshot; snapshots themselves are immutable.
    const saveVersion = project.saveVersion + 1;
    if (!Number.isSafeInteger(saveVersion)) throw new ProductionApplicationError('INVALID_INPUT', 'Project save version exceeds the safe integer range');
    const nextProject = ProjectSchema.parse({ ...project, workspaceId: command.workspaceId, activeSnapshotId: snapshot.id, updatedAt: now, saveVersion });
    if (!tx.compareAndSetProject(nextProject, project.saveVersion)) throw new ProductionApplicationError('STALE_REVISION', 'Project changed while creating the snapshot; reload and retry');
    return snapshot;
  }));
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, CreateProductionSnapshotCommandSchema);
    const snapshot = await createSnapshot(command);
    return Response.json(ProductionSnapshotSchema.parse(snapshot), { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
