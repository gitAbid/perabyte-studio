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

/**
 * Streams a render through our own origin so the client can download
 * cross-origin media (the `download` attribute is ignored cross-origin) and
 * so the render provider is never linked directly from our pages.
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

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { accept: "image/*,video/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return NextResponse.json(
      {
        error: "The render provider did not respond. Please retry.",
        retryable: true,
      },
      { status: 504 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      {
        error: "That render could not be fetched. Please retry.",
        retryable: true,
      },
      { status: 502 },
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webm") ? "webm" : "jpg";
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