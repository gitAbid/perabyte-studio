/**
 * Workspaces feature — client data access over the real REST APIs.
 *
 * Speaks HTTP only (GET/POST/PATCH), exactly like the accepted production UI:
 * reads via GET /api/workspaces[/:id] and GET /api/production/projects[/:id],
 * mutates via POST /api/workspaces and PATCH /api/workspaces/:id with
 * expectedSaveVersion optimistic concurrency (409 STALE_REVISION on conflict).
 *
 * Canon entity options (for cast/environment membership pickers) reuse the
 * existing production read APIs read-only: GET /api/production/projects lists
 * project summaries, and each project read model carries that project's active
 * canon revisions. Entities are deduped by entityId keeping the highest
 * revision number. There is no global canon-list endpoint in Wave 0, so this
 * walk is the honest read-only surface available.
 *
 * Fail-closed rules honored throughout: a failed save renders the server error
 * envelope (code + message + requestId) and keeps every editor value; a save is
 * never reported successful without a parsed server workspace.
 */

import { z } from "zod";
import {
  ProjectListResponseSchema,
  ProjectReadModelSchema,
  WorkspaceListResponseSchema,
  WorkspaceSchema,
  type CanonEntityKind,
  type Workspace,
} from "@/lib/production/contracts";

/* ------------------------------------------------------------------ */
/* Error envelope view                                                 */
/* ------------------------------------------------------------------ */

/** Normalized view of a failed request (server envelope or honest stand-in). */
export type RequestFailure = {
  code: string;
  message: string;
  requestId: string;
  action: string | null;
  retryable: boolean;
  status: number | null;
  shape: "envelope" | "network" | "unparseable";
};

/** True when the failure is the save-conflict case (spec: "someone else changed it"). */
export function isStaleRevisionFailure(failure: RequestFailure): boolean {
  return failure.status === 409 && failure.code === "STALE_REVISION";
}

/** Pure mapping of a failed request/response to what the UI may truthfully display. */
export function deriveRequestFailure(
  status: number | null,
  payload: unknown,
  networkFailed: boolean,
): RequestFailure {
  if (networkFailed) {
    return {
      code: "NETWORK_ERROR",
      message: "The studio service could not be reached.",
      requestId: "unavailable",
      action: "Retry once the server responds.",
      retryable: true,
      status: null,
      shape: "network",
    };
  }
  const body = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const error = body && body.error !== null && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
  const requestId = typeof body?.requestId === "string" && body.requestId.length > 0 ? body.requestId : "unavailable";
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : null;
  if (code && message) {
    return {
      code,
      message,
      requestId,
      action: typeof error?.action === "string" && error.action.length > 0 ? error.action : null,
      retryable: error?.retryable === true,
      status,
      shape: "envelope",
    };
  }
  return {
    code: "UNKNOWN_RESPONSE",
    message: `The server answered ${status ?? "without a status"} with a response this page does not understand.`,
    requestId,
    action: "Retry; if it repeats, inspect the server logs.",
    retryable: true,
    status,
    shape: "unparseable",
  };
}

/** One-line deterministic rendering of a failure for alerts. */
export function formatFailure(failure: RequestFailure): string {
  const parts = [`${failure.code} — ${failure.message}`];
  if (failure.action) parts.push(`What to do: ${failure.action}`);
  parts.push(`Request ID: ${failure.requestId}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

type RawResult = { networkFailed: true } | { networkFailed: false; status: number; payload: unknown };

async function requestJson(path: string, init?: RequestInit): Promise<RawResult> {
  try {
    const response = await fetch(path, { ...init, cache: "no-store" });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { networkFailed: false, status: response.status, payload };
  } catch {
    return { networkFailed: true };
  }
}

/** GET helper: parse `schema` on success, otherwise return a failure view. */
async function loadParsed<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; failure: RequestFailure }> {
  const raw = await requestJson(path);
  if (raw.networkFailed) return { ok: false, failure: deriveRequestFailure(null, null, true) };
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, failure: deriveRequestFailure(raw.status, raw.payload, false) };
  }
  const parsed = schema.safeParse(raw.payload);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: "UNKNOWN_RESPONSE",
        message: "The response did not match the shared contract; refusing to render it.",
        requestId: "unavailable",
        action: "Reload; if it repeats, inspect the server logs.",
        retryable: true,
        status: raw.status,
        shape: "unparseable",
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** POST/PATCH helper with the JSON content type; never throws for HTTP errors. */
async function mutateJson(path: string, method: "POST" | "PATCH", body: unknown): Promise<RawResult> {
  return requestJson(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Workspace reads/writes                                              */
/* ------------------------------------------------------------------ */

export async function loadWorkspaces(): Promise<{ ok: true; workspaces: Workspace[] } | { ok: false; failure: RequestFailure }> {
  const result = await loadParsed("/api/workspaces", WorkspaceListResponseSchema);
  return result.ok ? { ok: true, workspaces: result.value.workspaces } : result;
}

export async function loadWorkspace(id: string): Promise<{ ok: true; workspace: Workspace } | { ok: false; failure: RequestFailure }> {
  const result = await loadParsed(`/api/workspaces/${encodeURIComponent(id)}`, WorkspaceSchema);
  return result.ok ? { ok: true, workspace: result.value } : result;
}

export async function createWorkspace(
  command: unknown,
): Promise<{ ok: true; workspace: Workspace } | { ok: false; failure: RequestFailure }> {
  const raw = await mutateJson("/api/workspaces", "POST", command);
  if (raw.networkFailed) return { ok: false, failure: deriveRequestFailure(null, null, true) };
  if (raw.status !== 201) return { ok: false, failure: deriveRequestFailure(raw.status, raw.payload, false) };
  const parsed = WorkspaceSchema.safeParse(raw.payload);
  if (!parsed.success) return { ok: false, failure: deriveRequestFailure(raw.status, null, false) };
  return { ok: true, workspace: parsed.data };
}

export async function patchWorkspace(
  id: string,
  command: unknown,
): Promise<{ ok: true; workspace: Workspace } | { ok: false; failure: RequestFailure }> {
  const raw = await mutateJson(`/api/workspaces/${encodeURIComponent(id)}`, "PATCH", command);
  if (raw.networkFailed) return { ok: false, failure: deriveRequestFailure(null, null, true) };
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, failure: deriveRequestFailure(raw.status, raw.payload, false) };
  }
  const parsed = WorkspaceSchema.safeParse(raw.payload);
  if (!parsed.success) return { ok: false, failure: deriveRequestFailure(raw.status, null, false) };
  return { ok: true, workspace: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Canon entity options (read-only reuse of the production APIs)        */
/* ------------------------------------------------------------------ */

/** One selectable canon entity, resolved to its latest known revision. */
export type CanonEntityOption = {
  entityId: string;
  /** Contract vocabulary; "location" legacy rows present as "environment". */
  entityKind: "character" | "environment" | "prop" | "style";
  description: string;
  revisionId: string;
  revision: number;
};

const MAX_CANON_PROJECT_PAGES = 5;

/**
 * Contract vocabulary normalization (CONTRACTS-FROZEN C1): the UI never shows
 * the word "location" — legacy rows surface as "environment".
 */
function canonOptionKind(entityKind: CanonEntityKind): CanonEntityOption["entityKind"] {
  return entityKind === "location" ? "environment" : entityKind;
}

/** Minimal production summary the workspace page shows (productions in this workspace). */
export type WorkspaceProductionSummary = {
  id: string;
  name: string;
  updatedAt: number;
  workspaceId: string | null;
  stage: string;
};

/**
 * Collect every canon entity AND production reachable through the read-only
 * production APIs: walk the project list (bounded), read each project read
 * model, keep the highest-revision canon row per entityId and the project's
 * workspace link. Partial failures degrade gracefully — `incomplete` tells the
 * caller the lists may be missing entries.
 */
export async function loadCanonContext(): Promise<
  | { ok: true; options: CanonEntityOption[]; projects: WorkspaceProductionSummary[]; incomplete: boolean }
  | { ok: false; failure: RequestFailure }
> {
  const byEntity = new Map<string, CanonEntityOption>();
  const projects: WorkspaceProductionSummary[] = [];
  let cursor: string | null = null;
  let incomplete = false;
  const projectIds: string[] = [];

  for (let page = 0; page < MAX_CANON_PROJECT_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "24" });
    if (cursor) params.set("cursor", cursor);
    const list = await loadParsed(`/api/production/projects?${params.toString()}`, ProjectListResponseSchema);
    if (!list.ok) return { ok: false, failure: list.failure };
    for (const project of list.value.projects) projectIds.push(project.id);
    cursor = list.value.nextCursor;
    if (!cursor) break;
  }

  const readModels = await Promise.all(
    projectIds.map(async (projectId) => {
      const result = await loadParsed(`/api/production/projects/${encodeURIComponent(projectId)}`, ProjectReadModelSchema);
      if (!result.ok) {
        incomplete = true;
        return null;
      }
      return result.value;
    }),
  );

  for (const readModel of readModels) {
    if (!readModel) continue;
    for (const revision of readModel.canonRevisions) {
      const existing = byEntity.get(revision.entityId);
      if (!existing || revision.revision > existing.revision) {
        byEntity.set(revision.entityId, {
          entityId: revision.entityId,
          entityKind: canonOptionKind(revision.entityKind),
          description: revision.description,
          revisionId: revision.id,
          revision: revision.revision,
        });
      }
    }
    const project = readModel.project;
    projects.push({
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      workspaceId: project.workspaceId ?? null,
      stage: project.activeAudioMixRevisionId
        ? "audio"
        : project.activeShotPlanRevisionId
          ? "shots"
          : project.activeStoryRevisionId
            ? "script"
            : readModel.canonRevisions.length > 0
              ? "canon"
              : "setup",
    });
  }

  const options = [...byEntity.values()].sort(
    (left, right) => left.description.localeCompare(right.description) || left.entityId.localeCompare(right.entityId),
  );
  projects.sort((left, right) => right.updatedAt - left.updatedAt);
  return { ok: true, options, projects, incomplete };
}

/* ------------------------------------------------------------------ */
/* Display constants (mirrors of the shared contract vocabulary)        */
/* ------------------------------------------------------------------ */

export const WORKSPACE_RATINGS = ["General", "Mature", "Adult"] as const;
export const QUALITY_STRATEGIES = ["economy", "balanced", "best"] as const;
export const ASPECT_RATIOS = ["16:9", "9:16"] as const;

export const RATING_DESCRIPTIONS: Record<Workspace["rating"], string> = {
  General: "Safe for general audiences",
  Mature: "May include mature themes",
  Adult: "Intended for adults only — export-only publishing",
};

export const QUALITY_STRATEGY_LABELS: Record<Workspace["productionRecipe"]["qualityStrategy"], string> = {
  economy: "Economy — fastest and lightest",
  balanced: "Balanced — the default",
  best: "Best — most detail, slower",
};

export const ASPECT_RATIO_LABELS: Record<Workspace["productionRecipe"]["aspectRatio"], string> = {
  "16:9": "16:9 — widescreen",
  "9:16": "9:16 — vertical / short-form",
};

/** Shared limits from the workspace contract, for client-side validation hints. */
export const WORKSPACE_NAME_MAX = 160;
export const LANGUAGE_MIN = 2;
export const LANGUAGE_MAX = 35;
export const WORLD_BIBLE_SUMMARY_MAX = 20_000;
export const WORLD_BIBLE_TITLE_MAX = 200;
export const WORLD_BIBLE_BODY_MAX = 20_000;
export const WORLD_BIBLE_TAGS_MAX = 20;
export const WORLD_BIBLE_ENTRIES_MAX = 500;
