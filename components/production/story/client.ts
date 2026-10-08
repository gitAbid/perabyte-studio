import { useEffect, useState } from "react";
import { z } from "zod";
import {
  ProjectReadModelSchema,
  SceneListResponseSchema,
  SceneSchema,
  StoryRevisionSchema,
  type ProjectReadModel,
  type Scene,
} from "@/lib/production/contracts";
import {
  deriveMutationFailure,
  deriveProposalOutcome,
  parseTextEnginesPayload,
  type ErrorEnvelopeView,
  type ProposalOutcome,
  type TextEngineOptionView,
} from "@/components/production/project-canon";

/* ------------------------------------------------------------------ */
/* Story Studio HTTP helpers                                           */
/* ------------------------------------------------------------------ */
/* Speaks HTTP only, mirroring the accepted script-editor client: same- */
/* origin JSON POST, error envelopes parsed by the shared derivation,  */
/* responses validated against the frozen zod contracts before use.    */

/** Same-origin JSON POST; the browser supplies the Origin header the routes require. */
export async function postJson(path: string, body: unknown): Promise<{ networkFailed: true } | { networkFailed: false; response: Response }> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return { networkFailed: false, response };
  } catch {
    return { networkFailed: true };
  }
}

/** Response body reader for a request; never throws for HTTP error statuses. */
export async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type ReadModelResult = { ok: true; value: ProjectReadModel } | { ok: false; view: ErrorEnvelopeView };

/** GET /api/production/projects/:id — the project plus its current story revision and approvals. */
export async function fetchStoryReadModel(projectId: string): Promise<ReadModelResult> {
  try {
    const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
    const payload = await responsePayload(response);
    if (!response.ok) return { ok: false, view: deriveMutationFailure(response.status, payload, false) };
    const parsed = ProjectReadModelSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        view: {
          code: "UNKNOWN_RESPONSE",
          message: "The project read model did not match the accepted contract; refusing to render it.",
          requestId: "unavailable",
          action: "Reload; if it repeats, inspect the local server logs.",
          retryable: true,
          status: response.status,
          shape: "unparseable",
        },
      };
    }
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false, view: deriveMutationFailure(null, null, true) };
  }
}

export type ScenesResult = { ok: true; value: Scene[] } | { ok: false, view: ErrorEnvelopeView };

/** GET /api/production/scenes — scenes pinned to one story revision (or the whole project). */
export async function fetchScenes(input: { projectId: string; storyRevisionId: string | null }): Promise<ScenesResult> {
  try {
    const params = new URLSearchParams({ projectId: input.projectId });
    if (input.storyRevisionId !== null) params.set("storyRevisionId", input.storyRevisionId);
    const response = await fetch(`/api/production/scenes?${params.toString()}`, { cache: "no-store" });
    const payload = await responsePayload(response);
    if (!response.ok) return { ok: false, view: deriveMutationFailure(response.status, payload, false) };
    const parsed = SceneListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        view: {
          code: "UNKNOWN_RESPONSE",
          message: "The scene list did not match the accepted contract; refusing to render it.",
          requestId: "unavailable",
          action: "Reload; if it repeats, inspect the local server logs.",
          retryable: true,
          status: response.status,
          shape: "unparseable",
        },
      };
    }
    return { ok: true, value: parsed.data.scenes };
  } catch {
    return { ok: false, view: deriveMutationFailure(null, null, true) };
  }
}

export type SceneSaveResult =
  | { ok: true; scene: Scene; created: boolean }
  | { ok: false; view: ErrorEnvelopeView };

/** POST /api/production/scenes — upsert one scene; the response must parse as a Scene. */
export async function upsertScene(command: unknown): Promise<SceneSaveResult> {
  const call = await postJson("/api/production/scenes", command);
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    return { ok: false, view: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed) };
  }
  const parsed = SceneSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      view: {
        code: "UNKNOWN_RESPONSE",
        message: "The scene save could not be confirmed against the scene contract; no success is claimed.",
        requestId: "unavailable",
        action: "Reload the scene list to check whether the save landed.",
        retryable: true,
        status: call.response.status,
        shape: "unparseable",
      },
    };
  }
  return { ok: true, scene: parsed.data, created: call.response.status === 201 };
}

export type StoryProposalCall =
  | { state: "sent"; outcome: ProposalOutcome }
  | { state: "invalid_command"; reason: string };

/**
 * POST /api/production/projects/:id/proposals with the frozen story proposal
 * command. `scriptText` carries the idea (first draft) or the base script plus
 * the revision instruction (follow-up); `expectedStoryRevisionId` marks the
 * base revision (null for a first draft). The endpoint is fail-closed today
 * (403 BUDGET_BLOCKED) and the outcome is reported exactly as returned.
 */
export async function requestStoryProposal(input: {
  projectId: string;
  providerId: string;
  modelId: string;
  scriptText: string;
  expectedCanonRevisionIds: readonly string[];
  expectedStoryRevisionId: string | null;
}): Promise<StoryProposalCall> {
  const call = await postJson(`/api/production/projects/${encodeURIComponent(input.projectId)}/proposals`, {
    schemaVersion: 1,
    projectId: input.projectId,
    kind: "story",
    providerId: input.providerId,
    modelId: input.modelId,
    scriptText: input.scriptText,
    expectedCanonRevisionIds: [...input.expectedCanonRevisionIds],
    expectedStoryRevisionId: input.expectedStoryRevisionId,
  });
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  const status = call.networkFailed ? null : call.response.status;
  return { state: "sent", outcome: deriveProposalOutcome(status, payload, call.networkFailed) };
}

/* ------------------------------------------------------------------ */
/* Deterministic story revise (POST /api/production/projects/:id/story/revise) */
/* ------------------------------------------------------------------ */

/** Client-side shape check for the revise response; the server validated the strict contracts. */
const StoryReviseResponseSchema = z.strictObject({
  storyRevision: StoryRevisionSchema,
  changedSceneIds: z.array(z.string()),
});

export type StoryReviseOutcome =
  | { state: "applied"; revisionId: string; changedSceneIds: string[] }
  | { state: "replayed"; revisionId: string; changedSceneIds: string[] }
  | { state: "error"; envelope: ErrorEnvelopeView };

export type StoryReviseCall = { state: "sent"; outcome: StoryReviseOutcome };

/**
 * POST /api/production/projects/:id/story/revise — the deterministic revise action: the
 * instruction is applied server-side as a NEW child story revision (no AI provider call), so
 * no engine pick is needed. `baseStoryRevisionId` + `expectedBaseContentHash` pin the exact
 * base revision; a mismatch comes back as STALE_REVISION and nothing is written. 201 means a
 * new child was created; 200 means the same instruction was already applied to that revision.
 */
export async function requestStoryRevise(input: {
  projectId: string;
  baseStoryRevisionId: string;
  expectedBaseContentHash: string;
  instruction: string;
}): Promise<StoryReviseCall> {
  const call = await postJson(
    `/api/production/projects/${encodeURIComponent(input.projectId)}/story/revise`,
    {
      projectId: input.projectId,
      baseStoryRevisionId: input.baseStoryRevisionId,
      expectedBaseContentHash: input.expectedBaseContentHash,
      instruction: input.instruction,
    },
  );
  const payload = call.networkFailed ? null : await responsePayload(call.response);
  if (call.networkFailed || !call.response.ok) {
    return {
      state: "sent",
      outcome: {
        state: "error",
        envelope: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed),
      },
    };
  }
  const parsed = StoryReviseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      state: "sent",
      outcome: {
        state: "error",
        envelope: {
          code: "UNKNOWN_RESPONSE",
          message: "The revise response did not match the accepted contract; no success is claimed.",
          requestId: "unavailable",
          action: "Reload the story to see whether the revision landed.",
          retryable: true,
          status: call.response.status,
          shape: "unparseable",
        },
      },
    };
  }
  return call.response.status === 200
    ? { state: "sent", outcome: { state: "replayed", revisionId: parsed.data.storyRevision.id, changedSceneIds: parsed.data.changedSceneIds } }
    : { state: "sent", outcome: { state: "applied", revisionId: parsed.data.storyRevision.id, changedSceneIds: parsed.data.changedSceneIds } };
}

/* ------------------------------------------------------------------ */
/* Text-engine options (shared per page load)                          */
/* ------------------------------------------------------------------ */

let textEnginesCache: Promise<TextEngineOptionView[]> | null = null;

function loadTextEngineOptions(): Promise<TextEngineOptionView[]> {
  textEnginesCache ??= (async () => {
    try {
      const response = await fetch("/api/production/text-engines", { cache: "no-store" });
      if (!response.ok) throw new Error(`text engines request failed with status ${response.status}`);
      const engines = parseTextEnginesPayload(await responsePayload(response));
      if (!engines) throw new Error("text engines response did not match the expected shape");
      return engines;
    } catch {
      // Honest empty state: the selects render disabled with the Settings pointer.
      return [];
    }
  })();
  return textEnginesCache;
}

export type TextEngineCatalog = { loading: boolean; engines: TextEngineOptionView[] };

/** One fetch per page load; every story engine picker shares the same promise. */
export function useTextEngineCatalog(active: boolean): TextEngineCatalog {
  const [state, setState] = useState<TextEngineCatalog>({ loading: true, engines: [] });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    void loadTextEngineOptions().then((engines) => {
      if (!stopped) setState({ loading: false, engines });
    });
    return () => { stopped = true; };
  }, [active]);
  return state;
}

/** Fresh idempotency key for one submit attempt. */
export function freshRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Scene ID vocabulary: prefixed UUIDs keep scene identity stable across edits. */
export function freshSceneId(): string {
  return `scene-${freshRequestId()}`;
}
