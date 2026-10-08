import { IdSchema } from '@/lib/production/contracts';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { RerollRequestBodySchema, enqueueGuidedReroll } from '@/lib/services/production/reroll';

type Context = { params: Promise<{ projectId: string }> };

/** POST /api/production/projects/:projectId/reroll — queue one continuity-guided take re-roll. */
export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    if (!IdSchema.safeParse(projectId).success) throw new ProductionApplicationError('INVALID_INPUT', 'Invalid project ID');
    const body = await readProductionJson(request, RerollRequestBodySchema, { maxBytes: 64 * 1024 });
    const result = await withProductionStore((store) => enqueueGuidedReroll(store, { projectId, ...body }));
    return Response.json(
      { jobId: result.job.id, retryOf: result.retryOf, created: result.created, status: result.job.status },
      { status: result.created ? 201 : 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) { return productionErrorResponse(error, requestId); }
}
