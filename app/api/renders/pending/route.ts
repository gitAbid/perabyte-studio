import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  listPendingRenders,
  removePendingRender,
} from "@/lib/repositories/pending-renders.repository";

export const runtime = "nodejs";

const log = logger.child({ route: "api/renders/pending" });

/**
 * Detached renders: jobs that outlived their request and kept rendering on
 * the provider. GET lists them (the studio UI polls and absorbs `recovered`
 * entries); DELETE ?id= removes one after it has been attached.
 */
export async function GET() {
  return NextResponse.json(
    { renders: listPendingRenders() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  removePendingRender(id);
  log.debug("pending render removed", { id });
  return new NextResponse(null, { status: 204 });
}
