import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { runWriterAction, WriterServiceError } from "@/lib/services/writer.service";
import { WriterValidationError } from "@/lib/domain/writer";

export const runtime = "nodejs";

const log = logger.child({ route: "api/writer" });

/**
 * Thin controller for the story writer: parse → service → response.
 * Validation failures are 400s with a field hint; engine failures are
 * retryable 502s. Creative writing has no deterministic fallback.
 */
export async function POST(request: Request) {
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
    const response = await runWriterAction(body, {
      signal: request.signal,
      logger: log,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || request.signal.aborted) {
      log.info("writer action cancelled by client");
      return new NextResponse(null, { status: 499 });
    }
    if (error instanceof WriterValidationError) {
      log.warn("writer request rejected", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: false },
        { status: 400 },
      );
    }
    if (error instanceof WriterServiceError) {
      log.warn("writer action failed", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: error.retryable },
        { status: error.retryable ? 502 : error.status },
      );
    }
    log.error("writer action failed unexpectedly", { error });
    return NextResponse.json(
      { error: "Something went wrong in the writer. Please try again.", retryable: true },
      { status: 500 },
    );
  }
}
