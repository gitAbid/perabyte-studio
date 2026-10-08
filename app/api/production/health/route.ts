import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HealthResponseSchema } from "../../../../lib/production/contracts";
import { getRequestId, productionErrorResponse } from "../../../../lib/production/http";
import { withProductionStore, resolveProductionDataDir } from "../../../../lib/production/runtime";

const MAX_HEARTBEAT_AGE_MS = 30_000;
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const schemaVersion = await withProductionStore(store => store.schemaVersion());
    const dataDir = resolveProductionDataDir(process.env, process.cwd());
    let heartbeatAgeMs: number | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dataDir, "worker-heartbeat.json"), "utf8"));
      const owner: unknown = JSON.parse(await readFile(join(dataDir, "worker-owner.json"), "utf8"));
      if (parsed && typeof parsed === "object" && owner && typeof owner === "object" && "at" in parsed && typeof parsed.at === "number" && Number.isSafeInteger(parsed.at) && parsed.at <= Date.now() && "pid" in parsed && typeof parsed.pid === "number" && "ownerId" in parsed && typeof parsed.ownerId === "string" && "pid" in owner && owner.pid === parsed.pid && "ownerId" in owner && owner.ownerId === parsed.ownerId && processAlive(parsed.pid)) heartbeatAgeMs = Date.now() - parsed.at;
    } catch { /* Missing or malformed heartbeat means unavailable. */ }
    const response = HealthResponseSchema.parse({ schemaVersion, storage: "ready", worker: { available: heartbeatAgeMs !== null && heartbeatAgeMs <= MAX_HEARTBEAT_AGE_MS, heartbeatAgeMs } });
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
