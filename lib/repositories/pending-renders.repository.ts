import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Registry of renders that outlived their HTTP request. When our render
 * timeout hits, the provider often keeps rendering (Sogni projects and
 * apikey.fan jobs continue server-side and results stay downloadable for
 * ~24 h). Abandoned work is recorded here as `detached`; the detached
 * continuations flip records to `recovered` (media cached on our origin) or
 * `failed` once they settle. The studio UI polls and absorbs them.
 *
 * Persisted so the list survives dev-server reloads, mirroring
 * provider-config.repository's thin JSON-file style.
 */

export interface PendingRender {
  id: string;
  provider: string;
  kind: "image" | "video";
  modelId: string;
  prompt: string;
  /**
   * Opaque client association — `s_<story>:<sceneId>` for story scenes;
   * absent for solo renders (recovery lands in History instead).
   */
  clientTag?: string;
  status: "detached" | "recovered" | "failed";
  /** Set when recovered: a media URL served from our own origin. */
  media?: { url: string; mime: string };
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** Records older than this are pruned — providers keep results ~24 h. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 100;

let overridePath: string | null = null;
let cache: PendingRender[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(process.cwd(), ".studio", "pending-renders.json");
}

function sanitize(value: unknown): PendingRender[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((raw): raw is PendingRender => {
      if (typeof raw !== "object" || raw === null) return false;
      const r = raw as Record<string, unknown>;
      return (
        typeof r.id === "string" &&
        typeof r.provider === "string" &&
        (r.kind === "image" || r.kind === "video") &&
        typeof r.prompt === "string" &&
        (r.status === "detached" || r.status === "recovered" || r.status === "failed")
      );
    })
    .map((r) => ({
      ...r,
      clientTag: typeof r.clientTag === "string" && r.clientTag ? r.clientTag : undefined,
      note: typeof r.note === "string" ? r.note : undefined,
      media:
        r.media && typeof r.media === "object" && typeof (r.media as PendingRender["media"])?.url === "string"
          ? (r.media as PendingRender["media"])
          : undefined,
    }));
}

function read(): PendingRender[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = sanitize(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
      return cache;
    }
  } catch {
    // Corrupt file → start clean; renders are best-effort salvage.
  }
  cache = [];
  return cache;
}

function write(records: PendingRender[]): void {
  const target = resolvePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cutoff = Date.now() - RETENTION_MS;
  cache = records
    .filter((r) => r.updatedAt > cutoff)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_RECORDS);
  fs.writeFileSync(target, JSON.stringify(cache, null, 2), "utf-8");
}

export function listPendingRenders(): PendingRender[] {
  return read();
}

export function addPendingRender(
  entry: Omit<PendingRender, "id" | "status" | "createdAt" | "updatedAt"> &
    Partial<Pick<PendingRender, "status">>,
): PendingRender {
  const now = Date.now();
  const record: PendingRender = {
    ...entry,
    id: `pr_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: entry.status ?? "detached",
    createdAt: now,
    updatedAt: now,
  };
  write([...read(), record]);
  return record;
}

export function updatePendingRender(
  id: string,
  patch: Partial<Pick<PendingRender, "status" | "media" | "note">>,
): PendingRender | undefined {
  const records = read();
  const existing = records.find((r) => r.id === id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  write(records.map((r) => (r.id === id ? next : r)));
  return next;
}

export function removePendingRender(id: string): void {
  write(read().filter((r) => r.id !== id));
}

/** Test hooks. */
export function resetPendingRendersForTests(): void {
  cache = null;
}

export function setPendingRendersPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
