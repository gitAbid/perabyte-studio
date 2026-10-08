import { join } from "node:path";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { resolveProductionDataDir, withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { getRequestId, productionErrorResponse } from "@/lib/production/http";
import { z } from "zod";
import {
  buildAuthorizeUrl, fetchYouTubeTransport, loadUploads, newUploadRecord, resolveUploadsPath,
  resolveYouTubeConfig, saveUploads, type YouTubeTransport,
} from "@/lib/services/production/platforms/youtube";

// M6-1 YouTube adapter surface (config-gated). With no credentials every route
// answers { configured: false } / 400 NOT_CONFIGURED — "Connect" is the only
// visible action, never a fake-enabled Publish (spec 15 policy rules).

export const runtime = "nodejs";

function transport(): YouTubeTransport {
  return fetchYouTubeTransport;
}

/** GET: status + recent auditable records. */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const config = resolveYouTubeConfig();
    const uploads = await loadUploads(resolveProductionDataDir());
    return Response.json(
      {
        configured: config !== null,
        connected: uploads.refreshToken !== null,
        records: uploads.records,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

const ConnectSchema = z.strictObject({ projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/) });

/** POST { action: "connect" } → { authorizeUrl } · POST { action: "upload", exportId, privacy, confirmed: true } → auditable record. */
export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const config = resolveYouTubeConfig();
    if (!config) {
      throw new ProductionApplicationError("CAPABILITY_MISMATCH", "YouTube publishing is not configured on this machine.", {
        action: "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET, then connect your channel.",
        retryable: false,
      });
    }
    const body = await request.json().catch(() => null) as { action?: unknown; projectId?: unknown; exportId?: unknown; privacy?: unknown; confirmed?: unknown } | null;
    const action = body?.action === "connect" ? "connect" : body?.action === "upload" ? "upload" : null;
    if (action === null) {
      throw new ProductionApplicationError("INVALID_INPUT", "Body must carry action \"connect\" or \"upload\".");
    }
    const dataDir = resolveProductionDataDir();

    if (action === "connect") {
      if (!IdSchema.safeParse(body?.projectId).success) throw new ProductionApplicationError("INVALID_INPUT", "A valid projectId is required for connect.");
      const origin = new URL(request.url).origin;
      const state = crypto.randomUUID();
      return Response.json(
        { authorizeUrl: buildAuthorizeUrl(config, `${origin}/api/production/platforms/youtube/callback`, state) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    // Upload: explicit confirmation is REQUIRED (spec: "publish action is explicit and auditable").
    if (body?.confirmed !== true) {
      throw new ProductionApplicationError("INVALID_INPUT", "Publishing requires an explicit confirmation flag (confirmed: true).");
    }
    const exportId = typeof body.exportId === "string" ? body.exportId : "";
    const privacy = body.privacy === "public" || body.privacy === "private" ? body.privacy : "unlisted";
    if (!IdSchema.safeParse(exportId).success) throw new ProductionApplicationError("INVALID_INPUT", "A valid exportId is required.");
    const projectId = typeof body.projectId === "string" && IdSchema.safeParse(body.projectId).success ? body.projectId : null;
    if (!projectId) throw new ProductionApplicationError("INVALID_INPUT", "A valid projectId is required.");

    // Same master gate as derivatives/download: approved + checksum match.
    const master = await withProductionStore(async (store) => {
      const exportRecord = store.read.getExport(exportId);
      if (!exportRecord) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Export not found.");
      const manifest = store.read.getManifest(exportRecord.manifestId);
      if (!manifest || manifest.projectId !== projectId) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Export not found in this project.");
      if (exportRecord.status !== "approved") throw new ProductionApplicationError("APPROVAL_REQUIRED", "The master must be approved before any publish action.");
      const asset = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
      if (!asset) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "The approved master asset is missing.");
      if (exportRecord.approvedSha256 !== asset.sha256) throw new ProductionApplicationError("STALE_REVISION", "The approved checksum no longer matches the master output.");
      const title = manifest.projectId;
      return { asset, title };
    });

    const uploads = await loadUploads(dataDir);
    if (!uploads.refreshToken) {
      throw new ProductionApplicationError("CAPABILITY_MISMATCH", "No connected YouTube channel.", { action: "Connect the channel first.", retryable: false });
    }
    const record = newUploadRecord({ projectId, exportId, privacy, now: Date.now() });
    const withRunning = { ...uploads, records: [{ ...record, state: "running" as const }, ...uploads.records] };
    await saveUploads(dataDir, withRunning);

    try {
      const vault = new LocalMediaVault({ root: join(dataDir, "media") });
      const bytes = await vault.readVerified(master.asset.vaultRef, master.asset.sha256);
      const tokens = uploads.refreshToken ? await transport().refresh(config, uploads.refreshToken) : null;
      if (!tokens) throw new Error("No stored refresh token.");
      const session = await transport().initiateUpload(config, tokens.accessToken, { title: master.title, description: `Uploaded from PeraByte Studio (${exportId}).`, privacyStatus: privacy, videoBytes: bytes.byteLength });
      const uploaded = await transport().uploadBytes(session, bytes);
      const completed = { ...record, state: "completed" as const, remoteVideoId: uploaded.remoteVideoId, remoteUrl: `https://www.youtube.com/watch?v=${uploaded.remoteVideoId}`, completedAt: Date.now() };
      await saveUploads(dataDir, { ...withRunning, records: withRunning.records.map((entry) => (entry.id === record.id ? completed : entry)), refreshToken: tokens.refreshToken ?? uploads.refreshToken });
      return Response.json({ record: completed }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      // NEVER mark complete on failure (spec rule); the record carries the error.
      const message = error instanceof Error ? error.message : "The upload failed.";
      const failed = { ...record, state: "failed" as const, error: message.slice(0, 4000) };
      await saveUploads(dataDir, { ...withRunning, records: withRunning.records.map((entry) => (entry.id === record.id ? failed : entry)) });
      return Response.json({ record: failed, error: { message } }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

