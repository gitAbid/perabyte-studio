import type { Approval, Take } from "./contracts";
import { ProductionApplicationError } from "./errors";
import { hashCanonicalJson } from "./hash";
import type { ProductionReadPort } from "../repositories/production/ports";
import { computeAnchorApprovalHash } from "../jobs/production/queue";

export const APPROVAL_CHECKLISTS = {
  canon: {
    character: ["identity", "wardrobe", "style", "reference_rights"],
    location: ["location", "style", "reference_rights"],
    prop: ["props", "style", "reference_rights"],
    style: ["style", "reference_rights"],
  },
  story: ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"],
  shotplan: ["beat_coverage", "spoken_lines", "canon_bindings", "duration_format", "plot_fidelity"],
  animatic: ["beat_coverage", "spoken_lines", "timing", "duration_format", "continuity"],
  anchor: ["identity", "wardrobe", "location", "props", "framing"],
  take: ["identity", "wardrobe", "location", "props", "intended_action", "motion_camera", "artifacts"],
  audio: ["spoken_lines", "intelligibility", "voice_consistency", "cue_timing", "music_sfx_rights", "no_truncation", "balance"],
} as const;

export type ApprovalChecklistRequirements = readonly string[];
type ApprovalTargetKind = Approval["targetKind"];
type ApprovalChecklistItem = Approval["checklist"][number];

export function requiredApprovalChecklist(kind: ApprovalTargetKind, canonKind?: string): ApprovalChecklistRequirements {
  if (kind === "canon") {
    const items = APPROVAL_CHECKLISTS.canon[canonKind as keyof typeof APPROVAL_CHECKLISTS.canon];
    if (!items) throw new ProductionApplicationError("INVALID_INPUT", "Canon approval target has an unsupported entity kind.");
    return items;
  }
  if (kind === "final") throw new ProductionApplicationError("QC_BLOCKED", "Final approval is unavailable until checksum-bound technical QC is implemented.");
  return APPROVAL_CHECKLISTS[kind];
}

export function validateApprovalChecklist(
  kind: ApprovalTargetKind,
  checklist: readonly ApprovalChecklistItem[],
  canonKind?: string,
): void {
  const required = requiredApprovalChecklist(kind, canonKind);
  if (checklist.length !== required.length || new Set(checklist.map((item) => item.id)).size !== checklist.length ||
      required.some((id) => !checklist.some((item) => item.id === id))) {
    throw new ProductionApplicationError("INVALID_INPUT", "Approval checklist must contain each required check exactly once.");
  }
}

/** Take approvals bind the exact stored take, its accepted anchor and the rendered bytes. */
export function computeTakeApprovalHash(read: ProductionReadPort, take: Take): string {
  const asset = read.getAsset(take.assetId);
  if (!asset) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Take media is unavailable.");
  return hashCanonicalJson({
    recipeVersion: 1,
    takeId: take.id,
    shotRevisionId: take.shotRevisionId,
    anchorId: take.anchorId,
    approvalId: take.approvalId,
    inputsHash: take.inputsHash,
    assetSha256: asset.sha256,
  });
}

export function approvalCommandId(projectId: string, idempotencyKey: string): string {
  return `approval:${hashCanonicalJson({ schemaVersion: 1, operation: "human_approval", projectId, idempotencyKey })}`;
}

export function isExactApprovalReplay(
  existing: Approval,
  command: {
    targetKind: ApprovalTargetKind;
    targetId: string;
    expectedHash: string;
    decision: "approved" | "rejected";
    checklist: ApprovalChecklistItem[];
    notes: string;
    advisoryAcknowledgements: { code: string; reason: string }[];
  },
  actorId: string,
): boolean {
  return existing.actorId === actorId && existing.targetKind === command.targetKind && existing.targetId === command.targetId &&
    existing.targetHash === command.expectedHash && existing.decision === command.decision &&
    existing.checklist.length === command.checklist.length && existing.checklist.every((item, index) => {
      const requested = command.checklist[index];
      return !!requested && item.id === requested.id && item.passed === requested.passed && item.note === requested.note;
    }) && existing.notes === command.notes && existing.advisoryAcknowledgements.length === command.advisoryAcknowledgements.length &&
    existing.advisoryAcknowledgements.every((item, index) => {
      const requested = command.advisoryAcknowledgements[index];
      return !!requested && item.code === requested.code && item.reason === requested.reason;
    });
}
