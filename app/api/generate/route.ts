import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  GenerationServiceError,
  runGeneration,
} from "@/lib/services/generation.service";

export const runtime = "nodejs";
/** Video generation polls a provider job for several minutes. */
export const maxDuration = 300;

const log = logger.child({ route: "api/generate" });

/** Thin controller: parse → service → response. All logic lives in the service. */
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
    const response = await runGeneration(body, {
      signal: request.signal,
      logger: log,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || request.signal.aborted) {
      log.info("generation cancelled by client");
      return new NextResponse(null, { status: 499 });
    }
    if (error instanceof GenerationServiceError) {
      log.warn("generation rejected", {
        message: error.message,
        field: error.field,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: error.retryable },
        { status: error.status },
      );
    }
    log.error("generation failed unexpectedly", { error });
    return NextResponse.json(
      { error: "Something went wrong while generating.", retryable: true },
      { status: 500 },
    );
  }
}
