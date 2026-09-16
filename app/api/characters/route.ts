import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  listCharacters,
  patchCharacter,
  putCharacter,
  removeCharacters,
} from "@/lib/services/characters.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/characters" });

/**
 * Server-side saved characters.
 *
 * GET    — all rows, most recently updated first.
 * POST   — upsert one row (full character payload).
 * PATCH  — merge a patch onto one row (?id=).
 * DELETE — ?ids=a,b to remove.
 */
export async function GET() {
  return NextResponse.json(
    { characters: listCharacters() },
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
  const character = putCharacter(body);
  if (!character) {
    return NextResponse.json(
      { error: "That character record is not valid.", retryable: false },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { character },
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
  // The patch body is untrusted Partial<CharacterRow>; the row parser
  // re-validates everything on merge, so a malformed write is rejected
  // instead of poisoning the store.
  const patched = patchCharacter(id, patch);
  if (!patched) {
    return NextResponse.json(
      { error: "Character not found.", retryable: false },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { character: patched },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    return NextResponse.json({ error: "Missing ids.", retryable: false }, { status: 400 });
  }
  const removed = removeCharacters(ids);
  log.debug("characters removed", { count: removed });
  return NextResponse.json(
    { removed },
    { headers: { "cache-control": "no-store" } },
  );
}
