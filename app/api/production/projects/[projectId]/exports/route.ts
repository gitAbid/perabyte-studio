import { join } from "node:path";
import { createExportAssemblyScheduler, type ExportAssemblyScheduler } from "../../../../../../lib/media/production/assembly";
import { LocalMediaVault } from "../../../../../../lib/media/production/vault";
import { resolveProductionDataDir } from "../../../../../../lib/production/runtime";
import { createExportRouteHandlers } from "../../../../../../lib/services/production/manifest";

// Per-process export assembly singleton, resolved lazily at trigger time (no import-time I/O) with
// the composition-owned conventions: dataDir from the runtime resolver, vault at <dataDir>/media,
// and a store opened per drive inside the scheduler. createExportAssemblyScheduler keeps one
// instance per dataDir, so every route invocation shares a single render slot.
function exportScheduler(): ExportAssemblyScheduler {
  const dataDir = resolveProductionDataDir();
  return createExportAssemblyScheduler({
    dataDir,
    vault: new LocalMediaVault({ root: join(dataDir, "media") }),
  });
}

const handlers = createExportRouteHandlers({ scheduler: { trigger: (projectId) => exportScheduler().trigger(projectId) } });
export const POST = handlers.POST;
