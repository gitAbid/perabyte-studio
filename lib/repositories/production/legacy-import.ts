import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { openProductionStore } from "./sqlite";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const ALLOWED = /(?:characters|locations|stories|assets|jobs)(?:\/|\.|$)/i;
const MEDIA_EXTENSION = /\.(?:png|jpe?g|webp|wav|mp3|aac|flac|mp4|mov)$/i;
const MEDIA_REFERENCE_KEY = /(?:path|file|media|asset|image|video|audio|uri|url)/i;
export interface LegacyImportOptions { sourceDir: string; dbPath: string; backupDir: string; now?: () => number; }
export interface LegacyImportReport { status: "prepared" | "complete" | "invalid"; source: string; sourceKey: string; files: number; records: number; fileHashes: Record<string,string>; errors: {path:string;message:string}[]; backupDir: string; }

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }); const found: string[] = [];
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...await walk(path)); else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function inspectFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Expected a regular file: ${path}`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return { bytes: metadata.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readFileNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function collectMediaReferences(value: unknown, key: string, results: string[]): void {
  if (typeof value === "string") {
    if (MEDIA_REFERENCE_KEY.test(key) && MEDIA_EXTENSION.test(value) && !/^https?:\/\//i.test(value) && !/^data:/i.test(value)) results.push(value);
    return;
  }
  if (Array.isArray(value)) { value.forEach(item => collectMediaReferences(item, key, results)); return; }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectMediaReferences(child, childKey, results);
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

class SourceChangedDuringImportError extends Error {
  constructor(path: string) {
    super(`Source file changed while its backup was being created: ${path}`);
    this.name = "SourceChangedDuringImportError";
  }
}

async function canonicalTarget(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const actual = await realpath(current);
      return join(actual, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

async function prepareBackupRoot(requestedPath: string): Promise<string> {
  const path = resolve(requestedPath);
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isDirectory()) throw new Error("backupDir must be a real directory, not a symlink or file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("backupDir must be a real directory, not a symlink or file");
  const actual = await realpath(path);
  await chmod(actual, 0o700);
  return actual;
}

async function ensureSafeParent(root: string, relativePath: string): Promise<string> {
  const parts = dirname(relativePath).split(/[\\/]/).filter(part => part && part !== ".");
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe backup path component: ${next}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(next, { mode: 0o700 }); }
      catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe backup path component: ${next}`);
    }
    current = await realpath(next);
    if (!isWithin(root, current)) throw new Error(`Backup path escaped its root: ${next}`);
  }
  return current;
}

async function copyIntoBackup(sourcePath: string, backupRoot: string, relativePath: string, expectedHash?: string): Promise<{ bytes: number; sha256: string }> {
  const parent = await ensureSafeParent(backupRoot, relativePath);
  const destination = join(parent, relativePath.split(/[\\/]/).at(-1)!);
  const sourceSnapshot = await inspectFile(sourcePath);
  if (expectedHash && sourceSnapshot.sha256 !== expectedHash) throw new SourceChangedDuringImportError(relativePath);
  const snapshotHash = expectedHash ?? sourceSnapshot.sha256;
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe existing backup file: ${relativePath}`);
    const destinationSnapshot = await inspectFile(destination);
    if (snapshotHash !== destinationSnapshot.sha256 || sourceSnapshot.bytes !== destinationSnapshot.bytes) throw new Error(`Refusing to overwrite an unknown backup file: ${relativePath}`);
    return destinationSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  const destinationSnapshot = await inspectFile(destination);
  if (snapshotHash !== destinationSnapshot.sha256 || sourceSnapshot.bytes !== destinationSnapshot.bytes) {
    const info = await lstat(destination);
    if (info.isFile() && !info.isSymbolicLink()) await unlink(destination);
    throw new SourceChangedDuringImportError(relativePath);
  }
  return destinationSnapshot;
}

async function writeOwnedMetadata(path: string, text: string, source: string, sourceKey: string, kind: "report" | "manifest"): Promise<void> {
  let existed = false;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe existing backup metadata: ${path}`);
    existed = true;
    const current = JSON.parse((await readFileNoFollow(path)).toString("utf8")) as { source?: unknown; sourceKey?: unknown; status?: unknown; version?: unknown };
    const owned = current.source === source && current.sourceKey === sourceKey &&
      (kind === "report" ? ["prepared", "complete", "invalid"].includes(String(current.status)) : current.version === 1);
    if (!owned) throw new Error(`Refusing to overwrite unknown backup metadata: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (existed) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe backup metadata replacement: ${path}`);
    } else {
      await lstat(path).then(() => { throw new Error(`Refusing to replace unexpected backup metadata: ${path}`); }, error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function splitRawJsonRecords(raw: string): string[] {
  const text = raw.trim();
  if (!text.startsWith("[")) return [text];
  const result: string[] = [];
  let start = 1, objects = 0, arrays = 0, inString = false, escaped = false;
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") objects++;
    else if (char === "}") objects--;
    else if (char === "[") arrays++;
    else if (char === "]") {
      if (objects === 0 && arrays === 0) {
        const item = text.slice(start, index).trim();
        if (item) result.push(item);
        return result;
      }
      arrays--;
    } else if (char === "," && objects === 0 && arrays === 0) {
      const item = text.slice(start, index).trim();
      if (item) result.push(item);
      start = index + 1;
    }
  }
  throw new SyntaxError("Could not split validated legacy JSON array");
}

/** Copies source bytes and inventories media before committing any import-complete ledger row. */
export async function importLegacyStudio(options: LegacyImportOptions): Promise<LegacyImportReport> {
  const source = await realpath(resolve(options.sourceDir));
  const backupRequested = resolve(options.backupDir);
  const dbPath = resolve(options.dbPath);
  const backupCanonical = await canonicalTarget(backupRequested);
  const dbCanonical = await canonicalTarget(dbPath);
  if (isWithin(source, backupRequested) || isWithin(backupRequested, source) || isWithin(source, backupCanonical) || isWithin(backupCanonical, source)) throw new Error("backupDir must be separate from sourceDir");
  if (isWithin(source, dbCanonical) || isWithin(backupCanonical, dbCanonical) || isWithin(dbCanonical, backupCanonical)) throw new Error("dbPath must be outside sourceDir and backupDir");
  const backupDir = await prepareBackupRoot(backupRequested);
  const files = await walk(source);
  const selected = new Set(files.filter(path => (ALLOWED.test(relative(source,path).replaceAll("\\","/")) && path.toLowerCase().endsWith(".json")) || MEDIA_EXTENSION.test(path)));
  const available = new Set(files.map(path => resolve(path)));
  const errors: LegacyImportReport["errors"] = [], fileHashes: Record<string,string> = {};
  const fileSizes = new Map<string, number>();
  const parsed: {path:string; raw:string; hash:string; value:unknown; rows:{raw:string;value:unknown}[]}[] = [];
  const eligible = [...selected].filter(path => path.toLowerCase().endsWith(".json")).sort();
  if (!eligible.length) errors.push({ path: source, message: "No explicitly supported legacy JSON records found (characters, locations, stories, assets, or jobs)" });
  for (const path of eligible) {
    const bytes = await readFileNoFollow(path), raw = bytes.toString("utf8"), rel = relative(source,path).replaceAll("\\","/");
    const fileHash = sha(bytes);
    fileHashes[rel] = fileHash;
    fileSizes.set(rel, bytes.byteLength);
    try {
      const value:unknown = JSON.parse(raw);
      const rows = splitRawJsonRecords(raw).map(payload => ({ raw: payload, value: JSON.parse(payload) as unknown }));
      parsed.push({path:rel,raw,hash:fileHash,value,rows});
    }
    catch { errors.push({path:rel,message:"JSON is malformed; source was preserved without import"}); }
  }
  for (const file of parsed) {
    const refs:string[]=[]; collectMediaReferences(file.value,"",refs);
    for (const mediaRef of refs) {
      const target=resolve(isAbsolute(mediaRef)?mediaRef:join(source,mediaRef));
      if (!isWithin(source,target) || !available.has(target)) {
        errors.push({path:file.path,message:`Referenced local media is missing from the selected source: ${mediaRef}`});
      } else selected.add(target);
    }
  }
  const inventory: {path:string;bytes:number;sha256:string;media:boolean}[] = [];
  for (const path of [...selected].sort()) {
    const rel=relative(source,path);
    try {
      const copied = await copyIntoBackup(path, backupDir, rel, fileHashes[rel]);
      const expectedSize = fileSizes.get(rel);
      if (expectedSize !== undefined && copied.bytes !== expectedSize) throw new SourceChangedDuringImportError(rel);
      inventory.push({path:rel.replaceAll("\\","/"),bytes:copied.bytes,sha256:copied.sha256,media:MEDIA_EXTENSION.test(path)});
    } catch (error) {
      if (!(error instanceof SourceChangedDuringImportError)) throw error;
      errors.push({path:rel,message:`${error.message}; import was blocked and the legacy source remains unchanged`});
    }
  }
  const sourceKey=sha(JSON.stringify({source,fileHashes,inventory}));
  const report: LegacyImportReport = {status:errors.length?"invalid":"prepared",source,sourceKey,files:eligible.length,records:parsed.reduce((sum,file)=>sum+file.rows.length,0),fileHashes,errors,backupDir};
  const backupManifest = {version:1,source,sourceKey:report.sourceKey,files:inventory};
  await writeOwnedMetadata(join(backupDir,"legacy-backup-manifest.json"),JSON.stringify(backupManifest,null,2),source,sourceKey,"manifest");
  await writeOwnedMetadata(join(backupDir,"legacy-import-report.json"),JSON.stringify(report,null,2),source,sourceKey,"report");
  if (errors.length) return report;
  const store = openProductionStore({dbPath,now:options.now});
  try {
    const native = new Database(dbPath,{timeout:250}); native.pragma("foreign_keys=ON");
    try {
      const prior=native.prepare("SELECT source_sha256 AS hash,record_count AS count,report_json AS report FROM legacy_imports WHERE source_key=?").get(report.sourceKey) as {hash:string;count:number;report:string}|undefined;
      if (prior) { const existing=JSON.parse(prior.report) as LegacyImportReport; await writeOwnedMetadata(join(backupDir,"legacy-import-report.json"),JSON.stringify(existing,null,2),source,sourceKey,"report"); return existing; }
      const insert=native.prepare("INSERT INTO legacy_records(source_key,record_key,source_path,source_sha256,payload_json) VALUES(?,?,?,?,?)");
      const tx=native.transaction(()=>{
        let count=0;
        for (const file of parsed) {
          for(let i=0;i<file.rows.length;i++) {
            const row=file.rows[i]; const value=row.value; const id=value&&typeof value==="object"&&"id" in value&&typeof (value as {id?:unknown}).id==="string"?(value as {id:string}).id:`row-${i}`; const key=`${file.path}:${i}:${id}`;
            insert.run(report.sourceKey,key,file.path,file.hash,row.raw); count++;
          }
        }
        const complete={...report,status:"complete" as const,records:count};
        native.prepare("INSERT INTO legacy_imports(source_key,source_sha256,imported_at,record_count,report_json) VALUES(?,?,?,?,?)").run(report.sourceKey,report.sourceKey,options.now?.()??Date.now(),count,JSON.stringify(complete));
        return complete;
      });
      const complete=tx.immediate();
      await writeOwnedMetadata(join(backupDir,"legacy-import-report.json"),JSON.stringify(complete,null,2),source,sourceKey,"report");
      return complete;
    } finally { native.close(); }
  } finally { store.close(); }
}
