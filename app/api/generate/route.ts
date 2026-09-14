import { NextResponse, after } from "next/server";
import {
  ASPECTS,
  IMAGE_STYLES,
  PROMPT_MAX,
  RESOLUTIONS,
  VIDEO_STYLES,
} from "@/lib/constants";
import { buildMediaUrl, randomSeed } from "@/lib/renderer";
import type { GeneratedMedia, GenerationResponse } from "@/lib/types";

export const runtime = "nodejs";
/** Rendering is synchronous against the provider, so allow a long budget. */
export const maxDuration = 60;

/**
 * Ask the provider for a render before we answer the client.
 *
 * The provider renders on first request (~40s) and then serves the same URL
 * from cache in under a second. Warming here means the browser's own request —
 * which goes through /api/media — is a cache hit, so the completed render
 * appears immediately instead of after another 40s of blank skeleton.
 */
async function warm(url: string, timeoutMs = 45_000): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { accept: "image/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) return false;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return false;
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

interface Payload {
  kind?: unknown;
  prompt?: unknown;
  aspect?: unknown;
  resolution?: unknown;
  style?: unknown;
  count?: unknown;
  seed?: unknown;
  negativePrompt?: unknown;
  enhance?: unknown;
  safe?: unknown;
}

function bad(error: string, field?: string, status = 400) {
  return NextResponse.json({ error, field, retryable: false }, { status });
}

export async function POST(request: Request) {
  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return bad("We could not read that request. Please try again.");
  }

  const kind = body.kind === "video" ? "video" : "image";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    return bad("Describe what you want to create before generating.", "prompt");
  }
  if (prompt.length > PROMPT_MAX) {
    return bad(
      `Prompts are limited to ${PROMPT_MAX} characters. Shorten yours and try again.`,
      "prompt",
    );
  }

  const aspect = typeof body.aspect === "string" ? body.aspect : "16:9";
  if (!(aspect in ASPECTS)) {
    return bad("That aspect ratio is not supported.", "aspect");
  }

  const resolution = typeof body.resolution === "string" ? body.resolution : "1080p";
  if (!(resolution in RESOLUTIONS)) {
    return bad("That resolution is not supported.", "resolution");
  }

  const styleTable = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  const style = typeof body.style === "string" ? body.style : "Realistic";
  if (!(style in styleTable)) {
    return bad("That style preset is not supported.", "style");
  }

  const count =
    typeof body.count === "number" && Number.isFinite(body.count)
      ? Math.min(4, Math.max(1, Math.trunc(body.count)))
      : 1;

  const started = Date.now();
  const baseSeed =
    typeof body.seed === "string" && body.seed.trim() !== ""
      ? Number(body.seed)
      : typeof body.seed === "number"
        ? body.seed
        : randomSeed();
  const seed = Number.isFinite(baseSeed) ? Math.trunc(baseSeed) : randomSeed();

  const media: GeneratedMedia[] = Array.from({ length: count }, (_, i) => {
    const variantSeed = count === 1 ? seed : seed + i * 977;
    const url = buildMediaUrl(
      {
        kind,
        prompt,
        aspect: aspect as keyof typeof ASPECTS,
        resolution: resolution as keyof typeof RESOLUTIONS,
        style,
        enhance: body.enhance !== false,
        safe: body.safe === false ? false : body.safe === true ? true : undefined,
        negativePrompt:
          typeof body.negativePrompt === "string" ? body.negativePrompt : "",
      },
      variantSeed,
    );
    return {
      id: `m_${variantSeed.toString(36)}_${i}`,
      url,
      width: 0,
      height: 0,
      seed: variantSeed,
    };
  });

  const payload: GenerationResponse = {
    requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "completed",
    kind,
    elapsedMs: Date.now() - started,
    media,
  };

  // Warm the primary render inline so the client sees pixels, not a skeleton.
  // Extra variations are warmed after the response — the provider 429s if we
  // ask for several renders at once, so they queue one at a time.
  const [primary, ...extras] = media;
  const prewarmed = primary ? await warm(primary.url) : false;

  if (extras.length) {
    after(async () => {
      for (const extra of extras) {
        const ok = await warm(extra.url, 75_000);
        if (!ok) break;
      }
    });
  }

  return NextResponse.json(
    { ...payload, elapsedMs: Date.now() - started, prewarmed },
    { headers: { "cache-control": "no-store" } },
  );
}
