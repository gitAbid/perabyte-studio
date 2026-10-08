import { join } from "node:path";
import { resolveMediaTools } from "@/lib/media/production/assembly";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { resolveProductionDataDir } from "@/lib/production/runtime";
import { createExportDraftRouteHandlers } from "@/lib/services/production/qc";

// C12 draft download: clearly labeled Draft/QC-failed bytes for qc_pending, qc_failed and
// ready_for_review exports only; approved exports 409 to the final route; failed/canceled exports
// 409 with the recorded failure summary.
function handlers() {
  const dataDir = resolveProductionDataDir();
  return createExportDraftRouteHandlers({
    dataDir,
    vault: new LocalMediaVault({ root: join(dataDir, "media") }),
    paths: resolveMediaTools(),
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET(request, context);
}
