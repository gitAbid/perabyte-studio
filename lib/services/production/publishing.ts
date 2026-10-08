import { z } from "zod";
import { IdSchema } from "../../production/contracts";
import { computeTakeApprovalHash } from "../../production/approval";
import { latestMatchingApproval } from "../../production/approval-policy";
import { ProductionApplicationError, type ProductionErrorCode } from "../../production/errors";
import {
  derivePublicationPackage, resolvePublicationProfile, selectPublicationExport,
  type PublicationPackage,
} from "../../production/publishing";
import { getProjectReadModel } from "./revisions";
import type { ProductionStore } from "../../repositories/production/ports";

/**
 * Publishing service: a thin read-only bridge from the store to the pure publication derivation.
 * It reuses the existing read model (revisions service), re-checks the fail-closed publication
 * gates against the exact stored records (export-to-manifest alignment with the active plan and
 * take selections, and hash-exact current take approvals), then returns the deterministic package.
 * No network, no routes, no writes, no uploads: the package is data for a manual, human upload.
 */
export const PublicationCommandSchema = z.strictObject({ projectId: IdSchema, profileId: IdSchema });
export type PublicationCommand = z.infer<typeof PublicationCommandSchema>;
export interface PublishingServiceOptions { catalog?: readonly unknown[] }

function fail(code: ProductionErrorCode, message: string): never { throw new ProductionApplicationError(code, message); }

export function deriveProjectPublication(store: ProductionStore, rawCommand: unknown, options: PublishingServiceOptions = {}): PublicationPackage {
  const parsedCommand = PublicationCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) fail("INVALID_INPUT", `Invalid publication command: ${parsedCommand.error.issues.map((issue) => issue.message).join("; ")}`);
  const command = parsedCommand.data;
  const readModel = getProjectReadModel(store, command.projectId);
  const profile = resolvePublicationProfile(command.profileId, options.catalog);
  const basis = selectPublicationExport(readModel.exports);
  const exportRecord = store.read.getExport(basis.exportId);
  if (!exportRecord) fail("UNKNOWN_REFERENCE", `Export ${basis.exportId} is missing from the store; the approved export is not verifiable.`);
  const manifest = store.read.getManifest(exportRecord.manifestId);
  if (!manifest) fail("STALE_REVISION", `Export ${exportRecord.id} references missing manifest ${exportRecord.manifestId}; the approved export is not verifiable.`);
  if (manifest.shots.length !== readModel.shots.length) {
    fail("APPROVAL_REQUIRED", `Approved export ${exportRecord.id} pins ${manifest.shots.length} shots but the active plan lists ${readModel.shots.length}; create and approve a new export before deriving publication metadata.`);
  }
  for (const [index, shot] of readModel.shots.entries()) {
    const manifestShot = manifest.shots[index]!;
    const take = shot.selectedTake;
    if (!take || manifestShot.shotRevisionId !== shot.shotRevision.id || manifestShot.takeId !== take.id || manifestShot.assetId !== take.assetId) {
      fail("APPROVAL_REQUIRED", `Approved export ${exportRecord.id} no longer matches the active plan or take selection at shot ${shot.shotRevision.shotId}; create and approve a new export before deriving publication metadata.`);
    }
    // Take-acceptance policy re-expressed with the domain helpers exactly as the manifest compiler
    // does (latestMatchingApproval over the take's decisions, hash-bound via computeTakeApprovalHash).
    if (!latestMatchingApproval(store.read.listApprovals("take", take.id), "take", take.id, computeTakeApprovalHash(store.read, take))) {
      fail("APPROVAL_REQUIRED", `Take ${take.id} for shot ${shot.shotRevision.shotId} has no current matching approval; publication requires an accepted take.`);
    }
  }
  return derivePublicationPackage(readModel, profile);
}
