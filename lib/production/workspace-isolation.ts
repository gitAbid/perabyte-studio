import { type Workspace } from "./contracts";
import { ProductionApplicationError } from "./errors";

/**
 * Workspace isolation admission (CONTRACTS-FROZEN C9, spec 02 §2, spec 05 §9).
 *
 * Isolation invariant, evaluated before any workspace-scoped generation job is enqueued:
 *
 *   resolvedReferences ⊆ workspaceSelection ∪ productionSnapshot ∪ explicitUserPicks
 *
 * A globally available asset is never implicitly available to generation: every resolved
 * reference must be covered by the workspace's own canon selections, the production snapshot
 * pinned at production creation, or an explicit per-job user pick. Violation raises
 * `WorkspaceIsolationError` and the job is never enqueued.
 */

/** Raised when a job's resolved references are not covered by its workspace admission evidence, or when the evidence itself cannot be verified. */
export class WorkspaceIsolationError extends ProductionApplicationError {
  /** Resolved reference ids that are outside the allowed union (deduplicated, input order). Empty when the failure is missing or mismatched admission evidence. */
  readonly offendingIds: readonly string[];

  constructor(message: string, offendingIds: readonly string[] = []) {
    super("INVALID_INPUT", message);
    this.name = "WorkspaceIsolationError";
    this.offendingIds = Object.freeze([...offendingIds]);
  }
}

/** The frozen C2 Workspace fields the admission check reads; a full `Workspace` satisfies it. */
export type WorkspaceSelection = Pick<Workspace, "id" | "characterCanonIds" | "environmentCanonIds" | "styleCanonIds">;

/** Optional additions to the allowed union: the production snapshot's pinned ids and explicit per-job user picks. */
export interface WorkspaceIsolationAllowance {
  readonly productionSnapshot?: readonly string[];
  readonly explicitUserPicks?: readonly string[];
}

/** Full admission evidence a caller must supply when enqueueing a workspace-scoped job. */
export interface WorkspaceIsolationAdmission extends WorkspaceIsolationAllowance {
  readonly workspace: WorkspaceSelection;
}

/** Structural subset of the C9-extended `ProductionJob` the admission path reads; the current `ProductionJob` satisfies it. */
export interface WorkspaceScopedJobRef {
  readonly id: string;
  readonly scope?: Readonly<{ workspaceId?: string | null }> | null;
  readonly resolvedReferenceIds?: readonly string[] | null;
}

function workspaceAllowedIds(workspace: WorkspaceSelection, allowance: WorkspaceIsolationAllowance | undefined): Set<string> {
  const allowed = new Set<string>();
  for (const group of [workspace.characterCanonIds, workspace.environmentCanonIds, workspace.styleCanonIds, allowance?.productionSnapshot, allowance?.explicitUserPicks]) {
    for (const id of group ?? []) if (typeof id === "string") allowed.add(id);
  }
  return allowed;
}

/**
 * Asserts every resolved reference is inside `workspaceSelection ∪ productionSnapshot ∪
 * explicitUserPicks`. Throws `WorkspaceIsolationError` listing the offending ids (deduplicated,
 * input order) on the first violation; returns silently when the union covers all references.
 */
export function assertResolvedRefsWithinWorkspace(
  resolvedReferenceIds: readonly string[],
  workspace: WorkspaceSelection,
  allowance?: WorkspaceIsolationAllowance,
): void {
  if (!workspace || typeof workspace !== "object" || typeof workspace.id !== "string" || workspace.id.length === 0) {
    throw new ProductionApplicationError("INVALID_INPUT", "Workspace isolation requires a workspace selection with an id.");
  }
  if (!Array.isArray(resolvedReferenceIds)) {
    throw new ProductionApplicationError("INVALID_INPUT", `Workspace isolation for workspace ${workspace.id} requires an array of resolved reference ids.`);
  }
  const allowed = workspaceAllowedIds(workspace, allowance);
  const offending: string[] = [];
  for (const referenceId of resolvedReferenceIds) {
    if (typeof referenceId === "string" && allowed.has(referenceId)) continue;
    if (!offending.includes(String(referenceId))) offending.push(String(referenceId));
  }
  if (offending.length > 0) {
    throw new WorkspaceIsolationError(
      `${offending.length} resolved reference(s) are outside workspace ${workspace.id} selections, its production snapshot, and explicit user picks: ${offending.join(", ")}. The job was not enqueued.`,
      offending,
    );
  }
}

/**
 * Enqueue-time admission gate for one job. Jobs without a workspace scope (legacy or
 * workspace-free jobs) pass through untouched. A workspace-scoped job must carry admission
 * evidence for exactly its scoped workspace, and its resolved references must pass
 * {@link assertResolvedRefsWithinWorkspace}; anything else throws `WorkspaceIsolationError`
 * so the job is never enqueued. Pure: no store access — the caller supplies the evidence.
 */
export function admitWorkspaceIsolation(job: WorkspaceScopedJobRef, admission?: WorkspaceIsolationAdmission | null): void {
  const workspaceId = job?.scope?.workspaceId ?? null;
  if (workspaceId === null) return;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new WorkspaceIsolationError(`Job ${job.id} carries a malformed workspace scope; the job was not enqueued.`);
  }
  if (!admission?.workspace) {
    throw new WorkspaceIsolationError(`Job ${job.id} is scoped to workspace ${workspaceId} but no workspace isolation admission was provided; the job was not enqueued.`);
  }
  if (admission.workspace.id !== workspaceId) {
    throw new WorkspaceIsolationError(`Job ${job.id} is scoped to workspace ${workspaceId} but the admission evidence describes workspace ${admission.workspace.id}; the job was not enqueued.`);
  }
  assertResolvedRefsWithinWorkspace(job.resolvedReferenceIds ?? [], admission.workspace, admission);
}
