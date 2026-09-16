import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  createJob,
  ensureJobsRecovered,
  listActiveJobs,
} from "@/lib/jobs/jobs.service";
import { GenerationServiceError } from "@/lib/services/generation.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/jobs" });

/**
 * Durable render jobs (Phase B). POST enqueues (202 with the job record —
 * the render proceeds server-side regardless of this connection); GET lists
 * active jobs (the UI's polling endpoint). Boot recovery runs on first use.
 */
export async function POST(request: Request) {
  ensureJobsRecovered();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }
  try {
    const job = createJob(body);
    log.info("job created", { jobId: job.id, kind: job.kind, provider: job.provider });
    return NextResponse.json(
      { job },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GenerationServiceError) {
      return NextResponse.json(
        {
          error: error.message,
          ...(error.field ? { field: error.field } : {}),
          retryable: error.retryable,
        },
        { status: error.status },
      );
    }
    log.error("job create failed unexpectedly", { error });
    return NextResponse.json(
      { error: "Something went wrong while starting the render.", retryable: true },
      { status: 500 },
    );
  }
}

export async function GET() {
  ensureJobsRecovered();
  return NextResponse.json(
    { jobs: listActiveJobs() },
    { headers: { "cache-control": "no-store" } },
  );
}
