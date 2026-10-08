import { join } from "node:path";
import { resolveMediaTools } from "@/lib/media/production/assembly";
import { createExportPackageRouteHandlers } from "@/lib/media/production/package";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { resolveProductionDataDir } from "@/lib/production/runtime";

// M4-5 manual publication package (spec 15): GET serves the complete package zip under the same
// gate as the final download (approved export, checksum still matching); PUT persists the
// creator's metadata edits server-side before publishing. ?meta=1 reads overrides + defaults.
// The package builds on demand against the approved master bytes and caches beside the export
// record keyed by every package input; a failed build preserves the previous valid package.
function handlers() {
  const dataDir = resolveProductionDataDir();
  return createExportPackageRouteHandlers({
    dataDir,
    vault: new LocalMediaVault({ root: join(dataDir, "media") }),
    paths: resolveMediaTools(),
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET(request, context);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().PUT(request, context);
}
