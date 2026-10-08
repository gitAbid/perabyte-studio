"use client";

/**
 * C19 plan builder UI (/production/[projectId]/plan).
 *
 * Speaks HTTP only: reads via GET /api/production/projects/[projectId] (read model v2) and mutates
 * via the accepted production routes (POST projects/[id]/shot-plans, POST approvals). No server
 * rule is reimplemented: the draft-from-beats derivation only prefills editable fields, the H3
 * 124 + 17n frame-grid check flags (never blocks — the server owns the real bound), the required
 * approval checklists mirror lib/production/approval.ts APPROVAL_CHECKLISTS verbatim through the
 * C08 APPROVAL_CHECKLISTS_VIEW mirror (asserted against the accepted constants), and canon choices
 * are restricted to revisions that are BOTH currently selected (read model canonRevisions) AND
 * pinned by the story (story.canonRevisionIds) — exactly the set the accepted createShotPlan
 * service accepts, so no canon/selection POST is needed and none is fabricated.
 *
 * The exported plain functions at the top are pure view-model helpers (no hooks, no window, no
 * fetch) so tests can import them in a node environment.
 *
 * Fail-closed rules honored throughout: no story revision, an unapproved story, or a story that
 * pins no currently-selected location/style canon renders an explicit empty/blocked state naming
 * the prerequisite chain; a failed create/approval renders the error envelope (code + message +
 * requestId) and keeps every input; nothing is auto-created by rendering and no data is fabricated.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, FieldShell, LinkButton, formatDate, formatTime } from "@/components/ui";
import { deriveMutationFailure, deriveStoryApprovalState, formatEnvelope, type ErrorEnvelopeView } from "@/components/production/project-canon";
import { APPROVAL_CHECKLISTS_VIEW, framesToDurationLabel, latestDecisionFor } from "@/components/production/storyboard";
import {
  AnimaticRevisionSchema, ProjectReadModelSchema, ShotPlanRevisionSchema,
  type AnimaticRevision, type Approval, type CanonRevision, type CreateApprovalCommand,
  type CreateShotPlanCommand, type ProjectReadModel, type ShotPlanRevision, type StoryRevision,
} from "@/lib/production/contracts";

/* ================================================================== */
/* Pure view-model helpers (no hooks / window / fetch — test in node)  */
/* ================================================================== */

/** Default shot duration: 192 frames is on the H3 grid (124 + 17·4). */
export const PLAN_DEFAULT_TARGET_FRAMES = 192;
export const PLAN_DEFAULT_MOTION_INTENT = "Gentle, storybook camera movement.";
/** The frozen H3 legal frame grid (lib/production/animatic.ts legal-grid rule). */
export const H3_FRAME_GRID = { baseFrames: 124, stepFrames: 17, maxFrames: 362 } as const;
/** The six contract framings, verbatim from ShotRevisionSchema.shape.framing. */
export const PLAN_SHOT_FRAMINGS = ["extreme_wide", "wide", "medium_wide", "medium", "close", "extreme_close"] as const;
export type PlanShotFraming = (typeof PLAN_SHOT_FRAMINGS)[number];

/** True exactly when frames is a safe integer on the 124 + 17n grid up to 362. */
export function isLegalH3TargetFrames(frames: number): boolean {
  return Number.isSafeInteger(frames) && frames >= H3_FRAME_GRID.baseFrames && frames <= H3_FRAME_GRID.maxFrames &&
    (frames - H3_FRAME_GRID.baseFrames) % H3_FRAME_GRID.stepFrames === 0;
}

/** Integer-math "≈ Ns at 24 fps" hint for a frame count (display only). */
export function framesSecondsHint(frames: number): string {
  return `≈ ${framesToDurationLabel(frames)} at 24 fps`;
}

/** Positive safe-integer frames within the contract bound, or null (keep the text editable). */
export function parsePlanTargetFrames(text: string): number | null {
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : null;
}

export type PlanCanonOptions = { characters: CanonRevision[]; locations: CanonRevision[]; styles: CanonRevision[] };

/**
 * Canon the plan may bind: revisions that are BOTH currently selected (the read model's
 * canonRevisions are exactly project.activeCanonRevisionIds) AND pinned by the story. The accepted
 * createShotPlan service rejects anything else (UNKNOWN_REFERENCE), so the builder never offers it.
 */
export function derivePlanCanonOptions(story: StoryRevision | null, canonRevisions: readonly CanonRevision[]): PlanCanonOptions {
  const pinned = story ? new Set(story.canonRevisionIds) : new Set<string>();
  const selected = (kind: CanonRevision["entityKind"]) =>
    canonRevisions.filter((revision) => revision.entityKind === kind && pinned.has(revision.id));
  return { characters: selected("character"), locations: selected("location"), styles: selected("style") };
}

export type PlanCastDraft = { characterId: string; canonRevisionId: string; wardrobe: string };

/** One editable shot draft; every field maps 1:1 onto CreateShotPlanCommand.shots[number]. */
export type PlanShotDraft = {
  key: string;
  shotId: string;
  beatIds: string[];
  visualIntent: string;
  motionIntent: string;
  castBindings: PlanCastDraft[];
  locationRevisionId: string;
  styleRevisionId: string;
  framing: PlanShotFraming;
  targetFramesText: string;
};

/** Draft generation: one editable shot per story beat, in beat order. */
export function derivePlanDraftFromBeats(story: StoryRevision, options: PlanCanonOptions): PlanShotDraft[] {
  return story.beats.map((beat, index) => ({
    key: `shot-draft-${index + 1}`,
    shotId: `shot_${index + 1}`,
    beatIds: [beat.id],
    visualIntent: beat.action,
    motionIntent: PLAN_DEFAULT_MOTION_INTENT,
    castBindings: [],
    locationRevisionId: options.locations[0]?.id ?? "",
    styleRevisionId: options.styles[0]?.id ?? "",
    framing: "medium",
    targetFramesText: String(PLAN_DEFAULT_TARGET_FRAMES),
  }));
}

export type PlanDraftIssue = { code: string; message: string; field?: string };

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Client-side preflight for the create command (the server remains the truth). Covers the accepted
 * service rules the UI can check cheaply: stable unique shot IDs, full beat coverage, nonempty
 * intents, parseable frame counts, the 3-binding cast cap, per-binding wardrobe text, required
 * location/style pins, and the dialogue-speaker coverage rule.
 */
export function derivePlanDraftIssues(input: { story: StoryRevision; drafts: readonly PlanShotDraft[]; options?: PlanCanonOptions }): PlanDraftIssue[] {
  const issues: PlanDraftIssue[] = [];
  const seenShotIds = new Set<string>();
  for (const [index, draft] of input.drafts.entries()) {
    const label = draft.shotId.trim() || `#${index + 1}`;
    const field = (suffix: string) => `shots.${index}.${suffix}`;
    const shotId = draft.shotId.trim();
    if (shotId === "") issues.push({ code: "SHOT_ID_REQUIRED", message: `Shot ${label} needs a shot ID.`, field: field("shotId") });
    else if (!STABLE_ID_PATTERN.test(shotId) || shotId.length > 200) {
      issues.push({ code: "SHOT_ID_INVALID", message: `Shot ID "${shotId}" is not a canonical stable ID.`, field: field("shotId") });
    } else if (seenShotIds.has(shotId)) {
      issues.push({ code: "SHOT_ID_DUPLICATE", message: `Shot ID "${shotId}" is used by more than one shot.`, field: field("shotId") });
    } else {
      seenShotIds.add(shotId);
    }
    if (draft.beatIds.length === 0) {
      issues.push({ code: "SHOT_BEATS_REQUIRED", message: `Shot ${label} must cover at least one story beat.`, field: field("beatIds") });
    }
    if (draft.visualIntent.trim() === "") issues.push({ code: "VISUAL_INTENT_REQUIRED", message: `Shot ${label} needs a visual intent.`, field: field("visualIntent") });
    if (draft.motionIntent.trim() === "") issues.push({ code: "MOTION_INTENT_REQUIRED", message: `Shot ${label} needs a motion intent.`, field: field("motionIntent") });
    if (parsePlanTargetFrames(draft.targetFramesText) === null) {
      issues.push({ code: "FRAMES_INVALID", message: `Shot ${label} target frames must be a positive whole number up to 100000.`, field: field("targetFrames") });
    }
    if (draft.castBindings.length > 3) {
      issues.push({ code: "CAST_LIMIT", message: `Shot ${label} binds more than three cast members (contract cap is 3).`, field: field("castBindings") });
    }
    for (const binding of draft.castBindings) {
      if (binding.wardrobe.trim() === "") {
        issues.push({ code: "WARDROBE_REQUIRED", message: `Shot ${label} needs wardrobe text for ${binding.characterId}.`, field: field(`cast.${binding.characterId}.wardrobe`) });
      }
    }
    if (draft.locationRevisionId === "") {
      issues.push({
        code: "LOCATION_REQUIRED",
        message: input.options && input.options.locations.length === 0
          ? `Shot ${label} needs a location, but the story pins no currently-selected location canon — re-save the story from the script editor to pin the current canon.`
          : `Shot ${label} needs a location canon revision.`,
        field: field("location"),
      });
    }
    if (draft.styleRevisionId === "") {
      issues.push({
        code: "STYLE_REQUIRED",
        message: input.options && input.options.styles.length === 0
          ? `Shot ${label} needs a style, but the story pins no currently-selected style canon — re-save the story from the script editor to pin the current canon.`
          : `Shot ${label} needs a style canon revision.`,
        field: field("style"),
      });
    }
  }
  for (const beat of input.story.beats) {
    if (!input.drafts.some((draft) => draft.beatIds.includes(beat.id))) {
      issues.push({ code: "BEAT_UNCOVERED", message: `Story beat ${beat.id} has no shot coverage.`, field: `beats.${beat.id}` });
    }
    const speakers = new Set(beat.dialogue.map((line) => line.characterId));
    for (const speaker of speakers) {
      const covered = input.drafts.some((draft) =>
        draft.beatIds.includes(beat.id) && draft.castBindings.some((binding) => binding.characterId === speaker));
      if (!covered) {
        issues.push({
          code: "DIALOGUE_SPEAKER_UNBOUND",
          message: `Dialogue speaker ${speaker} for beat ${beat.id} has no covering shot with a cast binding.`,
          field: `beats.${beat.id}`,
        });
      }
    }
  }
  return issues;
}

/** The exact POST /api/production/projects/[id]/shot-plans body; exists only when no issue is open. */
export function deriveCreateShotPlanCommand(input: { projectId: string; story: StoryRevision; drafts: readonly PlanShotDraft[] }): CreateShotPlanCommand | null {
  if (derivePlanDraftIssues({ story: input.story, drafts: input.drafts }).length > 0) return null;
  return {
    projectId: input.projectId,
    storyRevisionId: input.story.id,
    approvedStoryHash: input.story.contentHash,
    shots: input.drafts.map((draft) => ({
      shotId: draft.shotId.trim(),
      beatIds: [...draft.beatIds],
      visualIntent: draft.visualIntent.trim(),
      motionIntent: draft.motionIntent.trim(),
      castBindings: draft.castBindings.map((binding) => ({
        characterId: binding.characterId,
        canonRevisionId: binding.canonRevisionId,
        wardrobe: binding.wardrobe.trim(),
      })),
      locationRevisionId: draft.locationRevisionId,
      propRevisionIds: [],
      styleRevisionId: draft.styleRevisionId,
      framing: draft.framing,
      targetFrames: parsePlanTargetFrames(draft.targetFramesText) as number,
      continuation: null,
    })),
  };
}

export type RevisionChecklistEntry = { id: string; passed: boolean; note: string };
export type RevisionApprovalCommandBody = { projectId: string; idempotencyKey: string; command: CreateApprovalCommand };

/**
 * The exact POST /api/production/approvals body for a shot-plan or animatic approval. Revision
 * kinds bind expectedHash to the revision's own contentHash (verified against the accepted pilot),
 * so no prior decision is required — only the complete all-passed checklist.
 */
export function deriveRevisionApprovalCommand(input: {
  projectId: string;
  idempotencyKey: string;
  targetKind: "shotplan" | "animatic";
  targetId: string;
  revisionHash: string;
  checklist: readonly RevisionChecklistEntry[];
  notes: string;
}): RevisionApprovalCommandBody | null {
  const checklist = APPROVAL_CHECKLISTS_VIEW[input.targetKind].map((id) => {
    const entry = input.checklist.find((candidate) => candidate.id === id);
    return { id, passed: entry?.passed === true, note: entry?.note ?? "" };
  });
  if (checklist.some((item) => !item.passed)) return null;
  const command: CreateApprovalCommand = {
    targetKind: input.targetKind,
    targetId: input.targetId,
    expectedHash: input.revisionHash,
    decision: "approved",
    checklist,
    notes: input.notes,
    advisoryAcknowledgements: [],
  };
  return { projectId: input.projectId, idempotencyKey: input.idempotencyKey, command };
}

export type PlanSummaryRow = { shotId: string; beatIds: string[]; framing: string; targetFrames: number; durationLabel: string };

/** Read-only plan-order summary of the active plan's shots (read model order, never resorted). */
export function derivePlanSummaryRows(shots: readonly ProjectReadModel["shots"][number][]): PlanSummaryRow[] {
  return shots.map((shot) => ({
    shotId: shot.shotRevision.shotId,
    beatIds: [...shot.shotRevision.beatIds],
    framing: shot.shotRevision.framing,
    targetFrames: shot.shotRevision.targetFrames,
    durationLabel: framesToDurationLabel(shot.shotRevision.targetFrames),
  }));
}

/** Clear warning when a newer plan would reset downstream approvals; null when none exists. */
export function deriveReplanWarning(plan: ShotPlanRevision | null): string | null {
  if (!plan) return null;
  return `A shot plan already exists (${plan.id}). Creating a newer plan re-points the project to it and resets downstream approvals — anchors and takes pinned to the previous plan stop being current.`;
}

/* ================================================================== */
/* Shared data access (HTTP only)                                      */
/* ================================================================== */

type MutationCall = { networkFailed: true } | { networkFailed: false; response: Response };

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

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

function freshIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ================================================================== */
/* Shared presentational helpers                                       */
/* ================================================================== */

function ErrorAlert({ view, lead }: { view: ErrorEnvelopeView; lead?: string }) {
  return (
    <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      {lead ? <p className="text-[13px] font-bold text-ink">{lead}</p> : null}
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Your work is unchanged — nothing was lost. You can retry.</p>
    </div>
  );
}

function MonoId({ value }: { value: string }) {
  return <span className="break-all font-mono text-[11.5px] text-muted">{value}</span>;
}

function PlanIssueList({ issues, label }: { issues: readonly PlanDraftIssue[]; label?: string }) {
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-danger">{label ?? "Fix before creating the plan"}</p>
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

function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" className="rounded-[12px] border border-border bg-raised px-6 py-14 text-center text-sm text-muted">
      {label}
    </div>
  );
}

function ReadModelLoadError({ error, onRetry }: { error: ErrorEnvelopeView; onRetry: () => void }) {
  return (
    <div className="space-y-4">
      <ErrorAlert view={error} lead="The project could not be loaded." />
      <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: "approved" | "rejected" | null }) {
  if (!decision) return <Badge tone="neutral">no decision</Badge>;
  return <Badge tone={decision === "approved" ? "success" : "danger"}>{decision}</Badge>;
}

/* ================================================================== */
/* Revision approve form (shot plan / animatic)                        */
/* ================================================================== */

function RevisionApproveForm({ projectId, targetKind, targetId, revisionHash, staleReason, latestDecision, onApproved }: {
  projectId: string;
  targetKind: "shotplan" | "animatic";
  targetId: string;
  revisionHash: string;
  /** Honest reason the revision is not the current pin; null when it is current. */
  staleReason: string | null;
  latestDecision: Approval | null;
  onApproved: () => void;
}) {
  const required = APPROVAL_CHECKLISTS_VIEW[targetKind];
  const label = targetKind === "shotplan" ? "shot plan" : "animatic";
  const [checks, setChecks] = useState<Record<string, RevisionChecklistEntry>>(() =>
    Object.fromEntries(required.map((id) => [id, { id, passed: false, note: "" } as RevisionChecklistEntry])));
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorEnvelopeView | null>(null);
  const [saved, setSaved] = useState<{ approvalId: string; created: boolean } | null>(null);

  const checklist = required.map((id) => checks[id] ?? { id, passed: false, note: "" });
  const allTicked = checklist.every((entry) => entry.passed);
  const approvedCurrent = !!latestDecision && latestDecision.decision === "approved" && latestDecision.targetHash === revisionHash;

  async function submit() {
    if (!allTicked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const command = deriveRevisionApprovalCommand({
        projectId, idempotencyKey: freshIdempotencyKey(), targetKind, targetId, revisionHash, checklist, notes,
      });
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
      onApproved();
    } finally {
      setSubmitting(false);
    }
  }

  if (approvedCurrent) {
    return (
      <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink" data-testid={`${targetKind}-approved`}>
        <Badge tone="success">approved</Badge>
        <span className="ml-2">
          The current {label} is approved — hash <span className="font-mono text-[12px]">{revisionHash}</span>.
        </span>
        {latestDecision ? (
          <span className="mt-0.5 block text-[12px] text-muted">
            Decision {latestDecision.id} · {latestDecision.actorId} · {formatDate(latestDecision.createdAt)} {formatTime(latestDecision.createdAt)}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <fieldset className="mt-3 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid={`${targetKind}-approve-workspace`}>
      <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Approve {label} — {targetId}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge decision={latestDecision?.decision ?? null} />
        <MonoId value={`hash ${revisionHash}`} />
      </div>
      {staleReason ? (
        <p role="alert" className="text-[12.5px] text-warning">
          <span className="font-mono text-[11px]">STALE_TARGET</span>
          <span className="ml-1.5">{staleReason}</span>
        </p>
      ) : null}
      <div className="space-y-2.5">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Required checklist ({required.length} items — tick every check to approve)</p>
        {required.map((id) => {
          const entry = checks[id] ?? { id, passed: false, note: "" };
          return (
            <div key={id} className="grid gap-2 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={entry.passed}
                  disabled={staleReason !== null}
                  onChange={(event) =>
                    setChecks((previous) => ({ ...previous, [id]: { ...entry, passed: event.target.checked } }))}
                />
                {id}
              </label>
              <input
                aria-label={`Note for checklist item ${id}`}
                value={entry.note}
                disabled={staleReason !== null}
                onChange={(event) => setChecks((previous) => ({ ...previous, [id]: { ...entry, note: event.target.value } }))}
                placeholder="Evidence note for this check"
                className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
              />
            </div>
          );
        })}
      </div>
      <FieldShell label="Notes" htmlFor={`${targetKind}-${targetId}-notes`} hint="Optional context recorded with the decision.">
        <textarea
          id={`${targetKind}-${targetId}-notes`}
          rows={2}
          value={notes}
          disabled={staleReason !== null}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
        />
      </FieldShell>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={staleReason !== null || !allTicked || submitting}
          loading={submitting}
          data-testid={`${targetKind}-approve-button`}
          onClick={() => void submit()}
        >
          {submitting ? "Submitting approval…" : `Approve ${label}`}
        </Button>
        {!allTicked && staleReason === null ? <span className="text-[12px] text-muted">Tick every checklist item to enable the approval.</span> : null}
      </div>
      {saved ? (
        <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
          {saved.created ? "Decision recorded" : "Decision already recorded (identical replay)"} — approval <span className="font-mono text-[12px]">{saved.approvalId}</span>.
        </div>
      ) : null}
      {error ? <ErrorAlert view={error} lead={`The ${label} approval could not be recorded.`} /> : null}
    </fieldset>
  );
}

/* ================================================================== */
/* Shot draft editor card                                              */
/* ================================================================== */

function ShotDraftCard({ story, draft, index, options, wardrobeDrafts, onPatch, onRemove, canRemove }: {
  story: StoryRevision;
  draft: PlanShotDraft;
  index: number;
  options: PlanCanonOptions;
  wardrobeDrafts: Record<string, string>;
  onPatch: (key: string, changes: Partial<PlanShotDraft>) => void;
  onRemove: (key: string) => void;
  canRemove: boolean;
}) {
  const label = draft.shotId.trim() || `#${index + 1}`;
  const parsedFrames = parsePlanTargetFrames(draft.targetFramesText);
  const onGrid = parsedFrames !== null && isLegalH3TargetFrames(parsedFrames);

  const toggleBeat = (beatId: string, checked: boolean) => {
    const beatIds = checked
      ? (draft.beatIds.includes(beatId) ? draft.beatIds : [...draft.beatIds, beatId])
      : draft.beatIds.filter((id) => id !== beatId);
    onPatch(draft.key, { beatIds });
  };
  const toggleCast = (character: CanonRevision, checked: boolean) => {
    if (checked) {
      const binding: PlanCastDraft = {
        characterId: character.entityId,
        canonRevisionId: character.id,
        wardrobe: wardrobeDrafts[character.entityId] ?? "",
      };
      onPatch(draft.key, { castBindings: [...draft.castBindings, binding] });
    } else {
      onPatch(draft.key, { castBindings: draft.castBindings.filter((binding) => binding.characterId !== character.entityId) });
    }
  };

  return (
    <Card className="p-4" as="article" >
      <div className="space-y-4" data-testid="plan-shot-draft" data-shot-id={draft.shotId}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold tabular-nums text-primary">{index + 1}</span>
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Shot draft {index + 1}</p>
          {canRemove ? (
            <Button variant="ghost" size="sm" icon="trash" className="ml-auto" onClick={() => onRemove(draft.key)}>
              Remove this shot draft
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell label="Shot ID" htmlFor={`${draft.key}-shot-id`} hint="Stable plan ID, e.g. shot_1.">
            <input
              id={`${draft.key}-shot-id`}
              value={draft.shotId}
              onChange={(event) => onPatch(draft.key, { shotId: event.target.value })}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <FieldShell label="Framing" htmlFor={`${draft.key}-framing`}>
            <select
              id={`${draft.key}-framing`}
              value={draft.framing}
              onChange={(event) => onPatch(draft.key, { framing: event.target.value as PlanShotFraming })}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            >
              {PLAN_SHOT_FRAMINGS.map((framing) => <option key={framing} value={framing}>{framing.replace(/_/g, " ")}</option>)}
            </select>
          </FieldShell>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-semibold text-ink-soft">Story beats covered</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {story.beats.map((beat) => (
              <label key={beat.id} className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={draft.beatIds.includes(beat.id)}
                  onChange={(event) => toggleBeat(beat.id, event.target.checked)}
                />
                <span className="font-mono text-[11.5px]">{beat.id}</span>
                <span className="text-muted">{beat.action}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <FieldShell label="Visual intent" htmlFor={`${draft.key}-visual`}>
          <textarea
            id={`${draft.key}-visual`}
            rows={2}
            value={draft.visualIntent}
            onChange={(event) => onPatch(draft.key, { visualIntent: event.target.value })}
            className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
        <FieldShell label="Motion intent" htmlFor={`${draft.key}-motion`}>
          <input
            id={`${draft.key}-motion`}
            value={draft.motionIntent}
            onChange={(event) => onPatch(draft.key, { motionIntent: event.target.value })}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell
            label="Target frames"
            htmlFor={`${draft.key}-frames`}
            hint={parsedFrames !== null ? framesSecondsHint(parsedFrames) : "Positive whole number, up to 100000."}
          >
            <div className="flex items-center gap-2">
              <input
                id={`${draft.key}-frames`}
                inputMode="numeric"
                value={draft.targetFramesText}
                onChange={(event) => onPatch(draft.key, { targetFramesText: event.target.value })}
                className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm tabular-nums text-ink focus:border-primary focus:outline-none"
              />
              {parsedFrames !== null ? (
                onGrid
                  ? <Badge tone="success">on H3 grid</Badge>
                  : <Badge tone="warning">off H3 grid</Badge>
              ) : null}
            </div>
          </FieldShell>
          <div className="self-end text-[12px] leading-snug text-muted">
            {parsedFrames !== null && !onGrid
              ? `Not on the legal 124 + 17n grid (max ${H3_FRAME_GRID.maxFrames}) — flagged for the provider, but the server accepts it and this does not block the create.`
              : "Legal H3 durations are 124 + 17n frames up to 362; 192 = 124 + 17·4."}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold text-ink-soft">Cast bindings (max 3)</legend>
          {options.characters.length === 0 ? (
            <p role="status" className="text-[12.5px] text-muted">No story-pinned character canon is currently selected — cast bindings are unavailable.</p>
          ) : (
            <div className="space-y-1.5">
              {options.characters.map((character) => {
                const binding = draft.castBindings.find((entry) => entry.characterId === character.entityId);
                const limitReached = !binding && draft.castBindings.length >= 3;
                return (
                  <div key={character.id} className="grid gap-2 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
                    <label className="flex items-center gap-2 text-[13px] text-ink" title={limitReached ? "A shot binds at most three cast members" : undefined}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--color-primary)]"
                        checked={!!binding}
                        disabled={limitReached}
                        onChange={(event) => toggleCast(character, event.target.checked)}
                      />
                      <span className="font-mono text-[11.5px]">{character.entityId}</span>
                      <span className="truncate text-muted">{character.description}</span>
                    </label>
                    {binding ? (
                      <input
                        aria-label={`Wardrobe for ${character.entityId} in shot ${label}`}
                        value={binding.wardrobe}
                        onChange={(event) =>
                          onPatch(draft.key, {
                            castBindings: draft.castBindings.map((entry) =>
                              entry.characterId === character.entityId ? { ...entry, wardrobe: event.target.value } : entry),
                          })}
                        placeholder="Wardrobe for this shot"
                        className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell label="Location canon revision" htmlFor={`${draft.key}-location`}>
            <select
              id={`${draft.key}-location`}
              value={draft.locationRevisionId}
              onChange={(event) => onPatch(draft.key, { locationRevisionId: event.target.value })}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            >
              {options.locations.length === 0 ? <option value="">no story-pinned location selected</option> : null}
              {options.locations.map((revision) => (
                <option key={revision.id} value={revision.id}>{revision.entityId} — {revision.description}</option>
              ))}
            </select>
          </FieldShell>
          <FieldShell label="Style canon revision" htmlFor={`${draft.key}-style`}>
            <select
              id={`${draft.key}-style`}
              value={draft.styleRevisionId}
              onChange={(event) => onPatch(draft.key, { styleRevisionId: event.target.value })}
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            >
              {options.styles.length === 0 ? <option value="">no story-pinned style selected</option> : null}
              {options.styles.map((revision) => (
                <option key={revision.id} value={revision.id}>{revision.entityId} — {revision.description}</option>
              ))}
            </select>
          </FieldShell>
        </div>
        <p className="text-[12px] text-muted">Props: none pinned · continuation: none (first plan keeps shots independent).</p>
      </div>
    </Card>
  );
}

/* ================================================================== */
/* /production/[projectId]/plan — plan builder panel                   */
/* ================================================================== */

type CreatedPlanState =
  | { kind: "idle" }
  | { kind: "created"; shotPlanRevision: ShotPlanRevision; animaticRevision: AnimaticRevision };

export function PlanBuilderPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);
  const [drafts, setDrafts] = useState<PlanShotDraft[]>([]);
  const [draftsForStoryId, setDraftsForStoryId] = useState<string | null>(null);
  const [wardrobeDrafts, setWardrobeDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<ErrorEnvelopeView | null>(null);
  const [created, setCreated] = useState<CreatedPlanState>({ kind: "idle" });

  const ready = state.phase === "ready";
  const readModel = ready ? state.readModel : null;
  const story = readModel?.storyRevision ?? null;
  const storyApproval = useMemo(() => deriveStoryApprovalState(readModel?.revisionApprovals ?? [], story), [readModel, story]);
  const options = useMemo(() => derivePlanCanonOptions(story, readModel?.canonRevisions ?? []), [story, readModel]);
  const plan = readModel?.shotPlanRevision ?? null;
  const animatic = readModel?.animaticRevision ?? null;
  const planCurrent = !!plan && !!story && plan.storyRevisionId === story.id;
  const animaticCurrent = !!animatic && !!plan && animatic.shotPlanRevisionId === plan.id;

  // (Re)seed the editable drafts once per story revision; never overwrite creator edits on reload.
  useEffect(() => {
    if (story && storyApproval.approvedCurrent && draftsForStoryId !== story.id) {
      setDrafts(derivePlanDraftFromBeats(story, options));
      setDraftsForStoryId(story.id);
    }
  }, [story, storyApproval.approvedCurrent, options, draftsForStoryId]);

  const issues = useMemo(
    () => (story ? derivePlanDraftIssues({ story, drafts, options }) : []),
    [story, drafts, options],
  );
  const command = useMemo(
    () => (story ? deriveCreateShotPlanCommand({ projectId, story, drafts }) : null),
    [projectId, story, drafts],
  );

  function patchDraft(key: string, changes: Partial<PlanShotDraft>) {
    setDrafts((previous) => previous.map((draft) => (draft.key === key ? { ...draft, ...changes } : draft)));
  }

  async function createPlan() {
    if (!command || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const call = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/shot-plans`, command);
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        setCreateError(deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed));
        return;
      }
      const body = payload as { shotPlanRevision?: unknown; animaticRevision?: unknown } | null;
      const planParsed = ShotPlanRevisionSchema.safeParse(body?.shotPlanRevision);
      const animaticParsed = AnimaticRevisionSchema.safeParse(body?.animaticRevision);
      if (!planParsed.success || !animaticParsed.success) {
        setCreateError({
          code: "UNKNOWN_RESPONSE",
          message: "The shot-plan endpoint returned an unexpected payload; the create may have landed — reload before retrying.",
          requestId: "unavailable",
          action: "Reload to check whether the plan was created.",
          retryable: true,
          status: call.response.status,
          shape: "unparseable",
        });
        return;
      }
      setCreated({ kind: "created", shotPlanRevision: planParsed.data, animaticRevision: animaticParsed.data });
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  const replanWarning = deriveReplanWarning(plan);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="plan-page">
      {state.phase === "loading" ? <LoadingPanel label="Loading plan builder…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} /> : null}
      {ready && readModel ? (
        <>
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production / {readModel.project.name} / Plan</p>
              <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Plan builder</h1>
              <p className="mt-1 text-[12px] text-muted">
                Build the shot plan and animatic from the approved story, then approve both. Rendering never calls a provider and never fabricates shots.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" icon="refresh" onClick={reload} data-testid="reload-button">Reload</Button>
              <LinkButton href={`/production/${projectId}`} size="sm" variant="secondary" icon="arrow-left">Overview</LinkButton>
              <LinkButton href={`/production/${projectId}/script`} size="sm" variant="ghost" icon="pen">Script editor</LinkButton>
              <LinkButton href={`/production/${projectId}/shots`} size="sm" variant="ghost" icon="grid">Storyboard</LinkButton>
            </div>
          </header>

          {!story ? (
            <div className="mt-6">
              <EmptyState
                icon="story"
                title="No story revision yet"
                body="A shot plan is built from an approved story revision, and none exists in the read model. Write and save the script first — this page renders only what the read model holds and never fabricates beats."
                action={<LinkButton href={`/production/${projectId}/script`} icon="pen">Open the script editor</LinkButton>}
              />
            </div>
          ) : null}

          {story && !storyApproval.approvedCurrent ? (
            <div className="mt-6">
              <EmptyState
                icon="check"
                title="The current story revision is not approved"
                body={`Story revision ${story.id} has no current human approval (an approval bound to its exact content hash). Approve the story in the script editor first — the plan builder stays closed until then.`}
                action={<LinkButton href={`/production/${projectId}/script`} icon="pen">Approve the story</LinkButton>}
              />
            </div>
          ) : null}

          {story && storyApproval.approvedCurrent && (options.locations.length === 0 || options.styles.length === 0) ? (
            <div role="alert" className="mt-6 rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
              <p className="text-[13px] font-bold text-ink">The story pins no currently-selected {options.locations.length === 0 ? "location" : "style"} canon</p>
              <p className="mt-1 text-[13px] leading-snug text-ink">
                Every shot needs a location and a style canon revision that is both selected by the project and pinned by the story. Re-save the story in the script editor to pin the current canon, then return here.
              </p>
              <div className="mt-2"><LinkButton href={`/production/${projectId}/script`} size="sm" variant="secondary" icon="pen">Open the script editor</LinkButton></div>
            </div>
          ) : null}

          {story && storyApproval.approvedCurrent ? (
            <>
              <section aria-label="Approval chain" className="mt-6" data-testid="plan-approval-chain">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Approval chain</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge tone="success">story approved</Badge>
                  {plan ? (
                    <Badge tone={latestDecisionFor(readModel.revisionApprovals, "shotplan", plan.id)?.decision === "approved" && latestDecisionFor(readModel.revisionApprovals, "shotplan", plan.id)?.targetHash === plan.contentHash ? "success" : "warning"}>
                      shot plan {latestDecisionFor(readModel.revisionApprovals, "shotplan", plan.id)?.decision === "approved" && latestDecisionFor(readModel.revisionApprovals, "shotplan", plan.id)?.targetHash === plan.contentHash ? "approved" : "not approved"}
                    </Badge>
                  ) : <Badge tone="neutral">no shot plan yet</Badge>}
                  {animatic ? (
                    <Badge tone={latestDecisionFor(readModel.revisionApprovals, "animatic", animatic.id)?.decision === "approved" && latestDecisionFor(readModel.revisionApprovals, "animatic", animatic.id)?.targetHash === animatic.contentHash ? "success" : "warning"}>
                      animatic {latestDecisionFor(readModel.revisionApprovals, "animatic", animatic.id)?.decision === "approved" && latestDecisionFor(readModel.revisionApprovals, "animatic", animatic.id)?.targetHash === animatic.contentHash ? "approved" : "not approved"}
                    </Badge>
                  ) : <Badge tone="neutral">no animatic yet</Badge>}
                </div>
              </section>

              <section aria-label="Current shot plan" className="mt-8" data-testid="current-plan-section">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Current shot plan &amp; animatic</h2>
                {!plan || !animatic ? (
                  <p role="status" className="mt-2 text-[13px] text-muted">
                    No shot plan exists yet — build one below from the approved story beats.
                  </p>
                ) : (
                  <div className="mt-3 space-y-4">
                    <Card className="p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="primary">shotplan</Badge>
                        <span className="text-sm font-semibold text-ink"><span className="font-mono text-[12px]">{plan.id}</span></span>
                        {!planCurrent ? <Badge tone="warning">stale pin</Badge> : null}
                        <MonoId value={`hash ${plan.contentHash}`} />
                      </div>
                      <table className="mt-3 w-full text-left text-[12.5px]" data-testid="plan-summary-table">
                        <thead>
                          <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted">
                            <th className="py-1.5 pr-3 font-bold">#</th>
                            <th className="py-1.5 pr-3 font-bold">Shot</th>
                            <th className="py-1.5 pr-3 font-bold">Beats</th>
                            <th className="py-1.5 pr-3 font-bold">Framing</th>
                            <th className="py-1.5 font-bold">Frames</th>
                          </tr>
                        </thead>
                        <tbody>
                          {derivePlanSummaryRows(readModel.shots).map((row, index) => (
                            <tr key={`${row.shotId}-${index}`} className="border-b border-border/60" data-testid="plan-summary-row" data-shot-id={row.shotId}>
                              <td className="py-1.5 pr-3 tabular-nums text-muted">{index + 1}</td>
                              <td className="py-1.5 pr-3 font-semibold text-ink">{row.shotId}</td>
                              <td className="py-1.5 pr-3 text-ink-soft">{row.beatIds.join(", ")}</td>
                              <td className="py-1.5 pr-3"><Badge tone="neutral">{row.framing.replace(/_/g, " ")}</Badge></td>
                              <td className="py-1.5 tabular-nums text-ink-soft">{row.targetFrames} · {row.durationLabel}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <RevisionApproveForm
                        projectId={projectId}
                        targetKind="shotplan"
                        targetId={plan.id}
                        revisionHash={plan.contentHash}
                        staleReason={planCurrent ? null : "this plan is pinned to a different story revision; build a newer plan from the current story"}
                        latestDecision={latestDecisionFor(readModel.revisionApprovals, "shotplan", plan.id)}
                        onApproved={reload}
                      />
                    </Card>
                    <Card className="p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="primary">animatic</Badge>
                        <span className="text-sm font-semibold text-ink"><span className="font-mono text-[12px]">{animatic.id}</span></span>
                        {!animaticCurrent ? <Badge tone="warning">stale pin</Badge> : null}
                        <span className="text-[12px] tabular-nums text-muted">{animatic.totalFrames} frames total · {animatic.slots.length} slots</span>
                        <MonoId value={`hash ${animatic.contentHash}`} />
                      </div>
                      <RevisionApproveForm
                        projectId={projectId}
                        targetKind="animatic"
                        targetId={animatic.id}
                        revisionHash={animatic.contentHash}
                        staleReason={animaticCurrent ? null : "this animatic is pinned to a different shot plan; build a newer plan from the current story"}
                        latestDecision={latestDecisionFor(readModel.revisionApprovals, "animatic", animatic.id)}
                        onApproved={reload}
                      />
                    </Card>
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkButton href={`/production/${projectId}/shots`} size="sm" variant="secondary" icon="grid">Open the storyboard</LinkButton>
                    </div>
                  </div>
                )}
                {created.kind === "created" ? (
                  <div role="status" className="mt-3 rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink" data-testid="plan-created-banner">
                    Shot plan <span className="font-mono text-[12px]">{created.shotPlanRevision.id}</span> and animatic{" "}
                    <span className="font-mono text-[12px]">{created.animaticRevision.id}</span> created — approve both below (or after the reload) to unlock anchors and takes.
                  </div>
                ) : null}
              </section>

              {replanWarning ? (
                <div role="alert" className="mt-6 rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3" data-testid="replan-warning">
                  <p className="text-[13px] font-bold text-ink">Re-planning resets downstream approvals</p>
                  <p className="mt-1 text-[13px] leading-snug text-ink">{replanWarning}</p>
                </div>
              ) : null}

              <section aria-label="Build a shot plan" className="mt-8" data-testid="plan-builder">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">
                  {plan ? "Build a newer shot plan" : "Build a shot plan from the approved story beats"}
                </h2>
                <p className="mt-1 text-[12px] text-muted">
                  One editable shot draft per story beat. Every field below is editable before the create; the server re-validates the whole command.
                </p>

                {options.characters.length > 0 ? (
                  <Card className="mt-3 p-4">
                    <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Cast wardrobe (applied when you tick a cast member in a shot)</p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {options.characters.map((character) => (
                        <FieldShell key={character.id} label={`Wardrobe for ${character.entityId}`} htmlFor={`wardrobe-${character.entityId}`}>
                          <input
                            id={`wardrobe-${character.entityId}`}
                            value={wardrobeDrafts[character.entityId] ?? ""}
                            onChange={(event) => setWardrobeDrafts((previous) => ({ ...previous, [character.entityId]: event.target.value }))}
                            placeholder="Wardrobe text for new bindings"
                            className="h-9 w-full rounded-[7px] border border-border-strong bg-raised px-3 text-[13px] text-ink focus:border-primary focus:outline-none"
                          />
                        </FieldShell>
                      ))}
                    </div>
                  </Card>
                ) : null}

                <div className="mt-3 space-y-4">
                  {drafts.map((draft, index) => (
                    <ShotDraftCard
                      key={draft.key}
                      story={story}
                      draft={draft}
                      index={index}
                      options={options}
                      wardrobeDrafts={wardrobeDrafts}
                      onPatch={patchDraft}
                      onRemove={(key) => setDrafts((previous) => previous.filter((entry) => entry.key !== key))}
                      canRemove={drafts.length > 1}
                    />
                  ))}
                </div>

                <div className="mt-4 space-y-3">
                  <PlanIssueList issues={issues} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      icon="plus"
                      disabled={!story || submitting}
                      onClick={() => {
                        if (!story) return;
                        setDrafts((previous) => [...previous, {
                          key: `shot-draft-added-${previous.length + 1}-${Date.now().toString(36)}`,
                          shotId: `shot_${previous.length + 1}`,
                          beatIds: [],
                          visualIntent: "",
                          motionIntent: PLAN_DEFAULT_MOTION_INTENT,
                          castBindings: [],
                          locationRevisionId: options.locations[0]?.id ?? "",
                          styleRevisionId: options.styles[0]?.id ?? "",
                          framing: "medium",
                          targetFramesText: String(PLAN_DEFAULT_TARGET_FRAMES),
                        }]);
                      }}
                    >
                      Add another shot draft
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="refresh"
                      disabled={!story || submitting}
                      onClick={() => {
                        if (!story) return;
                        setDrafts(derivePlanDraftFromBeats(story, options));
                      }}
                    >
                      Reset to one draft per beat
                    </Button>
                    <Button
                      size="sm"
                      icon="check"
                      disabled={command === null || submitting}
                      loading={submitting}
                      data-testid="create-plan-button"
                      onClick={() => void createPlan()}
                    >
                      {submitting ? "Creating shot plan…" : plan ? "Create newer shot plan (resets downstream approvals)" : "Create shot plan & animatic"}
                    </Button>
                    {command === null && !submitting ? <span className="text-[12px] text-muted">Resolve the issues above to enable the create.</span> : null}
                  </div>
                  {createError ? <ErrorAlert view={createError} lead="The shot plan could not be created." /> : null}
                </div>
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
