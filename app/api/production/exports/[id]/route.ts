import { join } from "node:path";
import { resolveMediaTools } from "@/lib/media/production/assembly";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { withProductionStore, resolveProductionDataDir } from "@/lib/production/runtime";
import { recordGeneration } from "@/lib/services/production/metrics";
import { createExportItemRouteHandlers } from "@/lib/services/production/qc";

// C12 export detail + QC actions. Composition conventions match the C11 exports route: dataDir
// from the runtime resolver and the vault at <dataDir>/media, resolved per request (no import-time
// I/O); the tested handler factory stays the single behavior surface.
function handlers() {
  const dataDir = resolveProductionDataDir();
  return createExportItemRouteHandlers({
    dataDir,
    vault: new LocalMediaVault({ root: join(dataDir, "media") }),
    paths: resolveMediaTools(),
  });
}

/**
 * C19 best-effort product metric: when a run_qc action drives an export to ready_for_review,
 * record export_completed with the queue-to-QC-pass duration. Fires only on that success
 * transition; any failure here is swallowed so the metric can never affect the API response.
 */
async function recordExportCompletedMetric(response: Response): Promise<void> {
  try {
    if (!response.ok) return;
    const payload = (await response.clone().json()) as { exportRecord?: { id?: unknown; createdAt?: unknown; manifestId?: unknown; status?: unknown } } | null;
    const record = payload?.exportRecord;
    if (!record || record.status !== "ready_for_review") return;
    const exportId = typeof record.id === "string" ? record.id : "";
    const manifestId = typeof record.manifestId === "string" ? record.manifestId : "";
    const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : null;
    await withProductionStore((store) => {
      const projectId = manifestId ? store.read.getManifest(manifestId)?.projectId ?? null : null;
      recordGeneration(store, {
        projectId, workspaceId: null, kind: "export_completed",
        at: Date.now(), durationMs: createdAt !== null ? Math.max(0, Date.now() - createdAt) : null, costMicros: null,
        dims: { exportId: exportId || "unknown" },
      });
    });
  } catch { /* metrics are best-effort */ }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await handlers().POST(request, context);
  await recordExportCompletedMetric(response);
  return response;
}
