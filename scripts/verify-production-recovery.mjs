#!/usr/bin/env node
// C15-RECOVERY end-to-end recovery drills for a Perabyte production data dir.
//
// Usage:
//   node scripts/verify-production-recovery.mjs --source <live-data-dir> [--work <dir>]
//        [--jobs <n>] [--worker <scripts/production-worker.mjs>] [--report <path>] [--clean]
//
// Requires Node >= 22.12 (node:sqlite). No third-party dependencies.
//
// The source store is only opened READ-ONLY (snapshot via `VACUUM INTO`) and is
// never written. Every drill runs against private copies under --work:
//   A) backup -> restore into an isolated dir -> compare logical counts and
//      re-hash every restored file -> orphan media report -> export hash checks.
//   B) seed a copy, enqueue submission-gated jobs, spawn a REAL production
//      worker against the copy, SIGSTOP + kill -9 it mid-stream, wait for lease
//      expiry, restart a second worker, and assert the Phase B guarantees:
//      leases recover exactly once, no provider submission is ever attempted
//      (the gated jobs carry no provider id), no second outbox intent exists,
//      and pre-existing history is untouched.
// Exits 0 only when every drill passes; writes recovery-report.json.

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE, MEDIA_ROOT, RecoveryToolError, createBackup, sha256File } from "./production-backup.mjs";
import { restoreArchive } from "./production-restore.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const TERMINAL = new Set(["blocked", "canceled", "failed", "completed"]);
const COUNT_TABLES = {
  schemaMigrations: "SELECT count(*) AS c FROM schema_migrations",
  records: "SELECT count(*) AS c FROM records",
  projects: "SELECT count(*) AS c FROM projects",
  jobs: "SELECT count(*) AS c FROM jobs",
  jobEvents: "SELECT count(*) AS c FROM job_events",
  jobLeases: "SELECT count(*) AS c FROM job_leases",
  outbox: "SELECT count(*) AS c FROM outbox",
  assets: "SELECT count(*) AS c FROM assets",
  exports: "SELECT count(*) AS c FROM records WHERE kind='export'",
  budgetReservations: "SELECT count(*) AS c FROM budget_reservations",
  budgetExecutions: "SELECT count(*) AS c FROM budget_executions",
  providerProofArtifacts: "SELECT count(*) AS c FROM provider_proof_artifacts",
};

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const scrub = text => String(text)
  .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]")
  .slice(-2000);

function fail(message) {
  throw new RecoveryToolError(message);
}

function parseArgs(argv) {
  const args = { jobs: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const known = new Set(["--source", "--work", "--jobs", "--worker", "--report", "--clean"]);
    if (!known.has(flag)) fail(`Unknown argument: ${flag}`);
    if (flag === "--clean") { args.clean = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) fail(`Missing value for ${flag}`);
    index += 1;
    args[flag.slice(2)] = value;
  }
  if (!Number.isInteger(Number(args.jobs)) || Number(args.jobs) < 1 || Number(args.jobs) > 5000) {
    fail("--jobs must be an integer between 1 and 5000");
  }
  return args;
}

/** Canonical JSON compatible with lib/production/hash.ts for plain JSON values. */
function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail("Canonical JSON requires finite numbers");
      return JSON.stringify(value);
    default: break;
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail(`Unsupported canonical JSON value: ${typeof value}`);
}

function readOnlyDb(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function logicalCounts(db) {
  const counts = {};
  for (const [name, sql] of Object.entries(COUNT_TABLES)) counts[name] = Number(db.prepare(sql).get().c);
  return counts;
}

function listFileNames(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) fail(`Unexpected symlink under ${dir}`);
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFileNames(path, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}

function mediaFileDigests(dataDir) {
  const root = join(dataDir, MEDIA_ROOT, "sha256");
  const digests = new Map();
  if (!existsSync(root)) return digests;
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    for (const entry of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
      if (entry.isFile()) digests.set(entry.name, join(root, bucket.name, entry.name));
    }
  }
  return digests;
}

function referencedMediaDigests(db) {
  const referenced = new Set();
  for (const row of db.prepare("SELECT DISTINCT sha256 AS sha FROM assets WHERE sha256 IS NOT NULL").all()) referenced.add(row.sha);
  for (const row of db.prepare("SELECT DISTINCT json_extract(payload,'$.sha256') AS sha FROM records WHERE kind='asset'").all()) {
    if (typeof row.sha === "string") referenced.add(row.sha);
  }
  return referenced;
}

/** Orphan media report: vault files no asset row references, plus referenced digests with no file. */
function orphanMediaReport(dataDir) {
  const files = mediaFileDigests(dataDir);
  const db = readOnlyDb(join(dataDir, DB_FILE));
  let referenced;
  try {
    referenced = referencedMediaDigests(db);
  } finally {
    db.close();
  }
  const orphans = [...files.keys()].filter(digest => !referenced.has(digest)).sort();
  const missing = [...referenced].filter(digest => !files.has(digest)).sort();
  return { totalFiles: files.size, referencedCount: referenced.size, orphans, missingReferenced: missing };
}

/** Verify every export record's output asset bytes against the asset row and the backup manifest. */
async function verifyExportHashes(dataDir, manifest) {
  const db = readOnlyDb(join(dataDir, DB_FILE));
  const manifestByPath = new Map((manifest?.media?.files ?? []).map(file => [file.path, file]));
  const results = [];
  try {
    const rows = db.prepare("SELECT id, payload FROM records WHERE kind='export' ORDER BY id").all();
    for (const row of rows) {
      const record = JSON.parse(row.payload);
      const assetRow = record.assetId ? db.prepare("SELECT payload FROM records WHERE kind='asset' AND id=?").get(record.assetId) : null;
      const asset = assetRow ? JSON.parse(assetRow.payload) : null;
      const sha256 = asset?.sha256 ?? null;
      const vaultPath = sha256 ? `media/sha256/${sha256.slice(0, 2)}/${sha256}` : null;
      let verified = false;
      let detail;
      if (!asset || !sha256 || !vaultPath) {
        detail = "export has no resolvable output asset record";
      } else {
        const file = join(dataDir, ...vaultPath.split("/"));
        const manifestEntry = manifestByPath.get(vaultPath);
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) detail = `vault file missing: ${vaultPath}`;
        else if (!manifestEntry) detail = `vault file is not covered by the backup manifest: ${vaultPath}`;
        else {
          const actualSha = await sha256File(file);
          const bytes = lstatSync(file).size;
          verified = actualSha === sha256 && bytes === asset.byteSize && manifestEntry.sha256 === sha256 && manifestEntry.bytes === bytes;
          detail = verified
            ? "vault sha256 and size match the asset record and the backup manifest"
            : `mismatch: vault sha256 ${actualSha} (${bytes} bytes), asset ${sha256} (${asset.byteSize} bytes), manifest ${manifestEntry.sha256} (${manifestEntry.bytes} bytes)`;
        }
      }
      results.push({ id: row.id, status: record.status ?? null, assetId: record.assetId ?? null, sha256, verified, detail });
    }
  } finally {
    db.close();
  }
  return results;
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node >= 22.12 is required (found ${process.versions.node}); node:sqlite powers every drill.`);
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source ?? join(process.cwd(), ".studio"));
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) fail(`Source data dir does not exist: ${source}`);
  if (!statSync(join(source, DB_FILE), { throwIfNoEntry: false })?.isFile()) fail(`No ${DB_FILE} in ${source}`);
  const work = args.work ? resolve(args.work) : mkdtempSync(join(tmpdir(), "c15-recovery-drill-"));
  if (work === source || work.startsWith(`${source}/`) || source.startsWith(`${work}/`)) fail("--work must not overlap the source data dir");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const workerScript = resolve(args.worker ?? join(REPO_ROOT, "scripts", "production-worker.mjs"));
  if (!statSync(workerScript, { throwIfNoEntry: false })?.isFile()) fail(`Worker script not found: ${workerScript}`);
  const jobCount = Number(args.jobs);
  const report = {
    packet: "C15-RECOVERY", generatedAt: new Date().toISOString(), node: process.version,
    source, work, workerScript, jobCount, drills: {}, allPass: false,
  };
  const sourceDbAtStart = readOnlyDb(join(source, DB_FILE));
  let sourceCounts;
  try {
    sourceCounts = logicalCounts(sourceDbAtStart);
  } finally {
    sourceDbAtStart.close();
  }
  const sourceNamesBefore = listFileNames(source);
  const sourceMainDbBefore = statSync(join(source, DB_FILE));
  console.log(`[c15] source=${source} work=${work} jobs=${jobCount}`);
  console.log(`[c15] source counts: ${JSON.stringify(sourceCounts)}`);

  // ---- Drill A: backup -> restore -> compare ---------------------------------
  console.log("[c15] drill A: backup the live store (read-only) and restore into an isolated dir");
  const backup = await createBackup({ dataDir: source, out: join(work, "backup") });
  report.drills.backupRestore = { archive: backup.archiveDir };
  const sourceNamesAfter = listFileNames(source);
  const sourceUntouched = JSON.stringify(sourceNamesBefore) === JSON.stringify(sourceNamesAfter);
  report.drills.backupRestore.sourceUntouched = sourceUntouched;
  report.drills.backupRestore.sourceMainDbObserved = {
    bytesBefore: sourceMainDbBefore.size, bytesAfter: statSync(join(source, DB_FILE)).size,
    mtimeMsBefore: sourceMainDbBefore.mtimeMs, mtimeMsAfter: statSync(join(source, DB_FILE)).mtimeMs,
  };
  if (!sourceUntouched) {
    fail(`Backup drill observed new or removed files in the source data dir: ${sourceNamesBefore.filter(name => !sourceNamesAfter.includes(name)).concat(sourceNamesAfter.filter(name => !sourceNamesBefore.includes(name))).join(", ")}`);
  }
  const restored = await restoreArchive({ archive: backup.archiveDir, into: join(work, "restore") });
  const restoreDir = restored.into;
  const snapshotDb = readOnlyDb(join(backup.archiveDir, "production.sqlite.snapshot"));
  const restoredDb = readOnlyDb(join(restoreDir, DB_FILE));
  let countsMatch;
  try {
    const snapshotCounts = logicalCounts(snapshotDb);
    const restoredCounts = logicalCounts(restoredDb);
    countsMatch = JSON.stringify(snapshotCounts) === JSON.stringify(restoredCounts);
    report.drills.backupRestore.counts = { liveAtStart: sourceCounts, snapshot: snapshotCounts, restored: restoredCounts, match: countsMatch };
    report.drills.backupRestore.liveWriteRaceNote = "The live store may be written concurrently by the running worker; liveAtStart is observational. The gate compares the snapshot against the restore, which are fixed artifacts.";
  } finally {
    snapshotDb.close();
    restoredDb.close();
  }
  const restoredManifest = JSON.parse(readFileSync(join(backup.archiveDir, "manifest.json"), "utf8"));
  let restoredHashesMatch = true;
  for (const file of restoredManifest.media.files) {
    const hash = await sha256File(join(restoreDir, file.path));
    if (hash !== file.sha256 || lstatSync(join(restoreDir, file.path)).size !== file.bytes) restoredHashesMatch = false;
  }
  report.drills.backupRestore.restoredFilesRehashed = restoredManifest.media.files.length;
  report.drills.backupRestore.restoredHashesMatch = restoredHashesMatch;
  report.drills.backupRestore.integrityCheck = restored.report.integrityCheck;
  report.drills.backupRestore.foreignKeyCheck = restored.report.foreignKeyCheck;
  report.drills.backupRestore.pass = countsMatch && restoredHashesMatch
    && restored.report.integrityCheck.ok && restored.report.foreignKeyCheck.violations === 0 && sourceUntouched;
  const orphanReport = orphanMediaReport(restoreDir);
  const orphanRecount = orphanMediaReport(restoreDir);
  const orphanAccurate = orphanReport.missingReferenced.length === 0
    && JSON.stringify(orphanReport) === JSON.stringify(orphanRecount);
  report.drills.orphanMedia = { ...orphanReport, pass: orphanAccurate, restoredDir: restoreDir };
  const exportChecks = await verifyExportHashes(restoreDir, restoredManifest);
  report.drills.exportHashes = { exports: exportChecks, pass: exportChecks.every(check => check.verified) };

  // ---- Drill B: kill -9 a real spawned worker and recover --------------------
  console.log("[c15] drill B: seed a copy, spawn a worker, kill -9 mid-stream, restart, verify lease recovery");
  const drillDir = join(work, "drill-data");
  mkdirSync(drillDir, { recursive: true, mode: 0o700 });
  const seedDb = readOnlyDb(join(source, DB_FILE));
  try {
    seedDb.exec(`vacuum into '${join(drillDir, DB_FILE).replace(/'/g, "''")}'`);
  } finally {
    seedDb.close();
  }
  cpSync(join(restoreDir, MEDIA_ROOT), join(drillDir, MEDIA_ROOT), { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith("production.sqlite") || entry.name.startsWith("worker-") || entry.name.endsWith(".lock")) continue;
    copyFileSync(join(source, entry.name), join(drillDir, entry.name));
  }
  const drillDbPath = join(drillDir, DB_FILE);
  const drillKeys = [];
  const drillJobIds = [];
  {
    const drillDb = new DatabaseSync(drillDbPath);
    try {
      drillDb.exec("pragma journal_mode = wal");
      const drillProjectId = drillDb.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get()?.id;
      if (!drillProjectId) fail("The store copy has no project; cannot enqueue drill jobs.");
      // The copy may carry pending intents or non-terminal jobs copied from the
      // live store. A spawned worker must never act on them: delete every
      // preexisting outbox intent in this private copy. claimNext only walks the
      // outbox, so without an intent no preexisting job can ever be claimed or
      // submitted. (Deleting an intent cannot cause a provider call; keeping one
      // could double-spend the original job.) Counts are recorded in the report.
      const preexistingIntents = Number(drillDb.prepare("SELECT count(*) AS c FROM outbox").get().c);
      const nonTerminalCopied = Number(drillDb.prepare("SELECT count(*) AS c FROM jobs WHERE status NOT IN ('blocked','canceled','failed','completed')").get().c);
      drillDb.prepare("DELETE FROM outbox WHERE job_id NOT LIKE 'drill-job-%'").run();
      const remainingPreexisting = Number(drillDb.prepare("SELECT count(*) AS c FROM outbox WHERE job_id NOT LIKE 'drill-job-%'").get().c);
      if (remainingPreexisting !== 0) fail("Failed to neutralize preexisting outbox intents in the drill copy");
      report.drills.killRestartSeed = { preexistingIntentsNeutralized: preexistingIntents, preexistingNonTerminalJobs: nonTerminalCopied };
      const createdAt = Date.now();
      const insertRecord = drillDb.prepare("INSERT INTO records(kind,id,project_id,natural_key,payload) VALUES('job',?,?,?,?)");
      const insertJob = drillDb.prepare("INSERT INTO jobs(job_id,project_id,idempotency_key,status,provider_ref,request_hash) VALUES(?,?,?,'queued',NULL,?)");
      const insertOutbox = drillDb.prepare("INSERT INTO outbox(id,job_id,created_at) VALUES(?,?,?)");
      drillDb.exec("begin");
      for (let index = 0; index < jobCount; index += 1) {
        const jobId = `drill-job-${String(index).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
        const key = `drill-key-${String(index).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
        drillJobIds.push(jobId);
        drillKeys.push(key);
        // providerId is null on purpose: the standalone worker fails this job
        // CAPABILITY_MISMATCH before any provider or network access, so the drill
        // proves lease/ownership recovery without any chance of a paid submit.
        const requestSnapshot = { prompt: "C15 recovery drill; submission gated (no provider)" };
        const job = {
          version: 1, id: jobId, projectId: drillProjectId, operation: "anchor", status: "queued",
          idempotencyKey: key, requestSnapshot,
          requestHash: createHash("sha256").update(canonicalJson(requestSnapshot), "utf8").digest("hex"),
          providerId: null, modelId: null, providerRef: null, quoteId: null, receiptId: null, resultId: null,
          resultAssetIds: [], leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0,
          errorCode: null, errorMessage: null, createdAt, updatedAt: createdAt,
        };
        insertRecord.run(jobId, drillProjectId, key, JSON.stringify(job));
        insertJob.run(jobId, drillProjectId, key, job.requestHash);
        insertOutbox.run(randomUUID(), jobId, createdAt);
      }
      drillDb.exec("commit");
    } finally {
      drillDb.close();
    }
  }
  const preexistingStatuses = (() => {
    const db = readOnlyDb(drillDbPath);
    try {
      return Object.fromEntries(db.prepare("SELECT job_id, status FROM jobs WHERE job_id NOT LIKE 'drill-job-%'").all().map(row => [row.job_id, row.status]));
    } finally { db.close(); }
  })();

  // Spawn the worker exactly as the documented ops command does
  // (package.json "studio:worker": node --import tsx scripts/production-worker.mjs);
  // the repo's TypeScript modules need the tsx loader under plain node.
  const spawnWorker = () => {
    const child = spawn(process.execPath, ["--import", "tsx", workerScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, PERABYTE_STUDIO_DATA_DIR: drillDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.tail = { stdout: "", stderr: "" };
    child.stdout.on("data", chunk => { child.tail.stdout = `${child.tail.stdout}${chunk}`.slice(-4000); });
    child.stderr.on("data", chunk => { child.tail.stderr = `${child.tail.stderr}${chunk}`.slice(-4000); });
    return child;
  };
  const waitForExit = child => new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  const waitForExitWithTimeout = async (child, ms) => {
    const exit = await Promise.race([waitForExit(child), sleep(ms).then(() => null)]);
    if (!exit) {
      child.kill("SIGKILL");
      await waitForExit(child);
      return { code: null, signal: "SIGKILL-after-timeout" };
    }
    return exit;
  };
  const waitForOwnerFile = async (child, label) => {
    const ownerPath = join(drillDir, "worker-owner.json");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) fail(`${label} exited before acquiring worker ownership: ${scrub(child.tail.stderr)}`);
      // A kill -9 leaves the previous owner file behind as a crash artifact; only
      // accept the file once the freshly spawned pid owns it.
      if (existsSync(ownerPath)) {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (owner.pid === child.pid) return owner;
      }
      await sleep(50);
    }
    fail(`${label} never took worker ownership within 90s: ${scrub(child.tail.stderr)}`);
  };
  const pollDrillJobs = () => {
    const db = readOnlyDb(drillDbPath);
    try {
      const jobs = db.prepare("SELECT id, json_extract(payload,'$.status') AS status, json_extract(payload,'$.attempt') AS attempt FROM records WHERE kind='job' AND id LIKE 'drill-job-%'").all();
      const outbox = db.prepare("SELECT id, job_id FROM outbox WHERE job_id LIKE 'drill-job-%'").all();
      return { jobs, outbox };
    } finally { db.close(); }
  };
  const recordOutbox = snapshot => {
    for (const row of snapshot.outbox) {
      if (!outboxSeen.has(row.job_id)) outboxSeen.set(row.job_id, new Set());
      outboxSeen.get(row.job_id).add(row.id);
    }
  };
  const outboxSeen = new Map();

  // Worker 1: adopts the copy, starts claiming, gets SIGSTOP + kill -9 mid-stream.
  const worker1 = spawnWorker();
  const owner1 = await waitForOwnerFile(worker1, "worker-1");
  if (owner1.pid !== worker1.pid) fail(`worker-1 owner file pid ${owner1.pid} != spawned pid ${worker1.pid}`);
  const stopDeadline = Date.now() + 120_000;
  let atStop = null;
  while (Date.now() < stopDeadline) {
    if (worker1.exitCode !== null || worker1.signalCode !== null) fail(`worker-1 exited on its own before the kill: code=${worker1.exitCode} ${scrub(worker1.tail.stderr)}`);
    const snapshot = pollDrillJobs();
    recordOutbox(snapshot);
    const terminal = snapshot.jobs.filter(job => TERMINAL.has(job.status)).length;
    const inFlight = snapshot.jobs.filter(job => job.attempt >= 1 && !TERMINAL.has(job.status)).length;
    if (inFlight >= 1) { atStop = { terminal, inFlight, queued: snapshot.jobs.length - terminal - inFlight }; break; }
    if (snapshot.jobs.length > 0 && terminal === snapshot.jobs.length) {
      fail("worker-1 drained every drill job before it could be killed mid-stream; rerun with a higher --jobs count");
    }
    await sleep(20);
  }
  if (!atStop) fail("Timed out waiting for worker-1 to claim a drill job");
  worker1.kill("SIGSTOP");
  await sleep(100);
  worker1.kill("SIGKILL");
  const exit1 = await waitForExit(worker1);
  if (exit1.signal !== "SIGKILL") fail(`worker-1 did not die by SIGKILL (code=${exit1.code} signal=${exit1.signal})`);
  const killArtifact = existsSync(join(drillDir, "worker-owner.json"));
  console.log(`[c15] worker-1 (pid ${worker1.pid}) killed by SIGKILL mid-stream: ${JSON.stringify(atStop)}`);
  // Probe the FROZEN store: a committed-but-non-terminal claim at freeze time is the only
  // state worker-2 must reclaim (and the only way an attempt-2 can appear). If the freeze
  // landed inside a claimNext transaction instead, SIGKILL rolls that claim back and every
  // job finishes at the attempt it had when last committed. The earlier atStop snapshot is
  // taken while worker-1 is still running, so it may show an in-flight job that was already
  // completed before the freeze — the frozen probe below is the authoritative state.
  const frozen = pollDrillJobs();
  const frozenInFlightCommitted = frozen.jobs.filter(job => job.attempt >= 1 && !TERMINAL.has(job.status)).length;
  console.log(`[c15] frozen store after SIGKILL: inFlightCommitted=${frozenInFlightCommitted}`);
  // Job leases and outbox claims live 30s; wait out the window plus slack.
  await sleep(36_000);
  // Worker 2: restart on the same data dir; must reclaim expired leases and finish.
  const worker2 = spawnWorker();
  const owner2 = await waitForOwnerFile(worker2, "worker-2");
  if (owner2.pid !== worker2.pid) fail(`worker-2 owner file pid ${owner2.pid} != spawned pid ${worker2.pid}`);
  const settleDeadline = Date.now() + 240_000;
  let settled = false;
  while (Date.now() < settleDeadline) {
    if (worker2.exitCode !== null || worker2.signalCode !== null) fail(`worker-2 exited before settling the drill jobs: ${scrub(worker2.tail.stderr)}`);
    const snapshot = pollDrillJobs();
    recordOutbox(snapshot);
    if (snapshot.jobs.length > 0 && snapshot.jobs.every(job => TERMINAL.has(job.status))) { settled = true; break; }
    await sleep(250);
  }
  if (!settled) fail("worker-2 did not drive every drill job to a terminal state within 240s");
  worker2.kill("SIGTERM");
  const exit2 = await waitForExitWithTimeout(worker2, 20_000);
  const ownerAfterShutdown = existsSync(join(drillDir, "worker-owner.json"));

  // Final invariants on the drill copy.
  const placeholders = drillKeys.map(() => "?").join(",");
  const db = readOnlyDb(drillDbPath);
  let drill;
  try {
    const jobs = db.prepare(`SELECT j.job_id AS id, j.status AS mirror, json_extract(r.payload,'$.status') AS status, json_extract(r.payload,'$.attempt') AS attempt FROM jobs j JOIN records r ON r.kind='job' AND r.id=j.job_id WHERE j.idempotency_key IN (${placeholders})`).all(...drillKeys);
    const submittingEvents = Number(db.prepare(`SELECT count(*) AS c FROM job_events e JOIN jobs j ON j.job_id=e.job_id WHERE j.idempotency_key IN (${placeholders}) AND e.status IN ('submitting','submission_unknown')`).get(...drillKeys).c);
    const eventSequencesGapless = jobs.every(job => {
      const sequences = db.prepare("SELECT sequence FROM job_events WHERE job_id=? ORDER BY sequence").all(job.id).map(row => Number(row.sequence));
      return sequences.every((sequence, index) => sequence === index + 1);
    });
    const outboxRowsRemaining = Number(db.prepare(`SELECT count(*) AS c FROM outbox WHERE job_id IN (SELECT job_id FROM jobs WHERE idempotency_key IN (${placeholders}))`).get(...drillKeys).c);
    const reservations = Number(db.prepare(`SELECT count(*) AS c FROM budget_reservations WHERE idempotency_key IN (${placeholders})`).get(...drillKeys).c);
    const executions = Number(db.prepare(`SELECT count(*) AS c FROM budget_executions WHERE idempotency_key IN (${placeholders})`).get(...drillKeys).c);
    const currentStatuses = Object.fromEntries(db.prepare("SELECT job_id, status FROM jobs WHERE job_id NOT LIKE 'drill-job-%'").all().map(row => [row.job_id, row.status]));
    const historyUntouched = JSON.stringify(preexistingStatuses) === JSON.stringify(currentStatuses);
    const mirrorConsistent = jobs.every(job => job.mirror === job.status);
    const attemptsBounded = jobs.every(job => job.attempt >= 1 && job.attempt <= 2);
    const attemptsHistogram = jobs.reduce((acc, job) => { acc[job.attempt] = (acc[job.attempt] ?? 0) + 1; return acc; }, {});
    const reclaimedAtAttempt2 = jobs.filter(job => job.attempt >= 2).length;
    const reclaimConsistent = reclaimedAtAttempt2 === frozenInFlightCommitted;
    const allTerminal = jobs.length > 0 && jobs.every(job => TERMINAL.has(job.status));
    const intentsPerJob = [...outboxSeen.values()].map(set => set.size);
    drill = {
      kill: {
        worker1Pid: worker1.pid, worker2Pid: worker2.pid, killedBySignal: exit1.signal, atStop,
        frozenInFlightCommitted,
        ownerArtifactAfterCrash: killArtifact,
      },
      restart: {
        worker2Exit: exit2, ownerAdopted: owner2.pid === worker2.pid,
        cleanShutdownRemovedOwner: !ownerAfterShutdown,
      },
      jobsTotal: jobs.length,
      allTerminal,
      attemptsBounded,
      attemptsHistogram,
      reclaimedAtAttempt2,
      reclaimConsistent,
      submissionEvents: submittingEvents,
      outboxRowsRemaining,
      reservations,
      executions,
      eventSequencesGapless,
      distinctOutboxIntentsPerJobMax: intentsPerJob.length ? Math.max(...intentsPerJob) : 0,
      mirrorConsistent,
      historyUntouched,
      worker1Tail: scrub(worker1.tail.stderr),
      worker2Tail: scrub(worker2.tail.stderr),
    };
    drill.pass = allTerminal && attemptsBounded && reclaimConsistent && submittingEvents === 0 && outboxRowsRemaining === 0
      && reservations === 0 && executions === 0 && eventSequencesGapless
      && drill.distinctOutboxIntentsPerJobMax <= 1 && mirrorConsistent && historyUntouched
      && killArtifact && drill.restart.cleanShutdownRemovedOwner;
  } finally {
    db.close();
  }
  report.drills.killRestart = drill;

  report.allPass = report.drills.backupRestore.pass && report.drills.orphanMedia.pass
    && report.drills.exportHashes.pass && report.drills.killRestart.pass;
  const reportPath = args.report ? resolve(args.report) : join(work, "recovery-report.json");
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`[c15] backup/restore: ${report.drills.backupRestore.pass ? "PASS" : "FAIL"} (countsMatch=${countsMatch} hashesMatch=${restoredHashesMatch} integrity=${restored.report.integrityCheck.ok} fk=${restored.report.foreignKeyCheck.violations === 0} sourceUntouched=${sourceUntouched})`);
  console.log(`[c15] orphan media: ${report.drills.orphanMedia.pass ? "PASS" : "FAIL"} (files=${orphanReport.totalFiles} referenced=${orphanReport.referencedCount} orphans=${orphanReport.orphans.length} missingReferenced=${orphanReport.missingReferenced.length})`);
  console.log(`[c15] export hashes: ${report.drills.exportHashes.pass ? "PASS" : "FAIL"} (${exportChecks.filter(check => check.verified).length}/${exportChecks.length} verified)`);
  console.log(`[c15] kill -9 restart: ${report.drills.killRestart.pass ? "PASS" : "FAIL"} (jobs=${drill.jobsTotal} terminal=${drill.allTerminal} attempts<=2=${drill.attemptsBounded} frozenInFlight=${drill.kill.frozenInFlightCommitted} reclaimed@2=${drill.reclaimedAtAttempt2} reclaimConsistent=${drill.reclaimConsistent} submissionEvents=${drill.submissionEvents} outboxRemaining=${drill.outboxRowsRemaining} maxIntentsPerJob=${drill.distinctOutboxIntentsPerJobMax})`);
  console.log(`[c15] report: ${reportPath}`);
  if (args.clean && report.allPass) rmSync(work, { recursive: true, force: true });
  if (!report.allPass) process.exitCode = 1;
}

main().catch(error => {
  console.error(`verify-production-recovery: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
