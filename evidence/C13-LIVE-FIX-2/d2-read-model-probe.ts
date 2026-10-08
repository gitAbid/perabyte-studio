/** C13-LIVE-FIX-2 D2 read-only probe: blocked job read model parses after event-row projection.
 *
 * Strictly read-only access to the live production store: better-sqlite3 opened with
 * readonly:true (the repo's store driver; equivalent of the pilot's
 * new DatabaseSync(path, {readOnly:true}) pattern). Only SELECTs are issued.
 * openProductionStore is deliberately NOT used here because opening it performs
 * WAL/migration writes against the live database.
 */
import Database from "better-sqlite3";
import { JobEventSchema, JobReadModelSchema } from "../../lib/production/contracts";

const dataDir = "/Users/abid/Projects/perabyte-studio/.worktrees/zcode-production-core/.studio";
const jobId = "304f9c32-256b-4707-894b-88b758c6a6c3";
const recoveryAction = "Review the recorded cause, then create a new authorized job after correcting its inputs.";

const db = new Database(`${dataDir}/production.sqlite`, { readonly: true });
try {
  // Same access pattern as store.read.getJob: raw stored record payload.
  const jobRow = db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(jobId) as { payload: string } | undefined;
  if (!jobRow) throw new Error(`job ${jobId} not found`);
  const job: unknown = JSON.parse(jobRow.payload);
  // Exact listJobEvents query from lib/repositories/production/sqlite.ts.
  const rows = db.prepare("SELECT job_id AS jobId,sequence,at,status,message,progress FROM job_events WHERE job_id=? AND sequence>? ORDER BY sequence").all(jobId, 0) as Array<{ jobId: string; sequence: number; at: number; status: string; message: string; progress: number | null }>;
  console.log("store:", dataDir, "(readonly:true)");
  console.log("job:", jobId, "status:", (job as { status: string }).status);
  console.log("event rows:", rows.length, "raw row keys:", rows[0] ? Object.keys(rows[0]).sort().join(",") : "none");

  // D2 defect shape: raw rows carry the internal jobId key, JobEventSchema is strictObject.
  const rawParse = JobReadModelSchema.safeParse({ job, events: rows, recoveryAction });
  console.log("raw-row JobReadModelSchema.parse:", rawParse.success ? "PASS" : `FAIL (${String(rawParse.error.issues[0]?.message)})`);
  const rawEventParse = rows[0] ? JobEventSchema.safeParse(rows[0]) : null;
  console.log("raw-row JobEventSchema.parse:", rawEventParse === null ? "n/a" : rawEventParse.success ? "PASS" : `FAIL (${String(rawEventParse.error.issues[0]?.message)})`);

  // The route's projection (strip the internal jobId key; keep the five schema fields).
  const projected = rows.map(row => ({ sequence: row.sequence, at: row.at, status: row.status, message: row.message, progress: row.progress }));
  const parse = JobReadModelSchema.parse({ job, events: projected, recoveryAction });
  console.log("projected JobReadModelSchema.parse: PASS", JSON.stringify({ jobStatus: parse.job.status, events: parse.events.length, firstEvent: parse.events[0] ? { sequence: parse.events[0].sequence, status: parse.events[0].status } : null }));

  if (rawParse.success) throw new Error("expected raw-row parse to fail; defect no longer reproduces");
  if (rows.length === 0) throw new Error("expected the blocked job to have events");
  console.log("PROBE OK: defect reproduces on raw rows; projected read model parses.");
  process.exitCode = 0;
} finally { db.close(); }
