import {
  IdSchema, UpdateWorkspaceCommandSchema, WorkspaceSchema, isEnvironmentKind,
  type CanonEntityKind, type UpdateWorkspaceCommand, type Workspace,
} from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import type { ProductionWritePort } from '@/lib/repositories/production/ports';

type Context = { params: Promise<{ id: string }> };
// Schema maxima (500 world-bible entries at 20k chars each) exceed the default 2 MiB request limit.
const MAX_WORKSPACE_BODY_BYTES = 16 * 1024 * 1024;

function nowMillis(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ProductionApplicationError('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  return now;
}

function requireCanonEntitySelections(tx: ProductionWritePort, entityIds: readonly string[], kind: 'character' | 'environment' | 'style', label: string): void {
  if (new Set(entityIds).size !== entityIds.length) throw new ProductionApplicationError('INVALID_INPUT', `Workspace ${label} contain duplicate canon entity IDs`);
  for (const entityId of entityIds) {
    const head = tx.getLatestCanonRevision(entityId);
    const kindMatches = head !== null && (kind === 'environment' ? isEnvironmentKind(head.entityKind) : head.entityKind === (kind as CanonEntityKind));
    if (!kindMatches) throw new ProductionApplicationError('UNKNOWN_REFERENCE', `Workspace ${label} reference an unknown ${kind} canon entity: ${entityId}`);
  }
}

function updateWorkspace(workspaceId: string, command: UpdateWorkspaceCommand): Promise<Workspace> {
  return withProductionStore((store) => store.transaction((tx) => {
    const workspace = tx.getWorkspace(workspaceId);
    if (!workspace) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Workspace not found');
    if (workspace.saveVersion !== command.expectedSaveVersion) throw new ProductionApplicationError('STALE_REVISION', 'Workspace changed; reload and retry');
    if (command.characterCanonIds) requireCanonEntitySelections(tx, command.characterCanonIds, 'character', 'character selections');
    if (command.environmentCanonIds) requireCanonEntitySelections(tx, command.environmentCanonIds, 'environment', 'environment selections');
    if (command.styleCanonIds) requireCanonEntitySelections(tx, command.styleCanonIds, 'style', 'style selections');
    const patch: Partial<Workspace> = {};
    if (command.name !== undefined) patch.name = command.name;
    if (command.characterCanonIds !== undefined) patch.characterCanonIds = [...command.characterCanonIds];
    if (command.environmentCanonIds !== undefined) patch.environmentCanonIds = [...command.environmentCanonIds];
    if (command.styleCanonIds !== undefined) patch.styleCanonIds = [...command.styleCanonIds];
    if (command.worldBible !== undefined) patch.worldBible = command.worldBible;
    if (command.productionRecipe !== undefined) patch.productionRecipe = command.productionRecipe;
    if (command.rating !== undefined) patch.rating = command.rating;
    if (command.budgetPolicyId !== undefined) patch.budgetPolicyId = command.budgetPolicyId;
    const saveVersion = workspace.saveVersion + 1;
    if (!Number.isSafeInteger(saveVersion)) throw new ProductionApplicationError('INVALID_INPUT', 'Workspace save version exceeds the safe integer range');
    const next = WorkspaceSchema.parse({ ...workspace, ...patch, updatedAt: nowMillis(), saveVersion });
    if (!tx.compareAndSetWorkspace(next, workspace.saveVersion)) throw new ProductionApplicationError('STALE_REVISION', 'Workspace changed while saving; reload and retry');
    return next;
  }));
}

export async function GET(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    const { id } = await context.params;
    if (!IdSchema.safeParse(id).success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid workspace ID');
    const workspace = await withProductionStore((store) => store.read.getWorkspace(id));
    if (!workspace) throw new ProductionApplicationError('UNKNOWN_REFERENCE', 'Workspace not found');
    return Response.json(WorkspaceSchema.parse(workspace), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

export async function PATCH(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { id } = await context.params;
    if (!IdSchema.safeParse(id).success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid workspace ID');
    const command = await readProductionJson(request, UpdateWorkspaceCommandSchema, { maxBytes: MAX_WORKSPACE_BODY_BYTES });
    const workspace = await updateWorkspace(id, command);
    return Response.json(WorkspaceSchema.parse(workspace), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
