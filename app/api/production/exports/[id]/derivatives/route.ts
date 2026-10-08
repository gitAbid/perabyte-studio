import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resolveMediaTools } from "@/lib/media/production/assembly";
import {
  DERIVATIVE_ASPECTS, DERIVATIVE_QUALITIES, DerivativeRequestSchema, buildDerivative, derivativeCacheKey,
  probeMasterDimensions,
} from "@/lib/media/production/derivatives";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { ProductionApplicationError } from "@/lib/production/errors";
import { getRequestId, productionErrorResponse } from "@/lib/production/http";
import { resolveProductionDataDir, withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";

// M6-2 derivative exports (spec 15: "Export variants derive from same manifest"):
// GET ?projectId=…&aspect=16:9|9:16|1:1&quality=high|medium serves an ffmpeg
// scale+crop of the APPROVED master under the exact download gate (approved
// status + matching checksum). Cached on disk keyed by master sha + request;
// a failed encode preserves the previous valid derivative. No platform logic.

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const { id: exportId } = await context.params;
    if (!IdSchema.safeParse(exportId).success) throw new ProductionApplicationError("INVALID_INPUT", "Invalid export id");
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? "";
    if (!IdSchema.safeParse(projectId).success) throw new ProductionApplicationError("INVALID_INPUT", "A valid ?projectId= scope is required.");
    const parsed = DerivativeRequestSchema.safeParse({ aspect: url.searchParams.get("aspect"), quality: url.searchParams.get("quality") });
    if (!parsed.success) {
      throw new ProductionApplicationError("INVALID_INPUT", `Unsupported derivative request: aspect must be one of ${DERIVATIVE_ASPECTS.join("/")} and quality one of ${DERIVATIVE_QUALITIES.join("/")}.`);
    }
    const derivative = parsed.data;
    const dataDir = resolveProductionDataDir();
    const vault = new LocalMediaVault({ root: join(dataDir, "media") });

    const master = await withExportGate(exportId, projectId, vault);
    const paths = resolveMediaTools();
    const probe = await probeMasterDimensions(paths.ffprobe, master.tempPath).catch(async (error: unknown) => {
      await master.cleanup();
      throw error;
    });
    const cacheDir = join(dataDir, "exports", exportId, "derivatives");
    const outPath = join(cacheDir, `${derivativeCacheKey(master.sha256, derivative)}.mp4`);

    let served = outPath;
    if (!existsSafe(served)) {
      await buildDerivative({
        masterPath: master.tempPath,
        outPath,
        aspect: derivative.aspect,
        quality: derivative.quality,
        ffmpegPath: paths.ffmpeg,
        sourceWidth: probe.width,
        sourceHeight: probe.height,
      }).catch(async (error: unknown) => {
        await master.cleanup();
        throw error;
      });
    }
    await master.cleanup();

    const size = await stat(served);
    const stream = Readable.toWeb(createReadStream(served)) as ReadableStream;
    const label = derivative.aspect.replace(":", "x");
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(size.size),
        "content-disposition": `attachment; filename="derivative-${exportId}-${label}-${derivative.quality}.mp4"`,
        etag: `"${derivativeCacheKey(master.sha256, derivative)}"`,
        "cache-control": "no-store",
        "x-perabyte-derivative": "1",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Same gate as the final download: approved export, matching checksum, project scope. */
async function withExportGate(exportId: string, projectId: string, vault: LocalMediaVault): Promise<{ sha256: string; tempPath: string; cleanup: () => Promise<void> }> {
  const { writeFile, rm, mkdir } = await import("node:fs/promises");
  const gate = await withProductionStore(async (store) => {
    const exportRecord = store.read.getExport(exportId);
    if (!exportRecord) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Export not found.");
    const manifest = store.read.getManifest(exportRecord.manifestId);
    if (!manifest || manifest.projectId !== projectId) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Export not found in this project.");
    if (exportRecord.status !== "approved") throw new ProductionApplicationError("APPROVAL_REQUIRED", `Derivatives are blocked while the export is in status ${exportRecord.status}; approve the master first.`);
    const asset = exportRecord.assetId ? store.read.getAsset(exportRecord.assetId) : null;
    if (!asset) throw new ProductionApplicationError("UNKNOWN_REFERENCE", `Asset ${String(exportRecord.assetId)} pinned by export ${exportId} is missing.`);
    if (exportRecord.approvedSha256 !== asset.sha256) throw new ProductionApplicationError("STALE_REVISION", "The approved checksum no longer matches the master output; re-run QC and approval.");
    return { asset };
  });
  const bytes = await vault.readVerified(gate.asset.vaultRef, gate.asset.sha256);
  const tempPath = join(resolveProductionDataDir(), "exports", exportId, `master-${Date.now()}.tmp.mp4`);
  await mkdir(join(tempPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(tempPath, bytes, { mode: 0o600 });
  return {
    sha256: gate.asset.sha256,
    tempPath,
    cleanup: async () => {
      await rm(tempPath, { force: true });
    },
  };
}
