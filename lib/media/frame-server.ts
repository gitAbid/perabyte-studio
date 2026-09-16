import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMediaRepository } from "@/lib/repositories/media.repository";
import { logger as rootLogger, type Logger } from "@/lib/logging/logger";

/**
 * Server-side continuity-frame plumbing (Phase C): the story chain advances
 * on the server now, so end-frame derivation happens here — the provider's
 * exact export when it has one, the image itself for image scenes, and an
 * ffmpeg last-frame grab for videos. Every step degrades to null (the chain
 * continues prompt-only), matching the client runner's backfill semantics.
 */

/** Parse the bare media-cache ref out of a `/api/media?f=<ref>` URL. */
export function refFromMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}

export interface ServerFrameMedia {
  url: string;
  endFrameUrl?: string;
  mime?: string;
}

/**
 * Derive the chain end-frame ref for a completed scene's primary media.
 * Preference: the provider's exact export, the image itself for image
 * scenes, then an ffmpeg last-frame grab for videos. Null ⇒ prompt-only.
 */
export async function deriveEndFrameRefServerSide(
  media: ServerFrameMedia,
  kind: "image" | "video",
  options: { ffmpegPath?: string; logger?: Logger } = {},
): Promise<string | null> {
  const log = (options.logger ?? rootLogger).child({ module: "frame-server" });
  const exported = refFromMediaUrl(media.endFrameUrl);
  if (exported) return exported;
  if (kind === "image") return refFromMediaUrl(media.url);
  try {
    return await extractLastFrameRefServerSide(media.url, options);
  } catch (error) {
    log.warn("server-side frame extraction failed — chaining prompt-only", {
      url: media.url,
      error: (error as Error)?.message,
    });
    return null;
  }
}

/**
 * ffmpeg last-frame extraction from a cached video. Requires ffmpeg on the
 * host (raise `ffmpegPath` or set FFMPEG_PATH); without it the promise
 * rejects and callers degrade to prompt-only chaining.
 */
export async function extractLastFrameRefServerSide(
  mediaUrl: string,
  options: { ffmpegPath?: string; logger?: Logger } = {},
): Promise<string> {
  const log = (options.logger ?? rootLogger).child({ module: "frame-server" });
  const ref = refFromMediaUrl(mediaUrl);
  if (!ref) throw new Error(`not a cached media url: ${mediaUrl}`);
  const stored = await getMediaRepository().get(ref);
  if (!stored) throw new Error(`media ref not cached: ${ref}`);

  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const work = await mkdtemp(path.join(tmpdir(), "frame-server-"));
  const input = path.join(work, "input.mp4");
  const output = path.join(work, "last.jpg");
  try {
    await writeFile(input, stored.bytes);
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath,
        ["-sseof", "-0.1", "-i", input, "-frames:v", "1", "-q:v", "2", "-y", output],
        { timeout: 30_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const bytes = await readFile(output);
    const storedFrame = await getMediaRepository().put(bytes, "jpg");
    log.debug("last frame extracted server-side", { ref, frame: storedFrame.ref });
    return storedFrame.ref;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
