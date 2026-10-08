import { join } from "node:path";
import { resolveMediaTools } from "@/lib/media/production/assembly";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { resolveProductionDataDir } from "@/lib/production/runtime";
import { createExportDownloadRouteHandlers } from "@/lib/services/production/qc";

// C12 final download: 200 only for approved exports whose checksum still matches the asset; 428
// otherwise. The first media byte-serving route in the studio, scoped to export assets only.
function handlers() {
  const dataDir = resolveProductionDataDir();
  return createExportDownloadRouteHandlers({
    dataDir,
    vault: new LocalMediaVault({ root: join(dataDir, "media") }),
    paths: resolveMediaTools(),
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET(request, context);
}
