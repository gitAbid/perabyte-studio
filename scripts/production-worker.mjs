import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { openProductionStore } from "../lib/repositories/production/sqlite.ts";
import { resolveProductionDataDir } from "../lib/production/runtime.ts";
import { ProductionJobQueue } from "../lib/jobs/production/queue.ts";
import { ProductionWorker } from "../lib/jobs/production/worker.ts";
import { LocalMediaVault } from "../lib/media/production/vault.ts";
import { withProductionComposition } from "../lib/production/composition.ts";
const configuredDataDir=resolveProductionDataDir(process.env,process.cwd());await mkdir(configuredDataDir,{recursive:true,mode:0o700});const dataDir=await realpath(configuredDataDir);
const lockPath=join(dataDir,"worker-owner.json"),heartbeat=join(dataDir,"worker-heartbeat.json"),ownerId=randomUUID();
const schedulerPort=60_001+(createHash("sha256").update(dataDir).digest().readUInt32BE(0)%5_535);const schedulerLock=createServer();
try{await new Promise((resolvePromise,reject)=>{schedulerLock.once("error",reject);schedulerLock.listen(schedulerPort,"127.0.0.1",()=>{schedulerLock.removeListener("error",reject);resolvePromise();});});}catch(error){console.error(error?.code==="EADDRINUSE"?"Another production worker already owns this local scheduler slot.":`Unable to acquire production worker ownership (${error?.code??"socket error"}).`);process.exit(1);}
const ownerTemp=`${lockPath}.${ownerId}.tmp`;const ownerHandle=await open(ownerTemp,"wx",0o600);try{await ownerHandle.writeFile(JSON.stringify({pid:process.pid,ownerId,at:Date.now(),schedulerPort}));await ownerHandle.sync();}finally{await ownerHandle.close();}await rename(ownerTemp,lockPath);
const controller=new AbortController();const stop=()=>controller.abort();process.once("SIGINT",stop);process.once("SIGTERM",stop);
let store,pulse;
async function writeHeartbeat(){const temp=`${heartbeat}.${ownerId}.tmp`;const handle=await open(temp,"w",0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,ownerId,at:Date.now()}));await handle.sync();}finally{await handle.close();}const owner=JSON.parse(await readFile(lockPath,"utf8"));if(owner.ownerId!==ownerId)throw new Error("Production worker ownership was lost.");await rename(temp,heartbeat);}
try{
  store=openProductionStore({dataDir});const queue=new ProductionJobQueue(store);const vault=new LocalMediaVault({root:join(dataDir,"media")});
  // Composition role 'worker': the provider is built with the installed SDK proof metadata, the
  // composer's submission proof resolver, and the vault-backed asset loader; the composer's
  // worker budget context and atomic submission reservation gate every provider submit.
  await withProductionComposition(async composition=>{
    await writeHeartbeat();pulse=setInterval(()=>void writeHeartbeat().catch(()=>controller.abort()),5000);pulse.unref?.();
    await new ProductionWorker({queue,providers:{sogni:composition.provider},vault,prepareBudgetContext:(job,quote,capability)=>composition.composer.prepareWorkerBudgetContext(job,quote,capability),reserveSubmission:(tx,currentJob,quote,capability,at,context)=>composition.composer.reserveSubmission(tx,currentJob,quote,capability,at,context)}).run(controller.signal);
  },{role:"worker",store});
}catch(error){console.error(error instanceof Error?error.message:"Production worker failed.");process.exitCode=1;}finally{
  clearInterval(pulse);store?.close();
  try{const current=JSON.parse(await readFile(lockPath,"utf8"));if(current.ownerId===ownerId){const beat=JSON.parse(await readFile(heartbeat,"utf8").catch(()=>"null"));if(beat?.ownerId===ownerId)await rm(heartbeat,{force:true});await rm(lockPath,{force:true});}}catch{}await new Promise(resolvePromise=>schedulerLock.close(()=>resolvePromise()));
}
