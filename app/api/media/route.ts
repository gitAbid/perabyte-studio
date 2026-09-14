import { NextResponse } from "next/server";
import { isAllowedMediaUrl } from "@/lib/renderer";

export const runtime = "nodejs";

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
 * Streams a render through our own origin.
 *
 * - Same-origin media avoids Chrome's opaque response blocking and makes the
 *   `download` attribute work.
 * - The render provider rate-limits hard (HTTP 429) when asked for several
 *   images at once, so we retry with backoff before giving up.
 * - Successful responses are immutable, so the CDN caches them and the
 *   provider is only ever hit once per render.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
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
