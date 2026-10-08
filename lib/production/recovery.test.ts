import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openProductionStore } from "../repositories/production/sqlite";
import { ProductionJobQueue } from "../jobs/production/queue";
import { hashCanonicalJson } from "./hash";
import { createBackup } from "../../scripts/production-backup.mjs";
import { restoreArchive } from "../../scripts/production-restore.mjs";

const dirs: string[] = []; const stores: ReturnType<typeof openProductionStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sha256File(path: string) {
  const bytes = readFileSync(path);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function makeDataDir(withProject = true): string {
  const dir = mkdtempSync(join(tmpdir(), "recovery-store-")); dirs.push(dir);
  const store = openProductionStore({ dataDir: dir });
  stores.push(store);
  if (withProject) store.transaction(tx => tx.insertProject({
    version: 1, id: "project-1", name: "Recovery project", profileId: "storybook-short-v1",
    profile: { id: "storybook-short-v1", format: "9:16", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null },
    activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null,
    takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1000, updatedAt: 1000, saveVersion: 1,
  }));
  const media = join(dir, "media", "sha256");
  for (const digest of ["a".repeat(64), "b".repeat(64)]) {
    mkdirSync(join(media, digest.slice(0, 2)), { recursive: true });
    writeFileSync(join(media, digest.slice(0, 2), digest), Buffer.from(`media-bytes-${digest.slice(0, 8)}`));
  }
  return dir;
}

function inventory(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? inventory(path, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}

function manifestOf(archiveDir: string) {
  return JSON.parse(readFileSync(join(archiveDir, "manifest.json"), "utf8")) as {
    database: { file: string; bytes: number; sha256: string };
    media: { root: string; fileCount: number; files: { path: string; bytes: number; sha256: string }[] };
  };
}

async function backupOf(dataDir: string, out: string) {
  return await createBackup({ dataDir, out }) as { archiveDir: string; manifest: ReturnType<typeof manifestOf> };
}

describe("production recovery tooling", () => {
  it("backs up the store into a manifest that inventories every database and media byte without writing into the source data dir", async () => {
    const dataDir = makeDataDir();
    const out = mkdtempSync(join(tmpdir(), "recovery-out-")); dirs.push(out);
    const before = inventory(dataDir);
    const mainBefore = statSync(join(dataDir, "production.sqlite"));

    const { archiveDir, manifest } = await backupOf(dataDir, out);

    expect(existsSync(archiveDir)).toBe(true);
    expect(manifest.database.file).toBe("production.sqlite.snapshot");
    expect(manifest.database).toEqual({ file: manifest.database.file, ...sha256File(join(archiveDir, "production.sqlite.snapshot")) });
    expect(manifest.media.files.map(file => file.path).sort())
      .toEqual(inventory(join(dataDir, "media")).map(path => `media/${path}`));
    expect(manifest.media.files).toHaveLength(2);
    for (const file of manifest.media.files) {
      expect(file).toEqual({ path: file.path, ...sha256File(join(archiveDir, file.path)) });
    }
    expect(inventory(archiveDir)).toEqual(["manifest.json", "production.sqlite.snapshot",
      ...inventory(join(archiveDir, "media")).map(path => `media/${path}`)].sort());
    // The source data dir gained no files and its main database was not rewritten.
    expect(inventory(dataDir)).toEqual(before);
    expect(statSync(join(dataDir, "production.sqlite")).mtimeMs).toBe(mainBefore.mtimeMs);
    expect(statSync(join(dataDir, "production.sqlite")).size).toBe(mainBefore.size);
  });

  it("refuses to restore when an archived media file no longer matches its manifest checksum", async () => {
    const dataDir = makeDataDir();
    const out = mkdtempSync(join(tmpdir(), "recovery-out-")); dirs.push(out);
    const { archiveDir } = await backupOf(dataDir, out);
    const victim = join(archiveDir, manifestOf(archiveDir).media.files[0]!.path);
    writeFileSync(victim, Buffer.concat([readFileSync(victim), Buffer.from("tampered")]));

    const into = join(out, "restored");
    await expect(restoreArchive({ archive: archiveDir, into })).rejects.toThrow(/checksum/i);
    expect(existsSync(into)).toBe(false);
  });

  it("refuses manifest path traversal, absolute paths, and symlinked archive entries", async () => {
    const dataDir = makeDataDir();
    const out = mkdtempSync(join(tmpdir(), "recovery-out-")); dirs.push(out);
    const { archiveDir } = await backupOf(dataDir, out);
    const base = manifestOf(archiveDir);

    for (const evil of ["../evil.mp4", "/etc/evil.mp4", "media/../../evil.mp4"]) {
      const crafted = { ...base, media: { ...base.media, fileCount: base.media.fileCount + 1, files: [...base.media.files, { path: evil, bytes: 1, sha256: "0".repeat(64) }] } };
      writeFileSync(join(archiveDir, "manifest.json"), JSON.stringify(crafted));
      await expect(restoreArchive({ archive: archiveDir, into: join(out, `into-${evil.replace(/\W/g, "")}`) }))
        .rejects.toThrow(/traversal|absolute|escapes/i);
    }

    const symlinkManifest = { ...base, media: { ...base.media, fileCount: base.media.fileCount + 1, files: [...base.media.files, { path: "media/link.mp4", bytes: 3, sha256: "1".repeat(64) }] } };
    writeFileSync(join(archiveDir, "manifest.json"), JSON.stringify(symlinkManifest));
    symlinkSync(join(archiveDir, "manifest.json"), join(archiveDir, "media", "link.mp4"));
    await expect(restoreArchive({ archive: archiveDir, into: join(out, "into-link") })).rejects.toThrow(/symlink/i);
  });

  it("refuses partial archives: entries missing on disk and archived files missing from the manifest", async () => {
    const dataDir = makeDataDir();
    const out = mkdtempSync(join(tmpdir(), "recovery-out-")); dirs.push(out);
    const { archiveDir } = await backupOf(dataDir, out);
    const base = manifestOf(archiveDir);

    rmSync(join(archiveDir, base.media.files[0]!.path));
    await expect(restoreArchive({ archive: archiveDir, into: join(out, "into-missing") })).rejects.toThrow(/missing/i);

    const second = await backupOf(dataDir, out);
    const strayDir = join(second.archiveDir, "media", "sha256", "zz");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, "unlisted.bin"), "stray");
    await expect(restoreArchive({ archive: second.archiveDir, into: join(out, "into-extra") }))
      .rejects.toThrow(/not listed|extra|manifest/i);
  });

  it("restores a verified store with database integrity, identical media bytes, and a full restore report", async () => {
    const dataDir = makeDataDir();
    const out = mkdtempSync(join(tmpdir(), "recovery-out-")); dirs.push(out);
    const { archiveDir, manifest } = await backupOf(dataDir, out);
    const into = join(out, "restored");

    const { report } = await restoreArchive({ archive: archiveDir, into });

    expect(report.integrityCheck.ok).toBe(true);
    expect(report.foreignKeyCheck.violations).toBe(0);
    expect(report.database.sha256).toBe(manifest.database.sha256);
    const restoredFiles = report.files as { path: string }[];
    expect(restoredFiles).toHaveLength(1 + manifest.media.files.length);
    expect(restoredFiles.map(file => file.path).sort()).toEqual(
      ["production.sqlite", ...manifest.media.files.map(file => file.path)].sort(),
    );
    const verified = new DatabaseSync(join(into, "production.sqlite"), { readOnly: true });
    try {
      expect(verified.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(verified.prepare("SELECT count(*) AS c FROM projects").get()).toEqual({ c: 1 });
    } finally { verified.close(); }
    stores.push(openProductionStore({ dataDir: into }));
    const reopened = stores[stores.length - 1]!;
    expect(reopened.read.getProject("project-1")?.name).toBe("Recovery project");
    expect(readFileSync(join(into, "restore-report.json"), "utf8")).toContain('"integrityCheck"');
  });

  it("recovers an interrupted lease exactly once across a restart and never resubmits a job that may already be submitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-lease-")); dirs.push(dir);
    let now = 1000;
    const store = openProductionStore({ dbPath: join(dir, "production.sqlite"), now: () => now });
    stores.push(store);
    const queue = new ProductionJobQueue(store, () => now);
    const snapshot = { prompt: "recovery drill" };
    const insertProject = (tx: Parameters<Parameters<typeof store.transaction>[0]>[0]) => tx.insertProject({
      version: 1, id: "project-1", name: "Recovery project", profileId: "storybook-short-v1",
      profile: { id: "storybook-short-v1", format: "9:16", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null },
      activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null,
      takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1000, updatedAt: 1000, saveVersion: 1,
    });
    store.transaction(insertProject);
    queue.enqueue({
      version: 1 as const, id: "job-1", projectId: "project-1", operation: "anchor" as const, status: "queued" as const,
      idempotencyKey: "key-1", requestSnapshot: snapshot, requestHash: hashCanonicalJson(snapshot), providerId: null,
      modelId: null, providerRef: null, quoteId: null, receiptId: null, resultId: null, resultAssetIds: [] as string[],
      leaseToken: null, leaseUntil: null, heartbeatAt: null, attempt: 0, errorCode: null, errorMessage: null,
      createdAt: 1000, updatedAt: 1000,
    });

    // Worker A claims the job and the host dies before it finishes the durable intent.
    const crashed = queue.claimNext(now, 30_000)!;
    const crashedOutboxId = crashed.outbox.id;
    expect(crashed.job.attempt).toBe(1);
    store.close(); stores.splice(stores.indexOf(store), 1);

    // Restart after the lease expired: the same durable outbox intent is reclaimed once.
    now = 40_000;
    const reopened = openProductionStore({ dbPath: join(dir, "production.sqlite"), now: () => now });
    stores.push(reopened);
    const resumed = new ProductionJobQueue(reopened, () => now);
    const recovered = resumed.claimNext(now, 30_000)!;
    expect(recovered.outbox.id).toBe(crashedOutboxId);
    expect(recovered.job.attempt).toBe(2);
    expect(recovered.job.status).toBe("queued");
    expect(new ProductionJobQueue(reopened, () => now).claimNext(now, 30_000)).toBeNull();

    // A job whose provider submission may already have been accepted never resubmits:
    // it recovers to submission_unknown and its single outbox intent is acknowledged.
    resumed.store.transaction(tx => {
      const current = tx.getJob("job-1")!;
      const next = { ...current, status: "submitting" as const, updatedAt: now };
      if (!tx.updateLeasedJob(next, recovered.lease.leaseToken)) throw new Error("fixture could not seed submitting");
      tx.appendJobEvent({ jobId: next.id, sequence: tx.listJobEvents(next.id, 0).length + 1, at: now, status: "submitting", message: "fixture submission", progress: null });
      return next;
    });
    now = 80_000;
    const afterCrash = resumed.claimNext(now, 30_000)!;
    expect(afterCrash.job.status).toBe("submission_unknown");
    resumed.finishOutbox(afterCrash.outbox, afterCrash.lease);
    expect(resumed.claimNext(now + 1000, 30_000)).toBeNull();
    expect(reopened.read.getJob("job-1")?.status).toBe("submission_unknown");
    // The acknowledged intent is only re-armed through explicit idempotent ensureOutbox.
    expect(reopened.transaction(tx => tx.ensureOutbox({ id: randomUUID(), jobId: "job-1", createdAt: now, claimedAt: null, claimToken: null }))).toBe(true);
  });
});
