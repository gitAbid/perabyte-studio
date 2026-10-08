#!/usr/bin/env node
// Local audio import for Perabyte Studio production projects. Strictly validates narration,
// music, and SFX bytes by header parsing, stores them in the local media vault, and registers
// the asset with retained rights provenance. Never calls any generation provider.
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const REQUIRED_OPTIONS = ["file", "project", "source", "rights", "attestation"];
const KNOWN_OPTIONS = [...REQUIRED_OPTIONS, "actor", "data-dir"];

function argumentsMap(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!KNOWN_OPTIONS.includes(key)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    result[key] = value;
  }
  for (const key of REQUIRED_OPTIONS) if (!result[key]) throw new Error(`Required option missing: --${key}`);
  return result;
}

function load(name, module) {
  const value = module[name];
  if (!value) throw new Error(`Module did not export ${name}`);
  return value;
}

try {
  const args = argumentsMap(process.argv.slice(2));
  const parent = { parentURL: import.meta.url };
  const audioModule = await tsImport(resolve("lib/services/production/audio.ts"), parent);
  const runtimeModule = await tsImport(resolve("lib/production/runtime.ts"), parent);
  const vaultModule = await tsImport(resolve("lib/media/production/vault.ts"), parent);
  const repositoryModule = await tsImport(resolve("lib/repositories/production/sqlite.ts"), parent);
  const resolveProductionDataDir = load("resolveProductionDataDir", runtimeModule);
  const openProductionStore = load("openProductionStore", repositoryModule);
  const LocalMediaVault = load("LocalMediaVault", vaultModule);
  const importAudioAsset = load("importAudioAsset", audioModule);

  const stat = statSync(args.file);
  if (!stat.isFile()) throw new Error(`Audio source is not a regular file: ${args.file}`);
  const dataDir = args["data-dir"] ? resolve(args["data-dir"]) : resolveProductionDataDir(process.env, process.cwd());
  const store = openProductionStore({ dataDir });
  try {
    const project = store.read.getProject(args.project);
    if (!project) throw new Error(`Unknown project ${args.project}; create the project before importing audio`);
    const vault = new LocalMediaVault({ root: join(dataDir, "media") });
    const result = await importAudioAsset(store, {
      bytes: new Uint8Array(readFileSync(args.file)),
      source: args.source,
      rightsAttestation: args.attestation,
      rightsStatus: args.rights,
      actorId: args.actor ?? "local-creator",
    }, { now: Date.now, putMedia: (bytes, options) => vault.put(bytes, options) });
    process.stdout.write(`${JSON.stringify({
      status: result.created ? "imported" : "exists",
      asset: {
        id: result.asset.id,
        sha256: result.asset.sha256,
        mime: result.asset.mime,
        byteSize: result.asset.byteSize,
        audioSamples: result.asset.audioSamples,
        rightsStatus: result.asset.rightsStatus,
        source: result.asset.importProvenance?.source ?? null,
      },
    })}\n`);
  } finally {
    store.close();
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "IMPORT_FAILED";
  process.stderr.write(`Audio import failed (${code}): ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
