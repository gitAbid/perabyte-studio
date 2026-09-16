import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { parseAssetRow } from "@/lib/repositories/asset-row";
import { listStoriesRepository, putStoryRepository } from "@/lib/repositories/stories.repository";
import { getRecord, patchRecord, removeRecords } from "@/lib/services/records.service";
import type { Asset } from "@/lib/types";

export const runtime = "nodejs";

const log = logger.child({ route: "api/stories" });

/**
 * Story projects (durable-jobs spec Phase A). Story rows carry their scenes
 * and run state; the editor becomes addressable via /story?id=<id> reading
 * from here.
 *
 * GET    ?id= — one story with scenes, or the full story list.
 * POST       — upsert one story row.
 * PATCH  ?id= — scene edits, reorder, run-state flags.
 * DELETE ?id= — remove the story (and its History row, if any).
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (id) {
    const story = getRecord(id);
    if (!story || story.kind !== "story") {
      return NextResponse.json(
        { error: "Story not found.", retryable: false },
        { status: 404 },
      );
    }
    return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    { stories: listStoriesRepository() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const story = parseAssetRow(body);
  if (!story || story.kind !== "story") {
    return NextResponse.json(
      { error: "That story record is not valid.", retryable: false },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { story: putStoryRepository(story) },
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
  const patched = patchRecord(id, patch as Partial<Asset>);
  if (!patched || patched.kind !== "story") {
    return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
  }
  return NextResponse.json({ story: patched }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id.", retryable: false }, { status: 400 });
  }
  const story = getRecord(id);
  if (!story || story.kind !== "story") {
    return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
  }
  removeRecords([id]);
  log.info("story removed", { id });
  return new NextResponse(null, { status: 204 });
}
