import { GetJobQuerySchema, JobReadModelSchema } from "../../../../../lib/production/contracts";
import { getRequestId, productionErrorResponse } from "../../../../../lib/production/http";
import { ProductionApplicationError } from "../../../../../lib/production/errors";
import { withProductionStore } from "../../../../../lib/production/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> | { id: string } }): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => key !== "sinceEvent")) throw new ProductionApplicationError("INVALID_INPUT", "Invalid job query.");
    const sinceRaw = url.searchParams.get("sinceEvent");
    const query = GetJobQuerySchema.parse({ jobId: id, ...(sinceRaw === null ? {} : { sinceEvent: Number(sinceRaw) }) });
    const model = await withProductionStore(store => {
      const job = store.read.getJob(query.jobId);
      if (!job) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Production job was not found.");
      // Store rows carry the internal `jobId` key; JobEventSchema is strict, so project each row
      // to the exact schema shape before parsing (C13-LIVE-FIX-2).
      const events = store.read.listJobEvents(job.id, query.sinceEvent ?? 0)
        .map(row => ({ sequence: row.sequence, at: row.at, status: row.status, message: row.message, progress: row.progress }));
      const recoveryAction = job.status === "submission_unknown"
        ? "Provider acceptance is uncertain. Reconcile the provider reference before retrying; this job will not be submitted again automatically."
        : job.status === "blocked" ? "Review the recorded cause, then create a new authorized job after correcting its inputs." : null;
      return JobReadModelSchema.parse({ job, events, recoveryAction });
    });
    return Response.json(model, { headers: { "cache-control": "no-store" } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
