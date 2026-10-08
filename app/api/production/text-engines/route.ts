import { z } from "zod";
import { getRequestId, productionErrorResponse } from "@/lib/production/http";
import { listTextEngineOptions } from "@/lib/services/text-engine-chain";

export const runtime = "nodejs";

/** Strict response contract: engine ids + labels only — never provider credentials. */
export const TextEnginesResponseSchema = z.strictObject({
  engines: z.array(
    z.strictObject({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
});

/**
 * GET /api/production/text-engines — the text-engine chain's selectable
 * providers/models (enabled built-ins minus their disabledModels, then enabled
 * custom gateways), in chain priority order. Config weirdness never throws:
 * whatever is validly configured is listed, possibly nothing (an honest empty
 * list the client renders as a disabled dropdown).
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const engines = TextEnginesResponseSchema.parse({ engines: listTextEngineOptions() });
    return Response.json(engines, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}
