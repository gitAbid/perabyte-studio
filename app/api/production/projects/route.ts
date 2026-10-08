import { randomUUID } from 'node:crypto';
import { ListProjectsQuerySchema, ProjectListResponseSchema, CreateProjectCommandSchema } from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { getRequestId, productionErrorResponse, readProductionJson, assertSameOriginMutation } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { createProject } from '@/lib/services/production/revisions';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !['cursor', 'limit'].includes(key)) || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) {
      throw new ProductionApplicationError('INVALID_INPUT', 'Unknown or duplicate project list query parameter');
    }
    const parsed = ListProjectsQuerySchema.safeParse({ cursor: url.searchParams.get('cursor'), limit: Number(url.searchParams.get('limit') ?? 24) });
    if (!parsed.success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid project list query');
    const query = parsed.data;
    const data = await withProductionStore((store) => {
      try { return store.read.listProjects(query.cursor, query.limit); }
      catch (error) { if (error instanceof TypeError) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid project list cursor'); throw error; }
    });
    return Response.json(ProjectListResponseSchema.parse(data), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, CreateProjectCommandSchema);
    const project = await withProductionStore((store) => createProject(store, command, { idFactory: randomUUID }));
    return Response.json(project, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
