"use client";

/**
 * C07-FULL-UI creator canon/script UI.
 *
 * Speaks HTTP only: reads via GET /api/production/projects[/:id], mutates via the
 * accepted production routes (POST projects / canon / canon selection / stories /
 * proposals). Every derivation comes verbatim from the accepted C07-PRE-DOMAIN
 * lib/production/project-canon.ts — no server rule is reimplemented here. The
 * exported plain functions at the top are pure view-model helpers (no hooks, no
 * window, no fetch) so tests can import them in a node environment.
 *
 * Fail-closed rules honored throughout: a failed save renders the error envelope
 * (code + message + requestId) and keeps every editor value; a save is never
 * reported successful without a parsed server revision; the I02 proposal control
 * renders the by-design 403 BUDGET_BLOCKED envelope as an explicit "not yet
 * entitled" state, never a fake success.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useId, type ReactNode } from "react";
import { type ZodError, z } from "zod";
import {
  Badge, Button, Card, EmptyState, FieldShell, LinkButton, SelectField, formatDate, formatTime,
} from "@/components/ui";
import {
  CanonEntityDraftSchema, deriveProjectCreationFlow, deriveRevisionProvenance, deriveScriptImport,
  deriveScriptSaveFacts, deriveStaleDependencyNotices, PROJECT_CREATION_STEPS, SCRIPT_TEXT_MAX_CHARS,
  type ProjectCreationStep, type ScriptSaveFacts, type ValidationIssue,
} from "@/lib/production/project-canon";
import {
  ProjectListResponseSchema, ProjectReadModelSchema, CanonEntityKindSchema,
  type Approval, type CanonRevision, type CreateApprovalCommand, type Project, type ProjectReadModel, type StoryRevision,
} from "@/lib/production/contracts";

/** Canon entity kinds, derived from the accepted contract enum. */
type CanonEntityKind = z.infer<typeof CanonEntityKindSchema>;

/* ================================================================== */
/* Pure view-model helpers (no hooks / window / fetch — test in node)  */
/* ================================================================== */

/** Normalized view of a production error envelope (or an honest network stand-in). */
export type ErrorEnvelopeView = {
  code: string;
  message: string;
  requestId: string;
  action: string | null;
  retryable: boolean;
  status: number | null;
  shape: "envelope" | "network" | "unparseable";
};

/** Pure mapping of a failed mutation to what the UI may truthfully display. */
export function deriveMutationFailure(
  status: number | null,
  payload: unknown,
  networkFailed: boolean,
): ErrorEnvelopeView {
  if (networkFailed) {
    return {
      code: "NETWORK_ERROR",
      message: "The studio service could not be reached. Nothing was saved and your work is unchanged.",
      requestId: "unavailable",
      action: "Retry the save once the local server responds.",
      retryable: true,
      status: null,
      shape: "network",
    };
  }
  const body = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const error = body && body.error !== null && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
  const requestId = typeof body?.requestId === "string" && body.requestId.length > 0 ? body.requestId : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : null;
  if (code && message && requestId) {
    return {
      code,
      message,
      requestId,
      action: typeof error?.action === "string" ? error.action : null,
      retryable: error?.retryable === true,
      status,
      shape: "envelope",
    };
  }
  return {
    code: "UNKNOWN_RESPONSE",
    message: `The server answered ${status ?? "without a status"} with a body this page does not understand; nothing was saved.`,
    requestId: requestId ?? "unavailable",
    action: "Retry; if it repeats, inspect the local server logs.",
    retryable: true,
    status,
    shape: "unparseable",
  };
}

/** One-line deterministic rendering of an error envelope for alerts. */
export function formatEnvelope(view: ErrorEnvelopeView): string {
  const parts = [`${view.code} — ${view.message}`];
  if (view.action) parts.push(`What to do: ${view.action}`);
  parts.push(`Request ID: ${view.requestId}`);
  return parts.join(" · ");
}

/** Which wizard step a derivation issue belongs to. Entity-draft zod issues carry
 * a draft-relative field, so the bucket comes from the domain's own label. */
export type IssueScope = "details" | "cast" | "world" | "script";
export function issueScope(issue: ValidationIssue): IssueScope {
  const field = issue.field ?? "";
  if (field.startsWith("cast") || issue.message.startsWith("Canon draft cast")) return "cast";
  if (field.startsWith("world") || issue.message.startsWith("Canon draft world")) return "world";
  if (field === "text" || field === "mediaType") return "script";
  if (["EMPTY_SCRIPT", "SCRIPT_TOO_LONG", "UNSUPPORTED_MEDIA_TYPE", "INVALID_SCRIPT_TEXT", "INVALID_IMPORT"].includes(issue.code)) return "script";
  return "details";
}
/** Issues visible on one wizard step, in derivation order. */
export function scopeIssues(issues: readonly ValidationIssue[], scope: IssueScope): ValidationIssue[] {
  return issues.filter((issue) => issueScope(issue) === scope);
}

/** Per-beat narration bound from StoryBeatSchema (display constant, mirrors the contract). */
export const STORY_BEAT_NARRATION_MAX_CHARS = 20_000;
/** Beats-per-story bound from StoryRevisionSchema (display constant, mirrors the contract). */
export const STORY_BEATS_MAX = 10_000;

export type ScriptBeatDraft = { id: string; action: string; narration: string; dialogue: [] };

/**
 * Deterministic story beats for a manual script save: one beat per blank-line
 * separated paragraph, chunked to the per-beat narration bound so the command
 * always satisfies StoryBeatSchema/StoryRevisionSchema bounds.
 */
export function deriveScriptBeats(scriptText: string): ScriptBeatDraft[] {
  const paragraphs = scriptText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]+$/, ""))
    .filter((paragraph) => paragraph.trim().length > 0);
  const beats: ScriptBeatDraft[] = [];
  for (const paragraph of paragraphs) {
    const firstLine = (paragraph.split("\n", 1)[0] ?? "").trim().slice(0, 200);
    for (let offset = 0; offset < paragraph.length; offset += STORY_BEAT_NARRATION_MAX_CHARS) {
      const narration = paragraph.slice(offset, offset + STORY_BEAT_NARRATION_MAX_CHARS);
      beats.push({
        id: `beat_${beats.length + 1}`,
        action: firstLine.length > 0 ? firstLine : `Beat ${beats.length + 1}`,
        narration,
        dialogue: [],
      });
    }
  }
  return beats;
}

export type ScriptSaveReadiness =
  | { ok: true; facts: ScriptSaveFacts; beats: ScriptBeatDraft[]; import: { charCount: number; byteLength: number; lineCount: number } }
  | { ok: false; issues: readonly ValidationIssue[] };

/** Combined client-side save gate: accepted save-facts derivation + beat-count bound. */
export function deriveScriptSaveReadiness(input: { activeStoryRevisionId: string | null; scriptText: string }): ScriptSaveReadiness {
  const facts = deriveScriptSaveFacts(input);
  if (!facts.ok) return { ok: false, issues: facts.issues };
  const beats = deriveScriptBeats(input.scriptText);
  const issues: ValidationIssue[] = [];
  if (beats.length < 1) issues.push({ code: "NO_BEATS", message: "The script produces no beats; write at least one nonempty paragraph.", field: "scriptText" });
  if (beats.length > STORY_BEATS_MAX) {
    issues.push({
      code: "TOO_MANY_BEATS",
      message: `The script produces ${beats.length} beats, above the ${STORY_BEATS_MAX}-beat bound; use fewer blank-line paragraphs.`,
      field: "scriptText",
    });
  }
  if (issues.length) return { ok: false, issues };
  const imported = deriveScriptImport({ text: input.scriptText, mediaType: "text/plain" });
  if (!imported.ok) return { ok: false, issues: imported.issues };
  return {
    ok: true,
    facts: facts.value,
    beats,
    import: { charCount: imported.value.charCount, byteLength: imported.value.byteLength, lineCount: imported.value.lineCount },
  };
}

/** Fail-closed outcome of the I02 proposal request. A 403 is an explicit, expected state. */
export type ProposalOutcome =
  | { state: "not_entitled"; envelope: ErrorEnvelopeView }
  | { state: "failed"; envelope: ErrorEnvelopeView }
  | { state: "network"; envelope: ErrorEnvelopeView }
  | { state: "saved"; proposalId: string }
  | { state: "invalid_success"; status: number | null };

export function deriveProposalOutcome(status: number | null, payload: unknown, networkFailed: boolean): ProposalOutcome {
  if (networkFailed) return { state: "network", envelope: deriveMutationFailure(null, null, true) };
  if (status !== null && status >= 200 && status < 300) {
    const body = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const proposalId = typeof body?.proposalId === "string" ? body.proposalId : null;
    return proposalId ? { state: "saved", proposalId } : { state: "invalid_success", status };
  }
  const envelope = deriveMutationFailure(status, payload, false);
  return status === 403 ? { state: "not_entitled", envelope } : { state: "failed", envelope };
}

/* ---------------- Text-engine dropdowns for the proposal form (C21) ---------------- */

/** One text-engine dropdown entry exactly as GET /api/production/text-engines serves it. */
export type TextEngineOptionView = { providerId: string; modelId: string; label: string };

/** Strict view of the route payload; null tells the caller the answer is unusable. */
export function parseTextEnginesPayload(payload: unknown): TextEngineOptionView[] | null {
  const parsed = z.strictObject({
    engines: z.array(
      z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1), label: z.string().min(1) }),
    ),
  }).safeParse(payload);
  return parsed.success ? parsed.data.engines : null;
}

/** Deduped provider ids in first-appearance (chain priority) order. */
export function textEngineProviderIds(engines: readonly TextEngineOptionView[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const engine of engines) {
    if (seen.has(engine.providerId)) continue;
    seen.add(engine.providerId);
    ids.push(engine.providerId);
  }
  return ids;
}

/** A provider's first listed engine (what a provider change resets the model to); null when unknown. */
export function firstTextEngineModelForProvider(
  engines: readonly TextEngineOptionView[],
  providerId: string,
): TextEngineOptionView | null {
  return engines.find((engine) => engine.providerId === providerId) ?? null;
}

/** Honest canon-save banner: the service dedupes byte-identical content and re-points
 * the pin WITHOUT creating (createCanonRevision content-hash path), so "created" is
 * derived from the response id versus the pre-save active pin — never claimed blindly. */
export type CanonSaveBanner = { created: boolean; text: string };
export function deriveCanonSaveBanner(input: { entityId: string; revisionId: string; expectedRevisionId: string | null }): CanonSaveBanner {
  const created = input.expectedRevisionId === null || input.revisionId !== input.expectedRevisionId;
  return {
    created,
    text: created
      ? `Saved — canon revision ${input.revisionId} for ${input.entityId} is now the active pin. Saving created a new immutable revision.`
      : `Saved — canon revision ${input.revisionId} for ${input.entityId} is now the active pin (content identical — no new revision needed).`,
  };
}

/** Map a zod error into the shared display issue shape (formatting only — the schema is the accepted contract). */
export function zodViewIssues(error: ZodError, code: string, label: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code,
    message: `${label}: ${issue.message}`,
    ...(issue.path.length ? { field: issue.path.map(String).join(".") } : {}),
  }));
}

/* ---------------- C19 story approval (script editor page) ---------------- */

/**
 * Exact mirror of lib/production/approval.ts APPROVAL_CHECKLISTS.story for the script editor's
 * approve action. The accepted module is server-only (it imports lib/jobs), so the UI mirrors the
 * frozen list; lib/production/plan-ui.test.ts asserts this mirror matches the accepted constant so
 * the UI preflight and the server validation cannot drift.
 */
export const STORY_APPROVAL_CHECKLIST_VIEW = [
  "protagonist_goal",
  "cause_consequence_order",
  "earned_resolution",
  "plot_fidelity",
  "spoken_lines",
] as const;

export type StoryApprovalChecklistEntry = { id: string; passed: boolean; note: string };

export type StoryApprovalState = { latest: Approval | null; approvedCurrent: boolean };

/**
 * The story revision's approval facts: the newest decision for the revision plus whether that
 * decision is a current approval — decision "approved" AND bound to the revision's exact
 * contentHash. Any other combination leaves the approve action available.
 */
export function deriveStoryApprovalState(approvals: readonly Approval[], story: StoryRevision | null): StoryApprovalState {
  if (!story) return { latest: null, approvedCurrent: false };
  const matching = approvals
    .filter((approval) => approval.targetKind === "story" && approval.targetId === story.id)
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const latest = matching[0] ?? null;
  return { latest, approvedCurrent: !!latest && latest.decision === "approved" && latest.targetHash === story.contentHash };
}

export type StoryApprovalCommandInput = {
  projectId: string;
  idempotencyKey: string;
  story: StoryRevision;
  checklist: readonly StoryApprovalChecklistEntry[];
  notes: string;
};

/**
 * The exact POST /api/production/approvals body for a story approval; exists only when every
 * required checklist item is ticked. For revision kinds the expectedHash is simply the revision's
 * contentHash (verified against the accepted pilot).
 */
export function deriveStoryApprovalCommand(input: StoryApprovalCommandInput): { projectId: string; idempotencyKey: string; command: CreateApprovalCommand } | null {
  const checklist = STORY_APPROVAL_CHECKLIST_VIEW.map((id) => {
    const entry = input.checklist.find((candidate) => candidate.id === id);
    return { id, passed: entry?.passed === true, note: entry?.note ?? "" };
  });
  if (checklist.some((item) => !item.passed)) return null;
  const command: CreateApprovalCommand = {
    targetKind: "story",
    targetId: input.story.id,
    expectedHash: input.story.contentHash,
    decision: "approved",
    checklist,
    notes: input.notes,
    advisoryAcknowledgements: [],
  };
  return { projectId: input.projectId, idempotencyKey: input.idempotencyKey, command };
}

export type OverviewApprovalBadge = {
  kind: "story" | "shotplan" | "animatic";
  label: string;
  revisionId: string | null;
  approvedCurrent: boolean;
};

/** Overview chips for the story / shot plan / animatic chain; a missing revision is reported, never fabricated. */
export function deriveOverviewApprovalBadges(readModel: ProjectReadModel): OverviewApprovalBadge[] {
  const chain = [
    { kind: "story" as const, label: "Story", revision: readModel.storyRevision },
    { kind: "shotplan" as const, label: "Shot plan", revision: readModel.shotPlanRevision },
    { kind: "animatic" as const, label: "Animatic", revision: readModel.animaticRevision },
  ];
  return chain.map(({ kind, label, revision }) => {
    if (!revision) return { kind, label, revisionId: null, approvedCurrent: false };
    const matching = readModel.revisionApprovals
      .filter((approval) => approval.targetKind === kind && approval.targetId === revision.id)
      .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const latest = matching[0] ?? null;
    return {
      kind,
      label,
      revisionId: revision.id,
      approvedCurrent: !!latest && latest.decision === "approved" && latest.targetHash === revision.contentHash,
    };
  });
}

/* ================================================================== */
/* Shared data access                                                  */
/* ================================================================== */

type MutationCall = { networkFailed: true } | { networkFailed: false; response: Response };

/** Same-origin JSON POST; the browser supplies the Origin header the routes require. */
async function postJson(path: string, body: unknown): Promise<MutationCall> {
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

/** Response body reader for a mutation; never throws for HTTP error statuses. */
async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** One fetch per page load; every proposal form on the page shares the same promise. */
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
      // Honest empty state: the proposal selects render disabled with the Settings pointer.
      return [];
    }
  })();
  return textEnginesCache;
}

/** Text-engine options for the proposal selects; fetched once when the section is shown. */
function useTextEngineOptions(active: boolean): { loading: boolean; engines: TextEngineOptionView[] } {
  const [state, setState] = useState<{ loading: boolean; engines: TextEngineOptionView[] }>({ loading: true, engines: [] });
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

async function fetchReadModelById(projectId: string): Promise<{ ok: true; value: ProjectReadModel } | { ok: false; view: ErrorEnvelopeView }> {
  try {
    const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (!response.ok) return { ok: false, view: deriveMutationFailure(response.status, await responsePayload(response), false) };
    const parsed = ProjectReadModelSchema.safeParse(await responsePayload(response));
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

type ReadModelState =
  | { phase: "loading" }
  | { phase: "error"; error: ErrorEnvelopeView }
  | { phase: "ready"; readModel: ProjectReadModel };

function useProjectReadModel(projectId: string): { state: ReadModelState; reload: () => void } {
  const [state, setState] = useState<ReadModelState>({ phase: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    let stopped = false;
    setState({ phase: "loading" });
    void fetchReadModelById(projectId).then((result) => {
      if (stopped) return;
      if (result.ok) setState({ phase: "ready", readModel: result.value });
      else setState({ phase: "error", error: result.view });
    });
    return () => { stopped = true; };
  }, [projectId, reloadToken]);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  return { state, reload };
}

/* ================================================================== */
/* Shared presentational helpers                                       */
/* ================================================================== */

function IssueList({ issues, label }: { issues: readonly ValidationIssue[]; label?: string }) {
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-danger">{label ?? "Fix before continuing"}</p>
      <ul className="mt-1.5 space-y-1">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.field ?? "nofield"}-${index}`} className="text-[13px] leading-snug text-ink">
            <span className="font-mono text-[11px] text-danger">{issue.code}</span>
            {issue.field ? <span className="font-mono text-[11px] text-muted"> · {issue.field}</span> : null}
            <span className="ml-1.5">{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ErrorAlert({ view, lead }: { view: ErrorEnvelopeView; lead?: string }) {
  return (
    <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      {lead ? <p className="text-[13px] font-bold text-ink">{lead}</p> : null}
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Your work is unchanged — nothing was lost. You can retry.</p>
    </div>
  );
}

function StatusRegion({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="status" className="rounded-[8px] border border-primary/25 bg-primary-soft/60 px-3.5 py-3">
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line} className="text-[13px] leading-snug text-ink">{line}</li>
        ))}
      </ul>
    </div>
  );
}

function MonoId({ value }: { value: string }) {
  return <span className="break-all font-mono text-[11.5px] text-muted">{value}</span>;
}

function ProvenanceCard({ kind, revision, caption }: { kind: "canon" | "story" | "shotplan" | "animatic" | "audiomix"; revision: unknown; caption?: string }) {
  const provenance = deriveRevisionProvenance({ kind, revision });
  if (!provenance.ok) {
    return (
      <li>
        <Card>
          <IssueList issues={provenance.issues} label="Revision provenance unavailable" />
        </Card>
      </li>
    );
  }
  const value = provenance.value;
  return (
    <li>
      <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">{value.kind}</Badge>
        <span className="text-sm font-semibold text-ink">{value.revisionId}</span>
        {caption ? <span className="text-[12.5px] font-semibold text-ink-soft">{caption}</span> : null}
        <span className="text-[12px] text-muted">{formatDate(value.createdAt)} {formatTime(value.createdAt)}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-[150px_minmax(0,1fr)]">
        <dt className="font-semibold text-ink-soft">Content hash</dt>
        <dd><MonoId value={value.contentHash} /></dd>
        <dt className="font-semibold text-ink-soft">Parent revision</dt>
        <dd>{value.parentRevisionId ? <MonoId value={value.parentRevisionId} /> : <span className="text-muted">none (first revision)</span>}</dd>
        <dt className="font-semibold text-ink-soft">Dependencies</dt>
        <dd>
          {value.dependencies.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {value.dependencies.map((dependency) => (
                <MonoId key={dependency} value={dependency} />
              ))}
            </span>
          )}
        </dd>
        <dt className="font-semibold text-ink-soft">Save semantics</dt>
        <dd className="text-muted">{value.saveSemantics.label}</dd>
      </dl>
      </Card>
    </li>
  );
}

/** Stale downstream work, derived verbatim from the accepted domain derivation. */
function StaleNoticesSection({ readModel }: { readModel: ProjectReadModel }) {
  const derived = useMemo(
    () => deriveStaleDependencyNotices(readModel, readModel.shots),
    [readModel],
  );
  return (
    <section aria-label="Stale downstream work" className="mt-6">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Stale downstream work</h2>
      {derived.ok ? (
        derived.value.length === 0 ? (
          <p role="status" className="mt-2 text-[13px] text-muted">
            No stale downstream work — active revisions are current.
          </p>
        ) : (
          <div role="status" className="mt-2 space-y-2">
            {derived.value.map((notice) => (
              <div key={`${notice.code}-${notice.targetKind}-${notice.targetId}-${notice.pinnedDependencyId}`} className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
                <p className="text-[13px] leading-snug text-ink">
                  <Badge tone="warning">{notice.code}</Badge>
                  <span className="ml-2">{notice.message}</span>
                </p>
              </div>
            ))}
          </div>
        )
      ) : (
        <IssueList issues={derived.issues} label="Stale notices unavailable" />
      )}
    </section>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" className="rounded-[12px] border border-border bg-raised px-6 py-14 text-center text-sm text-muted">
      {label}
    </div>
  );
}

function ReadModelLoadError({ error, onRetry, backHref }: { error: ErrorEnvelopeView; onRetry: () => void; backHref: string }) {
  return (
    <div className="space-y-4">
      <ErrorAlert view={error} lead="The project could not be loaded." />
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>Retry</Button>
        <LinkButton variant="ghost" size="sm" href={backHref}>Back to projects</LinkButton>
      </div>
    </div>
  );
}

/* ================================================================== */
/* /production — project list                                          */
/* ================================================================== */

type ProjectListPayload = z.infer<typeof ProjectListResponseSchema>;
type ProjectSummaryRow = ProjectListPayload["projects"][number];

export function ProjectListPanel() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [projects, setProjects] = useState<ProjectSummaryRow[]>([]);
  const [error, setError] = useState<ErrorEnvelopeView | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let stopped = false;
    setPhase("loading");
    (async () => {
      try {
        const response = await fetch("/api/production/projects", { cache: "no-store" });
        if (!response.ok) {
          const view = deriveMutationFailure(response.status, await responsePayload(response), false);
          if (!stopped) { setError(view); setPhase("error"); }
          return;
        }
        const parsed = ProjectListResponseSchema.safeParse(await responsePayload(response));
        if (!parsed.success) {
          const view: ErrorEnvelopeView = {
            code: "UNKNOWN_RESPONSE", message: "The project list did not match the accepted contract.",
            requestId: "unavailable", action: "Reload.", retryable: true, status: response.status, shape: "unparseable",
          };
          if (!stopped) { setError(view); setPhase("error"); }
          return;
        }
        if (!stopped) { setProjects(parsed.data.projects); setPhase("ready"); }
      } catch {
        if (!stopped) { setError(deriveMutationFailure(null, null, true)); setPhase("error"); }
      }
    })();
    return () => { stopped = true; };
  }, [reloadToken]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production</p>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Production projects</h1>
          <p className="mt-1 text-[12px] text-muted">Create a project with reusable cast and world canon, then import and revise the script.</p>
        </div>
        <LinkButton href="/production/new" size="sm" icon="plus">New project</LinkButton>
      </header>

      {phase === "loading" ? <div className="mt-6"><LoadingPanel label="Loading projects…" /></div> : null}
      {phase === "error" && error ? (
        <div className="mt-6 space-y-4">
          <ErrorAlert view={error} lead="The project list could not be loaded." />
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => setReloadToken((token) => token + 1)}>Retry</Button>
        </div>
      ) : null}
      {phase === "ready" && projects.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="story"
            title="No production projects yet"
            body="Create your first project: give it details, pin reusable cast and world canon, and save the first script revision."
            action={<LinkButton href="/production/new" icon="plus">New project</LinkButton>}
          />
        </div>
      ) : null}
      {phase === "ready" && projects.length > 0 ? (
        <ul className="mt-5 space-y-2.5">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/production/${project.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-raised px-4 py-3 transition-colors hover:border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{project.name}</span>
                  <MonoId value={project.id} />
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={project.stage === "setup" ? "neutral" : "primary"}>{project.stage}</Badge>
                  <span className="text-[12px] tabular-nums text-muted">{formatDate(project.updatedAt)} {formatTime(project.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* /production/new — creation flow (details -> cast -> world -> script) */
/* ================================================================== */

type CanonEntityKindValue = CanonEntityKind;

type EntityDraftForm = {
  key: string;
  entityId: string;
  entityKind: CanonEntityKindValue;
  description: string;
  assetIdsText: string;
  attributesText: string;
};

const STEP_LABELS: Record<ProjectCreationStep, string> = { details: "Details", cast: "Cast", world: "World", script: "Script" };
const PROFILE_OPTIONS = [
  { id: "storybook-short-v1", label: "Storybook short · 9:16" },
  { id: "storybook-long-v1", label: "Storybook long · 16:9" },
] as const;

let entityFormKeyCounter = 0;
function nextEntityFormKey(): string {
  entityFormKeyCounter += 1;
  return `entity-${entityFormKeyCounter}`;
}
function emptyEntityForm(entityKind: CanonEntityKindValue): EntityDraftForm {
  return { key: nextEntityFormKey(), entityId: "", entityKind, description: "", assetIdsText: "", attributesText: "" };
}
function formIsBlank(form: EntityDraftForm): boolean {
  return form.entityId.trim() === "" && form.description.trim() === "" && form.assetIdsText.trim() === "" && form.attributesText.trim() === "";
}
/** Form row -> creation-flow draft entry; blank rows drop out, unparsable attributes fail the draft closed. */
function formToFlowEntry(form: EntityDraftForm): unknown {
  const assetIds = form.assetIdsText.trim() === "" ? [] : form.assetIdsText.split(/[\s,]+/).filter(Boolean);
  let attributes: unknown = {};
  if (form.attributesText.trim() !== "") {
    try { attributes = JSON.parse(form.attributesText); } catch { attributes = form.attributesText; }
  }
  return { entityId: form.entityId.trim(), entityKind: form.entityKind, description: form.description, attributes, assetIds };
}

function EntityDraftEditor({
  legend, forms, onChange, allowedKinds,
}: {
  legend: string;
  forms: EntityDraftForm[];
  onChange: (next: EntityDraftForm[]) => void;
  allowedKinds: readonly CanonEntityKindValue[];
}) {
  function patch(key: string, changes: Partial<EntityDraftForm>) {
    onChange(forms.map((form) => (form.key === key ? { ...form, ...changes } : form)));
  }
  return (
    <fieldset className="space-y-4">
      <legend className="text-[13px] font-semibold text-ink-soft">{legend}</legend>
      {forms.map((form, index) => (
        <div key={form.key} className="space-y-3 rounded-[10px] border border-border bg-surface p-4">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">{legend} {index + 1}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldShell label="Entity ID" htmlFor={`${form.key}-entity-id`} hint="Stable ID for this entity, e.g. char_ayo or loc_rooftop.">
              <input
                id={`${form.key}-entity-id`}
                value={form.entityId}
                onChange={(event) => patch(form.key, { entityId: event.target.value })}
                className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
              />
            </FieldShell>
            <SelectField
              label="Entity kind"
              value={form.entityKind}
              onChange={(event) => patch(form.key, { entityKind: event.target.value as CanonEntityKindValue })}
            >
              {allowedKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </SelectField>
          </div>
          <FieldShell label="Description" htmlFor={`${form.key}-description`} hint="What stays true about this entity across every revision.">
            <textarea
              id={`${form.key}-description`}
              rows={2}
              value={form.description}
              onChange={(event) => patch(form.key, { description: event.target.value })}
              className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldShell label="Reference asset IDs" htmlFor={`${form.key}-assets`} hint="Optional — comma-separated existing asset IDs; leave empty for none.">
              <input
                id={`${form.key}-assets`}
                value={form.assetIdsText}
                onChange={(event) => patch(form.key, { assetIdsText: event.target.value })}
                className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
              />
            </FieldShell>
            <FieldShell label="Attributes JSON" htmlFor={`${form.key}-attributes`} hint='Optional JSON object, e.g. {"age":"34"}.'>
              <input
                id={`${form.key}-attributes`}
                value={form.attributesText}
                onChange={(event) => patch(form.key, { attributesText: event.target.value })}
                className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 font-mono text-[12.5px] text-ink focus:border-primary focus:outline-none"
              />
            </FieldShell>
          </div>
          {forms.length > 1 ? (
            <Button
              variant="ghost" size="sm" icon="trash"
              onClick={() => onChange(forms.filter((entry) => entry.key !== form.key))}
            >
              Remove this {legend.toLowerCase()} draft
            </Button>
          ) : null}
        </div>
      ))}
      <Button
        variant="secondary" size="sm" icon="plus"
        onClick={() => onChange([...forms, emptyEntityForm(allowedKinds[0])])}
      >
        Add another {legend.toLowerCase()} draft
      </Button>
    </fieldset>
  );
}

export function ProjectCreationFlow() {
  const [step, setStep] = useState<ProjectCreationStep>("details");
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState<string>(PROFILE_OPTIONS[0].id);
  const [cast, setCast] = useState<EntityDraftForm[]>(() => [emptyEntityForm("character")]);
  const [world, setWorld] = useState<EntityDraftForm[]>(() => [emptyEntityForm("location")]);
  const [scriptText, setScriptText] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [savedEntityIds, setSavedEntityIds] = useState<string[]>([]);
  const [canonTotal, setCanonTotal] = useState(0);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [creationError, setCreationError] = useState<{ where: "project" | "canon" | "canon-state" | "script"; entityId: string | null; error: ErrorEnvelopeView } | null>(null);

  const flow = useMemo(
    () => deriveProjectCreationFlow({
      name,
      profileId,
      cast: cast.filter((form) => !formIsBlank(form)).map(formToFlowEntry),
      world: world.filter((form) => !formIsBlank(form)).map(formToFlowEntry),
      script: { text: scriptText, mediaType: "text/plain" },
    }),
    [name, profileId, cast, world, scriptText],
  );

  const stepIndex = PROJECT_CREATION_STEPS.indexOf(step);
  // The script step uses the same save-readiness preflight as the script editor
  // (including the beat-count bound) so an out-of-bounds script is rejected
  // BEFORE the project or any canon revision is committed.
  const scriptReadiness = useMemo(() => deriveScriptSaveReadiness({ activeStoryRevisionId: null, scriptText }), [scriptText]);
  const scriptStepIssues: readonly ValidationIssue[] = scriptReadiness.ok ? [] : scriptReadiness.issues;
  const stepIssueCount = step === "script" ? scriptStepIssues.length : scopeIssues(flow.issues, step).length;
  const canLeaveStep = flow.stepComplete[step] && stepIssueCount === 0;
  const canCreate = flow.issues.length === 0 && flow.projectCommand !== null && flow.script !== null && scriptReadiness.ok && !submitting;

  const statusLines = useMemo(() => {
    const lines: string[] = [];
    if (createdProjectId) lines.push(`Project created — ID ${createdProjectId}.`);
    if (savedEntityIds.length > 0) lines.push(`Canon revisions saved — ${savedEntityIds.length} of ${canonTotal}.`);
    if (scriptSaving) lines.push("Saving the first script revision…");
    return lines;
  }, [createdProjectId, savedEntityIds, canonTotal, scriptSaving]);

  async function handleCreate() {
    if (!canCreate || !flow.projectCommand || !flow.script) return;
    setSubmitting(true);
    setCreationError(null);
    try {
      // 1. Project details (skipped when a partial run already created it).
      let projectId = createdProjectId;
      if (!projectId) {
        const call = await postJson("/api/production/projects", flow.projectCommand);
        const payload = call.networkFailed ? null : await responsePayload(call.response);
        if (call.networkFailed || !call.response.ok) {
          setCreationError({
            where: "project",
            entityId: null,
            error: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed),
          });
          return;
        }
        const created = payload as { id?: unknown } | null;
        if (!created || typeof created.id !== "string") {
          setCreationError({
            where: "project",
            entityId: null,
            error: {
              code: "UNKNOWN_RESPONSE", message: "The project was created but the response had no project ID; nothing more was attempted.",
              requestId: "unavailable", action: "Retry to resume creation.", retryable: true, status: call.response.status, shape: "unparseable",
            },
          });
          return;
        }
        projectId = created.id;
        setCreatedProjectId(projectId);
      }

      // 2. Canon revisions for every valid cast/world draft (resume-aware).
      const remaining = flow.canonDrafts.filter((draft) => !savedEntityIds.includes(draft.entityId));
      setCanonTotal(flow.canonDrafts.length);
      for (const draft of remaining) {
        const call = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/canon`, {
          projectId, entityId: draft.entityId, expectedRevisionId: null, entityKind: draft.entityKind,
          description: draft.description, attributes: draft.attributes, assetIds: draft.assetIds,
        });
        const payload = call.networkFailed ? null : await responsePayload(call.response);
        if (call.networkFailed || !call.response.ok) {
          setCreationError({
            where: "canon", entityId: draft.entityId,
            error: deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed),
          });
          return;
        }
        const revision = payload as { id?: unknown } | null;
        if (!revision || typeof revision.id !== "string") {
          setCreationError({
            where: "canon", entityId: draft.entityId,
            error: {
              code: "UNKNOWN_RESPONSE", message: `Canon for ${draft.entityId} saved but the response had no revision ID; the remaining steps were not attempted.`,
              requestId: "unavailable", action: "Retry to resume creation.", retryable: true, status: call.response.status, shape: "unparseable",
            },
          });
          return;
        }
        setSavedEntityIds((previous) => (previous.includes(draft.entityId) ? previous : [...previous, draft.entityId]));
      }

      // 3. Read the project state back so the script pins the real active canon.
      const readModel = await fetchReadModelById(projectId);
      if (!readModel.ok) {
        setCreationError({ where: "canon-state", entityId: null, error: readModel.view });
        return;
      }

      // 4. First immutable story revision.
      setScriptSaving(true);
      const storyCall = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/stories`, {
        projectId,
        expectedStoryRevisionId: readModel.value.project.activeStoryRevisionId,
        scriptText: flow.script.scriptText,
        beats: deriveScriptBeats(flow.script.scriptText),
        canonRevisionIds: readModel.value.project.activeCanonRevisionIds,
      });
      const storyPayload = storyCall.networkFailed ? null : await responsePayload(storyCall.response);
      setScriptSaving(false);
      if (storyCall.networkFailed || !storyCall.response.ok) {
        setCreationError({
          where: "script", entityId: null,
          error: deriveMutationFailure(storyCall.networkFailed ? null : storyCall.response.status, storyPayload, storyCall.networkFailed),
        });
        return;
      }
      const story = storyPayload as { id?: unknown } | null;
      if (!story || typeof story.id !== "string") {
        setCreationError({
          where: "script", entityId: null,
          error: {
            code: "UNKNOWN_RESPONSE", message: "The script save could not be confirmed; no success is claimed.",
            requestId: "unavailable", action: "Retry — an identical save is safe.", retryable: true, status: storyCall.response.status, shape: "unparseable",
          },
        });
        return;
      }
      window.location.assign(`/production/${projectId}`);
    } finally {
      setSubmitting(false);
      setScriptSaving(false);
    }
  }

  const errorLead: Record<string, string> = {
    project: "The project details could not be saved.",
    canon: creationError?.entityId ? `The canon revision for ${creationError.entityId} could not be saved.` : "A canon revision could not be saved.",
    "canon-state": "The saved canon state could not be read back before the script save.",
    script: "The script revision could not be saved.",
  };

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
      <header className="border-b border-border pb-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production / New</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">New production project</h1>
        <p className="mt-1 text-[12px] text-muted">
          Four steps: details, cast canon, world canon, script. Each step is validated before it can continue; every save either succeeds or is reported — nothing is partially committed silently.
        </p>
      </header>

      <ol aria-label="Creation steps" className="mt-5 flex flex-wrap gap-2">
        {PROJECT_CREATION_STEPS.map((entry, index) => {
          const complete = flow.stepComplete[entry];
          const current = entry === step;
          return (
            <li
              key={entry}
              aria-current={current ? "step" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1 text-[12px] font-semibold ${
                current ? "border-primary/40 bg-primary-soft text-primary" : complete ? "border-success/30 bg-success-soft text-success" : "border-border bg-raised text-muted"
              }`}
            >
              <span className="tabular-nums">{index + 1}.</span> {STEP_LABELS[entry]}{complete && !current ? " ✓" : ""}
            </li>
          );
        })}
      </ol>

      <div className="mt-5 space-y-5">
        <StatusRegion lines={statusLines} />
        {creationError ? <ErrorAlert view={creationError.error} lead={errorLead[creationError.where]} /> : null}

        {step === "details" ? (
          <Card>
            <div className="space-y-4">
              <FieldShell label="Project name" htmlFor="project-name" hint="1–160 characters; trimmed.">
                <input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                />
              </FieldShell>
              <SelectField label="Profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                {PROFILE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </SelectField>
              <IssueList issues={scopeIssues(flow.issues, "details")} label="Project details issues" />
            </div>
          </Card>
        ) : null}

        {step === "cast" ? (
          <Card>
            <div className="space-y-4">
              <EntityDraftEditor legend="Cast" forms={cast} onChange={setCast} allowedKinds={["character"]} />
              <IssueList issues={scopeIssues(flow.issues, "cast")} label="Cast issues" />
            </div>
          </Card>
        ) : null}

        {step === "world" ? (
          <Card>
            <div className="space-y-4">
              <EntityDraftEditor legend="World" forms={world} onChange={setWorld} allowedKinds={["location", "prop", "style"]} />
              <IssueList issues={scopeIssues(flow.issues, "world")} label="World issues" />
            </div>
          </Card>
        ) : null}

        {step === "script" ? (
          <Card>
            <div className="space-y-4">
              <ScriptTextArea value={scriptText} onChange={setScriptText} rows={10} />
              <ScriptFactsLine scriptText={scriptText} />
              <p className="text-[12.5px] text-muted">
                Saving creates the first immutable story revision; later saves append new revisions — prior text is never modified.
              </p>
              <IssueList issues={scriptStepIssues} label="Script issues" />
            </div>
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary" size="sm" icon="arrow-left"
            disabled={stepIndex === 0 || submitting}
            onClick={() => setStep(PROJECT_CREATION_STEPS[Math.max(0, stepIndex - 1)])}
          >
            Back
          </Button>
          {stepIndex < PROJECT_CREATION_STEPS.length - 1 ? (
            <Button
              size="sm" iconRight="arrow-right"
              disabled={!canLeaveStep || submitting}
              onClick={() => setStep(PROJECT_CREATION_STEPS[stepIndex + 1])}
            >
              Next: {STEP_LABELS[PROJECT_CREATION_STEPS[stepIndex + 1]]}
            </Button>
          ) : (
            <Button size="sm" icon="check" disabled={!canCreate} onClick={() => void handleCreate()}>
              {createdProjectId ? "Resume creation" : "Create project"}
            </Button>
          )}
          {!canLeaveStep && stepIssueCount === 0 && !flow.stepComplete[step] ? (
            <span className="text-[12px] text-muted">Complete this step to continue.</span>
          ) : null}
          {!canLeaveStep && stepIssueCount > 0 ? (
            <span className="text-[12px] text-danger">Resolve the issues on this step before continuing.</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Shared script editor pieces                                         */
/* ================================================================== */

function ScriptTextArea({ value, onChange, rows }: { value: string; onChange: (next: string) => void; rows: number }) {
  const id = useId();
  return (
    <FieldShell
      label="Script text"
      htmlFor={id}
      hint={`Plain text only, up to ${SCRIPT_TEXT_MAX_CHARS.toLocaleString("en-US")} characters. Blank lines separate beats.`}
      counter={`${value.length.toLocaleString("en-US")} chars`}
    >
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink focus:border-primary focus:outline-none"
        spellCheck={false}
      />
    </FieldShell>
  );
}

function ScriptFactsLine({ scriptText }: { scriptText: string }) {
  const derived = deriveScriptImport({ text: scriptText, mediaType: "text/plain" });
  const beats = deriveScriptBeats(scriptText);
  if (!derived.ok) return null;
  return (
    <p role="status" className="text-[12.5px] tabular-nums text-muted">
      {derived.value.charCount.toLocaleString("en-US")} characters · {derived.value.byteLength.toLocaleString("en-US")} bytes · {derived.value.lineCount.toLocaleString("en-US")} lines · {beats.length.toLocaleString("en-US")} beat{beats.length === 1 ? "" : "s"} derived from blank-line paragraphs
    </p>
  );
}

/* ================================================================== */
/* /production/[projectId] — overview                                  */
/* ================================================================== */

export function ProjectOverviewPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6">
      {state.phase === "loading" ? <LoadingPanel label="Loading project…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} backHref="/production" /> : null}
      {state.phase === "ready" ? (
        <>
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production</p>
              <h1 className="mt-1 truncate text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">{state.readModel.project.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <MonoId value={state.readModel.project.id} />
                <Badge tone="neutral">{state.readModel.project.profile.format}</Badge>
                <Badge tone="neutral">{state.readModel.project.profile.language}</Badge>
                <span className="text-[12px] text-muted">{state.readModel.project.profile.targetFrames.toLocaleString("en-US")} target frames</span>
                <span className="text-[12px] text-muted">Updated {formatDate(state.readModel.project.updatedAt)} {formatTime(state.readModel.project.updatedAt)}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <LinkButton href={`/production/${projectId}/canon`} size="sm" variant="secondary" icon="character">Canon editor</LinkButton>
              <LinkButton href={`/production/${projectId}/script`} size="sm" icon="pen">Script editor</LinkButton>
              <LinkButton href={`/production/${projectId}/plan`} size="sm" icon="grid">Plan</LinkButton>
            </div>
          </header>

          <section aria-label="Active revisions" className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Active revisions &amp; provenance</h2>
              <Button variant="ghost" size="sm" icon="refresh" onClick={reload}>Reload</Button>
            </div>
            <ul className="mt-3 space-y-3">
              {state.readModel.canonRevisions.map((revision) => (
                <ProvenanceCard key={revision.id} kind="canon" revision={revision} caption={`${revision.entityKind} · ${revision.entityId}`} />
              ))}
              {state.readModel.storyRevision ? <ProvenanceCard kind="story" revision={state.readModel.storyRevision} /> : (
                <li>
                  <Card>
                    <p className="text-[13px] text-muted">No story revision yet — save a script in the <Link className="text-primary underline underline-offset-4" href={`/production/${projectId}/script`}>script editor</Link>.</p>
                  </Card>
                </li>
              )}
              {state.readModel.shotPlanRevision ? <ProvenanceCard kind="shotplan" revision={state.readModel.shotPlanRevision} /> : null}
              {state.readModel.animaticRevision ? <ProvenanceCard kind="animatic" revision={state.readModel.animaticRevision} /> : null}
              {state.readModel.audioMixRevision ? <ProvenanceCard kind="audiomix" revision={state.readModel.audioMixRevision} /> : null}
            </ul>
          </section>

          <OverviewApprovalStatesSection projectId={projectId} readModel={state.readModel} />

          <StaleNoticesSection readModel={state.readModel} />
        </>
      ) : null}
    </div>
  );
}

/** Overview chips for the story / shot plan / animatic approval chain (C19). */
function OverviewApprovalStatesSection({ projectId, readModel }: { projectId: string; readModel: ProjectReadModel }) {
  const badges = deriveOverviewApprovalBadges(readModel);
  return (
    <section aria-label="Approval states" className="mt-6" data-testid="overview-approval-states">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Approval states (story → shot plan → animatic)</h2>
      <ul className="mt-3 space-y-2">
        {badges.map((badge) => (
          <li key={badge.kind} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-raised px-4 py-2.5">
            <Badge tone="primary">{badge.kind}</Badge>
            <span className="text-[13px] font-semibold text-ink">{badge.label}</span>
            {badge.revisionId ? (
              <span className="font-mono text-[11.5px] text-muted">{badge.revisionId}</span>
            ) : (
              <span className="text-[12.5px] text-muted">no revision yet</span>
            )}
            {badge.revisionId ? (
              badge.approvedCurrent
                ? <Badge tone="success">approved</Badge>
                : <Badge tone="warning">not approved</Badge>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-muted">
        Approve the story in the <Link className="text-primary underline underline-offset-4" href={`/production/${projectId}/script`}>script editor</Link>; build and approve the shot plan and animatic in the{" "}
        <Link className="text-primary underline underline-offset-4" href={`/production/${projectId}/plan`}>plan builder</Link>.
      </p>
    </section>
  );
}

/* ================================================================== */
/* /production/[projectId]/canon — canon editor                        */
/* ================================================================== */

const CANON_KINDS: readonly CanonEntityKindValue[] = ["character", "location", "prop", "style"];

export function CanonEditorPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);
  const [entityKind, setEntityKind] = useState<CanonEntityKindValue>("character");
  const [entityId, setEntityId] = useState("");
  const [description, setDescription] = useState("");
  const [assetIdsText, setAssetIdsText] = useState("");
  const [attributesText, setAttributesText] = useState("");
  const [formIssues, setFormIssues] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorEnvelopeView | null>(null);
  const [saveBanner, setSaveBanner] = useState<{ entityId: string; banner: CanonSaveBanner } | null>(null);

  async function handleCreateRevision() {
    if (state.phase !== "ready" || saving) return;
    setSaveBanner(null);
    const assetIds = assetIdsText.trim() === "" ? [] : assetIdsText.split(/[\s,]+/).filter(Boolean);
    let attributes: unknown = {};
    if (attributesText.trim() !== "") {
      try { attributes = JSON.parse(attributesText); } catch { attributes = attributesText; }
    }
    const parsed = CanonEntityDraftSchema.safeParse({
      entityId: entityId.trim(), entityKind, description, attributes, assetIds,
    });
    if (!parsed.success) {
      setSaveError(null);
      setFormIssues(zodViewIssues(parsed.error, "INVALID_ENTITY_DRAFT", "Canon draft"));
      return;
    }
    setFormIssues([]);
    setSaving(true);
    try {
      const expectedRevisionId = state.readModel.canonRevisions.find((revision) => revision.entityId === parsed.data.entityId)?.id ?? null;
      const call = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/canon`, {
        projectId, expectedRevisionId, ...parsed.data,
      });
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        setSaveError(deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
        return;
      }
      const revision = payload as { id?: unknown } | null;
      if (!revision || typeof revision.id !== "string") {
        setSaveError({
          code: "UNKNOWN_RESPONSE", message: "The canon save could not be confirmed; no success is claimed.",
          requestId: "unavailable", action: "Reload to check whether the revision landed.", retryable: true, status: call.response.status, shape: "unparseable",
        });
        return;
      }
      setSaveBanner({
        entityId: parsed.data.entityId,
        banner: deriveCanonSaveBanner({ entityId: parsed.data.entityId, revisionId: revision.id, expectedRevisionId }),
      });
      setDescription("");
      setAssetIdsText("");
      setAttributesText("");
      reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6">
      {state.phase === "loading" ? <LoadingPanel label="Loading canon…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} backHref="/production" /> : null}
      {state.phase === "ready" ? (
        <>
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production / {state.readModel.project.name}</p>
              <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Canon editor</h1>
              <p className="mt-1 text-[12px] text-muted">Reusable cast and world canon. Saving a canon entity appends a new immutable revision when content changes and re-points the project pin; byte-identical content re-points the pin without creating a new revision.</p>
            </div>
            <div className="flex gap-2">
              <LinkButton href={`/production/${projectId}`} size="sm" variant="ghost" icon="arrow-left">Overview</LinkButton>
              <LinkButton href={`/production/${projectId}/script`} size="sm" variant="secondary" icon="pen">Script editor</LinkButton>
            </div>
          </header>

          <section aria-label="Canon revisions" className="mt-6">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Canon revisions (active selections)</h2>
            {state.readModel.canonRevisions.length === 0 ? (
              <p role="status" className="mt-2 text-[13px] text-muted">No canon is pinned yet — create the first revision below.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {state.readModel.canonRevisions.map((revision) => (
                  <ProvenanceCard key={revision.id} kind="canon" revision={revision} caption={`${revision.entityKind} · ${revision.entityId}`} />
                ))}
              </ul>
            )}
          </section>

          <section aria-label="New canon revision" className="mt-8">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Create a canon revision</h2>
            <Card className="mt-3">
              <div className="space-y-4">
                {saveBanner ? (
                  <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
                    {saveBanner.banner.text}
                  </div>
                ) : null}
                {saveError ? <ErrorAlert view={saveError} lead="The canon revision could not be saved." /> : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldShell label="Entity ID" htmlFor="canon-entity-id" hint="Existing entity to revise, or a new entity ID to add.">
                    <input
                      id="canon-entity-id"
                      value={entityId}
                      onChange={(event) => setEntityId(event.target.value)}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                    />
                  </FieldShell>
                  <SelectField label="Entity kind" value={entityKind} onChange={(event) => setEntityKind(event.target.value as CanonEntityKindValue)}>
                    {CANON_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </SelectField>
                </div>
                <FieldShell label="Description" htmlFor="canon-description" hint="A new immutable revision is created with this description.">
                  <textarea
                    id="canon-description"
                    rows={3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldShell label="Reference asset IDs" htmlFor="canon-assets" hint="Optional — comma-separated existing asset IDs; leave empty for none.">
                    <input
                      id="canon-assets"
                      value={assetIdsText}
                      onChange={(event) => setAssetIdsText(event.target.value)}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                    />
                  </FieldShell>
                  <FieldShell label="Attributes JSON" htmlFor="canon-attributes" hint='Optional JSON object, e.g. {"mood":"dawn"}.'>
                    <input
                      id="canon-attributes"
                      value={attributesText}
                      onChange={(event) => setAttributesText(event.target.value)}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 font-mono text-[12.5px] text-ink focus:border-primary focus:outline-none"
                    />
                  </FieldShell>
                </div>
                <IssueList issues={formIssues} label="Canon draft issues" />
                <Button icon="plus" disabled={saving || state.phase !== "ready"} loading={saving} onClick={() => void handleCreateRevision()}>
                  {saving ? "Saving canon revision…" : "Create canon revision"}
                </Button>
                <p className="text-[12px] text-muted">Saving appends a new immutable revision when content changes; byte-identical content re-points the pin without creating. Existing revisions are never modified.</p>
              </div>
            </Card>
          </section>

          <StaleNoticesSection readModel={state.readModel} />
        </>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* /production/[projectId]/script — story approval (C19)               */
/* ================================================================== */

/**
 * Checklist-gated "Approve story" action for the current story revision. Available exactly when a
 * current story revision exists and has no current approval (an approval bound to the revision's
 * exact contentHash). The POST body is derived by deriveStoryApprovalCommand; the idempotency key
 * is a fresh crypto.randomUUID() per submit attempt, and an HTTP 200 (exact replay) is reported as
 * an already-recorded success, never an error.
 */
function StoryApprovalSection({ projectId, readModel, reload }: { projectId: string; readModel: ProjectReadModel; reload: () => void }) {
  const story = readModel.storyRevision;
  const [checks, setChecks] = useState<Record<string, StoryApprovalChecklistEntry>>(() =>
    Object.fromEntries(STORY_APPROVAL_CHECKLIST_VIEW.map((id) => [id, { id, passed: false, note: "" } as StoryApprovalChecklistEntry])),
  );
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorEnvelopeView | null>(null);
  const [saved, setSaved] = useState<{ approvalId: string; created: boolean } | null>(null);

  if (!story) {
    return (
      <p role="status" className="text-[13px] text-muted">
        No story revision exists yet — the approval action appears once a revision is current.
      </p>
    );
  }

  const state = deriveStoryApprovalState(readModel.revisionApprovals, story);
  const currentStory = story;
  const checklist = STORY_APPROVAL_CHECKLIST_VIEW.map((id) => checks[id] ?? { id, passed: false, note: "" });
  const allTicked = checklist.every((entry) => entry.passed);

  async function submit() {
    if (!allTicked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const uuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const command = deriveStoryApprovalCommand({ projectId, idempotencyKey: uuid, story: currentStory, checklist, notes });
      if (!command) return;
      const call = await postJson("/api/production/approvals", command);
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        setError(deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
        return;
      }
      const record = payload as { approval?: { id?: unknown }; created?: unknown } | null;
      const approvalId = typeof record?.approval?.id === "string" ? record.approval.id : null;
      if (!approvalId) {
        setError({
          code: "UNKNOWN_RESPONSE",
          message: "The approval endpoint returned an unexpected payload; no success is claimed.",
          requestId: "unavailable",
          action: "Reload to check whether the decision landed.",
          retryable: true,
          status: call.response.status,
          shape: "unparseable",
        });
        return;
      }
      setSaved({ approvalId, created: record?.created === true });
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  if (state.approvedCurrent) {
    return (
      <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">approved</Badge>
          <span className="text-[13px] text-ink">
            Story revision <span className="font-mono text-[12px]">{story.id}</span> is approved and current.
          </span>
          <LinkButton href={`/production/${projectId}/plan`} size="sm" variant="secondary" icon="grid">Build the shot plan</LinkButton>
        </div>
        {state.latest ? (
          <p className="mt-1 text-[12px] text-muted">
            Decision {state.latest.id} · {state.latest.actorId} · {formatDate(state.latest.createdAt)} {formatTime(state.latest.createdAt)} · hash <span className="font-mono">{state.latest.targetHash}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <fieldset className="space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="story-approval-workspace">
      <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Approve story — revision {story.id}</legend>
      <p className="text-[12px] text-muted">
        {state.latest
          ? state.latest.decision === "rejected"
            ? "The latest decision for this revision is a rejection; a new approval requires every check below."
            : "The latest recorded approval no longer matches this revision's hash; approve again to make it current."
          : "No human decision is recorded for this revision."}{" "}
        Approval hash is this revision's content hash: <span className="font-mono">{story.contentHash}</span>
      </p>
      <div className="space-y-2.5">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Required checklist ({STORY_APPROVAL_CHECKLIST_VIEW.length} items — tick every check to approve)</p>
        {STORY_APPROVAL_CHECKLIST_VIEW.map((id) => {
          const entry = checks[id] ?? { id, passed: false, note: "" };
          return (
            <div key={id} className="grid gap-2 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={entry.passed}
                  onChange={(event) =>
                    setChecks((previous) => ({ ...previous, [id]: { ...entry, passed: event.target.checked } }))}
                />
                {id}
              </label>
              <input
                aria-label={`Note for checklist item ${id}`}
                value={entry.note}
                onChange={(event) => setChecks((previous) => ({ ...previous, [id]: { ...entry, note: event.target.value } }))}
                placeholder="Evidence note for this check"
                className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
              />
            </div>
          );
        })}
      </div>
      <FieldShell label="Notes" htmlFor="story-approval-notes" hint="Optional context recorded with the decision.">
        <textarea
          id="story-approval-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
        />
      </FieldShell>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={!allTicked || submitting}
          loading={submitting}
          data-testid="story-approve-button"
          onClick={() => void submit()}
        >
          {submitting ? "Submitting approval…" : "Approve story"}
        </Button>
        {!allTicked ? <span className="text-[12px] text-muted">Tick every checklist item to enable the approval.</span> : null}
      </div>
      {saved ? (
        <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
          {saved.created ? "Story approved" : "Story approval already recorded (identical replay)"} — approval <span className="font-mono text-[12px]">{saved.approvalId}</span>.
        </div>
      ) : null}
      {error ? <ErrorAlert view={error} lead="The story approval could not be recorded." /> : null}
    </fieldset>
  );
}

/* ================================================================== */
/* /production/[projectId]/script — script editor                      */
/* ================================================================== */

export function ScriptEditorPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);
  const [text, setText] = useState("");
  const [synced, setSynced] = useState(false);
  const [superseded, setSuperseded] = useState<StoryRevision[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorEnvelopeView | null>(null);
  const [saveBanner, setSaveBanner] = useState<{ revisionId: string; created: boolean; label: string } | null>(null);

  const [providerId, setProviderId] = useState("unconfigured");
  const [modelId, setModelId] = useState("unconfigured");
  const [proposing, setProposing] = useState(false);
  const [proposalOutcome, setProposalOutcome] = useState<ProposalOutcome | null>(null);

  // The proposal selects are fed by the text-engine chain listing; fetched once
  // when the page is ready (the proposal section only renders then). "unconfigured"
  // stays the honest schema-valid placeholder until a real engine is chosen.
  const engineCatalog = useTextEngineOptions(state.phase === "ready");
  const textEngineProviderIdList = useMemo(() => textEngineProviderIds(engineCatalog.engines), [engineCatalog.engines]);
  const providerEngines = useMemo(
    () => engineCatalog.engines.filter((engine) => engine.providerId === providerId),
    [engineCatalog.engines, providerId],
  );

  useEffect(() => {
    if (engineCatalog.loading || textEngineProviderIdList.length === 0) return;
    const nextProvider = textEngineProviderIdList.includes(providerId)
      ? providerId
      : textEngineProviderIdList[0] ?? "unconfigured";
    const firstModel = firstTextEngineModelForProvider(engineCatalog.engines, nextProvider);
    setProviderId(nextProvider);
    if (firstModel) setModelId(firstModel.modelId);
  }, [engineCatalog, textEngineProviderIdList, providerId]);

  const enginesUnavailable = engineCatalog.loading || textEngineProviderIdList.length === 0;

  function handleProposalProviderChange(nextProvider: string) {
    setProviderId(nextProvider);
    const firstModel = firstTextEngineModelForProvider(engineCatalog.engines, nextProvider);
    if (firstModel) setModelId(firstModel.modelId);
  }

  useEffect(() => {
    if (state.phase !== "ready" || synced) return;
    setText(state.readModel.storyRevision?.scriptText ?? "");
    setSynced(true);
  }, [state, synced]);

  const readiness = useMemo(() => deriveScriptSaveReadiness({
    activeStoryRevisionId: state.phase === "ready" ? state.readModel.project.activeStoryRevisionId : null,
    scriptText: text,
  }), [state, text]);

  async function handleSave() {
    if (state.phase !== "ready" || !readiness.ok || saving) return;
    setSaveBanner(null);
    setSaveError(null);
    setSaving(true);
    try {
      const call = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/stories`, {
        projectId,
        expectedStoryRevisionId: state.readModel.project.activeStoryRevisionId,
        scriptText: text,
        beats: readiness.beats,
        canonRevisionIds: state.readModel.project.activeCanonRevisionIds,
      });
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        setSaveError(deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
        return;
      }
      const revision = payload as { id?: unknown } | null;
      if (!revision || typeof revision.id !== "string") {
        setSaveError({
          code: "UNKNOWN_RESPONSE", message: "The script save could not be confirmed; no success is claimed and the editor is unchanged.",
          requestId: "unavailable", action: "Retry — an identical save is safe.", retryable: true, status: call.response.status, shape: "unparseable",
        });
        return;
      }
      const priorActive = state.readModel.storyRevision;
      if (priorActive && priorActive.id !== revision.id) {
        setSuperseded((previous) => (previous.some((entry) => entry.id === priorActive.id) ? previous : [...previous, priorActive]));
      }
      setSaveBanner({
        revisionId: revision.id,
        created: revision.id !== state.readModel.project.activeStoryRevisionId,
        label: readiness.facts.label,
      });
      reload();
    } finally {
      setSaving(false);
    }
  }

  async function handlePropose() {
    if (state.phase !== "ready" || proposing || text.trim().length === 0) return;
    setProposing(true);
    try {
      const call = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/proposals`, {
        schemaVersion: 1,
        projectId,
        kind: "story",
        providerId: providerId.trim(),
        modelId: modelId.trim(),
        scriptText: text,
        expectedCanonRevisionIds: state.readModel.project.activeCanonRevisionIds,
        expectedStoryRevisionId: state.readModel.project.activeStoryRevisionId,
      });
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      setProposalOutcome(deriveProposalOutcome(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
    } finally {
      setProposing(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6">
      {state.phase === "loading" ? <LoadingPanel label="Loading script…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} backHref="/production" /> : null}
      {state.phase === "ready" ? (
        <>
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production / {state.readModel.project.name}</p>
              <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Script editor</h1>
              <p className="mt-1 text-[12px] text-muted">
                {state.readModel.storyRevision
                  ? <>Active revision <span className="font-mono text-[11.5px]">{state.readModel.storyRevision.id}</span> · pins {state.readModel.project.activeCanonRevisionIds.length} canon revision{state.readModel.project.activeCanonRevisionIds.length === 1 ? "" : "s"}</>
                  : "No story revision yet — the first save creates one."}
              </p>
            </div>
            <div className="flex gap-2">
              <LinkButton href={`/production/${projectId}`} size="sm" variant="ghost" icon="arrow-left">Overview</LinkButton>
              <LinkButton href={`/production/${projectId}/canon`} size="sm" variant="secondary" icon="character">Canon editor</LinkButton>
            </div>
          </header>

          <section aria-label="Script editor" className="mt-6">
            <Card>
              <div className="space-y-4">
                {saveBanner ? (
                  <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
                    {saveBanner.created
                      ? <>Saved — created immutable story revision <span className="font-mono text-[12px]">{saveBanner.revisionId}</span>. {saveBanner.label}</>
                      : <>Saved — identical content: the existing revision <span className="font-mono text-[12px]">{saveBanner.revisionId}</span> remains active; no new revision was needed. {saveBanner.label}</>}
                  </div>
                ) : null}
                {saveError ? <ErrorAlert view={saveError} lead="The script revision could not be saved." /> : null}

                <ScriptTextArea value={text} onChange={setText} rows={14} />
                <ScriptFactsLine scriptText={text} />

                <IssueList issues={readinessBlockingIssues(readiness)} label="Save blocked" />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    icon="check"
                    disabled={!readiness.ok || saving}
                    loading={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? "Saving revision…" : "Save script revision"}
                  </Button>
                  <Button variant="ghost" size="sm" icon="refresh" onClick={() => { setSynced(false); reload(); }}>
                    Reload from server
                  </Button>
                </div>
                <p className="text-[12px] text-muted">
                  {readiness.ok ? readiness.facts.label : "Saving is disabled until the script passes the bounds above."}
                </p>
              </div>
            </Card>
          </section>

          <section aria-label="Story approval" className="mt-8" data-testid="story-approval-section">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Story approval</h2>
            <Card className="mt-3">
              <StoryApprovalSection projectId={projectId} readModel={state.readModel} reload={reload} />
            </Card>
          </section>

          <section aria-label="Revision history" className="mt-8">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Revision history</h2>
            {superseded.length === 0 ? (
              <p role="status" className="mt-2 text-[13px] text-muted">
                Revisions you supersede in this session stay listed here with their exact text — prior revisions are never modified.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {superseded.map((revision) => (
                  <li key={revision.id}>
                    <Card>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">superseded</Badge>
                        <span className="text-sm font-semibold text-ink">{revision.id}</span>
                        <span className="text-[12px] text-muted">{formatDate(revision.createdAt)} {formatTime(revision.createdAt)}</span>
                      </div>
                      <p className="mt-2 text-[12.5px] text-muted">Text unchanged since capture ({revision.scriptText.length.toLocaleString("en-US")} characters):</p>
                      <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[8px] border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink">{revision.scriptText}</pre>
                      <p className="mt-2"><MonoId value={revision.contentHash} /></p>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
            {state.readModel.storyRevision ? (
              <ul className="mt-3 space-y-3">
                <ProvenanceCard kind="story" revision={state.readModel.storyRevision} />
              </ul>
            ) : null}
          </section>

          <section aria-label="Story proposal" className="mt-8">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Plan story beats (proposal)</h2>
            <Card className="mt-3">
              <div className="space-y-4">
                {proposalOutcome?.state === "not_entitled" ? (
                  <div role="alert" className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
                    <p className="text-[13px] font-bold text-ink">Script proposal planning is not yet entitled.</p>
                    <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(proposalOutcome.envelope)}</p>
                    <p className="mt-1 text-[12px] text-muted">Proposals never apply automatically. Continue editing the script manually.</p>
                  </div>
                ) : null}
                {proposalOutcome?.state === "failed" || proposalOutcome?.state === "network" ? (
                  <ErrorAlert view={proposalOutcome.envelope} lead="The proposal request failed." />
                ) : null}
                {proposalOutcome?.state === "invalid_success" ? (
                  <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3 text-[13px] text-ink">
                    The proposal endpoint returned an unexpected success payload without a proposal ID (status {proposalOutcome.status ?? "unknown"}). Nothing was applied.
                  </div>
                ) : null}
                {proposalOutcome?.state === "saved" ? (
                  <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
                    Proposal accepted — ID <span className="font-mono text-[12px]">{proposalOutcome.proposalId}</span>. Review it before anything is applied; proposals never auto-apply.
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldShell label="Provider ID" htmlFor="proposal-provider" hint="Text proposal provider ID (no entitlement exists yet).">
                    <select
                      id="proposal-provider"
                      data-testid="proposal-provider-input"
                      value={providerId}
                      onChange={(event) => handleProposalProviderChange(event.target.value)}
                      disabled={enginesUnavailable}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                    >
                      {engineCatalog.loading ? (
                        <option value="unconfigured">Loading text engines…</option>
                      ) : textEngineProviderIdList.length === 0 ? (
                        <option value="unconfigured">No text engines configured — set up providers in Settings</option>
                      ) : (
                        textEngineProviderIdList.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))
                      )}
                    </select>
                  </FieldShell>
                  <FieldShell label="Model ID" htmlFor="proposal-model" hint="Text proposal model ID (no entitlement exists yet).">
                    <select
                      id="proposal-model"
                      data-testid="proposal-model-input"
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={enginesUnavailable || providerEngines.length === 0}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                    >
                      {engineCatalog.loading ? (
                        <option value="unconfigured">Loading text engines…</option>
                      ) : providerEngines.length === 0 ? (
                        <option value="unconfigured">No text engines configured — set up providers in Settings</option>
                      ) : (
                        providerEngines.map((engine) => (
                          <option key={engine.modelId} value={engine.modelId}>{engine.label}</option>
                        ))
                      )}
                    </select>
                  </FieldShell>
                </div>
                {engineCatalog.loading || engineCatalog.engines.length > 0 ? null : (
                  <p className="text-[12px] text-muted">
                    Providers and models are configured in Settings — <Link href="/settings" className="font-medium text-ink underline underline-offset-2">open Settings</Link>.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary" icon="sparkle"
                    disabled={proposing || text.trim().length === 0}
                    loading={proposing}
                    onClick={() => void handlePropose()}
                  >
                    {proposing ? "Requesting proposal…" : "Request story proposal"}
                  </Button>
                  <span className="text-[12px] text-muted">
                    Text proposal generation has no reviewed entitlement yet — the request reports the exact server decision.
                  </span>
                </div>
              </div>
            </Card>
          </section>

          <StaleNoticesSection readModel={state.readModel} />
        </>
      ) : null}
    </div>
  );
}

/** The blocking issues a script save must clear, in derivation order. */
function readinessBlockingIssues(readiness: ScriptSaveReadiness): readonly ValidationIssue[] {
  return readiness.ok ? [] : readiness.issues;
}
