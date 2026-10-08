#!/usr/bin/env node
// C15-RECOVERY production restore: rebuild a production data dir from a
// production-backup.mjs archive after process or host loss.
//
// Usage: node scripts/production-restore.mjs --archive <dir> --into <fresh-dir>
//
// Requires Node >= 22.12 (node:sqlite). No third-party dependencies.
// The archive is refused (exit 1, actionable message) unless every manifest
// entry exists with an exact size and sha256, no entry is missing or unlisted,
// no path escapes the archive (absolute, "..", or symlink), and the restored
// database passes PRAGMA integrity_check and PRAGMA foreign_key_check. A full
// restore-report.json (every count and hash) is written into the target.

import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_KIND, BACKUP_SCHEMA_VERSION, DB_FILE, MANIFEST_FILE, MEDIA_ROOT, SNAPSHOT_FILE, RecoveryToolError, sha256File } from "./production-backup.mjs";

export const RESTORE_REPORT_FILE = "restore-report.json";
export const RESTORE_KIND = "perabyte-production-restore-report";
export const RESTORE_SCHEMA_VERSION = 1;
const TERMINAL_NOTE = "Media vault entries are content-addressed; paths use POSIX separators.";

function refuse(because) {
  throw new RecoveryToolError(`Refusing to restore: ${because}`);
}

function validateEntryPath(path) {
  if (typeof path !== "string" || path.length === 0) refuse("a manifest media path is empty");
  if (path.includes("\\") || path.includes("\0")) refuse(`manifest media path contains a backslash or NUL: ${path}`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) refuse(`manifest media path is absolute: ${path}`);
  const parts = path.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) {
    refuse(`manifest media path contains an empty, ".", or ".." segment (path traversal): ${path}`);
  }
  if (parts[0] !== MEDIA_ROOT || parts.length < 2) refuse(`manifest media path must live under ${MEDIA_ROOT}/: ${path}`);
  return path;
}

function walkArchive(root, prefix = "") {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      refuse(`archived entry is a symlink, so the archive is not a plain trusted copy: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      found.push(...walkArchive(path, `${relativePath}/`));
      continue;
    }
    if (!entry.isFile()) refuse(`archived entry is not a regular file: ${relativePath}`);
    found.push(relativePath);
  }
  return found;
}

function tableCount(db, sql) {
  return Number(db.prepare(sql).get().c);
}

function logicalCounts(db) {
  return {
    schemaMigrations: tableCount(db, "SELECT count(*) AS c FROM schema_migrations"),
    records: tableCount(db, "SELECT count(*) AS c FROM records"),
    projects: tableCount(db, "SELECT count(*) AS c FROM projects"),
    jobs: tableCount(db, "SELECT count(*) AS c FROM jobs"),
    jobEvents: tableCount(db, "SELECT count(*) AS c FROM job_events"),
    jobLeases: tableCount(db, "SELECT count(*) AS c FROM job_leases"),
    outbox: tableCount(db, "SELECT count(*) AS c FROM outbox"),
    assets: tableCount(db, "SELECT count(*) AS c FROM assets"),
    exports: tableCount(db, "SELECT count(*) AS c FROM records WHERE kind='export'"),
    budgetReservations: tableCount(db, "SELECT count(*) AS c FROM budget_reservations"),
    budgetExecutions: tableCount(db, "SELECT count(*) AS c FROM budget_executions"),
    providerProofArtifacts: tableCount(db, "SELECT count(*) AS c FROM provider_proof_artifacts"),
  };
}

/**
 * Restore `archive` (a createBackup output) into the fresh directory `into`.
 * Returns `{ report, into }`; every refusal throws RecoveryToolError before or
 * after cleaning up any partially written target.
 */
export async function restoreArchive({ archive, into, clock = () => new Date().toISOString() }) {
  const archiveDir = resolve(archive);
  const intoDir = resolve(into);
  if (!statSync(archiveDir, { throwIfNoEntry: false })?.isDirectory()) {
    refuse(`archive directory does not exist: ${archiveDir}`);
  }
  if (intoDir === archiveDir || intoDir.startsWith(archiveDir + sep)) {
    refuse(`restore target ${intoDir} must not live inside the archive ${archiveDir}`);
  }
  const manifestPath = join(archiveDir, MANIFEST_FILE);
  if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    refuse(`archive is missing ${MANIFEST_FILE}, so it is partial: ${archiveDir}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    refuse(`${MANIFEST_FILE} is not valid JSON (${error.message})`);
  }
  if (manifest?.schemaVersion !== BACKUP_SCHEMA_VERSION || manifest?.kind !== BACKUP_KIND) {
    refuse(`manifest is not a schemaVersion ${BACKUP_SCHEMA_VERSION} ${BACKUP_KIND} manifest`);
  }
  if (manifest.database?.file !== SNAPSHOT_FILE || typeof manifest.database.sha256 !== "string") {
    refuse(`manifest database entry must be ${SNAPSHOT_FILE} with a sha256`);
  }
  if (!Array.isArray(manifest.media?.files)) refuse("manifest media.files must be an array");

  const entries = manifest.media.files.map(file => ({
    path: validateEntryPath(file.path),
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  if (byPath.size !== entries.length) refuse("manifest lists duplicate media paths");
  if (Number.isInteger(manifest.media.fileCount) && manifest.media.fileCount !== entries.length) {
    refuse(`manifest media.fileCount is ${manifest.media.fileCount} but ${entries.length} entries are listed`);
  }

  const archivedFiles = walkArchive(archiveDir);
  const allowed = new Set([MANIFEST_FILE, SNAPSHOT_FILE, ...byPath.keys()]);
  for (const relativePath of archivedFiles) {
    if (!allowed.has(relativePath)) {
      refuse(`archived file ${relativePath} is not listed in ${MANIFEST_FILE}; the archive is partial or was modified after backup`);
    }
  }
  const dbSnapshotPath = join(archiveDir, SNAPSHOT_FILE);
  if (!statSync(dbSnapshotPath, { throwIfNoEntry: false })?.isFile()) {
    refuse(`archive is missing ${SNAPSHOT_FILE}, so it is partial`);
  }
  for (const entry of entries) {
    const path = join(archiveDir, entry.path);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      refuse(`archived media entry is missing from the archive: ${entry.path}`);
    }
  }

  const dbActual = { bytes: lstatSync(dbSnapshotPath).size, sha256: await sha256File(dbSnapshotPath) };
  if (dbActual.bytes !== manifest.database.bytes || dbActual.sha256 !== manifest.database.sha256) {
    refuse(`database checksum mismatch for ${SNAPSHOT_FILE}: manifest ${manifest.database.sha256} (${manifest.database.bytes} bytes), actual ${dbActual.sha256} (${dbActual.bytes} bytes); the archive is corrupt or was modified after backup`);
  }
  for (const entry of entries) {
    const path = join(archiveDir, entry.path);
    const actual = { bytes: lstatSync(path).size, sha256: await sha256File(path) };
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      refuse(`checksum mismatch for archived media ${entry.path}: manifest ${entry.sha256} (${entry.bytes} bytes), actual ${actual.sha256} (${actual.bytes} bytes); the archive is corrupt or was modified after backup`);
    }
  }

  const existingTarget = statSync(intoDir, { throwIfNoEntry: false });
  if (existingTarget && !existingTarget.isDirectory()) refuse(`restore target exists and is not a directory: ${intoDir}`);
  if (existingTarget && readdirSync(intoDir).length > 0) {
    refuse(`restore target ${intoDir} is not empty; --into must be a fresh directory`);
  }

  mkdirSync(intoDir, { recursive: true, mode: 0o700 });
  const restoredFiles = [];
  try {
    const restoredDbPath = join(intoDir, DB_FILE);
    copyFileSync(dbSnapshotPath, restoredDbPath);
    chmodSync(restoredDbPath, 0o600);
    restoredFiles.push({ path: DB_FILE, bytes: manifest.database.bytes, sha256: manifest.database.sha256 });
    for (const entry of entries) {
      const target = join(intoDir, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(archiveDir, entry.path), target);
      chmodSync(target, 0o600);
      restoredFiles.push(entry);
    }
    const restored = new DatabaseSync(restoredDbPath, { readOnly: true });
    let integrity;
    let foreignKeyViolations;
    let counts;
    try {
      const rows = restored.prepare("pragma integrity_check").all();
      integrity = { ok: rows.length === 1 && rows[0].integrity_check === "ok", messages: rows.map(row => row.integrity_check) };
      foreignKeyViolations = restored.prepare("pragma foreign_key_check").all().length;
      counts = logicalCounts(restored);
    } finally {
      restored.close();
    }
    if (!integrity.ok) refuse(`restored database failed PRAGMA integrity_check: ${integrity.messages.join("; ")}`);
    if (foreignKeyViolations !== 0) refuse(`restored database failed PRAGMA foreign_key_check with ${foreignKeyViolations} violation(s)`);
    const report = {
      schemaVersion: RESTORE_SCHEMA_VERSION,
      kind: RESTORE_KIND,
      restoredAt: clock(),
      archive: archiveDir,
      into: intoDir,
      note: TERMINAL_NOTE,
      database: { file: DB_FILE, bytes: manifest.database.bytes, sha256: manifest.database.sha256 },
      media: { root: MEDIA_ROOT, fileCount: entries.length, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) },
      files: restoredFiles,
      manifest: { file: MANIFEST_FILE, bytes: lstatSync(manifestPath).size, sha256: await sha256File(manifestPath) },
      integrityCheck: integrity,
      foreignKeyCheck: { ok: foreignKeyViolations === 0, violations: foreignKeyViolations },
      counts,
    };
    writeFileSync(join(intoDir, RESTORE_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return { report, into: intoDir };
  } catch (error) {
    rmSync(intoDir, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== "--archive" && flag !== "--into") throw new RecoveryToolError(`Unknown argument: ${String(flag)}`);
    const value = argv[index + 1];
    if (!value) throw new RecoveryToolError(`Missing value for ${flag}`);
    args[flag.slice(2)] = value;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.archive || !args.into) {
    throw new RecoveryToolError(`Usage: node ${basename(fileURLToPath(import.meta.url))} --archive <dir> --into <fresh-dir>`);
  }
  const { report, into } = await restoreArchive(args);
  console.log(JSON.stringify({
    ok: true,
    into,
    database: report.database,
    media: { fileCount: report.media.fileCount, bytes: report.media.bytes },
    integrityCheck: report.integrityCheck,
    foreignKeyCheck: report.foreignKeyCheck,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`production-restore: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
