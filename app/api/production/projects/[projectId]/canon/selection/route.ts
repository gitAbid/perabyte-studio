import { ProductionApplicationError } from '@/lib/production/errors';
import { SelectCanonRevisionCommandSchema } from '@/lib/production/contracts';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { selectCanonRevision } from '@/lib/services/production/revisions';
type Context = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, SelectCanonRevisionCommandSchema);
    if (command.projectId !== projectId) throw new ProductionApplicationError('INVALID_INPUT', 'Route project ID does not match command project ID');
    const project = await withProductionStore((store) => selectCanonRevision(store, command));
    return Response.json(project, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
