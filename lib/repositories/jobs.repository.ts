import * as fs from "node:fs";
import * as path from "node:path";
import type { GeneratedMedia } from "@/lib/types";
import type { ProviderProgress } from "@/lib/providers/types";

/**
 * Durable render jobs (`.studio/jobs.json`) — the Phase B replacement for
 * the detached-renders registry. A job IS the render: the provider ref is
 * persisted at submit time, so a restarted server re-attaches from the
 * record instead of orphaning the work. Same thin fs-backed pattern as the
 * other repositories: in-memory cache, sanitize on load, sync writes.
 */

/** The serialized generation request a job carries (frame REFS, not bytes —
 * the executor re-loads bytes through the media cache at submit). */
export type SerializedGenerationRequest = Record<string, unknown>;

export interface JobRecord {
  id: string;
  provider: string;
  kind: "image" | "video";
  modelId: string;
  request: SerializedGenerationRequest;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  /** Provider-side job reference — Sogni project id, relay request ids. */
  providerRef?: string;
  /** Latest provider tick (throttled persistence). */
  progress?: ProviderProgress;
  /** Set when completed: media served from our own origin. */
  result?: GeneratedMedia[];
  error?: string;
  retryable?: boolean;
  /** Model actually used when the service swapped for frame capability. */
  effectiveModelId?: string;
  effectiveModelLabel?: string;
  frameUsed?: boolean;
  /** `s_<storyId>:<sceneId>` for story scenes; absent for solo renders. */
  clientTag?: string;
  /** Set on solo completion: the server-created History asset id. */
  assetId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const STATUSES = ["queued", "running", "completed", "failed", "canceled"];

function parseJob(raw: unknown): JobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.provider !== "string" || !r.provider) return null;
  if (r.kind !== "image" && r.kind !== "video") return null;
  if (typeof r.modelId !== "string" || !r.modelId) return null;
  if (!r.request || typeof r.request !== "object") return null;
  if (!STATUSES.includes(String(r.status))) return null;
  if (typeof r.createdAt !== "number") return null;
  return r as unknown as JobRecord;
}

let overridePath: string | null = null;
let cache: JobRecord[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "jobs.json");
}

function load(): JobRecord[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = [];
    } else {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8"),
      );
      cache = Array.isArray(parsed)
        ? parsed.map(parseJob).filter((j): j is JobRecord => j !== null)
        : [];
    }
  } catch {
    cache = [];
  }
  return cache;
}

function persist(rows: JobRecord[]): void {
  cache = rows;
  const target = resolvePath();
  const dir = path.dirname(target);
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(/*turbopackIgnore: true*/ target, JSON.stringify(rows, null, 2), "utf-8");
  } catch (error) {
    console.error("[jobs-repository] persist failed", error);
  }
}

export function listJobsRepository(): JobRecord[] {
  return load();
}

export function listActiveJobsRepository(): JobRecord[] {
  return load()
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Every non-terminal job — the boot-recovery input. */
export function listRecoverableJobsRepository(): JobRecord[] {
  return load().filter((j) => j.status === "queued" || j.status === "running");
}

export function getJobsRepository(id: string): JobRecord | undefined {
  return load().find((j) => j.id === id);
}

export function putJobRepository(job: JobRecord): JobRecord {
  persist([job, ...load().filter((j) => j.id !== job.id)]);
  return job;
}

export function patchJobRepository(id: string, patch: Partial<JobRecord>): JobRecord | null {
  let patched: JobRecord | null = null;
  persist(
    load().map((j) => {
      if (j.id !== id) return j;
      patched = { ...j, ...patch };
      return patched;
    }),
  );
  return patched;
}

export function removeJobsRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  const kept = rows.filter((j) => !doomed.has(j.id));
  persist(kept);
  return rows.length - kept.length;
}

export function setJobsPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
