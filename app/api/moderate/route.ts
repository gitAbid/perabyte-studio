import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { isValidMediaRef } from "@/lib/repositories/media.repository";
import { classifyMediaRef } from "@/lib/services/moderation.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/moderate" });

/**
 * Classify one media-cache ref for the 18+ preview gate. Never fails the
 * client: any problem degrades to source "static" (flag-driven masking).
 */
export async function POST(request: Request) {
  let body: { ref?: unknown };
  try {
    body = (await request.json()) as { ref?: unknown };
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }

  const ref = typeof body.ref === "string" ? body.ref : "";
  if (!isValidMediaRef(ref)) {
    return NextResponse.json(
      { error: "Unknown media reference.", retryable: false },
      { status: 400 },
    );
  }

  const decision = await classifyMediaRef(ref, { signal: request.signal, logger: log });
  return NextResponse.json(
    { ref, verdict: decision.verdict, source: decision.source },
    { headers: { "cache-control": "no-store" } },
  );
}
