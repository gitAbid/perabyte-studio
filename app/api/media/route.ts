import { NextResponse } from "next/server";
import {
  contentTypeForRef,
  getMediaRepository,
  isValidMediaRef,
} from "@/lib/repositories/media.repository";
import { logger } from "@/lib/logging/logger";
import { isAllowedMediaUrl } from "@/lib/renderer";
import { isPlausibleMp4 } from "@/lib/media/mp4";

export const runtime = "nodejs";

const log = logger.child({ route: "api/media" });

function safeFilename(name: string | null, fallback: string) {
  const cleaned = (name ?? "")
    .replace(/[^\w\-. ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return cleaned || fallback;
}

const ATTEMPTS = [
  { delayMs: 0, timeoutMs: 45_000 },
  // A 429 from the provider usually clears within a couple of seconds.
  { delayMs: 2000, timeoutMs: 12_000 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serves media from our own origin.
 *
 * - `?f=<ref>` — a content-addressed file from the media cache (generated
 *   images/videos persisted server-side). Immutable once written.
 * - `?u=<url>` — pass-through proxy for deterministic provider URLs
 *   (Pollinations). Same-origin avoids Chrome's opaque response blocking and
 *   makes the `download` attribute work; provider 429s are retried with
 *   backoff before giving up.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const ref = searchParams.get("f");
  if (ref) {
    if (!isValidMediaRef(ref)) {
      return NextResponse.json(
        { error: "That media reference is not allowed.", retryable: false },
        { status: 400 },
      );
    }
    const stored = await getMediaRepository().get(ref);
    if (!stored) {
      // Ephemeral serverless disks lose the cache; the browser can retry.
      log.warn("media cache miss", { ref: ref.slice(0, 12) });
      return NextResponse.json(
        { error: "That render is no longer cached. Regenerate it.", retryable: false },
        { status: 404 },
      );
    }
    if (ref.endsWith(".mp4") && !isPlausibleMp4(stored.bytes)) {
      // A cached placeholder mp4 (provider answered "done" before its storage
      // did) would only ever render as a silent black player.
      log.warn("media cache hit is not a playable video", { ref: ref.slice(0, 12) });
      return NextResponse.json(
        { error: "That render is damaged. Regenerate it.", retryable: false },
        { status: 404 },
      );
    }

    const contentType = contentTypeForRef(ref);
    const ext = ref.split(".").pop() ?? "jpg";
    const headers = new Headers({
      "content-type": contentType,
      "content-length": String(stored.bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
    });
    if (searchParams.get("download") === "1") {
      headers.set(
        "content-disposition",
        `attachment; filename="${safeFilename(searchParams.get("filename"), `perabyte-${Date.now()}`)}.${ext}"`,
      );
    }
    return new NextResponse(new Uint8Array(stored.bytes), { status: 200, headers });
  }

  const target = searchParams.get("u");
  if (!target || !isAllowedMediaUrl(target)) {
    return NextResponse.json(
      { error: "That media URL is not allowed.", retryable: false },
      { status: 400 },
    );
  }

  const download = searchParams.get("download") === "1";
  let lastStatus = 502;

  for (const attempt of ATTEMPTS) {
    if (attempt.delayMs) await sleep(attempt.delayMs);

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        headers: { accept: "image/*" },
        cache: "no-store",
        signal: AbortSignal.timeout(attempt.timeoutMs),
      });
    } catch {
      lastStatus = 504;
      continue;
    }

    if (!upstream.ok || !upstream.body) {
      lastStatus = upstream.status === 429 ? 429 : 502;
      continue;
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      // A rate-limit or error page came back instead of a render.
      lastStatus = 429;
      continue;
    }

    const ext = contentType.includes("png") ? "png" : "jpg";
    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    });

    if (download) {
      headers.set(
        "content-disposition",
        `attachment; filename="${safeFilename(searchParams.get("filename"), `perabyte-${Date.now()}`)}.${ext}"`,
      );
    }

    return new NextResponse(upstream.body, { status: 200, headers });
  }

  return NextResponse.json(
    {
      error:
        lastStatus === 429
          ? "The render provider is rate limiting us. Please retry in a moment."
          : "That render could not be fetched. Please retry.",
      retryable: true,
    },
    { status: lastStatus },
  );
}
