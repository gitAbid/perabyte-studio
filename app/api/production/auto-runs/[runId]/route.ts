import { advanceAutoRun, cancelAutoRun, confirmAutoRun } from "@/lib/services/production/auto-run";
import { resolveFirstChainTextProvider } from "@/lib/services/production/text-chain-provider";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "@/lib/production/http";
import { withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { z } from "zod";

type Context = { params: Promise<{ runId: string }> };

const ActionSchema = z.strictObject({ action: z.enum(["confirm", "cancel", "advance"]) });

export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const { runId } = await context.params;
    if (!IdSchema.safeParse(runId).success) throw new ProductionApplicationError("INVALID_INPUT", "Invalid auto run id");
    const run = await withProductionStore((store) => {
      const found = store.read.getAutoRun(runId);
      if (!found) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Auto run not found");
      return found;
    });
    return Response.json({ run }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { runId } = await context.params;
    const { action } = await readProductionJson(request, ActionSchema);
    const run = await withProductionStore(async (store) => {
      switch (action) {
        case "confirm": return confirmAutoRun(store, runId);
        case "cancel": return cancelAutoRun(store, runId);
        case "advance": {
          return advanceAutoRun(store, runId, { textProvider: resolveFirstChainTextProvider() });
        }
      }
    });
    return Response.json({ run }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}
