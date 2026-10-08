"use client";

/**
 * C08 storyboard/anchors/takes UI.
 *
 * Speaks HTTP only: reads via GET /api/production/projects/[projectId] (read model v2) and mutates
 * via the accepted production routes (POST approvals, POST shots/[shotId]/selection, POST
 * media-quotes, POST shots/[shotId]/anchors, POST shots/[shotId]/takes). No server rule is
 * reimplemented: stale notices come verbatim from the accepted deriveStaleDependencyNotices, and
 * the required approval checklists mirror lib/production/approval.ts APPROVAL_CHECKLISTS verbatim
 * (that module is server-only — it imports lib/jobs — so the UI carries an exact mirror that
 * lib/production/storyboard.test.ts asserts against the accepted constants).
 *
 * The exported plain functions at the top are pure view-model helpers (no hooks, no window, no
 * fetch) so tests can import them in a node environment.
 *
 * Fail-closed rules honored throughout: a failed mutation renders the error envelope (code +
 * message + requestId) and keeps every input; candidates without a prior decision expose no
 * approval hash in the read model, so their approval controls stay disabled with that exact honest
 * reason; anchor/take generation is never auto-invoked by rendering and BUDGET_BLOCKED envelopes
 * render as the blocked state; offline projects render explicit empty states naming the
 * prerequisite chain, with no fabricated candidates.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Badge, Button, Card, EmptyState, FieldShell, LinkButton, formatDate, formatTime } from "@/components/ui";
import { deriveMutationFailure, formatEnvelope, type ErrorEnvelopeView } from "@/components/production/project-canon";
import { deriveStaleDependencyNotices, type StaleDependencyNotice, type ValidationIssue } from "@/lib/production/project-canon";
import { PRODUCTION_MODEL_DEFAULTS, productionModelOptions, type ProductionModelKind, type ProductionModelOption } from "@/lib/providers/production/sogni-h3";
import {
  ProjectReadModelSchema, ProviderRequestSnapshotSchema, SelectTakeCommandSchema,
  type Approval, type CanonRevision, type CreateApprovalCommand, type ProductionJob, type ProjectReadModel,
  type SelectTakeCommand, type ShotRevision, type Take,
} from "@/lib/production/contracts";

/* ================================================================== */
/* Pure view-model helpers (no hooks / window / fetch — test in node)  */
/* ================================================================== */

/** Display constant: the render profile fps (contracts RenderProfileSchema fps literal). */
export const ANIMATIC_FPS = 24;
/** Read-model shots per rendered chunk. A page size, never a ceiling. */
export const SHOTS_PER_CHUNK = 6;
/** Frozen honest note shown next to every pinned reference asset ID. */
export const REFERENCE_MEDIA_NOTE = "reference media not exposed by the read model";

/**
 * Exact mirror of lib/production/approval.ts APPROVAL_CHECKLISTS for the kinds this UI can gate.
 * The accepted module is server-only (it imports computeAnchorApprovalHash from lib/jobs), so the
 * UI mirrors the frozen lists; lib/production/storyboard.test.ts asserts this mirror matches the
 * accepted constants so a UI preflight and the server validation cannot drift.
 */
export const APPROVAL_CHECKLISTS_VIEW = {
  story: ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"],
  shotplan: ["beat_coverage", "spoken_lines", "canon_bindings", "duration_format", "plot_fidelity"],
  animatic: ["beat_coverage", "spoken_lines", "timing", "duration_format", "continuity"],
  anchor: ["identity", "wardrobe", "location", "props", "framing"],
  take: ["identity", "wardrobe", "location", "props", "intended_action", "motion_camera", "artifacts"],
} as const;

export type ApprovalDecisionTargetKind = keyof typeof APPROVAL_CHECKLISTS_VIEW;
export type DecisionIssue = { code: string; message: string };
export type ChecklistEntry = { id: string; passed: boolean | null; note: string };
export type Acknowledgement = { code: string; reason: string };
export type ReadModelShot = ProjectReadModel["shots"][number];

/** Integer-math duration label for a frame count at 24fps: "1.500s" style, never floating seconds. */
export function framesToDurationLabel(frames: number): string {
  const safe = Number.isSafeInteger(frames) && frames > 0 ? frames : 0;
  const scaled = safe * 1000;
  const totalMs = (scaled - (scaled % ANIMATIC_FPS)) / ANIMATIC_FPS;
  const whole = Math.trunc(totalMs / 1000);
  return `${whole}.${String(totalMs - whole * 1000).padStart(3, "0")}s`;
}

export type ShotboardRow = { index: number; shot: ReadModelShot; durationFrames: number; durationLabel: string };
export type ShotboardModel = { rows: ShotboardRow[]; chunks: ShotboardRow[][]; chunkCount: number };

/**
 * Stable shotboard order: exactly the read-model shots[] order (plan order). No sorting of any
 * kind — indices and chunks are derived from the array so order is stable across chunk boundaries.
 */
export function deriveShotboardModel(shots: readonly ReadModelShot[], chunkSize: number = SHOTS_PER_CHUNK): ShotboardModel {
  const size = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : SHOTS_PER_CHUNK;
  const rows: ShotboardRow[] = shots.map((shot, index) => ({
    index: index + 1,
    shot,
    durationFrames: shot.shotRevision.targetFrames,
    durationLabel: framesToDurationLabel(shot.shotRevision.targetFrames),
  }));
  const chunks: ShotboardRow[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) chunks.push(rows.slice(offset, offset + size));
  return { rows, chunks: chunks.length > 0 ? chunks : [[]], chunkCount: chunks.length };
}

/** The newest decision for one target, deterministic even when createdAt values tie. */
export function latestDecisionFor(approvals: readonly Approval[], targetKind: Approval["targetKind"], targetId: string): Approval | null {
  const matching = approvals.filter((approval) => approval.targetKind === targetKind && approval.targetId === targetId);
  matching.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return matching[0] ?? null;
}

const isCurrentlyApproved = (approvals: readonly Approval[], kind: Approval["targetKind"], targetId: string, contentHash: string): boolean => {
  const latest = latestDecisionFor(approvals, kind, targetId);
  return !!latest && latest.decision === "approved" && latest.targetHash === contentHash;
};

/** Pending (non-terminal) anchor/take jobs whose recorded result target is this shot revision. */
export function derivePendingMediaJobs(jobs: readonly ProductionJob[], shotRevisionId: string): ProductionJob[] {
  return jobs.filter((job) => {
    if (job.operation !== "anchor" && job.operation !== "take") return false;
    const snapshot = ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot);
    return snapshot.success && snapshot.data.resultTarget?.shotRevisionId === shotRevisionId;
  });
}

export type ShotCurrency = {
  shotCurrent: boolean;
  storyApprovedCurrent: boolean;
  shotPlanApprovedCurrent: boolean;
  animaticApprovedCurrent: boolean;
  pendingMediaJob: boolean;
};

/** Whether one shot is part of the current story/plan/animatic chain, with the approval preflight facts. */
export function deriveShotCurrency(readModel: ProjectReadModel, shot: ReadModelShot): ShotCurrency {
  const story = readModel.storyRevision;
  const plan = readModel.shotPlanRevision;
  const animatic = readModel.animaticRevision;
  const shotCurrent = !!(story && plan && animatic &&
    shot.shotRevision.storyRevisionId === story.id &&
    plan.orderedShotRevisionIds.includes(shot.shotRevision.id) &&
    animatic.slots.some((slot) => slot.shotRevisionId === shot.shotRevision.id));
  return {
    shotCurrent,
    storyApprovedCurrent: !!(story && isCurrentlyApproved(readModel.revisionApprovals, "story", story.id, story.contentHash)),
    shotPlanApprovedCurrent: !!(plan && isCurrentlyApproved(readModel.revisionApprovals, "shotplan", plan.id, plan.contentHash)),
    animaticApprovedCurrent: !!(animatic && isCurrentlyApproved(readModel.revisionApprovals, "animatic", animatic.id, animatic.contentHash)),
    pendingMediaJob: derivePendingMediaJobs(readModel.activeJobs, shot.shotRevision.id).length > 0,
  };
}

export type ShotStaleNotices =
  | { ok: true; notices: readonly StaleDependencyNotice[] }
  | { ok: false; issues: readonly ValidationIssue[] };

/** Shot/shotplan stale rows derived verbatim from the accepted derivation, never paraphrased. */
export function deriveShotStaleNotices(readModel: Pick<ProjectReadModel, "schemaVersion" | "dependencyIssues" | "shots">): ShotStaleNotices {
  const derived = deriveStaleDependencyNotices(
    { schemaVersion: readModel.schemaVersion, dependencyIssues: readModel.dependencyIssues },
    readModel.shots,
  );
  if (!derived.ok) return derived;
  return { ok: true, notices: derived.value.filter((notice) => notice.targetKind === "shot" || notice.targetKind === "shotplan") };
}

export type PinnedCanon = {
  revisionId: string;
  entityId: string;
  entityKind: CanonRevision["entityKind"];
  description: string;
  referenceAssetIds: string[];
};
export type ShotProvenance = {
  cast: { characterId: string; revisionId: string; wardrobe: string; canon: PinnedCanon | null }[];
  location: PinnedCanon | null;
  props: PinnedCanon[];
  style: PinnedCanon | null;
  referenceAssetIds: string[];
  referenceNote: string;
};

const toPinnedCanon = (revision: CanonRevision | undefined): PinnedCanon | null =>
  revision
    ? {
        revisionId: revision.id, entityId: revision.entityId, entityKind: revision.entityKind,
        description: revision.description, referenceAssetIds: [...revision.referenceAssetIds],
      }
    : null;

/** Pinned canon provenance for one shot; unknown pins resolve to null instead of a guessed description. */
export function deriveShotProvenance(shot: ShotRevision, canonRevisions: readonly CanonRevision[]): ShotProvenance {
  const byId = new Map(canonRevisions.map((revision) => [revision.id, revision]));
  const cast = shot.castBindings.map((binding) => ({
    characterId: binding.characterId,
    revisionId: binding.canonRevisionId,
    wardrobe: binding.wardrobe,
    canon: toPinnedCanon(byId.get(binding.canonRevisionId)),
  }));
  const location = toPinnedCanon(byId.get(shot.locationRevisionId));
  const props = shot.propRevisionIds.map((id) => toPinnedCanon(byId.get(id))).filter((pin): pin is PinnedCanon => pin !== null);
  const style = toPinnedCanon(byId.get(shot.styleRevisionId));
  const referenceAssetIds: string[] = [];
  for (const pin of [...cast.map((entry) => entry.canon), location, ...props, style]) {
    for (const assetId of pin?.referenceAssetIds ?? []) {
      if (!referenceAssetIds.includes(assetId)) referenceAssetIds.push(assetId);
    }
  }
  return { cast, location, props, style, referenceAssetIds, referenceNote: REFERENCE_MEDIA_NOTE };
}

/* ---------------- Approval readiness (frozen gating rules) ---------------- */

export type ApprovalDecisionInput = {
  projectId: string;
  idempotencyKey: string;
  targetKind: ApprovalDecisionTargetKind;
  targetId: string;
  /** False when the candidate is not part of the current story/plan/animatic selection. */
  current: boolean;
  pendingJob: boolean;
  /** Anchors only: visionAssessment.status, or null when absent (server treats null as "unavailable"). */
  visionStatus: string | null;
  /** Latest prior decision for this target from the read model; the only honest hash source. */
  latestDecision: Approval | null;
  /** Revision targets only: displayed revision contentHash, for the stale-hash preflight. */
  displayedRevisionHash: string | null;
  decision: "approved" | "rejected";
  checklist: readonly ChecklistEntry[];
  notes: string;
  acknowledgements: readonly Acknowledgement[];
};
export type ApprovalReadiness =
  | { ok: true; expectedHash: string; reasons: readonly [] }
  | { ok: false; expectedHash: string | null; reasons: readonly DecisionIssue[] };

const checklistOrder = (targetKind: ApprovalDecisionTargetKind): readonly string[] => APPROVAL_CHECKLISTS_VIEW[targetKind];

/**
 * Frozen approval gating: enabled ONLY when (a) the candidate is current, (b) every required
 * checklist item is explicitly set (all passed for an approval), (c) a rejected decision carries a
 * reason, and (d) anchors with a non-pass vision status carry the exact `vision_<status>`
 * acknowledgement (mirroring the server rule, null -> vision_unavailable). The expected hash comes
 * ONLY from the candidate's latest prior decision in the read model — a candidate without one has
 * no exported hash and stays disabled with the frozen honest reason.
 */
export function deriveApprovalReadiness(input: ApprovalDecisionInput): ApprovalReadiness {
  const reasons: DecisionIssue[] = [];
  const latest = input.latestDecision;
  const expectedHash = latest?.targetHash ?? null;
  if (input.idempotencyKey.trim() === "") {
    reasons.push({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "an idempotency key is required to submit a decision" });
  }
  if (!latest) {
    reasons.push({ code: "APPROVAL_HASH_UNAVAILABLE", message: "approval hash unavailable from the read model" });
  }
  if (!input.current) {
    reasons.push({
      code: "STALE_TARGET",
      message: `stale: this ${input.targetKind} candidate is not part of the current story, shot plan, and animatic selection`,
    });
  }
  if (latest && input.displayedRevisionHash !== null && latest.targetHash !== input.displayedRevisionHash) {
    reasons.push({ code: "STALE_REVISION_HASH", message: "stale: the recorded approval hash no longer matches the displayed revision hash" });
  }
  if (latest?.decision === "rejected") {
    reasons.push({ code: "REJECTED_LATEST", message: "the latest human decision for this candidate is a rejection; approval is disabled" });
  }
  if (input.pendingJob) {
    reasons.push({ code: "PENDING_JOB", message: "a generation job for this candidate is still pending" });
  }
  let hasFailedCheckWithNote = false;
  for (const requiredId of checklistOrder(input.targetKind)) {
    const entry = input.checklist.find((candidate) => candidate.id === requiredId);
    if (!entry || entry.passed === null) {
      reasons.push({ code: "CHECKLIST_UNSET", message: `checklist item "${requiredId}" is not set` });
      continue;
    }
    if (entry.passed === false && entry.note.trim() !== "") hasFailedCheckWithNote = true;
    if (input.decision === "approved" && entry.passed === false) {
      reasons.push({ code: "CHECKLIST_FAILED", message: `checklist item "${requiredId}" is marked failed` });
    }
  }
  if (input.decision === "rejected" && input.notes.trim() === "" && !hasFailedCheckWithNote) {
    reasons.push({ code: "REJECTION_REASON_REQUIRED", message: "a rejected decision requires notes or a failed checklist item with a note" });
  }
  if (input.targetKind === "anchor") {
    const visionStatus = input.visionStatus ?? "unavailable";
    if (visionStatus !== "pass") {
      const requiredCode = `vision_${visionStatus}`;
      const acknowledged = input.acknowledgements.some((ack) => ack.code === requiredCode && ack.reason.trim() !== "");
      if (!acknowledged) {
        reasons.push({ code: "VISION_ACK_REQUIRED", message: `an explicit "${requiredCode}" acknowledgement with a reason is required` });
      }
    }
  }
  if (reasons.length === 0 && expectedHash !== null) return { ok: true, expectedHash, reasons: [] };
  return { ok: false, expectedHash, reasons };
}

export type ApprovalRouteCommandBody = { projectId: string; idempotencyKey: string; command: CreateApprovalCommand };

/** The exact POST /api/production/approvals body; exists only when every gate passed. */
export function deriveApprovalCommand(input: ApprovalDecisionInput): ApprovalRouteCommandBody | null {
  const readiness = deriveApprovalReadiness(input);
  if (!readiness.ok) return null;
  const checklist = checklistOrder(input.targetKind).map((id) => {
    const entry = input.checklist.find((candidate) => candidate.id === id);
    return { id, passed: entry?.passed === true, note: entry?.note ?? "" };
  });
  const command: CreateApprovalCommand = {
    targetKind: input.targetKind,
    targetId: input.targetId,
    expectedHash: readiness.expectedHash,
    decision: input.decision,
    checklist,
    notes: input.notes,
    advisoryAcknowledgements: input.acknowledgements.map((ack) => ({ code: ack.code, reason: ack.reason })),
  };
  return { projectId: input.projectId, idempotencyKey: input.idempotencyKey, command };
}

/* ---------------- Take selection (project-global CAS) ---------------- */

/** The exact selection command: expectedSelectionVersion is carried exactly as read, never guessed. */
export function deriveSelectionCommand(projectId: string, shotRevisionId: string, takeId: string | null, takeSelection: ReadModelShot["takeSelection"]): SelectTakeCommand {
  return SelectTakeCommandSchema.parse({
    projectId,
    shotRevisionId,
    takeId,
    expectedSelectionVersion: takeSelection.version,
  });
}

export type TakeRow = { take: Take; selected: boolean; latestDecision: Approval | null };

/** Sibling takes newest-first with the selection pin and each take's latest decision. */
export function deriveTakeRows(shot: Pick<ReadModelShot, "takeHistory" | "approvals" | "takeSelection">): TakeRow[] {
  return [...shot.takeHistory]
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((take) => ({
      take,
      selected: shot.takeSelection.takeId === take.id,
      latestDecision: latestDecisionFor(shot.approvals, "take", take.id),
    }));
}

export type AnchorRow = { anchor: ReadModelShot["anchorHistory"][number]; latestDecision: Approval | null };

/** Anchor candidates newest-first with each candidate's latest decision. */
export function deriveAnchorRows(shot: Pick<ReadModelShot, "anchorHistory" | "approvals">): AnchorRow[] {
  return [...shot.anchorHistory]
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((anchor) => ({ anchor, latestDecision: latestDecisionFor(shot.approvals, "anchor", anchor.id) }));
}

/** Honest display text for what a rejection will and will not do to the selection. */
export function deriveRejectionSelectionNotice(selectedTakeId: string | null, rejectedTakeId: string): string {
  if (selectedTakeId === rejectedTakeId) {
    return `Take ${rejectedTakeId} is the selected take; rejecting it does not auto-select a sibling — the selection is retained until you explicitly reverse it.`;
  }
  if (selectedTakeId !== null) {
    return `Take ${rejectedTakeId} is not the selected take (selected: ${selectedTakeId}); the selection is untouched.`;
  }
  return `Take ${rejectedTakeId} is rejected; no take is selected for this shot, and none will be auto-selected.`;
}

/** Honest empty-state text naming the prerequisite chain; no fabricated candidates. */
export function deriveHistoryEmptyState(kind: "anchor" | "take", shotId: string): string {
  return kind === "anchor"
    ? `No anchors exist for shot ${shotId}. Anchors require the prerequisite chain — an approved current story, an approved shot plan, an approved animatic, and a completed anchor generation job — and none are present in the read model.`
    : `No takes exist for shot ${shotId}. Takes require an approved anchor candidate and a completed take generation job, and none are present in the read model.`;
}

/* ---------------- Generation (anchor/take) submit gates ---------------- */

export type GenerationGateInput = {
  operation: "anchor" | "take";
  providerId: string;
  modelId: string;
  storyApprovedCurrent: boolean;
  shotPlanApprovedCurrent: boolean;
  animaticApprovedCurrent: boolean;
  shotCurrent: boolean;
  pendingJob: boolean;
  anchorApprovedCurrent: boolean;
};
export type GenerationReadiness = { ok: boolean; reasons: readonly DecisionIssue[] };

/** Client preflight for the enqueue route's APPROVAL_REQUIRED rules; the server remains the truth. */
export function deriveGenerationReadiness(input: GenerationGateInput): GenerationReadiness {
  const reasons: DecisionIssue[] = [];
  if (input.providerId.trim() === "" || input.modelId.trim() === "") {
    reasons.push({ code: "PROVIDER_MODEL_REQUIRED", message: "a provider and model are required before a quote can be requested" });
  }
  if (!input.shotCurrent) {
    reasons.push({ code: "SHOT_NOT_CURRENT", message: "this shot is not part of the current story, shot plan, and animatic selection" });
  }
  if (!input.storyApprovedCurrent) {
    reasons.push({ code: "STORY_APPROVAL_REQUIRED", message: "the current story revision has no matching human approval; approve the story first" });
  }
  if (!input.shotPlanApprovedCurrent) {
    reasons.push({ code: "SHOT_PLAN_APPROVAL_REQUIRED", message: "the current shot plan has no matching human approval; approve the shot plan first" });
  }
  if (!input.animaticApprovedCurrent) {
    reasons.push({ code: "ANIMATIC_APPROVAL_REQUIRED", message: "the current animatic has no matching human approval; approve the animatic first" });
  }
  if (input.operation === "take" && !input.anchorApprovedCurrent) {
    reasons.push({ code: "ANCHOR_APPROVAL_REQUIRED", message: "this shot has no current approved anchor; approve an anchor before generating a take" });
  }
  if (input.pendingJob) {
    reasons.push({ code: "PENDING_JOB", message: "a generation job for this shot is already pending" });
  }
  return { ok: reasons.length === 0, reasons };
}

/* ---------------- Production model dropdowns (anchor/take generate forms) ---------------- */

/** A model dropdown entry exactly as GET /api/production/models serves it. */
export type ProductionModelOptionView = ProductionModelOption;

/** Offline/failure fallback: exactly the accepted production baseline, mirroring the route's merge. */
export function baselineProductionModelOptions(kind: ProductionModelKind): ProductionModelOptionView[] {
  return productionModelOptions(kind, []);
}

/** Strict view of the route payload; null tells the caller to fall back to the baseline options. */
export function parseProductionModelsPayload(payload: unknown): ProductionModelOptionView[] | null {
  const parsed = z.strictObject({
    provider: z.strictObject({ id: z.string(), label: z.string() }),
    models: z.array(z.strictObject({ id: z.string(), label: z.string(), mode: z.enum(["image", "image-to-video"]) })),
  }).safeParse(payload);
  return parsed.success ? parsed.data.models : null;
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

function newIdempotencyKey(prefix: string): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

/** One fetch per kind per page load; every generate form on the page shares the same promise. */
const productionModelsCatalogCache = new Map<ProductionModelKind, Promise<ProductionModelOptionView[]>>();

function loadProductionModelOptions(kind: ProductionModelKind): Promise<ProductionModelOptionView[]> {
  const cached = productionModelsCatalogCache.get(kind);
  if (cached) return cached;
  const loaded = (async () => {
    try {
      const response = await fetch(`/api/production/models?kind=${kind}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`model catalog request failed with status ${response.status}`);
      const options = parseProductionModelsPayload(await responsePayload(response));
      if (!options) throw new Error("model catalog response did not match the expected shape");
      return options;
    } catch {
      // Belt and braces: the route already degrades to the baseline; mirror that client-side.
      return baselineProductionModelOptions(kind);
    }
  })();
  productionModelsCatalogCache.set(kind, loaded);
  return loaded;
}

/** Model dropdown options for one form kind; disabled while the shared fetch is in flight. */
function useProductionModelOptions(kind: ProductionModelKind): { loading: boolean; options: ProductionModelOptionView[] } {
  const [state, setState] = useState<{ loading: boolean; options: ProductionModelOptionView[] }>({ loading: true, options: baselineProductionModelOptions(kind) });
  useEffect(() => {
    let stopped = false;
    void loadProductionModelOptions(kind).then((options) => {
      if (!stopped) setState({ loading: false, options });
    });
    return () => { stopped = true; };
  }, [kind]);
  return state;
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

function BlockedAlert({ view, lead }: { view: ErrorEnvelopeView; lead: string }) {
  return (
    <div role="alert" className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Nothing was submitted. The server owns the entitlement decision; adjust the request or configure the provider.</p>
    </div>
  );
}

function StatusRegion({ lines, testId }: { lines: readonly string[]; testId?: string }) {
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid={testId} className="rounded-[8px] border border-primary/25 bg-primary-soft/60 px-3.5 py-3">
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

function GateReasons({ reasons, testId }: { reasons: readonly DecisionIssue[]; testId: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul role="status" data-testid={testId} className="space-y-1 rounded-[8px] border border-border bg-surface px-3 py-2.5">
      {reasons.map((reason) => (
        <li key={`${reason.code}-${reason.message}`} className="text-[12.5px] leading-snug text-ink-soft">
          <span className="font-mono text-[11px] text-muted">{reason.code}</span>
          <span className="ml-1.5">{reason.message}</span>
        </li>
      ))}
    </ul>
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

function NoShotsEmptyState({ projectId }: { projectId: string }) {
  return (
    <EmptyState
      icon="grid"
      title="No shots yet"
      body="A shotboard requires an approved story revision and a shot plan. Create them from the project page; this page renders only what the read model holds and never fabricates shots."
      action={<LinkButton href={`/production/${projectId}`} icon="arrow-left">Open the project</LinkButton>}
    />
  );
}

function PanelHeader({ projectId, projectName, crumb, title, intro, reload }: {
  projectId: string; projectName: string; crumb: string; title: string; intro: string; reload: () => void;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Production / {projectName} / {crumb}</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">{title}</h1>
        <p className="mt-1 text-[12px] text-muted">{intro}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" icon="refresh" onClick={reload} data-testid="reload-button">Reload</Button>
        <LinkButton href={`/production/${projectId}`} size="sm" variant="secondary" icon="arrow-left">Overview</LinkButton>
        <LinkButton href={`/production/${projectId}/shots`} size="sm" variant="ghost" icon="grid">Storyboard</LinkButton>
        <LinkButton href={`/production/${projectId}/anchors`} size="sm" variant="ghost" icon="image">Anchors</LinkButton>
        <LinkButton href={`/production/${projectId}/takes`} size="sm" variant="ghost" icon="video">Takes</LinkButton>
      </div>
    </header>
  );
}

function DecisionBadge({ decision }: { decision: "approved" | "rejected" | null }) {
  if (!decision) return <Badge tone="neutral">no decision</Badge>;
  return <Badge tone={decision === "approved" ? "success" : "danger"}>{decision}</Badge>;
}

function ChecklistSummary({ approval }: { approval: Approval }) {
  if (approval.checklist.length === 0) return <span className="text-[12px] text-muted">no checklist recorded</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Checklist summary">
      {approval.checklist.map((item) => (
        <li
          key={item.id}
          className={`rounded-[5px] px-2 py-0.5 text-[11px] font-semibold ${item.passed ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}
        >
          {item.id} {item.passed ? "pass" : "fail"}
        </li>
      ))}
    </ul>
  );
}

/* ================================================================== */
/* Approval workspace (checklist-gated approve/reject commands)        */
/* ================================================================== */

type ApprovalWorkspaceProps = {
  projectId: string;
  targetKind: ApprovalDecisionTargetKind;
  targetId: string;
  candidateLabel: string;
  current: boolean;
  pendingJob: boolean;
  visionStatus: string | null;
  latestDecision: Approval | null;
  displayedRevisionHash: string | null;
};

function ApprovalWorkspace(props: ApprovalWorkspaceProps) {
  const { projectId, targetKind, targetId, candidateLabel } = props;
  const required = APPROVAL_CHECKLISTS_VIEW[targetKind];
  const [checks, setChecks] = useState<Record<string, ChecklistEntry>>(
    () => Object.fromEntries(required.map((id) => [id, { id, passed: null, note: "" } as ChecklistEntry])),
  );
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [notes, setNotes] = useState("");
  const [ackReason, setAckReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorEnvelopeView | null>(null);
  const [saved, setSaved] = useState<{ approvalId: string; created: boolean } | null>(null);

  const visionStatus = targetKind === "anchor" ? props.visionStatus ?? "unavailable" : null;
  const visionRequired = visionStatus !== null && visionStatus !== "pass";
  const visionCode = `vision_${visionStatus ?? "unavailable"}`;
  const checklist = required.map((id) => checks[id] ?? { id, passed: null, note: "" });
  const acknowledgements: Acknowledgement[] = visionRequired ? [{ code: visionCode, reason: ackReason }] : [];
  const input: ApprovalDecisionInput = {
    projectId,
    idempotencyKey,
    targetKind,
    targetId,
    current: props.current,
    pendingJob: props.pendingJob,
    visionStatus: targetKind === "anchor" ? props.visionStatus : null,
    latestDecision: props.latestDecision,
    displayedRevisionHash: props.displayedRevisionHash,
    decision,
    checklist,
    notes,
    acknowledgements,
  };
  const readiness = useMemo(() => deriveApprovalReadiness(input), [input]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const command = deriveApprovalCommand(input);
    if (!command || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <fieldset className="mt-3 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="approval-workspace">
      <legend className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Approval decision — {candidateLabel}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge decision={props.latestDecision?.decision ?? null} />
        {props.latestDecision ? <MonoId value={`hash ${props.latestDecision.targetHash}`} /> : <span className="text-[12px] text-warning">no prior decision — the read model exports no approval hash</span>}
      </div>
      {!readiness.ok ? <GateReasons reasons={readiness.reasons} testId="approval-gate-reasons" /> : null}

      <div className="space-y-2.5">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Required checklist ({required.length} items — every item must be set)</p>
        {required.map((id) => {
          const entry = checks[id] ?? { id, passed: null, note: "" };
          return (
            <div key={id} className="grid gap-2 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={entry.passed === true}
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

      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label="Decision" htmlFor={`${targetId}-decision`}>
          <select
            id={`${targetId}-decision`}
            value={decision}
            onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
          </select>
        </FieldShell>
        <FieldShell label="Idempotency key" htmlFor={`${targetId}-idempotency`} hint="Required; reuse a key only for the exact same command.">
          <input
            id={`${targetId}-idempotency`}
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 font-mono text-[12.5px] text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
      </div>
      <FieldShell label="Notes" htmlFor={`${targetId}-notes`} hint="A rejection requires notes or a failed checklist item with a note.">
        <textarea
          id={`${targetId}-notes`}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm text-ink focus:border-primary focus:outline-none"
        />
      </FieldShell>
      {visionRequired ? (
        <FieldShell
          label={`Acknowledgement ${visionCode} (required)`}
          htmlFor={`${targetId}-vision-ack`}
          hint={`Vision status is "${visionStatus}"; the server rejects this approval without an explicit ${visionCode} acknowledgement and reason.`}
        >
          <input
            id={`${targetId}-vision-ack`}
            value={ackReason}
            onChange={(event) => setAckReason(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={!readiness.ok || submitting}
          loading={submitting}
          onClick={() => void submit()}
        >
          {submitting ? "Submitting decision…" : `Submit ${decision}`}
        </Button>
        {!readiness.ok ? <span className="text-[12px] text-muted">Submit is disabled until every reason above is resolved.</span> : null}
      </div>

      {saved ? (
        <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
          {saved.created ? "Decision recorded" : "Decision already recorded (identical replay)"} — approval <span className="font-mono text-[12px]">{saved.approvalId}</span>. Reload to see it in the read model.
        </div>
      ) : null}
      {error ? <ErrorAlert view={error} lead="The approval could not be recorded." /> : null}
    </fieldset>
  );
}

/* ================================================================== */
/* Generation submit forms (gated, never auto-invoked)                 */
/* ================================================================== */

type GenerationPhase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "blocked"; view: ErrorEnvelopeView }
  | { kind: "failed"; view: ErrorEnvelopeView }
  | { kind: "queued"; jobId: string; jobStatus: string };

function GenerationResultView({ phase }: { phase: GenerationPhase }) {
  if (phase.kind === "blocked") {
    return <BlockedAlert view={phase.view} lead="Generation is blocked — the server refused the media quote." />;
  }
  if (phase.kind === "failed") {
    return <ErrorAlert view={phase.view} lead="The generation request could not be submitted." />;
  }
  if (phase.kind === "queued") {
    return (
      <div role="status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
        Job <span className="font-mono text-[12px]">{phase.jobId}</span> accepted with status {phase.jobStatus}. Reload to see it under pending jobs; results appear only after the worker and provider complete it.
      </div>
    );
  }
  return null;
}

function useGenerationForm(kind: ProductionModelKind) {
  const [providerId, setProviderId] = useState("sogni");
  const [modelId, setModelId] = useState<string>(PRODUCTION_MODEL_DEFAULTS[kind]);
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [seedText, setSeedText] = useState("");
  const [phase, setPhase] = useState<GenerationPhase>({ kind: "idle" });
  return { providerId, setProviderId, modelId, setModelId, aspect, setAspect, seedText, setSeedText, phase, setPhase };
}

function seedOrNull(seedText: string): { seed: number | null; valid: boolean } {
  if (seedText.trim() === "") return { seed: null, valid: true };
  const parsed = Number(seedText);
  return { seed: parsed, valid: Number.isSafeInteger(parsed) && parsed >= 0 };
}

function AnchorSubmitForm({ projectId, shot, gate }: { projectId: string; shot: ReadModelShot; gate: ShotCurrency }) {
  const form = useGenerationForm("anchor");
  const modelCatalog = useProductionModelOptions("anchor");
  const [resolution, setResolution] = useState<"480p" | "720p" | "1080p">("720p");
  const [referenceText, setReferenceText] = useState("");
  const seed = seedOrNull(form.seedText);
  const readiness = deriveGenerationReadiness({
    operation: "anchor",
    providerId: form.providerId,
    modelId: form.modelId,
    storyApprovedCurrent: gate.storyApprovedCurrent,
    shotPlanApprovedCurrent: gate.shotPlanApprovedCurrent,
    animaticApprovedCurrent: gate.animaticApprovedCurrent,
    shotCurrent: gate.shotCurrent,
    pendingJob: gate.pendingMediaJob,
    anchorApprovedCurrent: true,
  });
  const disabled = !readiness.ok || !seed.valid || form.phase.kind === "running";

  async function submit() {
    if (disabled) return;
    const renderSettings = {
      providerId: form.providerId.trim(),
      modelId: form.modelId.trim(),
      aspect: form.aspect,
      resolution,
      seed: seed.seed,
      referenceAssetIds: referenceText.split(/[\s,]+/).filter(Boolean),
    };
    form.setPhase({ kind: "running" });
    try {
      const quoteCall = await postJson("/api/production/media-quotes", {
        kind: "anchor",
        command: { projectId, shotRevisionId: shot.shotRevision.id, renderSettings },
      });
      const quotePayload = quoteCall.networkFailed ? null : await responsePayload(quoteCall.response);
      if (quoteCall.networkFailed || !quoteCall.response.ok) {
        const view = deriveMutationFailure(quoteCall.networkFailed ? null : quoteCall.response.status, quotePayload, quoteCall.networkFailed);
        form.setPhase(view.code === "BUDGET_BLOCKED" ? { kind: "blocked", view } : { kind: "failed", view });
        return;
      }
      const quoteId = typeof (quotePayload as { id?: unknown })?.id === "string" ? (quotePayload as { id: string }).id : null;
      if (!quoteId) {
        form.setPhase({
          kind: "failed",
          view: {
            code: "UNKNOWN_RESPONSE", message: "The quote response had no quote ID; nothing was enqueued.",
            requestId: "unavailable", action: "Retry; if it repeats, inspect the local server logs.",
            retryable: true, status: quoteCall.response.status, shape: "unparseable",
          },
        });
        return;
      }
      const enqueueCall = await postJson(`/api/production/shots/${encodeURIComponent(shot.shotRevision.shotId)}/anchors`, {
        projectId,
        shotRevisionId: shot.shotRevision.id,
        quoteId,
        idempotencyKey: newIdempotencyKey("anchor"),
        renderSettings,
      });
      const enqueuePayload = enqueueCall.networkFailed ? null : await responsePayload(enqueueCall.response);
      if (enqueueCall.networkFailed || !enqueueCall.response.ok) {
        const view = deriveMutationFailure(enqueueCall.networkFailed ? null : enqueueCall.response.status, enqueuePayload, enqueueCall.networkFailed);
        form.setPhase(view.code === "BUDGET_BLOCKED" ? { kind: "blocked", view } : { kind: "failed", view });
        return;
      }
      const job = (enqueuePayload as { job?: { id?: unknown; status?: unknown } } | null)?.job;
      form.setPhase({
        kind: "queued",
        jobId: typeof job?.id === "string" ? job.id : "unknown",
        jobStatus: typeof job?.status === "string" ? job.status : "unknown",
      });
    } catch (error) {
      form.setPhase({
        kind: "failed",
        view: {
          code: "UNKNOWN_RESPONSE",
          message: `The generation request could not be completed: ${error instanceof Error ? error.message : "unexpected failure"}; nothing was enqueued.`,
          requestId: "unavailable",
          action: "Retry; if it repeats, inspect the local server logs.",
          retryable: true,
          status: null,
          shape: "unparseable",
        },
      });
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="anchor-submit-form">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Generate an anchor (explicit submit — never automatic)</p>
      <p className="text-[12px] text-muted">
        Requests a media quote first, then enqueues the anchor job only if the quote succeeds. BUDGET_BLOCKED or unknown-entitlement envelopes are shown as the blocked state; nothing renders a job.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label="Provider" htmlFor={`anchor-${shot.shotRevision.id}-provider`}>
          <select
            id={`anchor-${shot.shotRevision.id}-provider`}
            data-testid="anchor-provider-input"
            value={form.providerId}
            onChange={(event) => form.setProviderId(event.target.value)}
            disabled={form.phase.kind === "running"}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="sogni">sogni</option>
          </select>
        </FieldShell>
        <FieldShell label="Model" htmlFor={`anchor-${shot.shotRevision.id}-model`}>
          <select
            id={`anchor-${shot.shotRevision.id}-model`}
            data-testid="anchor-model-input"
            value={modelCatalog.loading ? "" : form.modelId}
            onChange={(event) => form.setModelId(event.target.value)}
            disabled={modelCatalog.loading || form.phase.kind === "running"}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            {modelCatalog.loading ? (
              <option value="">Loading models…</option>
            ) : (
              modelCatalog.options.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))
            )}
          </select>
        </FieldShell>
        <FieldShell label="Aspect" htmlFor={`anchor-${shot.shotRevision.id}-aspect`}>
          <select
            id={`anchor-${shot.shotRevision.id}-aspect`}
            value={form.aspect}
            onChange={(event) => form.setAspect(event.target.value as "9:16" | "16:9")}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
          </select>
        </FieldShell>
        <FieldShell label="Resolution" htmlFor={`anchor-${shot.shotRevision.id}-resolution`}>
          <select
            id={`anchor-${shot.shotRevision.id}-resolution`}
            value={resolution}
            onChange={(event) => setResolution(event.target.value as "480p" | "720p" | "1080p")}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
        </FieldShell>
        <FieldShell label="Seed (optional)" htmlFor={`anchor-${shot.shotRevision.id}-seed`} hint="Nonnegative integer; leave empty for provider default.">
          <input
            id={`anchor-${shot.shotRevision.id}-seed`}
            value={form.seedText}
            onChange={(event) => form.setSeedText(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
        <FieldShell label="Reference asset IDs (optional)" htmlFor={`anchor-${shot.shotRevision.id}-refs`} hint="Comma-separated; only assets the read model already knows.">
          <input
            id={`anchor-${shot.shotRevision.id}-refs`}
            value={referenceText}
            onChange={(event) => setReferenceText(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 font-mono text-[12.5px] text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
      </div>
      {!seed.valid ? (
        <p role="status" className="text-[12.5px] text-ink-soft">
          <span className="font-mono text-[11px] text-muted">SEED_INVALID</span>
          <span className="ml-1.5">the seed must be a nonnegative integer.</span>
        </p>
      ) : null}
      <GateReasons reasons={readiness.reasons} testId="anchor-submit-gate-reasons" />
      <Button
        size="sm"
        icon="sparkle"
        disabled={disabled}
        data-testid="anchor-submit-button"
        data-shot-id={shot.shotRevision.shotId}
        onClick={() => void submit()}
      >
        {form.phase.kind === "running" ? "Requesting quote…" : "Request quote and enqueue anchor generation"}
      </Button>
      <GenerationResultView phase={form.phase} />
    </div>
  );
}

function TakeSubmitForm({ projectId, shot, gate, approvedAnchor }: {
  projectId: string; shot: ReadModelShot; gate: ShotCurrency;
  approvedAnchor: { anchor: ReadModelShot["anchorHistory"][number]; latestDecision: Approval } | null;
}) {
  const form = useGenerationForm("take");
  const modelCatalog = useProductionModelOptions("take");
  const [prompt, setPrompt] = useState("");
  const [targetFramesText, setTargetFramesText] = useState(String(shot.shotRevision.targetFrames));
  const parsedFrames = Number(targetFramesText);
  const framesValid = Number.isSafeInteger(parsedFrames) && parsedFrames > 0;
  const promptValid = prompt.trim() !== "";
  const readiness = deriveGenerationReadiness({
    operation: "take",
    providerId: form.providerId,
    modelId: form.modelId,
    storyApprovedCurrent: gate.storyApprovedCurrent,
    shotPlanApprovedCurrent: gate.shotPlanApprovedCurrent,
    animaticApprovedCurrent: gate.animaticApprovedCurrent,
    shotCurrent: gate.shotCurrent,
    pendingJob: gate.pendingMediaJob,
    anchorApprovedCurrent: approvedAnchor !== null,
  });
  const disabled = !readiness.ok || !framesValid || !promptValid || form.phase.kind === "running";

  async function submit() {
    if (disabled || !approvedAnchor) return;
    const motionSettings = {
      providerId: form.providerId.trim(),
      modelId: form.modelId.trim(),
      prompt: prompt.trim(),
      targetFrames: parsedFrames,
      aspect: form.aspect,
      seed: seedOrNull(form.seedText).seed,
    };
    form.setPhase({ kind: "running" });
    try {
      const quoteCall = await postJson("/api/production/media-quotes", {
        kind: "take",
        command: {
          projectId,
          shotRevisionId: shot.shotRevision.id,
          anchorId: approvedAnchor.anchor.id,
          approvalId: approvedAnchor.latestDecision.id,
          motionSettings,
        },
      });
      const quotePayload = quoteCall.networkFailed ? null : await responsePayload(quoteCall.response);
      if (quoteCall.networkFailed || !quoteCall.response.ok) {
        const view = deriveMutationFailure(quoteCall.networkFailed ? null : quoteCall.response.status, quotePayload, quoteCall.networkFailed);
        form.setPhase(view.code === "BUDGET_BLOCKED" ? { kind: "blocked", view } : { kind: "failed", view });
        return;
      }
      const quoteId = typeof (quotePayload as { id?: unknown })?.id === "string" ? (quotePayload as { id: string }).id : null;
      if (!quoteId) {
        form.setPhase({
          kind: "failed",
          view: {
            code: "UNKNOWN_RESPONSE", message: "The quote response had no quote ID; nothing was enqueued.",
            requestId: "unavailable", action: "Retry; if it repeats, inspect the local server logs.",
            retryable: true, status: quoteCall.response.status, shape: "unparseable",
          },
        });
        return;
      }
      const enqueueCall = await postJson(`/api/production/shots/${encodeURIComponent(shot.shotRevision.shotId)}/takes`, {
        projectId,
        shotRevisionId: shot.shotRevision.id,
        anchorId: approvedAnchor.anchor.id,
        approvalId: approvedAnchor.latestDecision.id,
        quoteId,
        idempotencyKey: newIdempotencyKey("take"),
        motionSettings,
      });
      const enqueuePayload = enqueueCall.networkFailed ? null : await responsePayload(enqueueCall.response);
      if (enqueueCall.networkFailed || !enqueueCall.response.ok) {
        const view = deriveMutationFailure(enqueueCall.networkFailed ? null : enqueueCall.response.status, enqueuePayload, enqueueCall.networkFailed);
        form.setPhase(view.code === "BUDGET_BLOCKED" ? { kind: "blocked", view } : { kind: "failed", view });
        return;
      }
      const job = (enqueuePayload as { job?: { id?: unknown; status?: unknown } } | null)?.job;
      form.setPhase({
        kind: "queued",
        jobId: typeof job?.id === "string" ? job.id : "unknown",
        jobStatus: typeof job?.status === "string" ? job.status : "unknown",
      });
    } catch (error) {
      form.setPhase({
        kind: "failed",
        view: {
          code: "UNKNOWN_RESPONSE",
          message: `The generation request could not be completed: ${error instanceof Error ? error.message : "unexpected failure"}; nothing was enqueued.`,
          requestId: "unavailable",
          action: "Retry; if it repeats, inspect the local server logs.",
          retryable: true,
          status: null,
          shape: "unparseable",
        },
      });
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-[8px] border border-border bg-surface p-3.5" data-testid="take-submit-form">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Generate a take (explicit submit — never automatic)</p>
      <p className="text-[12px] text-muted">
        Requires a current approved anchor; requests a media quote first, then enqueues the take job only if the quote succeeds.
        {approvedAnchor ? ` Approved anchor: ${approvedAnchor.anchor.id} (approval ${approvedAnchor.latestDecision.id}).` : " No approved anchor exists for this shot yet."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldShell label="Provider" htmlFor={`take-${shot.shotRevision.id}-provider`}>
          <select
            id={`take-${shot.shotRevision.id}-provider`}
            data-testid="take-provider-input"
            value={form.providerId}
            onChange={(event) => form.setProviderId(event.target.value)}
            disabled={form.phase.kind === "running"}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="sogni">sogni</option>
          </select>
        </FieldShell>
        <FieldShell label="Model" htmlFor={`take-${shot.shotRevision.id}-model`}>
          <select
            id={`take-${shot.shotRevision.id}-model`}
            data-testid="take-model-input"
            value={modelCatalog.loading ? "" : form.modelId}
            onChange={(event) => form.setModelId(event.target.value)}
            disabled={modelCatalog.loading || form.phase.kind === "running"}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            {modelCatalog.loading ? (
              <option value="">Loading models…</option>
            ) : (
              modelCatalog.options.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))
            )}
          </select>
        </FieldShell>
        <FieldShell label="Motion prompt" htmlFor={`take-${shot.shotRevision.id}-prompt`} hint="Nonempty motion intent for this take.">
          <input
            id={`take-${shot.shotRevision.id}-prompt`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
        <FieldShell label="Target frames" htmlFor={`take-${shot.shotRevision.id}-frames`} hint="Positive integer frame count.">
          <input
            id={`take-${shot.shotRevision.id}-frames`}
            value={targetFramesText}
            onChange={(event) => setTargetFramesText(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
        <FieldShell label="Aspect" htmlFor={`take-${shot.shotRevision.id}-aspect`}>
          <select
            id={`take-${shot.shotRevision.id}-aspect`}
            value={form.aspect}
            onChange={(event) => form.setAspect(event.target.value as "9:16" | "16:9")}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
          >
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
          </select>
        </FieldShell>
        <FieldShell label="Seed (optional)" htmlFor={`take-${shot.shotRevision.id}-seed`} hint="Nonnegative integer; leave empty for provider default.">
          <input
            id={`take-${shot.shotRevision.id}-seed`}
            value={form.seedText}
            onChange={(event) => form.setSeedText(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          />
        </FieldShell>
      </div>
      {!framesValid ? (
        <p role="status" className="text-[12.5px] text-ink-soft">
          <span className="font-mono text-[11px] text-muted">FRAMES_INVALID</span>
          <span className="ml-1.5">target frames must be a positive integer.</span>
        </p>
      ) : null}
      <GateReasons reasons={readiness.reasons} testId="take-submit-gate-reasons" />
      <Button
        size="sm"
        icon="sparkle"
        disabled={disabled}
        data-testid="take-submit-button"
        data-shot-id={shot.shotRevision.shotId}
        onClick={() => void submit()}
      >
        {form.phase.kind === "running" ? "Requesting quote…" : "Request quote and enqueue take generation"}
      </Button>
      <GenerationResultView phase={form.phase} />
    </div>
  );
}

/* ================================================================== */
/* /production/[projectId]/shots — ordered shotboard                   */
/* ================================================================== */

function ShotProvenanceRow({ shot, canonRevisions }: { shot: ShotRevision; canonRevisions: readonly CanonRevision[] }) {
  const provenance = useMemo(() => deriveShotProvenance(shot, canonRevisions), [shot, canonRevisions]);
  return (
    <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[150px_minmax(0,1fr)]">
      <dt className="font-semibold text-ink-soft">Cast pins</dt>
      <dd>
        {provenance.cast.length === 0 ? (
          <span className="text-muted">none (no cast bindings)</span>
        ) : (
          <ul className="space-y-0.5">
            {provenance.cast.map((binding) => (
              <li key={`${binding.characterId}-${binding.revisionId}`}>
                <span className="font-mono text-[11.5px]">{binding.characterId}</span> → <span className="font-mono text-[11.5px]">{binding.revisionId}</span>
                {binding.canon ? <span className="text-muted"> — {binding.canon.description}</span> : <span className="text-warning"> — pinned canon revision not in the read model</span>}
                <span className="text-muted"> · wardrobe: {binding.wardrobe}</span>
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt className="font-semibold text-ink-soft">Location pin</dt>
      <dd>
        {provenance.location ? (
          <>
            <span className="font-mono text-[11.5px]">{provenance.location.revisionId}</span>
            <span className="text-muted"> — {provenance.location.description}</span>
          </>
        ) : (
          <span className="text-warning">pinned location revision is not in the read model</span>
        )}
      </dd>
      <dt className="font-semibold text-ink-soft">Prop pins</dt>
      <dd>
        {provenance.props.length === 0 ? (
          <span className="text-muted">none</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {provenance.props.map((pin) => (
              <MonoId key={pin.revisionId} value={`${pin.revisionId} — ${pin.description}`} />
            ))}
          </span>
        )}
      </dd>
      <dt className="font-semibold text-ink-soft">Style pin</dt>
      <dd>
        {provenance.style ? (
          <>
            <span className="font-mono text-[11.5px]">{provenance.style.revisionId}</span>
            <span className="text-muted"> — {provenance.style.description}</span>
          </>
        ) : (
          <span className="text-warning">pinned style revision is not in the read model</span>
        )}
      </dd>
      <dt className="font-semibold text-ink-soft">Reference media</dt>
      <dd>
        {provenance.referenceAssetIds.length === 0 ? (
          <span className="text-muted">none pinned</span>
        ) : (
          <>
            <span className="flex flex-wrap gap-1.5">
              {provenance.referenceAssetIds.map((assetId) => <MonoId key={assetId} value={assetId} />)}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-warning">{provenance.referenceNote}</span>
          </>
        )}
      </dd>
    </dl>
  );
}

type RevisionApprovalView = {
  kind: "story" | "shotplan" | "animatic";
  targetId: string;
  revisionHash: string;
  stale: boolean;
};

function RevisionApprovalCard({ view, approvals }: { view: RevisionApprovalView; approvals: readonly Approval[] }) {
  const latest = latestDecisionFor(approvals, view.kind, view.targetId);
  const hashDrift = latest !== null && latest.targetHash !== view.revisionHash;
  const staleLabel = view.kind === "story" ? "Story" : view.kind === "shotplan" ? "Shot plan" : "Animatic";
  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">{view.kind}</Badge>
          <DecisionBadge decision={latest?.decision ?? null} />
          <span className="text-sm font-semibold text-ink">{staleLabel} revision <span className="font-mono text-[12px]">{view.targetId}</span></span>
          {view.stale ? <Badge tone="warning">stale pin</Badge> : null}
          {hashDrift ? <Badge tone="warning">hash drift</Badge> : null}
        </div>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[150px_minmax(0,1fr)]">
          <dt className="font-semibold text-ink-soft">Decision</dt>
          <dd>
            {latest ? (
              <>
                {latest.decision} by <span className="font-mono text-[11.5px]">{latest.actorId}</span> · {formatDate(latest.createdAt)} {formatTime(latest.createdAt)}
              </>
            ) : (
              <span className="text-muted">no human decision recorded for this revision</span>
            )}
          </dd>
          <dt className="font-semibold text-ink-soft">Checklist summary</dt>
          <dd>{latest ? <ChecklistSummary approval={latest} /> : <span className="text-muted">none</span>}</dd>
          <dt className="font-semibold text-ink-soft">Approval hash</dt>
          <dd>{latest ? <MonoId value={latest.targetHash} /> : <span className="text-muted">none recorded</span>}</dd>
        </dl>
        {hashDrift ? (
          <p role="status" className="mt-2 text-[12.5px] text-warning">
            The recorded approval hash no longer matches the displayed revision hash — the revision changed after the decision.
          </p>
        ) : null}
      </Card>
    </li>
  );
}

export function ShotsPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [staleFilter, setStaleFilter] = useState<"all" | "shot">("all");

  const board = useMemo(
    () => (state.phase === "ready" ? deriveShotboardModel(state.readModel.shots) : null),
    [state],
  );
  const notices = useMemo(
    () => (state.phase === "ready" ? deriveShotStaleNotices(state.readModel) : null),
    [state],
  );
  const filteredNotices = useMemo(() => {
    if (!notices?.ok) return null;
    return staleFilter === "all" ? notices.notices : notices.notices.filter((notice) => notice.targetKind === "shot");
  }, [notices, staleFilter]);
  const safeChunkIndex = board ? Math.min(chunkIndex, Math.max(0, board.chunkCount - 1)) : 0;
  const chunk = board?.chunks[safeChunkIndex] ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="shots-page">
      {state.phase === "loading" ? <LoadingPanel label="Loading shotboard…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} /> : null}
      {state.phase === "ready" ? (
        <>
          <PanelHeader
            projectId={projectId}
            projectName={state.readModel.project.name}
            crumb="Storyboard"
            title="Storyboard"
            intro="Ordered shots from the active shot plan with pinned canon provenance, exact stale notices and approval states. Rendering never calls a provider."
            reload={reload}
          />

          {board && board.rows.length === 0 ? (
            <div className="mt-6"><NoShotsEmptyState projectId={projectId} /></div>
          ) : null}

          {board && board.rows.length > 0 ? (
            <section aria-label="Shot order" className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Shot order ({board.rows.length} shots, plan order)</h2>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary" size="sm" icon="arrow-left"
                    aria-label="Previous shots"
                    disabled={safeChunkIndex === 0}
                    onClick={() => setChunkIndex(Math.max(0, safeChunkIndex - 1))}
                  >
                    Previous
                  </Button>
                  <span role="status" data-testid="chunk-status" className="text-[12px] tabular-nums text-muted">
                    Chunk {safeChunkIndex + 1} of {board.chunkCount} — shots {chunk.length > 0 ? chunk[0].index : 0}–{chunk.length > 0 ? chunk[chunk.length - 1].index : 0} of {board.rows.length}
                  </span>
                  <Button
                    variant="secondary" size="sm" iconRight="arrow-right"
                    aria-label="Next shots"
                    disabled={safeChunkIndex >= board.chunkCount - 1}
                    onClick={() => setChunkIndex(Math.min(board.chunkCount - 1, safeChunkIndex + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
              <ol className="mt-3 space-y-3">
                {chunk.map((row) => (
                  <li key={row.shot.shotRevision.id}>
                    <Card className="p-4" as="article">
                      <div className="flex flex-wrap items-center gap-2" data-testid="shot-row" data-shot-id={row.shot.shotRevision.shotId} data-index={row.index}>
                        <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold tabular-nums text-primary">{row.index}</span>
                        <span className="text-sm font-semibold text-ink">{row.shot.shotRevision.shotId}</span>
                        <Badge tone="neutral">{row.shot.shotRevision.framing.replace(/_/g, " ")}</Badge>
                        <span className="text-[12px] tabular-nums text-muted" data-testid="shot-duration" data-frames={row.durationFrames} data-label={row.durationLabel}>
                          {row.durationFrames} frames · {row.durationLabel} at {ANIMATIC_FPS} fps
                        </span>
                      </div>
                      <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[150px_minmax(0,1fr)]">
                        <dt className="font-semibold text-ink-soft">Visual intent</dt>
                        <dd className="text-ink">{row.shot.shotRevision.visualIntent}</dd>
                        <dt className="font-semibold text-ink-soft">Motion intent</dt>
                        <dd className="text-ink">{row.shot.shotRevision.motionIntent}</dd>
                        <dt className="font-semibold text-ink-soft">Shot revision</dt>
                        <dd><MonoId value={row.shot.shotRevision.id} /></dd>
                      </dl>
                      <ShotProvenanceRow shot={row.shot.shotRevision} canonRevisions={state.readModel.canonRevisions} />
                    </Card>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {notices ? (
            <section aria-label="Stale shot work" className="mt-6" data-testid="stale-region">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Stale shot work</h2>
                <div className="flex gap-2" role="group" aria-label="Stale notice filter">
                  <Button
                    variant={staleFilter === "all" ? "secondary" : "ghost"} size="sm"
                    aria-pressed={staleFilter === "all"}
                    onClick={() => setStaleFilter("all")}
                  >
                    shot + plan
                  </Button>
                  <Button
                    variant={staleFilter === "shot" ? "secondary" : "ghost"} size="sm"
                    aria-pressed={staleFilter === "shot"}
                    onClick={() => setStaleFilter("shot")}
                  >
                    shots only
                  </Button>
                </div>
              </div>
              {!notices.ok ? (
                <div role="alert" className="mt-2 rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3 text-[13px] text-ink">
                  Stale notices could not be derived: {notices.issues.map((issue) => issue.message).join(" ")}
                </div>
              ) : filteredNotices && filteredNotices.length === 0 ? (
                <p role="status" className="mt-2 text-[13px] text-muted">No stale shot or shot-plan work — pins match the active selections.</p>
              ) : filteredNotices ? (
                <ul className="mt-2 space-y-2">
                  {filteredNotices.map((notice) => (
                    <li
                      key={`${notice.code}-${notice.targetKind}-${notice.targetId}-${notice.pinnedDependencyId}`}
                      data-testid="stale-notice"
                      data-code={notice.code}
                      data-pinned={notice.pinnedDependencyId}
                      data-active={notice.activeDependencyId ?? ""}
                      className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3"
                    >
                      <p className="text-[13px] leading-snug text-ink">
                        <Badge tone="warning">{notice.code}</Badge>
                        <span className="ml-2">{notice.message}</span>
                      </p>
                      <p className="mt-1 text-[12px] text-ink-soft">
                        Pinned dependency: <span className="font-mono text-[11.5px]">{notice.pinnedDependencyId}</span>
                        {" · "}Active dependency: <span className="font-mono text-[11.5px]">{notice.activeDependencyId ?? "gone"}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {state.phase === "ready" ? (
            <section aria-label="Revision approval states" className="mt-6" data-testid="approval-states">
              <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Revision approval states (story, shot plan, animatic)</h2>
              {state.readModel.storyRevision || state.readModel.shotPlanRevision || state.readModel.animaticRevision ? (
                <ul className="mt-3 space-y-3">
                  {state.readModel.storyRevision ? (
                    <RevisionApprovalCard
                      view={{ kind: "story", targetId: state.readModel.storyRevision.id, revisionHash: state.readModel.storyRevision.contentHash, stale: false }}
                      approvals={state.readModel.revisionApprovals}
                    />
                  ) : null}
                  {state.readModel.shotPlanRevision ? (
                    <RevisionApprovalCard
                      view={{
                        kind: "shotplan",
                        targetId: state.readModel.shotPlanRevision.id,
                        revisionHash: state.readModel.shotPlanRevision.contentHash,
                        stale: state.readModel.shotPlanRevision.storyRevisionId !== state.readModel.project.activeStoryRevisionId,
                      }}
                      approvals={state.readModel.revisionApprovals}
                    />
                  ) : null}
                  {state.readModel.animaticRevision ? (
                    <RevisionApprovalCard
                      view={{
                        kind: "animatic",
                        targetId: state.readModel.animaticRevision.id,
                        revisionHash: state.readModel.animaticRevision.contentHash,
                        stale: state.readModel.animaticRevision.shotPlanRevisionId !== state.readModel.project.activeShotPlanRevisionId,
                      }}
                      approvals={state.readModel.revisionApprovals}
                    />
                  ) : null}
                </ul>
              ) : (
                <p role="status" className="mt-2 text-[13px] text-muted">No story, shot plan, or animatic revision exists yet.</p>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* /production/[projectId]/anchors — per-shot anchor candidates        */
/* ================================================================== */

function PendingJobsRow({ jobs }: { jobs: readonly ProductionJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <div role="status" className="mt-2 rounded-[8px] border border-border bg-surface px-3 py-2.5">
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Pending generation jobs</p>
      <ul className="mt-1 space-y-0.5">
        {jobs.map((job) => (
          <li key={job.id} className="text-[12.5px] text-ink-soft">
            <span className="font-mono text-[11.5px]">{job.id}</span> · {job.operation} · {job.status}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CandidateMetaGrid({ children }: { children: React.ReactNode }) {
  return <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[150px_minmax(0,1fr)]">{children}</dl>;
}

export function AnchorsPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="anchors-page">
      {state.phase === "loading" ? <LoadingPanel label="Loading anchors…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} /> : null}
      {state.phase === "ready" ? (
        <>
          <PanelHeader
            projectId={projectId}
            projectName={state.readModel.project.name}
            crumb="Anchors"
            title="Anchor candidates"
            intro="Per-shot anchor candidate histories with checklist-gated approve/reject decisions and a gated generation submit. Rendering never calls a provider and never fabricates candidates."
            reload={reload}
          />

          {state.readModel.shots.length === 0 ? (
            <div className="mt-6"><NoShotsEmptyState projectId={projectId} /></div>
          ) : (
            <div className="mt-6 space-y-8">
              {state.readModel.shots.map((shot) => {
                const gate = deriveShotCurrency(state.readModel, shot);
                const rows = deriveAnchorRows(shot);
                const pending = derivePendingMediaJobs(state.readModel.activeJobs, shot.shotRevision.id);
                return (
                  <section
                    key={shot.shotRevision.id}
                    aria-label={`Anchors for shot ${shot.shotRevision.shotId}`}
                    className="border-t border-border pt-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-ink">Shot {shot.shotRevision.shotId}</h2>
                      <MonoId value={shot.shotRevision.id} />
                      <Badge tone="neutral">{shot.shotRevision.framing.replace(/_/g, " ")}</Badge>
                      <span className="text-[12px] tabular-nums text-muted">
                        {shot.shotRevision.targetFrames} frames · {framesToDurationLabel(shot.shotRevision.targetFrames)}
                      </span>
                      {gate.shotCurrent ? <Badge tone="success">current shot</Badge> : <Badge tone="warning">stale shot</Badge>}
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted" aria-label="Approval preflight">
                      <li>{gate.storyApprovedCurrent ? "story approval current" : "story approval missing or stale"}</li>
                      <li>{gate.shotPlanApprovedCurrent ? "shot plan approval current" : "shot plan approval missing or stale"}</li>
                      <li>{gate.animaticApprovedCurrent ? "animatic approval current" : "animatic approval missing or stale"}</li>
                    </ul>
                    <PendingJobsRow jobs={pending} />

                    {rows.length === 0 ? (
                      <p role="status" data-testid="anchor-empty" data-shot-id={shot.shotRevision.shotId} className="mt-3 rounded-[8px] border border-dashed border-border-strong bg-surface px-3.5 py-3 text-[13px] text-muted">
                        {deriveHistoryEmptyState("anchor", shot.shotRevision.shotId)}
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-3">
                        {rows.map((row) => (
                          <li key={row.anchor.id}>
                            <Card className="p-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone="primary">anchor</Badge>
                                <DecisionBadge decision={row.latestDecision?.decision ?? null} />
                                <span className="text-sm font-semibold text-ink"><span className="font-mono text-[12px]">{row.anchor.id}</span></span>
                                {row.anchor.visionAssessment ? (
                                  <Badge tone={row.anchor.visionAssessment.status === "pass" ? "success" : "warning"}>
                                    vision: {row.anchor.visionAssessment.status}
                                  </Badge>
                                ) : (
                                  <Badge tone="warning">vision: none</Badge>
                                )}
                              </div>
                              <CandidateMetaGrid>
                                <dt className="font-semibold text-ink-soft">Asset</dt>
                                <dd><MonoId value={row.anchor.assetId} /></dd>
                                <dt className="font-semibold text-ink-soft">Media bytes</dt>
                                <dd className="text-muted">{REFERENCE_MEDIA_NOTE}</dd>
                                <dt className="font-semibold text-ink-soft">Job</dt>
                                <dd><MonoId value={row.anchor.jobId} /></dd>
                                <dt className="font-semibold text-ink-soft">Vision summary</dt>
                                <dd className="text-muted">{row.anchor.visionAssessment?.summary ?? "no vision assessment recorded"}</dd>
                                <dt className="font-semibold text-ink-soft">Created</dt>
                                <dd className="text-muted">{formatDate(row.anchor.createdAt)} {formatTime(row.anchor.createdAt)}</dd>
                                <dt className="font-semibold text-ink-soft">Latest decision</dt>
                                <dd>
                                  {row.latestDecision ? (
                                    <>
                                      {row.latestDecision.decision} by <span className="font-mono text-[11.5px]">{row.latestDecision.actorId}</span>
                                      {" · "}
                                      <ChecklistSummary approval={row.latestDecision} />
                                    </>
                                  ) : (
                                    <span className="text-muted">none — this candidate cannot be approved from the UI (no exported hash)</span>
                                  )}
                                </dd>
                              </CandidateMetaGrid>
                              <ApprovalWorkspace
                                projectId={projectId}
                                targetKind="anchor"
                                targetId={row.anchor.id}
                                candidateLabel={`anchor ${row.anchor.id}`}
                                current={gate.shotCurrent}
                                pendingJob={gate.pendingMediaJob}
                                visionStatus={row.anchor.visionAssessment?.status ?? null}
                                latestDecision={row.latestDecision}
                                displayedRevisionHash={null}
                              />
                            </Card>
                          </li>
                        ))}
                      </ul>
                    )}

                    <AnchorSubmitForm projectId={projectId} shot={shot} gate={gate} />
                  </section>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* /production/[projectId]/takes — siblings, selection, retakes        */
/* ================================================================== */

type SelectionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "saved"; message: string }
  | { kind: "error"; view: ErrorEnvelopeView };

function TakesSection({ projectId, shot, gate }: { projectId: string; shot: ReadModelShot; gate: ShotCurrency }) {
  const [selection, setSelection] = useState<SelectionState>({ kind: "idle" });

  async function runSelection(takeId: string | null, label: string) {
    if (selection.kind === "running") return;
    setSelection({ kind: "running" });
    try {
      const command = deriveSelectionCommand(projectId, shot.shotRevision.id, takeId, shot.takeSelection);
      const call = await postJson(`/api/production/shots/${encodeURIComponent(shot.shotRevision.shotId)}/selection`, command);
      const payload = call.networkFailed ? null : await responsePayload(call.response);
      if (call.networkFailed || !call.response.ok) {
        const view = deriveMutationFailure(call.networkFailed ? null : call.response.status, payload, call.networkFailed);
        setSelection({
          kind: "error",
          view: view.code === "STALE_REVISION"
            ? { ...view, message: "Selection changed; reload to see the current selection." }
            : view,
        });
        return;
      }
      const result = payload as { selection?: { takeId?: unknown; version?: unknown }; changed?: unknown } | null;
      const version = typeof result?.selection?.version === "number" ? result.selection.version : null;
      setSelection({
        kind: "saved",
        message: `${label} — ${typeof result?.selection?.takeId === "string" ? `selected take ${result.selection.takeId}` : "no take selected"} at selection version ${version ?? "unknown"}. Reload to refresh every control.`,
      });
    } catch (error) {
      setSelection({
        kind: "error",
        view: {
          code: "UNKNOWN_RESPONSE",
          message: `The selection could not be completed: ${error instanceof Error ? error.message : "unexpected failure"}; the selection is unchanged.`,
          requestId: "unavailable",
          action: "Retry; if it repeats, inspect the local server logs.",
          retryable: true,
          status: null,
          shape: "unparseable",
        },
      });
    }
  }

  const rows = deriveTakeRows(shot);

  return (
    <section aria-label={`Takes for shot ${shot.shotRevision.shotId}`} className="border-t border-border pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Shot {shot.shotRevision.shotId}</h2>
        <MonoId value={shot.shotRevision.id} />
        <Badge tone="neutral">{shot.shotRevision.framing.replace(/_/g, " ")}</Badge>
        <span className="text-[12px] tabular-nums text-muted">
          {shot.shotRevision.targetFrames} frames · {framesToDurationLabel(shot.shotRevision.targetFrames)}
        </span>
        <span className="text-[12px] text-muted">
          selection: {shot.takeSelection.takeId ?? "none"} · version {shot.takeSelection.version}
        </span>
      </div>

      {rows.length === 0 ? (
        <p role="status" data-testid="take-empty" data-shot-id={shot.shotRevision.shotId} className="mt-3 rounded-[8px] border border-dashed border-border-strong bg-surface px-3.5 py-3 text-[13px] text-muted">
          {deriveHistoryEmptyState("take", shot.shotRevision.shotId)}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => {
            const approved = row.latestDecision?.decision === "approved";
            const selectionDisabled = selection.kind === "running" || row.selected || !approved;
            const selectionReason = row.selected
              ? "this take is already selected; reverse it instead"
              : approved
                ? null
                : "this take has no current human approval";
            return (
              <li
                key={row.take.id}
                data-testid="take-row"
                data-selected={row.selected ? "true" : "false"}
                className={`rounded-[12px] border p-4 ${row.selected ? "border-primary/50 bg-primary-soft/40" : "border-border bg-raised"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {row.selected ? <Badge tone="primary">selected</Badge> : <Badge tone="neutral">sibling</Badge>}
                  <DecisionBadge decision={row.latestDecision?.decision ?? null} />
                  <span className="text-sm font-semibold text-ink"><span className="font-mono text-[12px]">{row.take.id}</span></span>
                  <span className="text-[12px] tabular-nums text-muted">{row.take.actualFrames} frames actual</span>
                </div>
                <CandidateMetaGrid>
                  <dt className="font-semibold text-ink-soft">Anchor</dt>
                  <dd><MonoId value={row.take.anchorId} /></dd>
                  <dt className="font-semibold text-ink-soft">Asset</dt>
                  <dd><MonoId value={row.take.assetId} /></dd>
                  <dt className="font-semibold text-ink-soft">Media bytes</dt>
                  <dd className="text-muted">{REFERENCE_MEDIA_NOTE}</dd>
                  <dt className="font-semibold text-ink-soft">Job</dt>
                  <dd><MonoId value={row.take.jobId} /></dd>
                  <dt className="font-semibold text-ink-soft">Created</dt>
                  <dd className="text-muted">{formatDate(row.take.createdAt)} {formatTime(row.take.createdAt)}</dd>
                  <dt className="font-semibold text-ink-soft">Latest decision</dt>
                  <dd>
                    {row.latestDecision ? (
                      <>
                        {row.latestDecision.decision} by <span className="font-mono text-[11.5px]">{row.latestDecision.actorId}</span>
                        {" · "}
                        <ChecklistSummary approval={row.latestDecision} />
                      </>
                    ) : (
                      <span className="text-muted">none — this take cannot be approved or selected from the UI (no exported hash)</span>
                    )}
                  </dd>
                </CandidateMetaGrid>
                <p role="status" className="mt-2 text-[12px] text-muted">{deriveRejectionSelectionNotice(shot.takeSelection.takeId, row.take.id)}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {row.selected ? (
                    <Button
                      variant="secondary" size="sm" icon="close"
                      data-testid="reverse-selection-button"
                      data-shot-id={shot.shotRevision.shotId}
                      disabled={selection.kind === "running"}
                      onClick={() => void runSelection(null, "Selection reversed")}
                    >
                      Reverse selection (clear the selected take)
                    </Button>
                  ) : (
                    <Button
                      variant="secondary" size="sm" icon="check"
                      data-testid="select-take-button"
                      data-shot-id={shot.shotRevision.shotId}
                      data-take-id={row.take.id}
                      disabled={selectionDisabled}
                      onClick={() => void runSelection(row.take.id, `Take ${row.take.id} selected`)}
                    >
                      Select this take
                    </Button>
                  )}
                  {selectionReason && !row.selected ? <span className="text-[12px] text-muted">{selectionReason}</span> : null}
                </div>
                <ApprovalWorkspace
                  projectId={projectId}
                  targetKind="take"
                  targetId={row.take.id}
                  candidateLabel={`take ${row.take.id}`}
                  current={gate.shotCurrent}
                  pendingJob={gate.pendingMediaJob}
                  visionStatus={null}
                  latestDecision={row.latestDecision}
                  displayedRevisionHash={null}
                />
              </li>
            );
          })}
        </ul>
      )}

      {selection.kind === "saved" ? <StatusRegion lines={[selection.message]} testId="selection-status" /> : null}
      {selection.kind === "error" ? <ErrorAlert view={selection.view} lead="The selection could not be saved." /> : null}
    </section>
  );
}

export function TakesPanel({ projectId }: { projectId: string }) {
  const { state, reload } = useProjectReadModel(projectId);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="takes-page">
      {state.phase === "loading" ? <LoadingPanel label="Loading takes…" /> : null}
      {state.phase === "error" ? <ReadModelLoadError error={state.error} onRetry={reload} /> : null}
      {state.phase === "ready" ? (
        <>
          <PanelHeader
            projectId={projectId}
            projectName={state.readModel.project.name}
            crumb="Takes"
            title="Take siblings & selection"
            intro="Per-shot retake siblings newest-first with checklist-gated decisions, distinct selected take and explicit reversible selection. Rendering never cascades a rejection and never fabricates candidates."
            reload={reload}
          />

          {state.readModel.shots.length === 0 ? (
            <div className="mt-6"><NoShotsEmptyState projectId={projectId} /></div>
          ) : (
            <div className="mt-6 space-y-8">
              {state.readModel.shots.map((shot) => {
                const gate = deriveShotCurrency(state.readModel, shot);
                const approvedAnchors = shot.anchorHistory
                  .filter((anchor) => latestDecisionFor(shot.approvals, "anchor", anchor.id)?.decision === "approved")
                  .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1));
                const approvedAnchor = approvedAnchors[0]
                  ? { anchor: approvedAnchors[0], latestDecision: latestDecisionFor(shot.approvals, "anchor", approvedAnchors[0].id)! }
                  : null;
                return (
                  <div key={shot.shotRevision.id}>
                    <TakesSection projectId={projectId} shot={shot} gate={gate} />
                    <TakeSubmitForm projectId={projectId} shot={shot} gate={gate} approvedAnchor={approvedAnchor} />
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
