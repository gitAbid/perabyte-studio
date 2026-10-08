import { randomUUID } from 'node:crypto';
import { ProductionApplicationError } from '@/lib/production/errors';
import { CreateShotPlanCommandSchema } from '@/lib/production/contracts';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { createShotPlan } from '@/lib/services/production/shot-plan';
type Context = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, CreateShotPlanCommandSchema);
    if (command.projectId !== projectId) throw new ProductionApplicationError('INVALID_INPUT', 'Route project ID does not match command project ID');
    const result = await withProductionStore((store) => createShotPlan(store, command, { idFactory: randomUUID, now: Date.now, maxShots: 10_000 }));
    return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
