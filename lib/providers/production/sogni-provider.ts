import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { ProductionApplicationError } from "../../production/errors";
import { ASPECTS, RESOLUTIONS } from "../../constants";
import { minimaxH3Dimensions } from "../sogni/video-limits";
import { CapabilityReceiptSchema, HonoredInputsReceiptSchema, type CapabilityReceipt, type CreateQuoteCommand, type ProductionQuote } from "../../production/contracts";
import { canSatisfy, unknownCapability, normalizeCatalogCapabilities, type CatalogModel, type ProductionCapabilityDiscovery, unknownProductionQuote } from "./capabilities";
import { acknowledgeH3Transport, checkH3Request, h3ModeForModel, mapH3InputFields } from "./sogni-h3";
import type { ProviderMediaResult, ProviderQuoteRequest, ProviderRequestSnapshot, ProviderSubmissionAck } from "../../repositories/production/ports";
import { resolveProductionDataDir } from "../../production/runtime";
import { BudgetUtcMillisSchema, IdSchema } from "../../production/contracts";
import type { ProviderSession } from "../../production/provider-proof";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { AuthenticatedProviderSessionSchema, CapturedProviderSessionSchema, ProviderAccountObservationSchema, SogniProofMetadataSchema, type AuthenticatedProviderSession, type CapturedProviderSession, type ProductionProofProvider, type ProviderAccountObservation, type SubmissionProofResolver, type SogniProofMetadata, type SubscriptionObservation } from "./proof-port";

export type SogniRole="worker"|"web"|"probe";
export interface SogniSdkSubmission { snapshot:ProviderRequestSnapshot; parameters:Record<string,unknown>; inputBytes:Record<string,Buffer>; proofSession?:AuthenticatedProviderSession }
export interface SogniProviderTransport {
  readonly sdkVersion:string; readonly configured:boolean;
  discover(modelIds:string[]):Promise<CatalogModel[]>;
  submit(request:SogniSdkSubmission):Promise<{providerRef:string}>;
  poll(providerRef:string):Promise<ProviderMediaResult>;
  cancel(providerRef:string):Promise<void>;
  close():Promise<void>;
  observeAccount?():Promise<ProviderAccountObservation>;
  currentSession?():CapturedProviderSession|null;
}
export interface SogniFactoryOptions {
  transport?:SogniProviderTransport; readAsset?:(assetId:string)=>Promise<Buffer>;
  env?:Readonly<Record<string,string|undefined>>; dataDir?:string; cwd?:string; role?:SogniRole;
  now?:()=>number; importSdk?:()=>Promise<unknown>; proofMetadata?:SogniProofMetadata; submissionProofResolver?:SubmissionProofResolver;
}
type SogniSdkJob={id:string;imgID?:string;status?:string;outputFormat?:string;result?:{outputFormat?:unknown}|null};
type SogniSdkClient={projects:{getAvailableModels:(network:"fast")=>Promise<Array<Record<string,unknown>>>;getVideoAssetConfig?:(modelId:string)=>Promise<{workflowType:string|null;assets?:Record<string,string>|null}>;getModelOptions?:(modelId:string)=>Promise<Record<string,unknown>>;create:(params:Record<string,unknown>)=>Promise<{id?:string}>;getStatus:(id:string)=>Promise<{status:string;workerJobs?:SogniSdkJob[];completedWorkerJobs?:SogniSdkJob[]}>;get:(id:string)=>Promise<{model?:{id?:string};workerJobs?:SogniSdkJob[];completedWorkerJobs?:SogniSdkJob[]}>;downloadUrl?:(params:{jobId:string;imageId:string;type:"complete";contentType?:string})=>Promise<string>;mediaDownloadUrl?:(params:{jobId:string;id:string;type:"complete"})=>Promise<string>;cancel:(id:string)=>Promise<void>};account?:{me:()=>Promise<unknown>;getSubscriptionStatus:()=>Promise<unknown>};dispose:()=>void};

const SOGNI_ADAPTER_VERSION="sogni-production-proof-v1";
export const SOGNI_PACKAGE_FILES=["dist-esm/Account/index.js","dist-esm/Projects/index.js","dist-esm/index.js","dist/Account/index.js","dist/Projects/index.js","dist/index.js","package.json","src/Account/index.ts","src/Account/subscription.types.ts","src/Projects/index.ts","src/Projects/types/index.ts","src/index.ts"] as const;
const BUDGET_BLOCKED_MESSAGE="Sogni provider proof could not be validated; submission is blocked.";
const budgetBlocked=()=>new ProductionApplicationError("BUDGET_BLOCKED",BUDGET_BLOCKED_MESSAGE);
export function readInstalledSogniProofMetadata():SogniProofMetadata {
  try {
    // Anchored on the process working directory with literal path joins on purpose: bundlers
    // rewrite `createRequire(import.meta.url)`/`require.resolve` into module-id constants, which
    // throw at runtime inside the built server. Every server/worker entrypoint runs with cwd at
    // the repo root, so node_modules/@sogni-ai/sogni-client resolves identically when unbundled.
    const packageRoot=join(process.cwd(),"node_modules","@sogni-ai","sogni-client"),packagePath=join(packageRoot,"package.json");
    const pkg=JSON.parse(readFileSync(packagePath,"utf8")) as {version?:unknown};
    if(typeof pkg.version!=="string"||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version))throw new Error("invalid installed package version");
    const files=SOGNI_PACKAGE_FILES.map(path=>({path,sha256:createHash("sha256").update(readFileSync(join(packageRoot,path))).digest("hex")})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const metadata=SogniProofMetadataSchema.parse({sdkVersion:pkg.version,sdkSourceHash:hashCanonicalJson({schemaVersion:1,packageName:"@sogni-ai/sogni-client",sdkVersion:pkg.version,files}),adapterVersion:SOGNI_ADAPTER_VERSION});
    return Object.freeze(metadata);
  } catch { throw budgetBlocked(); }
}
function validateInstalledProofMetadata(value:SogniProofMetadata):SogniProofMetadata {
  try { const supplied=SogniProofMetadataSchema.parse(value),installed=readInstalledSogniProofMetadata();if(canonicalJson(supplied)!==canonicalJson(installed))throw budgetBlocked();return installed; }
  catch { throw budgetBlocked(); }
}
function parseSubscription(value:unknown):SubscriptionObservation {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const raw=value as Record<string,unknown>,boundedText=(v:unknown)=>typeof v==="string"&&v.length>0&&Buffer.byteLength(v,"utf8")<=80;
  if(typeof raw.active!=="boolean"||typeof raw.status!=="string"||!boundedText(raw.status)||!raw.status.trim())return null;
  let tier:string|null=null;
  if(raw.tier!==undefined&&raw.tier!==null){if(typeof raw.tier!=="string"||!boundedText(raw.tier))return null;tier=raw.tier;}
  let currentPeriodEnd:number|null=null;
  if(raw.currentPeriodEnd!==undefined&&raw.currentPeriodEnd!==null){
    if(typeof raw.currentPeriodEnd!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw.currentPeriodEnd))return null;
    const date=new Date(raw.currentPeriodEnd);if(!Number.isFinite(date.getTime()))return null;
    const fraction=raw.currentPeriodEnd.match(/\.(\d{1,3})Z$/)?.[1]??"000",canonical=raw.currentPeriodEnd.replace(/\.\d{1,3}Z$/,"Z").replace(/Z$/,`.${fraction.padEnd(3,"0")}Z`);
    if(date.toISOString()!==canonical)return null;
    const parsed=BudgetUtcMillisSchema.safeParse(date.getTime());if(!parsed.success)return null;currentPeriodEnd=parsed.data;
  }
  let providerVersion:number|null=null;
  if(raw.providerVersion!==undefined&&raw.providerVersion!==null){if(typeof raw.providerVersion!=="number"||!Number.isSafeInteger(raw.providerVersion)||raw.providerVersion<0)return null;providerVersion=raw.providerVersion;}
  return Object.freeze({active:raw.active,status:raw.status,tier,currentPeriodEnd,providerVersion});
}
function frozenCaptured(value:CapturedProviderSession):CapturedProviderSession|null {
  const parsed=CapturedProviderSessionSchema.safeParse(value);if(!parsed.success)return null;
  return Object.freeze({session:Object.freeze({...parsed.data.session}),credentialFingerprint:parsed.data.credentialFingerprint,accountId:parsed.data.accountId});
}

export function createSogniProductionProvider(options:SogniFactoryOptions={}):ProductionProofProvider & {close:()=>Promise<void>} {
  const now=options.now??Date.now;const role=options.role??"web";
  const transport=options.transport??createSogniSdkTransport({env:options.env??process.env,dataDir:options.dataDir??resolveProductionDataDir(options.env??process.env,options.cwd??process.cwd()),role,importSdk:options.importSdk,proofMetadata:options.proofMetadata,submissionProofResolver:options.submissionProofResolver,now});
  const readAsset=options.readAsset??(async()=>{throw new ProductionApplicationError("MEDIA_UNAVAILABLE","Provider input asset loader is unavailable.");});
  const discovery:ProductionCapabilityDiscovery={sdkVersion:transport.sdkVersion,discover:async(_providerId,ids)=>transport.discover(ids)};
  return {
    providerId:"sogni",
    discoverCapabilities:async(modelId:string)=>{
      if(!transport.configured)return unknownCapability("sogni",modelId,now());
      const models=await discovery.discover("sogni",[modelId]);
      const exact=models.find(x=>x.id===modelId);if(!exact)return unknownCapability("sogni",modelId,now());
      const normalized=normalizeCatalogCapabilities("sogni",[exact],now(),5*60_000,now(),transport.sdkVersion)[0]??unknownCapability("sogni",modelId,now());
      return withVerifiedH3Constraints(normalized,exact,transport.sdkVersion);
    },
    quote:async(request:ProviderQuoteRequest):Promise<ProductionQuote>=>{
      const command:CreateQuoteCommand={projectId:request.projectId,providerId:request.providerId,modelId:request.modelId,operation:request.operation,inputSnapshot:request.inputSnapshot};
      return unknownProductionQuote(command,now());
    },
    submit:async(request:ProviderRequestSnapshot,capability:CapabilityReceipt):Promise<ProviderSubmissionAck>=>{
      const current=CapabilityReceiptSchema.parse(capability);
      if(current.providerId!=="sogni"||current.modelId!==request.modelId||current.provenance!=="live_catalog"||current.expiresAt===null||current.expiresAt<=now())throw new ProductionApplicationError("CAPABILITY_MISMATCH","Fresh live Sogni capability evidence is required.");
      if(request.providerId!=="sogni"||request.jobId.length===0||request.quoteId.length===0)throw new ProductionApplicationError("INVALID_INPUT","The provider request snapshot is incomplete.");
      if(request.billingMode!=="subscription"&&request.billingMode!=="tokens")throw new ProductionApplicationError("BUDGET_BLOCKED","An explicit server-authorized billing mode is required.");
      const currentSessionSnapshot=transport.currentSession?.();
      let proofSession:AuthenticatedProviderSession|undefined;
      if(transport.currentSession){
        if(!currentSessionSnapshot||!currentSessionSnapshot.accountId)throw budgetBlocked();
        const parsed=AuthenticatedProviderSessionSchema.safeParse({...currentSessionSnapshot,accountId:currentSessionSnapshot.accountId});if(!parsed.success)throw budgetBlocked();proofSession=Object.freeze({session:Object.freeze({...parsed.data.session}),credentialFingerprint:parsed.data.credentialFingerprint,accountId:parsed.data.accountId});
      }
      const mode=h3ModeForModel(request.modelId);const parameters=request.parameters as Record<string,unknown>;
      const inputs=request.inputs.map(x=>({...x,required:x.required===true}));
      const frameCount=Number(parameters.frameCount??parameters.durationFrames??0);
      if(mode!=="unknown"){
        const check=checkH3Request({modelId:request.modelId,startFrame:inputs.some(x=>x.role==="start_frame"),endFrame:inputs.some(x=>x.role==="end_frame"),contextImages:inputs.filter(x=>x.role==="context_image").length,contextVideos:inputs.filter(x=>x.role==="context_video").length,contextAudios:inputs.filter(x=>x.role==="context_audio").length,frameCount,sdkVersion:transport.sdkVersion,timedKeyframes:parameters.timedKeyframes===true,requestedResolution:typeof parameters.resolution==="string"?parameters.resolution:undefined,knownResolution:typeof parameters.verifiedResolution==="string"?parameters.verifiedResolution:undefined});
        if(!check.ok)throw new ProductionApplicationError("CAPABILITY_MISMATCH",check.reason??"H3 request is not compatible.",{field:"parameters"});
      } else if(inputs.some(x=>x.required)&&!current.supportsContextImages&&!current.supportsStartFrame&&!current.supportsEndFrame) {
        throw new ProductionApplicationError("CAPABILITY_MISMATCH","Required media references are not supported by verified provider capabilities.");
      }
      const requirements={startFrame:inputs.some(x=>x.required&&x.role==="start_frame"),endFrame:inputs.some(x=>x.required&&x.role==="end_frame"),contextImages:inputs.filter(x=>x.required&&x.role==="context_image").length};
      if(!canSatisfy(current,requirements,now()))throw new ProductionApplicationError("CAPABILITY_MISMATCH","Current capability receipt cannot satisfy the request's required reference roles.");
      const mapped=mode!=="unknown"?mapH3InputFields(request.modelId,inputs):inputs.map(input=>{
        const providerField=input.role==="start_frame"&&current.supportsStartFrame===true?"referenceImage":input.role==="end_frame"&&current.supportsEndFrame===true?"referenceImageEnd":input.role==="context_image"&&current.supportsContextImages===true?"contextImages":null;
        return{role:input.role,assetId:input.assetId,required:input.required,state:providerField?"mapped" as const:"rejected" as const,providerField,disclosedOmission:providerField?null:"No verified SDK field maps this required role."};
      });
      const rejected=mapped.find(x=>x.required&&x.state!=="mapped");if(rejected)throw new ProductionApplicationError("CAPABILITY_MISMATCH",`Required ${rejected.role} input has no verified provider mapping.`,{field:"inputs"});
      const inputBytes:Record<string,Buffer>={};for(const input of inputs){if(!mapped.find(x=>x.assetId===input.assetId&&x.state==="mapped"))continue;const bytes=await readAsset(input.assetId);if(bytes.length>100*1024*1024)throw new ProductionApplicationError("MEDIA_UNAVAILABLE","Provider reference exceeds the bounded SDK upload size.");inputBytes[input.assetId]=bytes;}
      const sdkParams=buildSdkParameters(request,inputs,mapped,inputBytes,mode);
      const ack=await transport.submit({snapshot:request,parameters:sdkParams,inputBytes,...(proofSession?{proofSession}:{})});
      const receipt=HonoredInputsReceiptSchema.parse({version:1,id:randomUUID(),jobId:request.jobId,capabilityProvenance:current.provenance,capabilityObservedAt:current.observedAt,inputs:mapped,createdAt:now()});
      return{providerRef:ack.providerRef,honoredInputs:acknowledgeH3Transport(receipt,true)};
    },
    observeAccount:async()=>{
      if(!transport.observeAccount)throw budgetBlocked();
      try {const parsed=ProviderAccountObservationSchema.parse(await transport.observeAccount());return Object.freeze({...parsed,captured:Object.freeze({...parsed.captured,session:Object.freeze({...parsed.captured.session})}),subscription:parsed.subscription?Object.freeze({...parsed.subscription}):null});}catch{throw budgetBlocked();}
    },
    currentSession:()=>{const snapshot=transport.currentSession?transport.currentSession():null;return snapshot?frozenCaptured(snapshot):null;},
    poll:(providerRef:string)=>transport.poll(providerRef),cancel:(providerRef:string)=>transport.cancel(providerRef),close:()=>transport.close(),
  };
}
function withVerifiedH3Constraints(receipt:CapabilityReceipt,model:CatalogModel,sdkVersion:string):CapabilityReceipt{
  const mode=h3ModeForModel(model.id);if(mode==="unknown")return receipt;
  const nullConstraints={supportsStartFrame:null,supportsEndFrame:null,supportsContextImages:null,maxReferenceImages:null,minFrames:null,maxFrames:null,frameStep:null};
  const expectedWorkflow=mode==="FL2VA"?"i2v":mode==="FLF2V"?"flf2v":mode==="Ref2VA"?"r2v":"t2v";
  if(sdkVersion!=="5.49.0"||model.workflowType!==expectedWorkflow)return{...receipt,...nullConstraints};
  const assetSupport=(key:string):boolean|null=>{const value=model.assets?.[key];return value==="forbidden"?false:value==="optional"||value==="required"?true:null;};
  if(mode==="FL2VA"||mode==="FLF2V")return{...receipt,supportsStartFrame:assetSupport("referenceImage"),supportsEndFrame:assetSupport("referenceImageEnd"),supportsContextImages:false,maxReferenceImages:2,minFrames:124,maxFrames:362,frameStep:17};
  if(mode==="Ref2VA")return{...receipt,supportsStartFrame:false,supportsEndFrame:false,supportsContextImages:true,maxReferenceImages:9,minFrames:124,maxFrames:362,frameStep:17};
  return{...receipt,supportsStartFrame:false,supportsEndFrame:false,supportsContextImages:false,minFrames:124,maxFrames:362,frameStep:17};
}
function buildSdkParameters(request:ProviderRequestSnapshot,inputs:ProviderRequestSnapshot["inputs"],mapped:ReturnType<typeof mapH3InputFields>,inputBytes:Record<string,Buffer>,mode:string):Record<string,unknown>{
  const p=request.parameters as Record<string,unknown>;const video=Number.isSafeInteger(p.frameCount??p.durationFrames);
  // C13-LIVE-FIX-3: Sogni rejects raw resolution strings as sizePreset (live WebSocket jobError 4007
  // "Unsupported size preset option: 1080p"), so image renders use the story-proven shape — preset
  // "custom" plus explicit dimensions from the shared aspect base x resolution scale on the 8px grid;
  // H3 video takes additionally render on their verified 32px aspect grid instead of the server default.
  const snap8=(value:number)=>Math.max(8,Math.round(value/8)*8);
  const aspect=(typeof p.aspect==="string"&&p.aspect in ASPECTS?p.aspect:"16:9") as keyof typeof ASPECTS;
  const resolution=(typeof p.resolution==="string"&&p.resolution in RESOLUTIONS?p.resolution:"1080p") as keyof typeof RESOLUTIONS;
  const scale=RESOLUTIONS[resolution]?.scale??1;
  const parameters:Record<string,unknown>=video?{type:"video",modelId:request.modelId,positivePrompt:request.prompt,numberOfMedia:1,ratio:typeof p.aspect==="string"?p.aspect:"16:9",duration:Number(p.frameCount??p.durationFrames)/24,outputFormat:"mp4"}:{type:"image",modelId:request.modelId,positivePrompt:request.prompt,numberOfMedia:1,sizePreset:"custom",width:snap8(ASPECTS[aspect].width*scale),height:snap8(ASPECTS[aspect].height*scale),outputFormat:"png"};
  if(request.billingMode)parameters.billingMode=request.billingMode;
  if(typeof p.seed==="number"&&Number.isSafeInteger(p.seed))parameters.seed=p.seed;
  const contexts:Buffer[]=[];const referenceVideos:Buffer[]=[];const referenceAudios:Buffer[]=[];
  for(let index=0;index<inputs.length;index++){const input=inputs[index]!;const item=mapped[index];if(!item?.providerField)continue;const bytes=inputBytes[input.assetId]!;if(item.providerField==="contextImages"||item.providerField==="contextImage1")contexts.push(bytes);else if(item.providerField==="referenceVideos")referenceVideos.push(bytes);else if(item.providerField==="referenceAudios")referenceAudios.push(bytes);else parameters[item.providerField]=bytes;}
  if(contexts.length)parameters.contextImages=contexts;
  if(referenceVideos.length)parameters.referenceVideos=referenceVideos;
  if(referenceAudios.length)parameters.referenceAudios=referenceAudios;
  if(mode!=="unknown"&&video&&typeof (p.frameCount??p.durationFrames)==="number"){parameters.frames=p.frameCount??p.durationFrames;const dimensions=minimaxH3Dimensions(aspect,resolution);if(dimensions){parameters.width=dimensions.width;parameters.height=dimensions.height;}}
  return parameters;
}

export interface SogniSdkTransportOptions {env?:Readonly<Record<string,string|undefined>>;dataDir:string;role?:SogniRole;importSdk?:()=>Promise<unknown>;proofMetadata?:SogniProofMetadata;submissionProofResolver?:SubmissionProofResolver;now?:()=>number}
export function createSogniSdkTransport(options:SogniSdkTransportOptions):SogniProviderTransport {
  const env=options.env??process.env,role=options.role??"web",now=options.now??Date.now;let clientPromise:Promise<SogniSdkClient>|null=null,clientInstance:SogniSdkClient|null=null,capturedSession:CapturedProviderSession|null=null,sessionEpoch=-1,epoch=0,closePromise:Promise<void>|null=null;let lockHandle:Awaited<ReturnType<typeof open>>|null=null;let lockServer:Server|null=null;let lockOwnerEpoch:number|null=null;
  const importSdk=options.importSdk??(async()=>import("@sogni-ai/sogni-client"));
  async function releaseOwnership(){if(lockHandle){await lockHandle.close();lockHandle=null;await unlink(join(options.dataDir,"sogni-worker-owner.lock")).catch(()=>undefined);}if(lockServer?.listening){await new Promise<void>(resolveClose=>lockServer!.close(()=>resolveClose()));lockServer=null;}lockOwnerEpoch=null;}
  async function getClient():Promise<SogniSdkClient>{
    if(closePromise){const closing=closePromise;await closing;if(closePromise===closing)closePromise=null;return getClient();}
    if(clientPromise)return clientPromise;
    const attemptEpoch=epoch,apiKey=env.SOGNI_API_KEY?.trim();if(!apiKey)throw new Error("SOGNI_API_KEY is not configured; Sogni provider is offline.");
    const attempt=(async()=>{let client:SogniSdkClient|null=null;try{
      const metadata=options.proofMetadata?validateInstalledProofMetadata(options.proofMetadata):null;
      await mkdir(options.dataDir,{recursive:true,mode:0o700});
      if(role==="worker"){try{lockServer=await acquireWorkerSocket(options.dataDir);lockHandle=await acquireWorkerPidFile(join(options.dataDir,"sogni-worker-owner.lock"));lockOwnerEpoch=attemptEpoch;}catch(error){if(lockServer?.listening)await new Promise<void>(resolveClose=>lockServer!.close(()=>resolveClose()));lockServer=null;throw new Error("Another local worker owns the Sogni worker app ID. Stop that worker before starting this one.",{cause:error});}}
      const appId=await resolveSogniAppIdForRole(options.dataDir,role);const mod=await importSdk() as {SogniClient:{createInstance:(config:Record<string,unknown>)=>Promise<SogniSdkClient>}};
      client=await mod.SogniClient.createInstance({appId,apiKey,network:"fast",appSource:`perabyte-studio-production-${role}`,socketEventSubscriptions:{modelAvailability:false},logLevel:"error"});
      if(epoch!==attemptEpoch){client.dispose();throw budgetBlocked();}
      clientInstance=client;sessionEpoch=attemptEpoch;
      capturedSession=metadata?frozenCaptured({session:{sessionId:`sogni-session:${randomUUID()}`,role,sdkVersion:metadata.sdkVersion,sdkSourceHash:metadata.sdkSourceHash,adapterVersion:metadata.adapterVersion},credentialFingerprint:createHash("sha256").update(apiKey,"utf8").digest("hex"),accountId:null}):null;
      if(metadata&&!capturedSession)throw budgetBlocked();
      return client;
    }catch(error){if(client&&clientInstance!==client){try{client.dispose();}catch{}}if(epoch===attemptEpoch){clientInstance=null;capturedSession=null;sessionEpoch=-1;await releaseOwnership();}else if(lockOwnerEpoch===attemptEpoch){await releaseOwnership();}throw error;}})();
    clientPromise=attempt;
    try{return await attempt;}catch(error){if(clientPromise===attempt){clientPromise=null;}throw error;}
  }
  const sdkVersion=(()=>{try{return readInstalledSogniProofMetadata().sdkVersion;}catch{return "unknown";}})();
  const currentSession=():CapturedProviderSession|null=>capturedSession&&sessionEpoch===epoch&&clientInstance?frozenCaptured(capturedSession):null;
  const isLive=(client:SogniSdkClient,atEpoch:number)=>epoch===atEpoch&&clientInstance===client&&sessionEpoch===atEpoch;
  const closeTransport=async():Promise<void>=>{if(closePromise)return closePromise;epoch++;const oldPromise=clientPromise;clientPromise=null;clientInstance=null;capturedSession=null;sessionEpoch=-1;const cleanup=(async()=>{if(oldPromise){try{const client=await oldPromise;client.dispose();}catch{}}if(lockOwnerEpoch!==null)await releaseOwnership();})();closePromise=cleanup;try{await cleanup;}finally{if(closePromise===cleanup)closePromise=null;}};
  const invalidate=(client:SogniSdkClient,atEpoch:number)=>{if(!isLive(client,atEpoch))return;void closeTransport();};
  return{sdkVersion,configured:Boolean(env.SOGNI_API_KEY?.trim()),currentSession,async observeAccount(){
      if(!options.proofMetadata)throw budgetBlocked();
      const metadata=validateInstalledProofMetadata(options.proofMetadata),client=await getClient(),atEpoch=epoch,starting=currentSession();
      if(!starting||!client.account?.me||!client.account.getSubscriptionStatus)throw budgetBlocked();
      let wallet:unknown;
      try{wallet=await client.account.me();}catch{if(isLive(client,atEpoch)){capturedSession=null;invalidate(client,atEpoch);}throw budgetBlocked();}
      if(!isLive(client,atEpoch))throw budgetBlocked();
      const walletAddress=wallet&&typeof wallet==="object"&&!Array.isArray(wallet)?(wallet as Record<string,unknown>).walletAddress:null;
      if(typeof walletAddress!=="string"||!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)){capturedSession=null;invalidate(client,atEpoch);throw budgetBlocked();}
      const accountId=IdSchema.parse(`sogni-account:${hashCanonicalJson({schemaVersion:1,providerId:"sogni",walletAddress:walletAddress.toLowerCase()})}`);
      if(starting.accountId&&starting.accountId!==accountId){capturedSession=null;invalidate(client,atEpoch);throw budgetBlocked();}
      const authenticated=AuthenticatedProviderSessionSchema.parse({...starting,accountId});capturedSession=frozenCaptured(authenticated);if(!capturedSession)throw budgetBlocked();
      let subscription:SubscriptionObservation=null;
      try{subscription=parseSubscription(await client.account.getSubscriptionStatus());}catch{subscription=null;}
      if(!isLive(client,atEpoch)||!capturedSession||capturedSession.accountId!==accountId)throw budgetBlocked();
      const observedAt=BudgetUtcMillisSchema.parse(now()),observation=ProviderAccountObservationSchema.parse({providerId:"sogni",captured:capturedSession,subscription,observedAt});
      if(canonicalJson(observation.captured.session)!==canonicalJson(metadata?capturedSession.session:null))throw budgetBlocked();
      return Object.freeze({...observation,captured:Object.freeze({...observation.captured,session:Object.freeze({...observation.captured.session})}),subscription:observation.subscription?Object.freeze({...observation.subscription}):null});
    },async discover(ids){const client=await getClient();const models=await client.projects.getAvailableModels("fast");const list:CatalogModel[]=[];for(const model of models){if(ids.length&&!ids.includes(String(model.id)))continue;const item:CatalogModel={id:String(model.id),media:String(model.media)};if(model.media==="video"&&client.projects.getVideoAssetConfig){try{const config=await client.projects.getVideoAssetConfig(item.id);item.workflowType=config.workflowType??undefined;item.assets=config.assets??undefined;}catch{/* Preserve unknown model fields on failed discovery. */}}list.push(item);}return list;},async submit(submission){
      if(!options.proofMetadata||typeof options.submissionProofResolver!=="function")throw budgetBlocked();
      const metadata=validateInstalledProofMetadata(options.proofMetadata),preSession=currentSession();if(!submission.proofSession||!preSession||!preSession.accountId)throw budgetBlocked();const client=await getClient(),atEpoch=epoch,active=currentSession(),expected=submission.proofSession;
      if(!active||!active.accountId||!expected||canonicalJson(active)!==canonicalJson(expected)||canonicalJson(active.session)!==canonicalJson(metadata?{...active.session,sdkVersion:metadata.sdkVersion,sdkSourceHash:metadata.sdkSourceHash,adapterVersion:metadata.adapterVersion}:null))throw budgetBlocked();
      let at:number,allowed:unknown;
      try{at=BudgetUtcMillisSchema.parse(now());allowed=options.submissionProofResolver(submission.snapshot,AuthenticatedProviderSessionSchema.parse(active),at);}catch{throw budgetBlocked();}
      const afterResolver=currentSession();
      if(allowed!==true||!isLive(client,atEpoch)||!afterResolver||canonicalJson(afterResolver)!==canonicalJson(expected)||afterResolver.session.sdkVersion!==metadata.sdkVersion||afterResolver.session.sdkSourceHash!==metadata.sdkSourceHash||afterResolver.session.adapterVersion!==metadata.adapterVersion)throw budgetBlocked();
      const creation=client.projects.create(submission.parameters);
      const project=await creation;if(!project.id)throw new Error("Sogni SDK returned no durable project ID");return{providerRef:project.id};
    },async poll(providerRef){
      const client=await getClient();
      const status=await client.projects.getStatus(providerRef);
      if(["pending","authorized","active","queued","assigned","progress","processing"].includes(status.status))return{providerRef,state:"running",temporaryUrl:null,mime:null,width:null,height:null,frames:null,errorCode:null,errorMessage:null};
      if(status.status==="errored"||status.status==="failed")return{providerRef,state:"failed",temporaryUrl:null,mime:null,width:null,height:null,frames:null,errorCode:"MEDIA_UNAVAILABLE",errorMessage:"Sogni reports that the project failed."};
      if(status.status==="cancelled"||status.status==="canceled")return{providerRef,state:"canceled",temporaryUrl:null,mime:null,width:null,height:null,frames:null,errorCode:null,errorMessage:"Sogni project was canceled."};
      if(status.status!=="completed")throw new Error("Sogni returned an unrecognized project state; result persistence is blocked.");
      const raw=await client.projects.get(providerRef);
      const completedJobs=[...(raw.completedWorkerJobs??[]).filter(job=>job.status==="jobCompleted"),...(raw.workerJobs??[]).filter(job=>job.status==="jobCompleted")];
      const result=completedJobs.find(job=>Boolean(job.imgID||job.id));
      const resultId=result?.imgID||result?.id;
      if(!result||!resultId)throw new Error("Sogni completed project has no result asset reference");
      const reportedOutputFormat=result.outputFormat??result.result?.outputFormat;
      let outputFormat=typeof reportedOutputFormat==="string"?reportedOutputFormat.toLowerCase():"";
      const modelId=raw.model?.id;
      if(reportedOutputFormat==null&&modelId){
        const models=await client.projects.getAvailableModels("fast");
        // C13-LIVE-FIX-4: live H3 video takes complete with no outputFormat field on the worker job;
        // alongside the image fallback, an exactly matched video model recovers the transport's own
        // buildSdkParameters request format ("mp4") instead of blocking persistence.
        if(models.some(model=>model.id===modelId&&model.media==="image"))outputFormat="png";
        else if(models.some(model=>model.id===modelId&&model.media==="video"))outputFormat="mp4";
      }
      const mimeByFormat:Record<string,string>={mp4:"video/mp4",mov:"video/quicktime",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp"};
      const mime=mimeByFormat[outputFormat];
      if(!mime)throw new Error("Sogni completed result has no supported media format; result persistence is blocked.");
      const isVideo=mime.startsWith("video/");
      let temporaryUrl:string;
      if(isVideo&&client.projects.mediaDownloadUrl)temporaryUrl=await client.projects.mediaDownloadUrl({jobId:providerRef,id:resultId,type:"complete"});
      else if(!isVideo&&client.projects.downloadUrl)temporaryUrl=await client.projects.downloadUrl({jobId:providerRef,imageId:resultId,type:"complete",contentType:mime});
      else throw new Error("Installed Sogni SDK does not expose a compatible result download method");
      return{providerRef,state:"completed",temporaryUrl,mime,width:null,height:null,frames:null,errorCode:null,errorMessage:null};
    },async cancel(providerRef){const client=await getClient();await client.projects.cancel(providerRef);},close:closeTransport};
}

async function acquireWorkerSocket(dataDir:string):Promise<Server>{const digest=createHash("sha256").update(resolve(dataDir)).digest();const port=40_000+(digest.readUInt16BE(0)%20_000);const server=createServer(socket=>socket.destroy());await new Promise<void>((resolveListen,reject)=>{const onError=(error:Error)=>reject(error);server.once("error",onError);server.listen({host:"127.0.0.1",port,exclusive:true},()=>{server.off("error",onError);server.on("error",()=>undefined);resolveListen();});});return server;}
async function acquireWorkerPidFile(path:string):Promise<Awaited<ReturnType<typeof open>>>{
  const create=async()=>{const handle=await open(path,"wx",0o600);await handle.writeFile(String(process.pid));await handle.sync();return handle;};
  try{return await create();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  const pid=Number.parseInt(await readFile(path,"utf8").catch(()=>""),10);let alive=false;
  if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);alive=true;}catch(error){alive=(error as NodeJS.ErrnoException).code==="EPERM";}}
  if(alive)throw new Error("A legacy worker PID lock belongs to a live process.");
  await unlink(path).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
  return create();
}

export async function resolveSogniAppIdForRole(dataDir:string,role:SogniRole):Promise<string>{const dir=resolve(dataDir);await mkdir(dir,{recursive:true,mode:0o700});const file=join(dir,`sogni-production-${role}.app-id`);try{const saved=(await readFile(file,"utf8")).trim();if(/^[A-Za-z0-9_-]{8,120}$/.test(saved))return saved;}catch{}const value=randomUUID();try{const handle=await open(file,"wx",0o600);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}return value;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const saved=(await readFile(file,"utf8")).trim();if(!saved)throw new Error("Unable to persist the Sogni role app ID");return saved;}}
