import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  EnhancementServiceError,
  runPromptEnhancement,
} from "@/lib/services/enhancement.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/enhance" });

/**
 * Thin controller: parse → service → response. The service never fails on
 * capacity — it degrades to the deterministic enhancer and reports the source.
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
    const response = await runPromptEnhancement(body, {
      signal: request.signal,
      logger: log,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || request.signal.aborted) {
      log.info("enhancement cancelled by client");
      return new NextResponse(null, { status: 499 });
    }
    if (error instanceof EnhancementServiceError) {
      log.warn("enhancement rejected", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: error.retryable },
        { status: error.status },
      );
    }
    log.error("enhancement failed unexpectedly", { error });
    return NextResponse.json(
      { error: "Something went wrong while enhancing the prompt.", retryable: true },
      { status: 500 },
    );
  }
}
