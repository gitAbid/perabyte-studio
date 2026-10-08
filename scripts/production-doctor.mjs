import { access, constants, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openProductionStore } from "../lib/repositories/production/sqlite.ts";
import { resolveProductionDataDir } from "../lib/production/runtime.ts";
import { readInstalledSogniProofMetadata } from "../lib/providers/production/sogni-provider.ts";
import { getInstalledPolicy } from "../lib/services/production/policy-service.ts";
const dataDir=resolveProductionDataDir(process.env,process.cwd());
const major=Number(process.versions.node.split(".")[0]);
const node={version:process.versions.node,localWorkerCompatible:major>=20,installedSogniSdkCompatible:major>=22};
const storage={ready:false,schemaVersion:null,schemaRequired:7,schemaCurrent:false,integrity:null};
try{await mkdir(dataDir,{recursive:true,mode:0o700});await access(dataDir,constants.R_OK|constants.W_OK);const store=openProductionStore({dataDir});try{storage.schemaVersion=store.schemaVersion();storage.integrity=store.integrityCheck();storage.ready=storage.integrity.ok;storage.schemaCurrent=storage.schemaVersion===storage.schemaRequired;}finally{store.close();}}catch{}
function binary(executable){const result=spawnSync(executable,["-version"],{encoding:"utf8",timeout:3000,maxBuffer:4096,windowsHide:true});return{available:result.status===0};}
const mediaTools={ffprobe:binary(process.env.FFPROBE_PATH?.trim()||"ffprobe"),ffmpeg:binary(process.env.FFMPEG_PATH?.trim()||"ffmpeg")};
let heartbeatAgeMs=null,workerAvailable=false;try{const parsed=JSON.parse(await readFile(join(dataDir,"worker-heartbeat.json"),"utf8"));const owner=JSON.parse(await readFile(join(dataDir,"worker-owner.json"),"utf8"));if(Number.isSafeInteger(parsed?.at)&&parsed.at<=Date.now()&&parsed.ownerId&&parsed.ownerId===owner.ownerId&&parsed.pid===owner.pid){heartbeatAgeMs=Date.now()-parsed.at;workerAvailable=heartbeatAgeMs<=30_000&&processAlive(parsed.pid);}}catch{}
function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){return error?.code==="EPERM";}}
const lockFiles={owner:false,heartbeat:false};for(const [name,key] of [["worker-owner.json","owner"],["worker-heartbeat.json","heartbeat"]]){try{await access(join(dataDir,name),constants.F_OK);lockFiles[key]=true;}catch{}}
const worker={available:workerAvailable,heartbeatAgeMs,lockFiles,submissionAuthorization:"blocked_until_I01",action:workerAvailable?null:"Start the standalone worker with npm run studio:worker; saved jobs will resume when it is available."};
const provider={providerId:"sogni",credentialsConfigured:Boolean(process.env.SOGNI_API_KEY?.trim()),connection:"not_checked",paidSubmissionEnabled:false,action:process.env.SOGNI_API_KEY?.trim()?"Discovery is not checked by doctor; paid submission remains blocked until the I01 atomic budget reservation is connected.":"Set SOGNI_API_KEY in the server environment to enable provider discovery; credentials are never displayed."};
let providerProofMetadata="fail";try{readInstalledSogniProofMetadata();providerProofMetadata="ok";}catch{}
// Presence comes from the real install: the reviewed-policy service reads
// <dataDir>/reviewed-policy.json and re-validates it offline, so a tampered or
// expired capture reports as absent. Budget identity is never checked online by
// the doctor and the key itself is never reported.
let reviewedPolicyPresent=false;try{reviewedPolicyPresent=(await getInstalledPolicy({env:process.env,cwd:process.cwd()})).configured;}catch{}
const admission={reviewedPolicyPresent,budgetIdentityAvailability:provider.credentialsConfigured?"not_checked":"unavailable",action:reviewedPolicyPresent?null:"No reviewed provider policy capture is installed; quotes stay unknown and submissions stay blocked until a reviewed policy is installed."};
const report={node,storage,mediaTools,worker,provider,admission,readiness:{mediaImport:storage.ready&&mediaTools.ffprobe.available&&mediaTools.ffmpeg.available,backgroundWorker:storage.ready&&node.localWorkerCompatible&&worker.available,providerConnection:node.installedSogniSdkCompatible&&provider.credentialsConfigured?"not_checked":"unavailable",paidSubmission:false},providerProofMetadata};
console.log(JSON.stringify(report));if(!node.localWorkerCompatible||!storage.ready)process.exitCode=1;
