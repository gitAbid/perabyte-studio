import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  clearHistoryRecords,
  ensureRecordsSeeded,
  listRecords,
  patchRecord,
  putRecord,
  removeRecords,
} from "@/lib/services/records.service";
import { parseAssetRow } from "@/lib/repositories/asset-row";
import type { Asset } from "@/lib/types";

export const runtime = "nodejs";

const log = logger.child({ route: "api/assets" });

/**
 * Server-side History records (durable-jobs spec Phase A).
 *
 * GET    — merged read model (assets + stories), newest first. Seeds the
 *          example strip once on a fresh install.
 * POST   — upsert one row (kind routes it to assets.json or stories.json).
 * PATCH  — merge a patch onto one row (?id=).
 * DELETE — ?ids=a,b to remove, or ?all=1 to clear History (stories kept).
 */
export async function GET() {
  ensureRecordsSeeded();
  return NextResponse.json(
    { assets: listRecords() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }
  const asset = parseAssetRow(body);
  if (!asset) {
    return NextResponse.json(
      { error: "That asset record is not valid.", retryable: false },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { asset: putRecord(asset) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id.", retryable: false }, { status: 400 });
  }
  let patch: Record<string, unknown> | null = null;
  try {
    patch = (await request.json()) as Record<string, unknown>;
  } catch {
    patch = null;
  }
  if (!patch || typeof patch !== "object") {
    return NextResponse.json({ error: "Missing patch body.", retryable: false }, { status: 400 });
  }
  // The patch body is untrusted Partial<Asset>; the row parser re-validates
  // everything on the next load, so a malformed write degrades to a row the
  // API drops instead of a crashed store.
  const patched = patchRecord(id, patch as Partial<Asset>);
  if (!patched) {
    return NextResponse.json({ error: "Asset not found.", retryable: false }, { status: 404 });
  }
  return NextResponse.json(
    { asset: patched },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("all") === "1") {
    clearHistoryRecords();
    log.info("history cleared");
    return new NextResponse(null, { status: 204 });
  }
  const ids = (params.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    return NextResponse.json({ error: "Missing ids.", retryable: false }, { status: 400 });
  }
  const removed = removeRecords(ids);
  log.debug("records removed", { count: removed });
  return NextResponse.json(
    { removed },
    { headers: { "cache-control": "no-store" } },
  );
}
