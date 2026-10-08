import { createAutoRun, listProjectAutoRuns } from "@/lib/services/production/auto-run";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "@/lib/production/http";
import { withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";
import { z } from "zod";
import { ProductionApplicationError } from "@/lib/production/errors";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const { projectId } = await context.params;
    if (!IdSchema.safeParse(projectId).success) throw new ProductionApplicationError("INVALID_INPUT", "Invalid project id");
    const runs = await withProductionStore((store) => listProjectAutoRuns(store, projectId));
    return Response.json({ runs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, CreateAutoRunBodySchema);
    if (command.projectId !== projectId) throw new ProductionApplicationError("INVALID_INPUT", "Route project ID does not match command project ID");
    const run = await withProductionStore((store) => createAutoRun(store, command));
    return Response.json({ run }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

const CreateAutoRunBodySchema = z.strictObject({
  projectId: IdSchema,
  idea: z.string().trim().min(1).max(5000),
  durationTargetMs: z.number().int().safe().positive(),
  qualityStrategy: z.enum(["economy", "balanced", "best"]),
});
