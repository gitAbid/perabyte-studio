import { UpdateProjectCommandSchema, IdSchema } from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { getProjectReadModel, updateProject } from '@/lib/services/production/revisions';

type Context = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    const { projectId } = await context.params;
    if (!IdSchema.safeParse(projectId).success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid project ID');
    const data = await withProductionStore((store) => getProjectReadModel(store, projectId));
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, UpdateProjectCommandSchema);
    const project = await withProductionStore((store) => updateProject(store, projectId, command));
    return Response.json(project, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
