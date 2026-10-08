import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openProductionStore } from "./sqlite";
import type { OutboxIntent, ProductionWritePort } from "./ports";
import type { Approval, Project } from "../../production/contracts";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { ProviderProofPayloadSchema } from "../../production/provider-proof";

type FutureBudgetReadPort = {
  getLatestAccountPolicy(scope: {providerId:string;accountId:string;currency:string|null;unit:"minor_currency"|"spark_token"}): unknown;
  getAccountPolicyRevision(revisionId:string): unknown;
  getBudgetQuote(id:string): unknown;
  listBudgetLedger(scope:unknown): {reservation:unknown;events:{sequence:number;evidence:unknown;semanticHash:string}[]}[];
};
type FutureBudgetWritePort = {
  appendAccountPolicy(record: unknown, expectedRevision:number|null): boolean;
  insertBudgetQuote(record: unknown, binding: unknown|null): {record:unknown;created:boolean};
  insertAccountEvidence(record:unknown):{record:unknown;created:boolean};
  appendBudgetAuthorization(record:unknown,expectedRevision:number|null):boolean;
  registerBudgetExecution(record:unknown):{record:unknown;created:boolean};
  insertBudgetReservation(record:unknown):{record:unknown;created:boolean};
  appendReconciliationEvidence(record:unknown):{record:{sequence:number;evidence:unknown;semanticHash:string};created:boolean};
};
const moneyScope={providerId:"provider-1",accountId:"account-1",currency:"USD",unit:"minor_currency" as const};
const policy=(revision:number, revisionId=`policy-revision-${revision}`, policyId="policy-1")=>({schemaVersion:1 as const,revisionId,policyId,revision,providerId:moneyScope.providerId,accountId:moneyScope.accountId,currency:moneyScope.currency,unit:moneyScope.unit,dailyCap:10_000,expiresAt:null,revoked:false,actorId:"local-user",createdAt:100+revision});
const budgetQuote=(id="budget-quote-1",mediaQuoteId:string|null="media-quote-1")=>({schemaVersion:1 as const,id,projectId:"project-1",providerId:moneyScope.providerId,modelId:"model-1",operation:"take" as const,inputHash:"a".repeat(64),estimateMin:100,estimateMax:200,currency:moneyScope.currency,unit:"minor_currency" as const,entitlement:"subscription" as const,createdAt:200,expiresAt:400,mediaQuoteId});
const evidence=()=>({schemaVersion:1 as const,id:"evidence-1",providerId:moneyScope.providerId,accountId:moneyScope.accountId,source:"trusted-account",reference:"account-reference",observedAt:100,expiresAt:1000,credentialBindingId:"credential-binding-1"});
const authorization=(revision:number,policyRevisionId:string,revisionId=`authorization-revision-${revision}`)=>({schemaVersion:1 as const,revisionId,authorizationId:"authorization-1",revision,projectId:"project-1",policyId:"policy-1",policyRevisionIdAtAuthorization:policyRevisionId,projectCap:5000,allowedModelIds:["model-1"],allowedOperations:["take" as const],entitlementModes:["subscription" as const],expiresAt:null,revoked:false,actorId:"local-user",createdAt:100+revision});
const execution=()=>({kind:"media_job" as const,executionId:"job-budget-1",operation:"take" as const,projectId:"project-1",idempotencyKey:"budget-idem-1",requestHash:"b".repeat(64),executionSemanticHash:"c".repeat(64),providerId:moneyScope.providerId,modelId:"model-1"});
const binding=()=>({schemaVersion:1 as const,id:"binding-1",budgetQuoteId:"budget-quote-1",accountEvidenceId:"evidence-1",providerId:moneyScope.providerId,accountId:moneyScope.accountId,credentialBindingId:"credential-binding-1",currency:moneyScope.currency,unit:"minor_currency" as const,executionSemanticHash:"c".repeat(64),quotedAt:250});
const reservation=()=>({schemaVersion:1 as const,id:"reservation-1",execution:execution(),authorizationRevisionId:"authorization-revision-1",policyRevisionId:"policy-revision-1",budgetQuoteId:"budget-quote-1",quoteBindingId:"binding-1",accountEvidenceId:"evidence-1",providerId:moneyScope.providerId,accountId:moneyScope.accountId,credentialBindingId:"credential-binding-1",currency:moneyScope.currency,unit:"minor_currency" as const,upperEstimate:200,reservedAt:260,utcDay:"1970-01-01"});
const actualEvent=(eventKey="event-1",cumulativeActual:number|null=100,final=false)=>({schemaVersion:1 as const,eventKey,reservationId:"reservation-1",providerId:moneyScope.providerId,accountId:moneyScope.accountId,currency:moneyScope.currency,unit:"minor_currency" as const,observedAt:300,source:"trusted-reconcile",reference:"provider-reference",provenance:{kind:"provider" as const,producerId:"provider-producer"},fact:{kind:"actual" as const,cumulativeActual,final}});
const budgetWrite=<T>(store:ReturnType<typeof openProductionStore>,work:(port:FutureBudgetWritePort)=>T):T=>store.transaction(tx=>work(tx as unknown as FutureBudgetWritePort) as never) as T;

const proofGeneration=(revision=1,generationId="credential-binding-1",accountId="account-1",credentialFingerprint="a".repeat(64),changedAt=40)=>({schemaVersion:1 as const,providerId:"provider-1",revision,generationId,accountId,credentialFingerprint,changedAt});
const proofSession=(role:"web"|"worker"|"probe"="probe",sessionId="session-probe")=>({sessionId,role,sdkVersion:"5.49.0",sdkSourceHash:"b".repeat(64),adapterVersion:"adapter-v1"});
const proofProducer={producerId:"local-test",producerVersion:"1.0",sourceHash:"c".repeat(64)};
const proofArtifact=(payload:Record<string,unknown>,createdAt:number)=>({schemaVersion:1 as const,hash:hashCanonicalJson(payload),canonicalPayload:canonicalJson(payload),createdAt});
function quoteProofFixture(){
  const generation=proofGeneration(),session=proofSession(),accountPayload={schemaVersion:1 as const,kind:"account_session" as const,producer:proofProducer,generation,session,subscription:{active:true,status:"active",tier:"creator",currentPeriodEnd:null,providerVersion:null},observedAt:100,expiresAt:1000};
  const accountArtifact=proofArtifact(accountPayload,100),sourceCapture="Reviewed public pricing and account policy capture.";
  const reviewedConfig={policyVersion:"review-v1"},policyPayload={schemaVersion:1 as const,kind:"reviewed_policy" as const,producer:proofProducer,providerId:"provider-1",reviewVersion:"review-v1",sourceUrl:"https://example.test/policy",sourceCapture,sourceCaptureSha256:createHash("sha256").update(sourceCapture,"utf8").digest("hex"),reviewedConfigCanonicalJson:canonicalJson(reviewedConfig),reviewedConfigHash:hashCanonicalJson(reviewedConfig),capturedAt:50,expiresAt:950};
  const policyArtifact=proofArtifact(policyPayload,50),projection={operation:"take",modelId:"model-1",projectId:"project-1"},inputHash=hashCanonicalJson(projection),recipe={operation:"take",modelId:"model-1",projectId:"project-1",inputHash},semanticHash="d".repeat(64);
  const mediaQuote={version:1 as const,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take" as const,inputHash,entitlement:"subscription" as const,estimateMinMinor:100,estimateMaxMinor:200,currency:"USD",expiresAt:900,withinAuthorizedCap:"unknown" as const,createdAt:200};
  const budget={schemaVersion:1 as const,id:"budget-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take" as const,inputHash,estimateMin:100,estimateMax:200,currency:"USD",unit:"minor_currency" as const,entitlement:"subscription" as const,createdAt:200,expiresAt:900,mediaQuoteId:mediaQuote.id};
  const accountEvidence={...evidence(),reference:`sha256:${accountArtifact.hash}`,credentialBindingId:generation.generationId,expiresAt:1000};
  const quoteBinding={...binding(),accountEvidenceId:accountEvidence.id,credentialBindingId:generation.generationId,executionSemanticHash:semanticHash,quotedAt:250};
  const capability={version:1 as const,providerId:"provider-1",modelId:"model-1",provenance:"live_catalog" as const,observedAt:50,expiresAt:900,supportedOperations:["video" as const],aspectRatios:["9:16" as const],maxReferenceImages:4,supportsStartFrame:true,supportsEndFrame:false,supportsContextImages:false,supportsTimedKeyframes:false,minFrames:1,maxFrames:1000,frameStep:1,supportsNativeAudio:false};
  const payload={schemaVersion:1 as const,kind:"media_quote" as const,producer:proofProducer,mediaQuote,budgetQuote:budget,binding:quoteBinding,accountEvidence,accountProofHash:accountArtifact.hash,policyProofHash:policyArtifact.hash,canonicalRecipeJson:canonicalJson(recipe),recipeHash:hashCanonicalJson(recipe),canonicalQuoteProjectionJson:canonicalJson(projection),quoteProjectionHash:inputHash,executionSemanticHash:semanticHash,capability,session,createdAt:300,expiresAt:700};
  const quoteArtifact=proofArtifact(payload,300),quoteLink={schemaVersion:1 as const,mediaQuoteId:mediaQuote.id,budgetQuoteId:budget.id,artifactHash:quoteArtifact.hash};
  return {generation,session,accountPayload,accountArtifact,policyPayload,policyArtifact,mediaQuote,budget,accountEvidence,quoteBinding,capability,payload,quoteArtifact,quoteLink,semanticHash};
}
const putQuotePrerequisites=(tx:ProductionWritePort,f:ReturnType<typeof quoteProofFixture>)=>{
  const parsed=ProviderProofPayloadSchema.safeParse(JSON.parse(f.quoteArtifact.canonicalPayload));expect(parsed.success?null:parsed.error.issues).toBeNull();
  tx.insertProject(project());tx.insertQuote(f.mediaQuote);tx.insertAccountEvidence(f.accountEvidence);tx.insertBudgetQuote(f.budget,f.quoteBinding);
  tx.insertProofArtifact(f.accountArtifact);tx.insertProofArtifact(f.policyArtifact);tx.insertProofArtifact(f.quoteArtifact);
};

function spawnStoreOpen(dbPath:string,barrierPath:string):Promise<{code:number|null;stdout:string;stderr:string;elapsedMs:number}>{
  const moduleUrl=pathToFileURL(join(process.cwd(),"lib/repositories/production/sqlite.ts")).href;
  const source=`import fs from 'node:fs';const {openProductionStore}=await import(${JSON.stringify(moduleUrl)});while(!fs.existsSync(process.argv[2]))await new Promise(r=>setTimeout(r,2));const started=Date.now();try{const store=openProductionStore({dbPath:process.argv[1]});console.log(JSON.stringify({schemaVersion:store.schemaVersion(),pragmas:store.pragmas(),integrity:store.integrityCheck()}));store.close()}catch(error){console.error(error);console.log('elapsed-ms='+String(Date.now()-started));process.exitCode=1}`;
  return new Promise(resolve=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",source,dbPath,barrierPath],{cwd:process.cwd()});
    let stdout="",stderr="";const timeout=setTimeout(()=>{child.kill("SIGKILL");resolve({code:null,stdout,stderr:`${stderr}child timed out`,elapsedMs:15_000});},15_000);timeout.unref();
    child.stdout.setEncoding("utf8").on("data",chunk=>stdout+=chunk);child.stderr.setEncoding("utf8").on("data",chunk=>stderr+=chunk);
    child.once("error",error=>{clearTimeout(timeout);resolve({code:null,stdout,stderr:`${stderr}${String(error)}`,elapsedMs:0});});
    child.once("exit",code=>{clearTimeout(timeout);const elapsed=Number(stdout.match(/elapsed-ms=(\d+)/)?.[1]??0);resolve({code,stdout,stderr,elapsedMs:elapsed});});
  });
}

const dirs: string[] = [];
function setup() { const dir=mkdtempSync(join(tmpdir(),"production-sqlite-")); dirs.push(dir); return {dir,dbPath:join(dir,"production.sqlite")}; }
afterEach(()=>{ for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const project=(id="project-1"):Project=>({version:1,id,name:"A project",profileId:"profile-1",profile:{id:"profile-1",format:"9:16",language:"en",ageIntent:"family",targetFrames:192,projectCapMinor:null,dailyCapMinor:null},activeCanonRevisionIds:[],activeStoryRevisionId:null,activeShotPlanRevisionId:null,activeAnimaticRevisionId:null,activeAudioMixRevisionId:null,takeSelectionVersion:0,audioMixVersion:0,createdAt:10,updatedAt:10,saveVersion:1});

describe("SQLite production store",()=>{
  it("opens one fresh database from two barrier-synchronized processes",async()=>{
    const {dbPath}=setup(),barrier=`${dbPath}.start`;
    const children=[spawnStoreOpen(dbPath,barrier),spawnStoreOpen(dbPath,barrier)];writeFileSync(barrier,"start");
    const results=await Promise.all(children);
    expect(results.map(result=>result.code)).toEqual([0,0]);
    for(const result of results){const observed=JSON.parse(result.stdout) as {schemaVersion:number;pragmas:{journalMode:string;foreignKeys:number;synchronous:number};integrity:{ok:boolean}};expect(observed).toMatchObject({schemaVersion:4,pragmas:{journalMode:"wal",foreignKeys:1,synchronous:2},integrity:{ok:true}});}
    const db=new Database(dbPath);expect(db.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all()).toEqual([{version:1,name:"001.sql"},{version:2,name:"002-budget.sql"},{version:3,name:"003-approval-commands.sql"},{version:4,name:"004-provider-proof.sql"}]);expect(db.pragma("foreign_key_check")).toEqual([]);db.close();
  });

  it("upgrades one real v1 database from two barrier-synchronized processes",async()=>{
    const {dbPath}=setup(),barrier=`${dbPath}.start`,legacy=new Database(dbPath);
    legacy.exec(readFileSync(new URL("./migrations/001.sql",import.meta.url),"utf8"));legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001.sql',10)").run();legacy.close();
    const children=[spawnStoreOpen(dbPath,barrier),spawnStoreOpen(dbPath,barrier)];writeFileSync(barrier,"start");
    const results=await Promise.all(children);
    expect(results.map(result=>result.code)).toEqual([0,0]);
    for(const result of results){const observed=JSON.parse(result.stdout) as {schemaVersion:number;pragmas:{journalMode:string;foreignKeys:number;synchronous:number};integrity:{ok:boolean}};expect(observed).toMatchObject({schemaVersion:4,pragmas:{journalMode:"wal",foreignKeys:1,synchronous:2},integrity:{ok:true}});}
    const db=new Database(dbPath);expect(db.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all()).toEqual([{version:1,name:"001.sql"},{version:2,name:"002-budget.sql"},{version:3,name:"003-approval-commands.sql"},{version:4,name:"004-provider-proof.sql"}]);expect(db.pragma("foreign_key_check")).toEqual([]);db.close();
  });

  it("fails closed within the WAL retry bound while a database stays exclusively locked",async()=>{
    const {dbPath}=setup(),barrier=`${dbPath}.start`,lock=new Database(dbPath,{timeout:0});lock.exec("BEGIN EXCLUSIVE");
    const child=spawnStoreOpen(dbPath,barrier);let released=false,watchdogExpired=false;
    const releaseLock=()=>{if(!released){lock.exec("ROLLBACK");lock.close();released=true;}};
    const watchdog=setTimeout(()=>{watchdogExpired=true;releaseLock();},10_000);
    try {
      writeFileSync(barrier,"start");const result=await child;
      expect(watchdogExpired).toBe(false);
      expect(result.code).toBe(1);expect(result.stderr).toMatch(/SQLITE_BUSY|database is locked/i);expect(result.elapsedMs).toBeGreaterThan(0);expect(result.elapsedMs).toBeLessThan(2000);
      releaseLock();
      const recovered=openProductionStore({dbPath});expect(recovered.schemaVersion()).toBe(4);recovered.close();
    } finally {
      clearTimeout(watchdog);releaseLock();
    }
  });

  it("stores stable account policy heads with compare-and-append revision semantics",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});
    const read=store.read as unknown as FutureBudgetReadPort;
    expect(budgetWrite(store,write=>write.appendAccountPolicy(policy(1),null))).toBe(true);
    expect(read.getLatestAccountPolicy(moneyScope)).toEqual(policy(1));
    expect(budgetWrite(store,write=>write.appendAccountPolicy(policy(2),1))).toBe(true);
    expect(read.getAccountPolicyRevision("policy-revision-1")).toEqual(policy(1));
    expect(read.getLatestAccountPolicy(moneyScope)).toEqual(policy(2));
    expect(budgetWrite(store,write=>write.appendAccountPolicy(policy(3),1))).toBe(false);
    expect(read.getLatestAccountPolicy(moneyScope)).toEqual(policy(2));
    store.close();
  });

  it("persists and replays an unknown-bound quote without manufacturing account facts",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});
    store.transaction(tx=>{tx.insertProject(project());tx.insertQuote({version:1,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take",inputHash:"a".repeat(64),entitlement:"unknown",estimateMinMinor:null,estimateMaxMinor:null,currency:null,expiresAt:400,withinAuthorizedCap:"unknown",createdAt:200});});
    const read=store.read as unknown as FutureBudgetReadPort;
    const unknown={...budgetQuote("unknown-budget-quote"),unit:"unknown" as const,currency:null,estimateMin:null,estimateMax:null};
    const first=budgetWrite(store,write=>write.insertBudgetQuote(unknown,null));
    expect(first).toEqual({record:unknown,created:true});
    expect(read.getBudgetQuote(unknown.id)).toEqual(unknown);
    expect(budgetWrite(store,write=>write.insertBudgetQuote(unknown,null))).toEqual({record:unknown,created:false});
    expect(()=>budgetWrite(store,write=>write.insertBudgetQuote({...unknown,modelId:"different"},null))).toThrow();
    expect(read.getBudgetQuote(unknown.id)).toEqual(unknown);
    store.close();
  });

  it("upgrades a real v1 database and rejects unknown or gapped migration history",()=>{
    const old=setup(),sql=readFileSync(new URL("./migrations/001.sql",import.meta.url),"utf8"),legacy=new Database(old.dbPath);
    legacy.exec(sql);legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001.sql',?)").run(10);legacy.close();
    const upgraded=openProductionStore({dbPath:old.dbPath});expect(upgraded.schemaVersion()).toBe(4);upgraded.close();
    const reopened=openProductionStore({dbPath:old.dbPath});expect(reopened.schemaVersion()).toBe(4);reopened.close();
    const malformed=setup(),bad=new Database(malformed.dbPath);bad.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(2,'002-budget.sql',20)");bad.close();
    expect(()=>openProductionStore({dbPath:malformed.dbPath})).toThrow(/migration/i);
    const future=setup(),unknown=new Database(future.dbPath);unknown.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(4,'004-future.sql',30)");unknown.close();
    expect(()=>openProductionStore({dbPath:future.dbPath})).toThrow(/migration/i);
    const rollback=setup(),legacyDb=new Database(rollback.dbPath);legacyDb.exec(sql);legacyDb.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001.sql',10)").run();legacyDb.exec("CREATE TABLE budget_policies(preexisting TEXT)");legacyDb.close();
    expect(()=>openProductionStore({dbPath:rollback.dbPath})).toThrow();
    const afterFailure=new Database(rollback.dbPath);expect(afterFailure.prepare("SELECT version,name FROM schema_migrations").all()).toEqual([{version:1,name:"001.sql"}]);expect(afterFailure.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='budget_policy_revisions'").get()).toBeUndefined();afterFailure.close();
  });

  it("persists a bound quote and validates reservation pins against stored execution evidence",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});store.transaction(tx=>{tx.insertProject(project());tx.insertQuote({version:1,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take",inputHash:"a".repeat(64),entitlement:"subscription",estimateMinMinor:100,estimateMaxMinor:200,currency:"USD",expiresAt:400,withinAuthorizedCap:"unknown",createdAt:200});
      const job={version:1 as const,id:"job-budget-1",projectId:"project-1",operation:"take" as const,status:"queued" as const,idempotencyKey:"budget-idem-1",requestSnapshot:{},requestHash:"b".repeat(64),providerId:"provider-1",modelId:"model-1",providerRef:null,quoteId:"media-quote-1",receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:210,updatedAt:210};tx.insertJob(job,{id:"outbox-budget-1",jobId:job.id,createdAt:210,claimedAt:null,claimToken:null});});
    const read=store.read as unknown as FutureBudgetReadPort;
    budgetWrite(store,write=>{write.appendAccountPolicy(policy(1),null);write.appendBudgetAuthorization(authorization(1,"policy-revision-1"),null);write.insertAccountEvidence(evidence());
      expect(write.insertBudgetQuote(budgetQuote(),binding())).toEqual({record:budgetQuote(),created:true});
      expect(write.registerBudgetExecution(execution())).toEqual({record:execution(),created:true});
      expect(write.insertBudgetReservation(reservation())).toEqual({record:reservation(),created:true});
      expect(write.insertBudgetReservation(reservation())).toEqual({record:reservation(),created:false});});
    expect(read.listBudgetLedger({kind:"project",projectId:"project-1",...moneyScope})).toEqual([{reservation:reservation(),events:[]}]);
    expect(()=>budgetWrite(store,write=>write.insertBudgetReservation({...reservation(),id:"reservation-wrong-account",accountId:"different-account"}))).toThrow();
    store.close();
  });

  it("serializes competing policy CAS operations from two SQLite connections",()=>{
    const {dbPath}=setup(),first=openProductionStore({dbPath}),second=openProductionStore({dbPath});
    expect(budgetWrite(first,write=>write.appendAccountPolicy(policy(1),null))).toBe(true);
    expect(budgetWrite(second,write=>write.appendAccountPolicy(policy(1,"policy-race-loser"),null))).toBe(false);
    expect((first.read as unknown as FutureBudgetReadPort).getLatestAccountPolicy(moneyScope)).toEqual(policy(1));
    first.close();second.close();
  });

  it("applies the latest standing policy while preserving older authorization provenance",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});
    const addJob=(tx:ProductionWritePort,id:string,key:string,requestHash:string)=>tx.insertJob({version:1,id,projectId:"project-1",operation:"take",status:"queued",idempotencyKey:key,requestSnapshot:{},requestHash,providerId:"provider-1",modelId:"model-1",providerRef:null,quoteId:"media-quote-1",receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:210,updatedAt:210},{id:`outbox-${id}`,jobId:id,createdAt:210,claimedAt:null,claimToken:null});
    store.transaction(tx=>{tx.insertProject(project());tx.insertQuote({version:1,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take",inputHash:"a".repeat(64),entitlement:"subscription",estimateMinMinor:100,estimateMaxMinor:200,currency:"USD",expiresAt:172800400,withinAuthorizedCap:"unknown",createdAt:200});addJob(tx,"job-budget-1","budget-idem-1","b".repeat(64));addJob(tx,"job-budget-2","budget-idem-2","d".repeat(64));});
    const first=reservation();
    budgetWrite(store,write=>{write.appendAccountPolicy(policy(1),null);write.appendBudgetAuthorization(authorization(1,"policy-revision-1"),null);write.insertAccountEvidence({...evidence(),expiresAt:172800000});write.insertBudgetQuote({...budgetQuote(),expiresAt:172800400},binding());write.registerBudgetExecution(execution());write.insertBudgetReservation(first);});
    expect(budgetWrite(store,write=>write.appendAccountPolicy(policy(2),1))).toBe(true);
    expect(budgetWrite(store,write=>write.insertBudgetReservation(first))).toEqual({record:first,created:false});
    const secondExecution={...execution(),executionId:"job-budget-2",idempotencyKey:"budget-idem-2",requestHash:"d".repeat(64)};
    const secondReservation={...first,id:"reservation-2",execution:secondExecution,policyRevisionId:"policy-revision-2",reservedAt:86400260,utcDay:"1970-01-02"};
    budgetWrite(store,write=>{write.registerBudgetExecution(secondExecution);expect(write.insertBudgetReservation(secondReservation)).toEqual({record:secondReservation,created:true});});
    expect((store.read as unknown as FutureBudgetReadPort).getLatestAccountPolicy(moneyScope)).toEqual(policy(2));
    const read=store.read as unknown as FutureBudgetReadPort;
    expect(read.listBudgetLedger({kind:"project",projectId:"project-1",...moneyScope}).map(entry=>(entry.reservation as typeof first).utcDay)).toEqual(["1970-01-01","1970-01-02"]);
    expect(read.listBudgetLedger({kind:"account_day",...moneyScope,utcDay:"1970-01-01"}).map(entry=>entry.reservation)).toEqual([first]);
    const projectTwo=project("project-2"),textQuote={schemaVersion:1 as const,id:"text-budget-quote",projectId:projectTwo.id,providerId:"provider-1",modelId:"model-1",operation:"text_proposal" as const,inputHash:"e".repeat(64),estimateMin:100,estimateMax:200,currency:"USD",unit:"minor_currency" as const,entitlement:"subscription" as const,createdAt:86400200,expiresAt:172800400,mediaQuoteId:null};
    const evidenceTwo={...evidence(),id:"evidence-project-2",observedAt:86400100,expiresAt:172800000},bindingTwo={schemaVersion:1 as const,id:"binding-project-2",budgetQuoteId:textQuote.id,accountEvidenceId:evidenceTwo.id,providerId:"provider-1",accountId:moneyScope.accountId,credentialBindingId:evidenceTwo.credentialBindingId,currency:"USD",unit:"minor_currency" as const,executionSemanticHash:"f".repeat(64),quotedAt:86400250};
    const authTwo={...authorization(1,"policy-revision-2","authorization-project-2"),authorizationId:"authorization-project-2",projectId:projectTwo.id,policyRevisionIdAtAuthorization:"policy-revision-2",allowedOperations:["text_proposal" as const]};
    const executionTwo={kind:"text_proposal" as const,executionId:"text-execution-project-2",operation:"text_proposal" as const,projectId:projectTwo.id,idempotencyKey:"text-idem-project-2",requestHash:"f".repeat(64),executionSemanticHash:"f".repeat(64),providerId:"provider-1",modelId:"model-1"};
    const reservationTwo={schemaVersion:1 as const,id:"reservation-project-2",execution:executionTwo,authorizationRevisionId:authTwo.revisionId,policyRevisionId:"policy-revision-2",budgetQuoteId:textQuote.id,quoteBindingId:bindingTwo.id,accountEvidenceId:evidenceTwo.id,providerId:"provider-1",accountId:moneyScope.accountId,credentialBindingId:evidenceTwo.credentialBindingId,currency:"USD",unit:"minor_currency" as const,upperEstimate:200,reservedAt:86400260,utcDay:"1970-01-02"};
    store.transaction(tx=>tx.insertProject(projectTwo));
    budgetWrite(store,write=>{write.appendBudgetAuthorization(authTwo,null);write.insertAccountEvidence(evidenceTwo);write.insertBudgetQuote(textQuote,bindingTwo);write.registerBudgetExecution(executionTwo);write.insertBudgetReservation(reservationTwo);});
    expect(read.listBudgetLedger({kind:"project",projectId:projectTwo.id,...moneyScope}).map(entry=>entry.reservation)).toEqual([reservationTwo]);
    expect(read.listBudgetLedger({kind:"account_day",...moneyScope,utcDay:"1970-01-02"}).map(entry=>entry.reservation)).toEqual([secondReservation,reservationTwo]);
    store.close();
  });

  it("rolls back both quote and binding when binding insertion fails inside a caught outer transaction",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});
    store.transaction(tx=>{tx.insertProject(project());tx.insertQuote({version:1,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take",inputHash:"a".repeat(64),entitlement:"subscription",estimateMinMinor:100,estimateMaxMinor:200,currency:"USD",expiresAt:400,withinAuthorizedCap:"unknown",createdAt:200});});
    budgetWrite(store,write=>write.insertAccountEvidence(evidence()));
    const db=new Database(dbPath);db.exec("CREATE TRIGGER fail_budget_binding BEFORE INSERT ON budget_quote_bindings BEGIN SELECT RAISE(ABORT,'injected binding failure'); END");db.close();
    store.transaction(tx=>{try {(tx as unknown as FutureBudgetWritePort).insertBudgetQuote(budgetQuote(),binding());}catch(error){expect(String(error)).toContain("injected binding failure");}
      tx.insertProject(project("project-marker"));});
    expect((store.read as unknown as FutureBudgetReadPort).getBudgetQuote("budget-quote-1")).toBeNull();
    expect(store.read.getProject("project-marker")).not.toBeNull();store.close();
  });

  it("deduplicates ordered reconciliation evidence and rejects conflicting semantic event replay",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});store.transaction(tx=>{tx.insertProject(project());tx.insertQuote({version:1,id:"media-quote-1",projectId:"project-1",providerId:"provider-1",modelId:"model-1",operation:"take",inputHash:"a".repeat(64),entitlement:"subscription",estimateMinMinor:100,estimateMaxMinor:200,currency:"USD",expiresAt:400,withinAuthorizedCap:"unknown",createdAt:200});
      const job={version:1 as const,id:"job-budget-1",projectId:"project-1",operation:"take" as const,status:"queued" as const,idempotencyKey:"budget-idem-1",requestSnapshot:{},requestHash:"b".repeat(64),providerId:"provider-1",modelId:"model-1",providerRef:null,quoteId:"media-quote-1",receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:210,updatedAt:210};tx.insertJob(job,{id:"outbox-budget-1",jobId:job.id,createdAt:210,claimedAt:null,claimToken:null});});
    const read=store.read as unknown as FutureBudgetReadPort;
    const first=budgetWrite(store,write=>{write.appendAccountPolicy(policy(1),null);write.appendBudgetAuthorization(authorization(1,"policy-revision-1"),null);write.insertAccountEvidence(evidence());write.insertBudgetQuote(budgetQuote(),binding());write.registerBudgetExecution(execution());write.insertBudgetReservation(reservation());return write.appendReconciliationEvidence(actualEvent());});expect(first.created).toBe(true);expect(first.record.sequence).toBe(1);
    expect(budgetWrite(store,write=>write.appendReconciliationEvidence(actualEvent()))).toEqual({record:first.record,created:false});
    expect(()=>budgetWrite(store,write=>write.appendReconciliationEvidence(actualEvent("event-1",120)))).toThrow();
    expect(read.listBudgetLedger({kind:"account_day",...moneyScope,utcDay:"1970-01-01"})[0]?.events).toHaveLength(1);
    store.close();const reopened=openProductionStore({dbPath});expect((reopened.read as unknown as FutureBudgetReadPort).listBudgetLedger({kind:"project",projectId:"project-1",...moneyScope})[0]?.events).toEqual([first.record]);reopened.close();
  });

  it("applies the migration once and enables WAL and foreign keys",()=>{
    const {dbPath}=setup(), store=openProductionStore({dbPath,now:()=>12});
    expect(store.schemaVersion()).toBe(4);
    const second=openProductionStore({dbPath}); expect(second.schemaVersion()).toBe(4);
    expect(second.integrityCheck()).toEqual({ok:true,messages:["ok"]});
    expect(store.pragmas()).toEqual({journalMode:"wal",foreignKeys:1,synchronous:2,busyTimeout:250});
    second.close(); store.close();
  });

  it("migrates a real v2 approval history and appends repeated same-hash decisions",()=>{
    const {dbPath}=setup(),legacy=new Database(dbPath);
    legacy.exec(readFileSync(new URL("./migrations/001.sql",import.meta.url),"utf8"));
    legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001.sql',10)").run();
    legacy.exec(readFileSync(new URL("./migrations/002-budget.sql",import.meta.url),"utf8"));
    legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(2,'002-budget.sql',20)").run();
    const p=project(), targetHash="a".repeat(64), historicalHash="f".repeat(64);
    legacy.prepare("INSERT INTO projects(id,name,profile_id,updated_at,save_version,take_selection_version,audio_mix_version,payload) VALUES(?,?,?,?,?,?,?,?)")
      .run(p.id,p.name,p.profileId,p.updatedAt,p.saveVersion,p.takeSelectionVersion,p.audioMixVersion,JSON.stringify(p));
    const addRecord=legacy.prepare("INSERT INTO records(kind,id,project_id,natural_key,payload) VALUES(?,?,?,?,?)");
    const addProjectRecord=(kind:string,id:string,key:string|null=null)=>addRecord.run(kind,id,p.id,key,JSON.stringify({id,version:1}));
    addProjectRecord("story","story-legacy","story-hash-legacy");addProjectRecord("story","story-1","story-hash-current");
    const priorApproval:Approval={version:1,id:"approval-old",targetKind:"story",targetId:"story-legacy",targetHash:historicalHash,decision:"approved",actorId:"local-user",createdAt:10,checklist:[{id:"reviewed",passed:true,note:"Reviewed"}],notes:"",advisoryAcknowledgements:[]};
    addRecord.run("approval",priorApproval.id,null,"story:story-legacy:"+historicalHash+":approved",JSON.stringify(priorApproval));
    legacy.prepare("INSERT INTO approvals(approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision) VALUES(?,?,?,?,?,?,?)")
      .run(priorApproval.id,"story","story-legacy","story","story-legacy",historicalHash,"approved");
    legacy.prepare("INSERT INTO record_refs(owner_kind,owner_id,role,ordinal,target_kind,target_id) VALUES('approval',?,'target',0,'story','story-legacy')").run(priorApproval.id);
    addProjectRecord("shot","shot-rev-1");addProjectRecord("anchor","anchor-1");addProjectRecord("asset","asset-1");
    addRecord.run("job","job-1",p.id,"job-key",JSON.stringify({id:"job-1",version:1}));
    addRecord.run("take","take-1",p.id,null,JSON.stringify({id:"take-1",version:1}));
    legacy.prepare("INSERT INTO assets(asset_id,sha256,mime,byte_size) VALUES(?,?,?,?)").run("asset-1","b".repeat(64),"image/png",1);
    legacy.prepare("INSERT INTO jobs(job_id,project_id,idempotency_key,status,provider_ref,request_hash) VALUES(?,?,?,?,?,?)").run("job-1",p.id,"job-key","completed",null,"c".repeat(64));
    legacy.prepare("INSERT INTO takes(take_id,shot_revision_id,anchor_id,approval_id,job_id,asset_id,inputs_hash) VALUES(?,?,?,?,?,?,?)")
      .run("take-1","shot-rev-1","anchor-1",priorApproval.id,"job-1","asset-1","d".repeat(64));
    const takeRefs=["shot","anchor","approval","asset","job"].map((kind,index)=>({role:kind,kind,id:["shot-rev-1","anchor-1",priorApproval.id,"asset-1","job-1"][index]}));
    const addTakeRef=legacy.prepare("INSERT INTO record_refs(owner_kind,owner_id,role,ordinal,target_kind,target_id) VALUES('take','take-1',?,0,?,?)");
    for(const ref of takeRefs)addTakeRef.run(ref.role,ref.kind,ref.id);
    const oldApprovals=legacy.prepare("SELECT approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision FROM approvals ORDER BY approval_id").all();
    const oldTake=legacy.prepare("SELECT take_id,shot_revision_id,anchor_id,approval_id,job_id,asset_id,inputs_hash FROM takes WHERE take_id='take-1'").get();
    const oldApprovalRefs=legacy.prepare("SELECT owner_kind,owner_id,role,ordinal,target_kind,target_id FROM record_refs WHERE owner_kind='approval' ORDER BY ordinal").all();
    const oldTakeRefs=legacy.prepare("SELECT owner_kind,owner_id,role,ordinal,target_kind,target_id FROM record_refs WHERE owner_kind='take' ORDER BY role,ordinal").all();
    legacy.close();

    const store=openProductionStore({dbPath,now:()=>40});
    expect(store.schemaVersion()).toBe(4);
    expect(store.integrityCheck()).toEqual({ok:true,messages:["ok"]});
    const db=new Database(dbPath);
    expect(db.prepare("SELECT approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision FROM approvals ORDER BY approval_id").all()).toEqual(oldApprovals);
    expect(db.prepare("SELECT take_id,shot_revision_id,anchor_id,approval_id,job_id,asset_id,inputs_hash FROM takes WHERE take_id='take-1'").get()).toEqual(oldTake);
    expect(db.prepare("SELECT owner_kind,owner_id,role,ordinal,target_kind,target_id FROM record_refs WHERE owner_kind='approval' ORDER BY ordinal").all()).toEqual(oldApprovalRefs);
    expect(db.prepare("SELECT owner_kind,owner_id,role,ordinal,target_kind,target_id FROM record_refs WHERE owner_kind='take' ORDER BY role,ordinal").all()).toEqual(oldTakeRefs);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'").get()).toMatchObject({sql:expect.not.stringContaining("UNIQUE(target_kind,target_id,target_hash,decision)")});
    db.close();
    const approved={...priorApproval,id:"approval-command-approve",targetId:"story-1",targetHash,createdAt:20};
    const rejected={...approved,id:"approval-command-reject",decision:"rejected" as const,createdAt:30,checklist:[],notes:"Needs revision"};
    const reapproved={...approved,id:"approval-command-reapprove",createdAt:40};
    store.transaction(tx=>{tx.appendApproval(approved);tx.appendApproval(rejected);tx.appendApproval(reapproved);});
    store.close();

    const reopened=openProductionStore({dbPath});
    expect(reopened.schemaVersion()).toBe(4);
    const finalDb=new Database(dbPath);
    expect(finalDb.prepare("SELECT json_extract(payload,'$.createdAt') AS created_at FROM records WHERE kind='approval' AND id LIKE 'approval-command-%' ORDER BY created_at").all())
      .toEqual([{created_at:20},{created_at:30},{created_at:40}]);
    expect(finalDb.prepare("SELECT a.approval_id,a.decision FROM approvals a JOIN records r ON r.kind='approval' AND r.id=a.approval_id WHERE a.target_kind='story' AND a.target_id='story-1' AND a.target_hash=? ORDER BY json_extract(r.payload,'$.createdAt')").all(targetHash))
      .toEqual([{approval_id:"approval-command-approve",decision:"approved"},{approval_id:"approval-command-reject",decision:"rejected"},{approval_id:"approval-command-reapprove",decision:"approved"}]);
    expect(new Set([approved.id,rejected.id,reapproved.id]).size).toBe(3);
    expect(finalDb.prepare("SELECT id,natural_key FROM records WHERE kind='approval' ORDER BY id").all()).toEqual([
      {id:"approval-command-approve",natural_key:"approval-command-approve"},
      {id:"approval-command-reapprove",natural_key:"approval-command-reapprove"},
      {id:"approval-command-reject",natural_key:"approval-command-reject"},
      {id:"approval-old",natural_key:`story:story-legacy:${historicalHash}:approved`},
    ]);
    expect(reopened.integrityCheck()).toEqual({ok:true,messages:["ok"]});
    expect(finalDb.pragma("foreign_key_check")).toEqual([]);
    finalDb.close();reopened.close();
  });

  it("enforces project references and rolls back every write when a transaction fails",()=>{
    const {dbPath}=setup(), store=openProductionStore({dbPath});
    expect(()=>store.transaction(tx=>{tx.insertProject(project()); throw new Error("abort");})).toThrow("abort");
    expect(store.read.getProject("project-1")).toBeNull();
    const bad={version:1 as const,id:"story-1",projectId:"missing",parentRevisionId:null,scriptText:"",beats:[{id:"b1",action:"Action",narration:"",dialogue:[],order:0}],canonRevisionIds:[],contentHash:"a".repeat(64),createdAt:1};
    expect(()=>store.transaction(tx=>tx.insertStoryRevision(bad))).toThrow();
    expect(store.read.getStoryRevision("story-1")).toBeNull(); store.close();
    const other=openProductionStore({dbPath});
    const orphanShot={version:1 as const,id:"shot-rev-1",shotId:"shot-1",storyRevisionId:"missing-story",beatIds:["beat-1"],order:0,visualIntent:"A visible action",motionIntent:"Slow movement",castBindings:[],locationRevisionId:"location-1",propRevisionIds:[],styleRevisionId:"style-1",framing:"wide" as const,targetFrames:24,continuation:null,contentHash:"c".repeat(64),createdAt:1};
    expect(()=>other.transaction(tx=>tx.insertShotRevisions([orphanShot]))).toThrow();
    expect(other.read.getShotRevision("shot-rev-1")).toBeNull();other.close();
  });

  it("shares committed records across instances and retains them after reopening",()=>{
    const {dbPath}=setup(), a=openProductionStore({dbPath}), b=openProductionStore({dbPath});
    a.transaction(tx=>tx.insertProject(project())); expect(b.read.getProject("project-1")?.name).toBe("A project");
    a.close(); b.close(); const reopened=openProductionStore({dbPath});
    expect(reopened.read.getProject("project-1")?.saveVersion).toBe(1); reopened.close();
  });

  it("persists distinct shot bytes that share an NFC-normalized fingerprint",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});const p=project();
    const location={version:1 as const,id:"location-1",entityId:"room",entityKind:"location" as const,revision:1,description:"Room",attributes:{},referenceAssetIds:[],contentHash:"a".repeat(64),createdAt:1};
    const style={version:1 as const,id:"style-1",entityId:"style",entityKind:"style" as const,revision:1,description:"Style",attributes:{},referenceAssetIds:[],contentHash:"b".repeat(64),createdAt:1};
    const story={version:1 as const,id:"story-shot-bytes",projectId:p.id,parentRevisionId:null,scriptText:"A line",beats:[{id:"beat-1",action:"Acts",narration:"A line",dialogue:[],order:0}],canonRevisionIds:[location.id,style.id],contentHash:"c".repeat(64),createdAt:2};
    const shot=(id:string,visualIntent:string)=>{const content={version:1 as const,shotId:"shot-stable",storyRevisionId:story.id,beatIds:["beat-1"],order:0,visualIntent,motionIntent:"Still",castBindings:[],locationRevisionId:location.id,propRevisionIds:[],styleRevisionId:style.id,framing:"wide" as const,targetFrames:24,continuation:null};return{...content,id,contentHash:hashCanonicalJson(content),createdAt:3};};
    const composed=shot("shot-composed","Café"),decomposed=shot("shot-decomposed","Cafe\u0301");
    expect(composed.contentHash).toBe(decomposed.contentHash);
    expect(()=>store.transaction(tx=>{tx.insertProject(p);tx.insertCanonRevision(location);tx.insertCanonRevision(style);tx.insertStoryRevision(story);tx.insertShotRevisions([composed,decomposed]);})).not.toThrow();
    expect(store.read.getShotRevision(composed.id)?.visualIntent).toBe("Café");
    expect(store.read.getShotRevision(decomposed.id)?.visualIntent).toBe("Cafe\u0301");
    store.close();const reopened=openProductionStore({dbPath});
    expect(reopened.read.getShotRevision(decomposed.id)?.contentHash).toBe(composed.contentHash);reopened.close();
  });

  it("increments take-selection versions atomically and refuses stale project snapshots",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});const original=project();store.transaction(tx=>tx.insertProject(original));
    expect(store.transaction(tx=>tx.compareAndSetSelectedTake(original.id,"shot-1",null,0))).toBe(true);
    expect(store.read.getTakeSelection(original.id,"shot-1")).toEqual({takeId:null,version:1});
    expect(store.transaction(tx=>tx.compareAndSetSelectedTake(original.id,"shot-2",null,0))).toBe(false);
    expect(store.transaction(tx=>tx.compareAndSetProject({...original,name:"Stale"},1))).toBe(false);
    const current=store.read.getProject(original.id)!;expect(current.takeSelectionVersion).toBe(1);
    expect(store.transaction(tx=>tx.compareAndSetProject({...current,name:"Updated",saveVersion:2},1))).toBe(true);
    expect(store.read.getProject(original.id)).toMatchObject({name:"Updated",takeSelectionVersion:1});store.close();
  });

  it("keeps selected audio mix refs, payload, and CAS version consistent across replacement and reopen",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath});
    const p=project();
    const story={version:1 as const,id:"story-rev",projectId:p.id,parentRevisionId:null,scriptText:"Story",beats:[{id:"beat-1",action:"Action",narration:"",dialogue:[],order:0}],canonRevisionIds:[],contentHash:"d".repeat(64),createdAt:1};
    const mix=(id:string,hash:string)=>({version:1 as const,id,projectId:p.id,storyRevisionId:story.id,cues:[],mixSettings:{sampleRate:48000 as const,channels:2 as const,loudnessTargetLufs:-14,truePeakLimitDbtp:-1,muteNativeAudio:true},contentHash:hash,createdAt:2});
    const first=mix("mix-a","e".repeat(64)),second=mix("mix-b","f".repeat(64));
    store.transaction(tx=>{tx.insertProject(p);tx.insertStoryRevision(story);tx.insertAudioMixRevision(first);tx.insertAudioMixRevision(second);});
    expect(store.transaction(tx=>tx.compareAndSetAudioMix(p.id,first.id,0))).toBe(true);
    expect(store.transaction(tx=>tx.compareAndSetAudioMix(p.id,second.id,0))).toBe(false);
    expect(store.transaction(tx=>tx.compareAndSetAudioMix(p.id,second.id,1))).toBe(true);
    expect(store.read.getProject(p.id)).toMatchObject({activeAudioMixRevisionId:second.id,audioMixVersion:2});
    const refs=new Database(dbPath);expect(refs.prepare("SELECT target_id FROM project_refs WHERE project_id=? AND role='audioMix'").all(p.id)).toEqual([{target_id:second.id}]);refs.close();
    store.close();const reopened=openProductionStore({dbPath});expect(reopened.read.getProject(p.id)).toMatchObject({activeAudioMixRevisionId:second.id,audioMixVersion:2});reopened.close();
  });

  it("claims outbox and job leases exclusively and rejects mutation after expiry",()=>{
    const {dbPath}=setup();let now=1000;const store=openProductionStore({dbPath,now:()=>now});store.transaction(tx=>tx.insertProject(project()));
    const job={version:1 as const,id:"job-1",projectId:"project-1",operation:"anchor" as const,status:"queued" as const,idempotencyKey:"idem-1",requestSnapshot:{},requestHash:"b".repeat(64),providerId:null,modelId:null,providerRef:null,quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:now,updatedAt:now};
    const outbox={id:"outbox-1",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null};store.transaction(tx=>tx.insertJob(job,outbox));
    expect(()=>store.transaction(tx=>tx.insertJob({...job,id:"job-2"},{...outbox,id:"outbox-2"}))).toThrow();
    expect(store.transaction(tx=>tx.claimOutbox(now,"outbox-token",1500,10))).toHaveLength(1);
    expect(store.transaction(tx=>tx.claimOutbox(1499,"other-token",2000,10))).toHaveLength(0);
    expect(store.transaction(tx=>tx.claimJob(job.id,now,{jobId:job.id,leaseToken:"lease-1",leaseUntil:1200,heartbeatAt:now}))).toMatchObject({id:job.id,leaseToken:"lease-1",leaseUntil:1200,attempt:1});
    expect(store.transaction(tx=>tx.heartbeatJob(job.id,"lease-1",now,1300))).toBe(true);
    const leased=store.read.getJob(job.id)!;
    expect(store.transaction(tx=>tx.updateLeasedJob({...leased,status:"running",updatedAt:1001},"lease-1"))).toBe(true);
    now=1301;expect(store.transaction(tx=>tx.updateLeasedJob({...leased,status:"completed",updatedAt:1301},"lease-1"))).toBe(false);
    expect(store.transaction(tx=>tx.claimJob(job.id,now,{jobId:job.id,leaseToken:"lease-2",leaseUntil:1600,heartbeatAt:now}))).toMatchObject({id:job.id});store.close();
  });

  it("acknowledges only the matching unexpired outbox claim and keeps the job history",()=>{
    const {dbPath}=setup();let now=1000;const store=openProductionStore({dbPath,now:()=>now});store.transaction(tx=>tx.insertProject(project()));
    const job={version:1 as const,id:"job-ack",projectId:"project-1",operation:"anchor" as const,status:"queued" as const,idempotencyKey:"idem-ack",requestSnapshot:{},requestHash:"a".repeat(64),providerId:null,modelId:null,providerRef:null,quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:now,updatedAt:now};
    store.transaction(tx=>tx.insertJob(job,{id:"outbox-ack",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null}));
    expect(store.transaction(tx=>tx.claimOutbox(now,"claim-right",1200,1))).toHaveLength(1);
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-ack","claim-wrong"))).toBe(false);
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-ack","claim-right"))).toBe(true);
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-ack","claim-right"))).toBe(false);
    expect(store.read.getJob(job.id)).toEqual(job);
    const expiredJob={...job,id:"job-expired-ack",idempotencyKey:"idem-expired-ack"};
    store.transaction(tx=>tx.insertJob(expiredJob,{id:"outbox-expired-ack",jobId:expiredJob.id,createdAt:now,claimedAt:null,claimToken:null}));
    expect(store.transaction(tx=>tx.claimOutbox(now,"claim-expired",1200,1))).toHaveLength(1);
    now=1200;
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-expired-ack","claim-expired"))).toBe(false);
    now=1201;
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-expired-ack","claim-expired"))).toBe(false);
    expect(store.transaction(tx=>tx.claimOutbox(now,"claim-renewed",1400,1))).toHaveLength(1);
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-expired-ack","claim-expired"))).toBe(false);
    expect(store.transaction(tx=>tx.acknowledgeOutbox("outbox-expired-ack","claim-renewed"))).toBe(true);
    expect(store.read.getJob(expiredJob.id)).toEqual(expiredJob);
    const db=new Database(dbPath);expect(db.prepare("SELECT id FROM outbox").all()).toEqual([]);expect(db.prepare("SELECT job_id FROM jobs ORDER BY job_id").all()).toEqual([{job_id:job.id},{job_id:expiredJob.id}]);db.close();store.close();
  });

  it("recreates an acknowledged unknown-submission outbox only during explicit leased reconciliation",()=>{
    const {dbPath}=setup();let now=1000;const store=openProductionStore({dbPath,now:()=>now});
    const p=project();store.transaction(tx=>tx.insertProject(p));
    const job={version:1 as const,id:"job-unknown-reconcile",projectId:p.id,operation:"anchor" as const,status:"submission_unknown" as const,idempotencyKey:"idem-unknown-reconcile",requestSnapshot:{prompt:"keep"},requestHash:"e".repeat(64),providerId:"provider",modelId:"model",providerRef:null,quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:"SUBMISSION_UNKNOWN",errorMessage:"Response was uncertain",createdAt:now,updatedAt:now};
    const originalIntent={id:"outbox-unknown-original",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null};
    store.transaction(tx=>tx.insertJob(job,originalIntent));
    expect(store.transaction(tx=>tx.claimOutbox(now,"outbox-first-claim",1100,1))).toHaveLength(1);
    expect(store.transaction(tx=>tx.acknowledgeOutbox(originalIntent.id,"outbox-first-claim"))).toBe(true);
    expect(store.transaction(tx=>tx.claimOutbox(now,"outbox-empty",1100,1))).toHaveLength(0);

    const receipt={version:1 as const,id:"receipt-unknown-reconcile",jobId:job.id,capabilityProvenance:"sdk_contract" as const,capabilityObservedAt:900,inputs:[],createdAt:now};
    const recoveredIntent={id:"outbox-unknown-recovered",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null};
    const lease={jobId:job.id,leaseToken:"lease-explicit-reconcile",leaseUntil:2000,heartbeatAt:now};
    const leased=store.transaction(tx=>tx.claimJob(job.id,now,lease)!);
    expect(leased.status).toBe("submission_unknown");
    const resolved={...leased,status:"running" as const,providerRef:"provider-job-ref",receiptId:receipt.id,errorCode:null,errorMessage:null,updatedAt:now};

    expect(()=>store.transaction(tx=>{
      tx.insertHonoredInputsReceipt(receipt);
      expect(tx.updateLeasedJob(resolved,lease.leaseToken)).toBe(true);
      expect(tx.ensureOutbox(recoveredIntent)).toBe(true);
      throw new Error("rollback resolution");
    })).toThrow("rollback resolution");
    expect(store.read.getJob(job.id)).toMatchObject({status:"submission_unknown",providerRef:null,receiptId:null});
    expect(store.read.getHonoredInputsReceipt(receipt.id)).toBeNull();
    const db=new Database(dbPath);expect(db.prepare("SELECT id FROM outbox WHERE job_id=?").all(job.id)).toEqual([]);expect(db.prepare("SELECT role,target_id FROM record_refs WHERE owner_kind='job' AND owner_id=? AND role='receipt'").all(job.id)).toEqual([]);db.close();

    expect(store.transaction(tx=>{
      tx.insertHonoredInputsReceipt(receipt);
      expect(tx.updateLeasedJob(resolved,lease.leaseToken)).toBe(true);
      expect(tx.ensureOutbox(recoveredIntent)).toBe(true);
      return tx.ensureOutbox({...recoveredIntent,id:"outbox-duplicate-intent"});
    })).toBe(false);
    store.close();

    const reopened=openProductionStore({dbPath,now:()=>now});
    expect(reopened.read.getJob(job.id)).toMatchObject({status:"running",providerRef:"provider-job-ref",receiptId:receipt.id});
    expect(reopened.read.getHonoredInputsReceipt(receipt.id)).toEqual(receipt);
    expect(reopened.transaction(tx=>tx.claimOutbox(now,"outbox-poll-claim",1200,1))).toEqual([{
      id:recoveredIntent.id,jobId:job.id,createdAt:now,claimedAt:now,claimToken:"outbox-poll-claim",
    }]);
    expect(reopened.read.getJob(job.id)?.providerRef).toBe("provider-job-ref");
    reopened.close();
  });

  it("creates outbox intents only for existing jobs with valid unclaimed intent records",()=>{
    const {dbPath}=setup();let now=1000;const store=openProductionStore({dbPath,now:()=>now});
    const p=project();store.transaction(tx=>tx.insertProject(p));
    const job={version:1 as const,id:"job-ensure-outbox",projectId:p.id,operation:"anchor" as const,status:"running" as const,idempotencyKey:"idem-ensure-outbox",requestSnapshot:{},requestHash:"f".repeat(64),providerId:"provider",modelId:"model",providerRef:"provider-job-ref",quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:now,updatedAt:now};
    store.transaction(tx=>tx.insertJob(job,{id:"outbox-ensure-original",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null}));
    expect(store.transaction(tx=>tx.claimOutbox(now,"existing-outbox-claim",1200,1))).toHaveLength(1);
    const replacement={id:"outbox-ensure-replacement",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null};
    expect(store.transaction(tx=>tx.ensureOutbox(replacement))).toBe(false);
    expect(store.transaction(tx=>tx.ensureOutbox({...replacement,jobId:"missing-job"}))).toBe(false);
    for(const invalid of [
      {...replacement,claimedAt:now},
      {...replacement,claimToken:"already-claimed"},
      {...replacement,createdAt:-1},
      {...replacement,createdAt:Number.MAX_SAFE_INTEGER+1},
      {...replacement,id:"bad id"},
      {...replacement,jobId:"bad/job"},
    ]) expect(()=>store.transaction(tx=>tx.ensureOutbox(invalid as unknown as OutboxIntent))).toThrow(TypeError);
    expect(store.read.getJob(job.id)).toEqual(job);
    const db=new Database(dbPath);expect(db.prepare("SELECT id,created_at,claimed_at,claim_until,claim_token FROM outbox WHERE job_id=?").all(job.id)).toEqual([{id:"outbox-ensure-original",created_at:now,claimed_at:now,claim_until:1200,claim_token:"existing-outbox-claim"}]);db.close();store.close();
  });

  it("renews only the matching live outbox claim without reviving an expired lease",()=>{
    const {dbPath}=setup();let now=1000;const store=openProductionStore({dbPath,now:()=>now});
    const p=project();store.transaction(tx=>tx.insertProject(p));
    const job={version:1 as const,id:"job-heartbeat",projectId:p.id,operation:"anchor" as const,status:"running" as const,idempotencyKey:"idem-heartbeat",requestSnapshot:{step:1},requestHash:"c".repeat(64),providerId:null,modelId:null,providerRef:"provider-job",quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:1,errorCode:null,errorMessage:null,createdAt:now,updatedAt:now};
    store.transaction(tx=>tx.insertJob(job,{id:"outbox-heartbeat",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null}));
    expect(store.transaction(tx=>tx.claimOutbox(now,"claim-live",1200,1))).toHaveLength(1);
    now=1100;expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now,1500))).toBe(true);
    now=1101;expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","wrong-claim",now,1600))).toBe(false);
    expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now,1800))).toBe(true);
    expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now,1700))).toBe(false);
    expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",1050,2000))).toBe(false);
    expect(()=>store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now+1,now+2))).toThrow();
    const db=new Database(dbPath);
    expect(db.prepare("SELECT claimed_at,claim_until,claim_token FROM outbox WHERE id=?").get("outbox-heartbeat")).toEqual({claimed_at:now,claim_until:1800,claim_token:"claim-live"});
    now=1800;expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now,2000))).toBe(false);
    now=1801;expect(store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",1799,2000))).toBe(false);
    expect(()=>store.transaction(tx=>tx.heartbeatOutbox("outbox-heartbeat","claim-live",now,now))).toThrow();
    db.close();store.close();
  });

  it("requests job cancellation with status CAS and preserves its lease, provider data and event history",()=>{
    const {dbPath}=setup();const now=1000;const store=openProductionStore({dbPath,now:()=>now});
    const p=project();store.transaction(tx=>tx.insertProject(p));
    const job={version:1 as const,id:"job-cancel",projectId:p.id,operation:"anchor" as const,status:"queued" as const,idempotencyKey:"idem-cancel",requestSnapshot:{prompt:"keep"},requestHash:"d".repeat(64),providerId:"provider",modelId:"model",providerRef:"provider-ref",quoteId:null,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:now,updatedAt:now};
    store.transaction(tx=>tx.insertJob(job,{id:"outbox-cancel",jobId:job.id,createdAt:now,claimedAt:null,claimToken:null}));
    expect(store.transaction(tx=>tx.claimJob(job.id,now,{jobId:job.id,leaseToken:"lease-cancel",leaseUntil:2000,heartbeatAt:now}))).toMatchObject({id:job.id});
    const leased={...store.read.getJob(job.id)!,status:"running" as const,providerRef:"provider-ref",updatedAt:1100};
    expect(store.transaction(tx=>tx.updateLeasedJob(leased,"lease-cancel"))).toBe(true);
    store.transaction(tx=>tx.appendJobEvent({jobId:job.id,sequence:1,at:1100,status:"running",message:"running",progress:25}));
    expect(store.transaction(tx=>tx.requestJobCancellation(job.id,"queued",1200))).toBe(false);
    expect(()=>store.transaction(tx=>{expect(tx.requestJobCancellation(job.id,"running",1200)).toBe(true);throw new Error("rollback");})).toThrow("rollback");
    expect(store.read.getJob(job.id)?.status).toBe("running");
    const db=new Database(dbPath);expect(db.prepare("SELECT status FROM jobs WHERE job_id=?").get(job.id)).toEqual({status:"running"});db.close();
    expect(store.transaction(tx=>tx.requestJobCancellation(job.id,"running",1200))).toBe(true);
    store.transaction(tx=>tx.appendJobEvent({jobId:job.id,sequence:2,at:1200,status:"cancel_requested",message:"cancel requested",progress:null}));
    expect(store.transaction(tx=>tx.requestJobCancellation(job.id,"cancel_requested",1201))).toBe(false);
    expect(store.transaction(tx=>tx.requestJobCancellation(job.id,"completed",1201))).toBe(false);
    expect(store.transaction(tx=>tx.requestJobCancellation(job.id,"failed",1201))).toBe(false);
    expect(()=>store.transaction(tx=>tx.requestJobCancellation(job.id,"running",Number.NaN))).toThrow();
    expect(store.read.getJob(job.id)).toMatchObject({...leased,status:"cancel_requested",updatedAt:1200,leaseToken:"lease-cancel",leaseUntil:2000,heartbeatAt:now,providerRef:"provider-ref",requestSnapshot:{prompt:"keep"},resultAssetIds:[]});
    expect(store.read.listJobEvents(job.id,0).map(event=>event.status)).toEqual(["running","cancel_requested"]);
    const finalDb=new Database(dbPath);expect(finalDb.prepare("SELECT status FROM jobs WHERE job_id=?").get(job.id)).toEqual({status:"cancel_requested"});finalDb.close();
    store.close();
  });

  it("rejects a thenable callback and rolls back its partial writes",()=>{
    const {dbPath}=setup(), store=openProductionStore({dbPath});
    expect(()=>store.transaction(((tx:ProductionWritePort)=>{tx.insertProject(project()); return Promise.resolve("late");}) as never)).toThrow(/synchronous/);
    expect(store.read.getProject("project-1")).toBeNull(); store.close();
  });

  it("expires the write port before an async callback can resume", async()=>{
    const {dbPath}=setup(), store=openProductionStore({dbPath});
    expect(()=>store.transaction((async (tx: ProductionWritePort)=>{
      await Promise.resolve();
      tx.insertProject(project());
    }) as never)).toThrow(/synchronous/);
    await Promise.resolve();
    expect(store.read.getProject("project-1")).toBeNull();
    store.close();
  });

  it("expires retained write-port methods when their transaction callback ends",()=>{
    const {dbPath}=setup(), store=openProductionStore({dbPath});
    let retained!: ProductionWritePort["insertProject"];
    store.transaction(tx=>{ retained=tx.insertProject; });
    expect(()=>retained(project())).toThrow(/transaction callback has ended/);
    expect(store.read.getProject("project-1")).toBeNull();
    store.close();
  });

  it("I01-B6-S preserves real v3 finance rows and immutable proof/CAS history across reopen",()=>{
    const {dbPath}=setup(),f=quoteProofFixture(),legacy=new Database(dbPath);
    legacy.exec(readFileSync(new URL("./migrations/001.sql",import.meta.url),"utf8"));legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'001.sql',10)").run();
    legacy.exec(readFileSync(new URL("./migrations/002-budget.sql",import.meta.url),"utf8"));legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(2,'002-budget.sql',20)").run();
    legacy.exec(readFileSync(new URL("./migrations/003-approval-commands.sql",import.meta.url),"utf8"));legacy.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(3,'003-approval-commands.sql',30)").run();
    const p=project();legacy.prepare("INSERT INTO projects(id,name,profile_id,updated_at,save_version,take_selection_version,audio_mix_version,payload) VALUES(?,?,?,?,?,?,?,?)").run(p.id,p.name,p.profileId,p.updatedAt,p.saveVersion,p.takeSelectionVersion,p.audioMixVersion,JSON.stringify(p));
    legacy.prepare("INSERT INTO records(kind,id,project_id,natural_key,payload) VALUES('quote',?,?,NULL,?)").run(f.mediaQuote.id,p.id,JSON.stringify(f.mediaQuote));
    legacy.prepare("INSERT INTO budget_account_evidence(id,provider_id,account_id,credential_binding_id,observed_at,expires_at,payload) VALUES(?,?,?,?,?,?,?)").run(f.accountEvidence.id,f.accountEvidence.providerId,f.accountEvidence.accountId,f.accountEvidence.credentialBindingId,f.accountEvidence.observedAt,f.accountEvidence.expiresAt,JSON.stringify(f.accountEvidence));
    legacy.prepare("INSERT INTO budget_quotes(id,project_id,media_quote_id,payload) VALUES(?,?,?,?)").run(f.budget.id,p.id,f.mediaQuote.id,JSON.stringify(f.budget));
    legacy.prepare("INSERT INTO budget_quote_bindings(id,budget_quote_id,account_evidence_id,provider_id,account_id,credential_binding_id,currency,currency_key,unit,execution_semantic_hash,quoted_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(f.quoteBinding.id,f.budget.id,f.accountEvidence.id,f.quoteBinding.providerId,f.quoteBinding.accountId,f.quoteBinding.credentialBindingId,f.quoteBinding.currency,f.quoteBinding.currency,f.quoteBinding.unit,f.quoteBinding.executionSemanticHash,f.quoteBinding.quotedAt,JSON.stringify(f.quoteBinding));
    legacy.close();

    const store=openProductionStore({dbPath});
    expect(store.schemaVersion()).toBe(4);expect(store.read.getQuote(f.mediaQuote.id)).toEqual(f.mediaQuote);expect(store.read.getBudgetQuote(f.budget.id)).toEqual(f.budget);expect(store.read.getQuoteAccountBinding(f.budget.id)).toEqual(f.quoteBinding);expect(store.read.getAccountEvidence(f.accountEvidence.id)).toEqual(f.accountEvidence);
    expect(store.transaction(tx=>tx.insertProofArtifact(f.accountArtifact))).toEqual({record:f.accountArtifact,created:true});
    expect(store.transaction(tx=>tx.insertProofArtifact(f.accountArtifact))).toEqual({record:f.accountArtifact,created:false});
    const generationA=f.generation,generationB=proofGeneration(2,"credential-binding-B","account-2","e".repeat(64),50),generationAReturn=proofGeneration(3,"credential-binding-A-return","account-1","a".repeat(64),60);
    expect(store.transaction(tx=>tx.compareAndSetProviderCredentialGeneration(generationA,null))).toBe(true);
    expect(store.transaction(tx=>tx.compareAndSetProviderCredentialGeneration(generationA,null))).toBe(true);
    expect(store.transaction(tx=>tx.compareAndSetProviderCredentialGeneration(generationB,null))).toBe(false);
    expect(store.read.getProviderCredentialGeneration("provider-1")).toEqual(generationA);
    expect(store.transaction(tx=>tx.compareAndSetProviderCredentialGeneration(generationB,1))).toBe(true);
    expect(store.transaction(tx=>tx.compareAndSetProviderCredentialGeneration(generationAReturn,2))).toBe(true);
    expect(store.read.getProviderCredentialGeneration("provider-1")).toEqual(generationAReturn);
    store.close();

    const corrupt=new Database(dbPath);corrupt.prepare("INSERT INTO provider_proof_artifacts(hash,kind,canonical_payload,created_at) VALUES(?,?,?,?)").run("f".repeat(64),"account_session",f.accountArtifact.canonicalPayload,f.accountArtifact.createdAt);
    expect(()=>corrupt.prepare("UPDATE provider_proof_artifacts SET created_at=created_at WHERE hash=?").run(f.accountArtifact.hash)).toThrow(/immutable/);
    expect(()=>corrupt.prepare("DELETE FROM provider_credential_generations WHERE provider_id=? AND revision=1").run("provider-1")).toThrow(/immutable/);
    expect(corrupt.pragma("foreign_key_check")).toEqual([]);corrupt.close();
    const reopened=openProductionStore({dbPath});
    expect(reopened.schemaVersion()).toBe(4);expect(reopened.read.getProviderCredentialGeneration("provider-1")).toEqual(generationAReturn);expect(reopened.read.getProofArtifact(f.accountArtifact.hash)).toEqual(f.accountArtifact);
    expect(()=>reopened.read.getProofArtifact("f".repeat(64))).toThrow(/integrity validation/);reopened.close();
  });

  it("I01-B6-S atomically validates and replays bound quote and execution proof links",()=>{
    const {dbPath}=setup(),store=openProductionStore({dbPath}),f=quoteProofFixture();
    expect(()=>store.transaction(tx=>{putQuotePrerequisites(tx,f);tx.insertQuoteProof({...f.quoteLink,mediaQuoteId:"quote-mismatch"});})).toThrow();
    let db=new Database(dbPath);expect(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='quote'").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM budget_quotes").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM budget_quote_bindings").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM budget_account_evidence").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM provider_proof_artifacts").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM provider_quote_proofs").get()).toEqual({n:0});db.close();
    store.transaction(tx=>{putQuotePrerequisites(tx,f);expect(tx.insertQuoteProof(f.quoteLink)).toEqual({record:f.quoteLink,created:true});expect(tx.insertQuoteProof(f.quoteLink)).toEqual({record:f.quoteLink,created:false});});

    const snapshot={resultTarget:{kind:"take",shotRevisionId:"shot-rev-1",anchorId:"anchor-1",anchorApprovalId:"anchor-approval-1",inputsHash:f.semanticHash}},requestHash=hashCanonicalJson(snapshot);
    const mediaExecution={kind:"media_job" as const,executionId:"job-proof-1",operation:"take" as const,projectId:"project-1",idempotencyKey:"job-proof-idem",requestHash,executionSemanticHash:f.semanticHash,providerId:"provider-1",modelId:"model-1"};
    const mediaJob={version:1 as const,id:mediaExecution.executionId,projectId:"project-1",operation:"take" as const,status:"queued" as const,idempotencyKey:mediaExecution.idempotencyKey,requestSnapshot:snapshot,requestHash,providerId:"provider-1",modelId:"model-1",providerRef:null,quoteId:f.mediaQuote.id,receiptId:null,resultId:null,resultAssetIds:[],leaseToken:null,leaseUntil:null,heartbeatAt:null,attempt:0,errorCode:null,errorMessage:null,createdAt:210,updatedAt:210};
    const mediaReservation={...reservation(),id:"reservation-proof-1",execution:mediaExecution,budgetQuoteId:f.budget.id,quoteBindingId:f.quoteBinding.id,accountEvidenceId:f.accountEvidence.id,credentialBindingId:f.generation.generationId,reservedAt:260};
    const workerSession=proofSession("worker","session-worker"),workerPayload={...f.accountPayload,session:workerSession,observedAt:300,expiresAt:800},workerArtifact=proofArtifact(workerPayload,300);
    const executionPayload={schemaVersion:1 as const,kind:"execution_session" as const,producer:proofProducer,execution:mediaExecution,mediaQuoteId:f.mediaQuote.id,budgetQuoteId:f.budget.id,quoteBindingId:f.quoteBinding.id,accountEvidenceId:f.accountEvidence.id,quoteProofHash:f.quoteArtifact.hash,accountProofHash:workerArtifact.hash,generation:f.generation,session:workerSession,capability:f.capability,observedAt:300,expiresAt:700};
    const executionArtifact=proofArtifact(executionPayload,300),executionLink={schemaVersion:1 as const,executionId:mediaExecution.executionId,reservationId:mediaReservation.id,artifactHash:executionArtifact.hash};
    const addFinanceAndJob=(tx:ProductionWritePort)=>{
      tx.appendAccountPolicy(policy(1),null);tx.appendBudgetAuthorization(authorization(1,"policy-revision-1"),null);
      tx.insertJob(mediaJob,{id:"outbox-proof-1",jobId:mediaJob.id,createdAt:210,claimedAt:null,claimToken:null});
      tx.registerBudgetExecution(mediaExecution);tx.insertBudgetReservation(mediaReservation);
      tx.insertProofArtifact(workerArtifact);tx.insertProofArtifact(executionArtifact);
    };
    expect(()=>store.transaction(tx=>{addFinanceAndJob(tx);tx.insertExecutionProof({...executionLink,reservationId:"reservation-mismatch"});})).toThrow();
    db=new Database(dbPath);expect(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM budget_executions").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM budget_reservations").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM provider_execution_proofs").get()).toEqual({n:0});expect(db.prepare("SELECT COUNT(*) AS n FROM provider_proof_artifacts").get()).toEqual({n:3});db.close();
    store.transaction(tx=>{addFinanceAndJob(tx);expect(tx.insertExecutionProof(executionLink)).toEqual({record:executionLink,created:true});expect(tx.insertExecutionProof(executionLink)).toEqual({record:executionLink,created:false});});
    expect(store.read.getQuoteProof(f.budget.id)).toEqual(f.quoteLink);expect(store.read.getExecutionProof(mediaExecution.executionId)).toEqual(executionLink);store.close();
    const reopened=openProductionStore({dbPath});expect(reopened.read.getQuoteProof(f.budget.id)).toEqual(f.quoteLink);expect(reopened.read.getExecutionProof(mediaExecution.executionId)).toEqual(executionLink);expect(reopened.integrityCheck().ok).toBe(true);reopened.close();
  });
});
