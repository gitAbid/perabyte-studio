import { NextResponse } from "next/server";
import { importLegacyRecords } from "@/lib/services/records.service";
import { logger } from "@/lib/logging/logger";

export const runtime = "nodejs";

const log = logger.child({ route: "api/assets/import" });

/**
 * One-time legacy import: the client posts its localStorage `assets.v2`
 * rows before wiping the migrated flag in. Known ids, demo rows and
 * malformed rows are skipped — an interrupted import can safely re-run.
 */
export async function POST(request: Request) {
  let rows: unknown = null;
  try {
    const body = (await request.json()) as { rows?: unknown } | null;
    rows = body?.rows;
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    return NextResponse.json(
      { error: "Expected { rows: [...] }.", retryable: false },
      { status: 400 },
    );
  }
  const result = importLegacyRecords(rows);
  log.info("legacy import", result);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
