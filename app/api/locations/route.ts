import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  listLocations,
  putLocation,
  removeLocations,
} from "@/lib/services/locations.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/locations" });

/**
 * Server-side saved locations.
 *
 * GET    — all rows, most recently updated first.
 * PUT    — upsert one row (full location payload).
 * DELETE — repeatable ?id= params to remove.
 */
export async function GET() {
  return NextResponse.json(
    { locations: listLocations() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }
  // The body is an untrusted LocationRow; the row parser re-validates
  // everything so a malformed write is rejected instead of poisoning the
  // store.
  const location = putLocation(body);
  if (!location) {
    return NextResponse.json(
      { error: "That location record is not valid.", retryable: false },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { location },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const ids = new URL(request.url)
    .searchParams.getAll("id")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    return NextResponse.json({ error: "Missing id.", retryable: false }, { status: 400 });
  }
  const removed = removeLocations(ids);
  log.debug("locations removed", { count: removed });
  return NextResponse.json(
    { removed },
    { headers: { "cache-control": "no-store" } },
  );
}
