import type { Approval } from "./contracts";

/** Returns the exact latest approved decision set, rejecting stale and conflicting ties. */
export function latestMatchingApproval(
  approvals: readonly Approval[],
  targetKind: Approval["targetKind"],
  targetId: string,
  targetHash: string,
): Approval[] | null {
  if (approvals.length === 0) return null;
  const latestAt = Math.max(...approvals.map((approval) => approval.createdAt));
  const latest = approvals.filter((approval) => approval.createdAt === latestAt);
  if (latest.length === 0 || latest.some((approval) =>
    approval.targetKind !== targetKind || approval.targetId !== targetId ||
    approval.targetHash !== targetHash || approval.decision !== "approved"
  )) return null;
  return latest.slice();
}
