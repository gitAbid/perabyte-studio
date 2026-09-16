import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { cancelJob, getJob, toSummary } from "@/lib/jobs/jobs.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/jobs/[id]" });

/**
 * One job: GET returns the full record (status, progress, result media);
 * POST ?action=cancel cancels a queued or running job.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json(
      { error: "That render job does not exist.", retryable: false },
      { status: 404 },
    );
  }
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const action = new URL(request.url).searchParams.get("action");
  if (action !== "cancel") {
    return NextResponse.json(
      { error: "Unsupported action.", retryable: false },
      { status: 400 },
    );
  }
  const canceled = cancelJob(id);
  if (!canceled) {
    return NextResponse.json(
      { error: "That render job does not exist.", retryable: false },
      { status: 404 },
    );
  }
  log.info("job cancel requested", { jobId: id, status: canceled.status });
  return NextResponse.json(
    { job: toSummary(canceled) },
    { headers: { "cache-control": "no-store" } },
  );
}
