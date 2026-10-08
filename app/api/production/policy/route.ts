import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { getInstalledPolicy, installReviewedPolicy, removeReviewedPolicy, ReviewedPolicyInstallSchema } from '@/lib/services/production/policy-service';

export const runtime = 'nodejs';

/** Two 64 KiB text fields (capture + canonical config) plus metadata. */
const MAX_BODY_BYTES = 192 * 1024;

/** GET /api/production/policy — the installed reviewed spend policy view (never secrets). */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    return Response.json(await getInstalledPolicy(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

/** PUT /api/production/policy — install or rotate the reviewed spend policy after full offline validation. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, ReviewedPolicyInstallSchema, { maxBytes: MAX_BODY_BYTES });
    return Response.json(await installReviewedPolicy(command), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}

/** DELETE /api/production/policy — remove the installed policy; paid generation returns to fail-closed. */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    return Response.json(await removeReviewedPolicy(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
