#!/usr/bin/env node
// C15-RECOVERY production backup: a consistent, verifiable snapshot of a Perabyte
// production data dir (production.sqlite + media vault) into an archive directory
// with a sha256 manifest of every byte.
//
// Usage: node scripts/production-backup.mjs --data-dir <dir> --out <archive-dir>
//
// Requires Node >= 22.12 (node:sqlite). No third-party dependencies.
// The source data dir is only ever opened READ-ONLY: the SQLite snapshot is taken
// with `VACUUM INTO`, which runs in a read transaction against the WAL database
// and writes a self-contained, fully checkpointed database file into the archive.
// (better-sqlite3's `.backup()` is not reachable from a node-builtins-only script;
// `VACUUM INTO` is SQLite's equivalent consistent-snapshot mechanism.) The tool
// refuses to write anywhere under the source data dir.

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DB_FILE = "production.sqlite";
export const SNAPSHOT_FILE = "production.sqlite.snapshot";
export const MEDIA_ROOT = "media";
export const MANIFEST_FILE = "manifest.json";
export const BACKUP_KIND = "perabyte-production-backup";
export const BACKUP_SCHEMA_VERSION = 1;

/** Raised for every refusal and operational failure; the CLI exits 1 on it. */
export class RecoveryToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecoveryToolError";
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function listMediaFiles(sourceRoot, archiveRoot, relativeBase = "") {
  const files = [];
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = join(sourceRoot, entry.name);
    const archivePath = join(archiveRoot, entry.name);
    const relativePath = `${relativeBase}${entry.name}`;
    if (entry.isSymbolicLink() || lstatSync(sourcePath).isSymbolicLink()) {
      throw new RecoveryToolError(`Media vault entry is a symlink; refusing to archive it: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      mkdirSync(archivePath, { recursive: true, mode: 0o700 });
      files.push(...listMediaFiles(sourcePath, archivePath, `${relativePath}/`));
      continue;
    }
    if (!entry.isFile()) {
      throw new RecoveryToolError(`Media vault entry is not a regular file: ${sourcePath}`);
    }
    copyFileSync(sourcePath, archivePath);
    files.push({ path: relativePath, bytes: lstatSync(archivePath).size });
  }
  return files;
}

/**
 * Create `<out>/backup-<utc-stamp>/{production.sqlite.snapshot,media/,manifest.json}`.
 * Returns `{ archiveDir, manifest }`. Throws RecoveryToolError instead of writing
 * anything when the source or target is unusable.
 */
export async function createBackup({ dataDir, out, clock = () => new Date().toISOString() }) {
  const source = resolve(dataDir);
  const outDir = resolve(out);
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new RecoveryToolError(`Source data dir does not exist: ${source}`);
  }
  const dbPath = join(source, DB_FILE);
  if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
    throw new RecoveryToolError(`No production database at ${dbPath}; pass --data-dir <dir> containing ${DB_FILE}.`);
  }
  if (outDir === source || outDir.startsWith(source + sep)) {
    throw new RecoveryToolError(`Backup output ${outDir} must not live inside the source data dir ${source}.`);
  }
  const stamp = utcStamp();
  let archiveDir = join(outDir, `backup-${stamp}`);
  for (let suffix = 2; lstatSync(archiveDir, { throwIfNoEntry: false }); suffix += 1) {
    archiveDir = join(outDir, `backup-${stamp}-${suffix}`);
  }
  const staging = join(outDir, `.backup-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const snapshotPath = join(staging, SNAPSHOT_FILE);
    const sourceDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      sourceDb.exec(`vacuum into '${snapshotPath.replace(/'/g, "''")}'`);
    } catch (error) {
      throw new RecoveryToolError(`Unable to take a consistent SQLite snapshot of ${dbPath}: ${error.message}`);
    } finally {
      sourceDb.close();
    }
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const rows = snapshotDb.prepare("pragma integrity_check").all();
      if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
        throw new RecoveryToolError(`Backup snapshot failed its integrity check: ${rows.map(row => row.integrity_check).join("; ")}`);
      }
    } finally {
      snapshotDb.close();
    }
    const mediaSource = join(source, MEDIA_ROOT);
    let mediaFiles = [];
    if (existsSync(mediaSource)) {
      mkdirSync(join(staging, MEDIA_ROOT), { recursive: true, mode: 0o700 });
      mediaFiles = listMediaFiles(mediaSource, join(staging, MEDIA_ROOT), `${MEDIA_ROOT}/`);
    }
    for (const file of mediaFiles) file.sha256 = await sha256File(join(staging, file.path));
    const database = { file: SNAPSHOT_FILE, bytes: lstatSync(snapshotPath).size, sha256: await sha256File(snapshotPath) };
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: BACKUP_KIND,
      createdAt: clock(),
      source: { database: DB_FILE },
      database,
      media: {
        root: MEDIA_ROOT,
        fileCount: mediaFiles.length,
        bytes: mediaFiles.reduce((total, file) => total + file.bytes, 0),
        files: mediaFiles,
      },
    };
    writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, archiveDir);
    return { archiveDir, manifest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== "--data-dir" && flag !== "--out") {
      throw new RecoveryToolError(`Unknown argument: ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (!value) throw new RecoveryToolError(`Missing value for ${flag}`);
    args[flag.slice(2)] = value;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args["data-dir"] || !args.out) {
    throw new RecoveryToolError(`Usage: node ${basename(fileURLToPath(import.meta.url))} --data-dir <dir> --out <archive-dir>`);
  }
  const { archiveDir, manifest } = await createBackup(args);
  console.log(JSON.stringify({
    ok: true,
    archiveDir,
    database: manifest.database,
    media: { fileCount: manifest.media.fileCount, bytes: manifest.media.bytes },
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`production-backup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
