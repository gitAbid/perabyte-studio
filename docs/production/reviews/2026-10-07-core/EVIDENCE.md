# Review evidence at 7570fd7

Read-only production review. Source worktree: /Users/abid/Projects/perabyte-studio/.worktrees/zcode-production-core.

## Lease fencing reproduction

Executed with `node --import tsx --input-type=module` from source worktree. Full script:

```javascript
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExportAssembly } from './lib/media/production/assembly.ts';
const dataDir=await mkdtemp(join(tmpdir(),'review-lease-'));
let record={id:'export-test',manifestId:'manifest-test',status:'queued'};
const store={read:{getExport:()=>({...record}),getManifest:()=>({id:'manifest-test'})},transaction:(fn)=>fn({getExport:()=>({...record}),compareAndSetExport:(next,expected)=>{if(record.status!==expected)return false;record=next;return true;}})};
let rejectA,rejectB,startedA,startedB;
const aStarted=new Promise(r=>startedA=r),bStarted=new Promise(r=>startedB=r);
const runA=runExportAssembly(record.id,{dataDir,store,vault:{},now:()=>1000,assembleManifest:()=>{startedA();return new Promise((_,reject)=>rejectA=reject);}});
await aStarted;
const runB=runExportAssembly(record.id,{dataDir,store,vault:{},now:()=>61000,assembleManifest:()=>{startedB();return new Promise((_,reject)=>rejectB=reject);}});
await bStarted;
console.log('Both runners entered assembly; replacement lease:',JSON.parse(await readFile(join(dataDir,'exports',record.id,'lease.json'),'utf8')).leaseUntil);
rejectA(new Error('old owner resumes and fails'));await runA;
console.log('Old runner changed replacement state:',record.status);
console.log('Replacement lease after old runner cleanup:',await readFile(join(dataDir,'exports',record.id,'lease.json'),'utf8').then(()=> 'present',e=>e.code));
rejectB(new Error('replacement cleanup'));await runB;
await rm(dataDir,{recursive:true,force:true});
```

Exit 0. Observed:

```
Both runners entered assembly; replacement lease: 91000
Old runner changed replacement state: failed
Replacement lease after old runner cleanup: ENOENT
```

## Backup artifact reproduction

Fresh real production store plus an exports/export-test/qc-report-qc-test.json fixture, then actual createBackup and restoreArchive. Both succeeded. Restored QC artifact access returned ENOENT. Fixture contained no project/export DB rows; state-gate consequence was verified from source (qc.ts179,340-341).

Installed Next CLI source node_modules/next/dist/bin/next155,181 confirms default hostname 0.0.0.0 for dev/start. package.json6,8 omit hostname override.

## Independent QC format probe

Root executed an offline `node --import tsx --input-type=module` probe against production/qc.ts.evaluateQc. A schema-valid 48-frame portrait manifest required AAC/48000Hz and carried an exact narration cue; the measurement had H.264/1080x1920/24fps video, successful checksum/decode, matching audio end, -14 LUFS/-2 dBTP, and no detector warnings. Its audio probe was deliberately MP3/44100Hz/one channel.

Exit 0; observed output:

```json
{"verdict":"passed","blockers":[],"advisories":[]}
```

This is a captured result/explanation, not a stored raw process log. It demonstrates missing independent format checks; normal assembly has its own format checks. Remediation must retain separate RED/GREEN regression logs on the actual assigned SHA.

## Evidence limits

The lease reproduction uses injected time and an in-memory store. Closure requires real SQLite and process contention, as specified in REMEDIATION.md. The backup reproduction proved filesystem report loss in an actual archive/restore; its fixture had no full export graph, so end-to-end final-review failure was inferred from source state gates. Closure requires a complete real export graph and actual final-review service call.
