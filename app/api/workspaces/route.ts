import { randomUUID } from 'node:crypto';
import {
  CreateWorkspaceCommandSchema, WorkspaceListResponseSchema, WorkspaceSchema, isEnvironmentKind,
  type CanonEntityKind, type CreateWorkspaceCommand, type Workspace,
} from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import type { ProductionStore, ProductionWritePort } from '@/lib/repositories/production/ports';

type Kind = 'character' | 'environment' | 'style';
// Schema maxima (500 world-bible entries at 20k chars each) exceed the default 2 MiB request limit.
const MAX_WORKSPACE_BODY_BYTES = 16 * 1024 * 1024;

function nowMillis(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ProductionApplicationError('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  return now;
}

function requireCanonEntitySelections(tx: ProductionWritePort, entityIds: readonly string[], kind: Kind, label: string): void {
  if (new Set(entityIds).size !== entityIds.length) throw new ProductionApplicationError('INVALID_INPUT', `Workspace ${label} contain duplicate canon entity IDs`);
  for (const entityId of entityIds) {
    const head = tx.getLatestCanonRevision(entityId);
    const kindMatches = head !== null && (kind === 'environment' ? isEnvironmentKind(head.entityKind) : head.entityKind === (kind as CanonEntityKind));
    if (!kindMatches) throw new ProductionApplicationError('UNKNOWN_REFERENCE', `Workspace ${label} reference an unknown ${kind} canon entity: ${entityId}`);
  }
}

function createWorkspace(store: ProductionStore, command: CreateWorkspaceCommand): Workspace {
  return store.transaction((tx) => {
    requireCanonEntitySelections(tx, command.characterCanonIds, 'character', 'character selections');
    requireCanonEntitySelections(tx, command.environmentCanonIds, 'environment', 'environment selections');
    requireCanonEntitySelections(tx, command.styleCanonIds, 'style', 'style selections');
    const now = nowMillis();
    const workspace = WorkspaceSchema.parse({ version: 1, id: randomUUID(), ...command, createdAt: now, updatedAt: now, saveVersion: 1 });
    tx.insertWorkspace(workspace);
    return workspace;
  });
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length > 0) throw new ProductionApplicationError('INVALID_INPUT', 'Unknown workspace list query parameter');
    const workspaces = await withProductionStore((store) => store.read.listWorkspaces());
    return Response.json(WorkspaceListResponseSchema.parse({ workspaces }), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, CreateWorkspaceCommandSchema, { maxBytes: MAX_WORKSPACE_BODY_BYTES });
    const workspace = await withProductionStore((store) => createWorkspace(store, command));
    return Response.json(WorkspaceSchema.parse(workspace), { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
