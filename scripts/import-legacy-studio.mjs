#!/usr/bin/env node
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

function argumentsMap(argv) {
  const result = {};
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i]; if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key=arg.slice(2); if (!["source","db","backup"].includes(key)) throw new Error(`Unknown option: ${arg}`);
    const value=argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`); result[key]=value;
  }
  for (const key of ["source","db","backup"]) if (!result[key]) throw new Error(`Required option missing: --${key}`);
  return result;
}

try {
  const args=argumentsMap(process.argv.slice(2));
  const {importLegacyStudio}=await tsImport(resolve("lib/repositories/production/legacy-import.ts"),{parentURL:import.meta.url});
  const report=await importLegacyStudio({sourceDir:args.source,dbPath:args.db,backupDir:args.backup});
  process.stdout.write(`${JSON.stringify({status:report.status,files:report.files,records:report.records,errors:report.errors.length,sourceKey:report.sourceKey,backupDir:report.backupDir})}\n`);
  if(report.status!=="complete") process.exitCode=1;
} catch(error) {
  const message=error instanceof Error?error.message:"Import failed";
  process.stderr.write(`Legacy import failed: ${message}\n`); process.exitCode=1;
}
