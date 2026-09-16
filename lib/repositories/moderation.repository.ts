import * as fs from "node:fs";
import * as path from "node:path";
import { isModerationVerdict, type ModerationVerdict } from "@/lib/domain/moderation";

/**
 * Verdict store (`.studio/moderation.json`) — media-cache ref → vision
 * verdict. The ref is the sha256 of the media bytes, so the key is content
 * addressing: one classification per unique image, ever. assets.repository
 * style: in-memory cache, sanitize on load, sync writes, pure storage.
 */

type ModerationRows = Record<string, ModerationVerdict>;

let overridePath: string | null = null;
let cache: ModerationRows | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    ".studio",
    "moderation.json",
  );
}

function load(): ModerationRows {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = {};
    } else {
      const raw = JSON.parse(
        fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8"),
      ) as Record<string, unknown>;
      cache = {};
      for (const [ref, value] of Object.entries(raw)) {
        if (isModerationVerdict(value)) cache[ref] = value;
      }
    }
  } catch {
    cache = {}; // unreadable/corrupt file beats a crashed server
  }
  return cache;
}

function persist(rows: ModerationRows): void {
  cache = rows;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ path.dirname(target))) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    fs.writeFileSync(
      /*turbopackIgnore: true*/ target,
      JSON.stringify(rows, null, 2),
      "utf-8",
    );
  } catch (error) {
    // A full disk must not crash the API route — memory stays authoritative
    // for this process and the next successful write re-syncs the file.
    console.error("[moderation-repository] persist failed", error);
  }
}

export function getModerationRepository(ref: string): ModerationVerdict | undefined {
  return load()[ref];
}

export function putModerationRepository(ref: string, verdict: ModerationVerdict): void {
  persist({ ...load(), [ref]: verdict });
}

export function clearModerationRepository(): void {
  persist({});
}

/** Test hook: point the store at a scratch file. */
export function setModerationPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
