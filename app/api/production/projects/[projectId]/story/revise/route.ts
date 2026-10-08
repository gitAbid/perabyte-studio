import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { applyStoryRevise, StoryReviseCommandSchema } from '@/lib/services/production/story-revise';
type Context = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, StoryReviseCommandSchema, { maxBytes: 64 * 1024 });
    if (command.projectId !== projectId) throw new ProductionApplicationError('INVALID_INPUT', 'Route project ID does not match command project ID');
    const result = await withProductionStore((store) => applyStoryRevise(store, command));
    // A new child revision is 201; an exact replay that resolved to the base revision is 200.
    const created = result.storyRevision.id !== command.baseStoryRevisionId;
    return Response.json(result, { status: created ? 201 : 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
