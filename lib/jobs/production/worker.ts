import { setTimeout as sleepFor } from "node:timers/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { canSatisfy } from "../../providers/production/capabilities";
import { isUncertainSubmissionError } from "../../providers/production/submission-errors";
import { ProductionApplicationError } from "../../production/errors";
import { ProviderRequestSnapshotSchema, type CapabilityReceipt, type ProductionJob, type ProductionQuote } from "../../production/contracts";
import type { DurableMediaRecord, JobLease, ProviderMediaResult, ProviderPort } from "../../repositories/production/ports";
import type { DurableMediaVault } from "../../media/production/vault";
import { recordGeneration } from "../../services/production/metrics";
import { productionSubmissionEligibilityFingerprint, validateProductionSnapshotForSubmission, type LeasedProductionJob, type PreparedBudgetContext, type ProductionJobQueue, type ReserveSubmission } from "./queue";

type Reconciliation = import("../../repositories/production/ports").ProviderSubmissionAck | null;
export interface ProductionWorkerOptions {
  queue: ProductionJobQueue; providers: Record<string,ProviderPort>; vault: DurableMediaVault;
  prepareBudgetContext?:(job:ProductionJob,quote:ProductionQuote,capability:CapabilityReceipt)=>Promise<PreparedBudgetContext>;
  reserveSubmission?:ReserveSubmission;
  reconcile?:(provider:ProviderPort,idempotencyKey:string)=>Promise<Reconciliation>;
  downloadResult?:(temporaryUrl:string,maxBytes:number)=>Promise<NodeJS.ReadableStream>;
  now?:()=>number; wait?:(ms:number,signal?:AbortSignal)=>Promise<void>; random?:()=>number; leaseMs?:number; heartbeatMs?:number; maxAttempts?:number;
}
/** Standalone worker state machine. Network and disk work stay outside SQLite transactions. */
export class ProductionWorker {
  private readonly now:()=>number; private readonly wait:(ms:number,signal?:AbortSignal)=>Promise<void>; private readonly random:()=>number;
  constructor(private readonly options:ProductionWorkerOptions){this.now=options.now??Date.now;this.wait=options.wait??((ms,signal)=>sleepFor(ms,undefined,{signal}));this.random=options.random??Math.random;}
  async runOnce(signal?:AbortSignal):Promise<boolean>{
    const claimed=this.options.queue.claimNext(this.now(),this.options.leaseMs??30_000);if(!claimed)return false;
    const {job,lease,outbox}=claimed;const leaseController=new AbortController();const relayAbort=()=>leaseController.abort();signal?.addEventListener("abort",relayAbort,{once:true});if(signal?.aborted)leaseController.abort();
    const timer=setInterval(()=>{try{if(!this.options.queue.heartbeat(lease,outbox,this.now(),this.options.leaseMs??30_000))leaseController.abort();}catch{leaseController.abort();}},this.options.heartbeatMs??10_000);timer.unref?.();
    try{await this.process(claimed,leaseController.signal);}finally{clearInterval(timer);signal?.removeEventListener("abort",relayAbort);this.options.queue.finishOutbox(outbox,lease);}
    return true;
  }
  async run(signal?:AbortSignal):Promise<void>{while(!signal?.aborted){if(!(await this.runOnce(signal)))await this.waitOwned(500,signal);}}
  private async process(claimed:LeasedProductionJob,signal?:AbortSignal):Promise<void>{
    let {job}=claimed;const {lease}=claimed;const now=this.now();if(!this.ownsLease(job.id,lease))return;
    if(job.status==="cancel_requested"){
      const provider=job.providerId?this.options.providers[job.providerId]:undefined;
      await this.cancelRequested(job,lease,provider,signal);return;
    }
    const provider=job.providerId?this.options.providers[job.providerId]:undefined;
    if(!provider){this.fail(job,lease,"CAPABILITY_MISMATCH","No server provider adapter is configured for this job.");return;}
    if(job.status==="submission_unknown"){
      let resolved:Reconciliation=null;try{resolved=await this.options.reconcile?.(provider,job.idempotencyKey)??null;}catch(error){this.options.queue.update({...job,errorCode:"SUBMISSION_UNKNOWN",errorMessage:clean(error)},lease,"Reconciliation failed; manual provider reconciliation remains required.",now,job.status);return;}
      if(resolved&&this.ownsLease(job.id,lease))this.options.queue.recoverSubmission(job,lease,resolved,now);
      return;
    }
    if(job.providerRef){await this.poll(job,lease,provider,signal);return;}
    let quote:ProductionQuote|null=job.quoteId?this.options.queue.store.read.getQuote(job.quoteId):null;
    if(!quote||quote.projectId!==job.projectId||quote.providerId!==provider.providerId||quote.modelId!==job.modelId||quote.expiresAt<=now||quote.entitlement==="unknown"||quote.withinAuthorizedCap!=="yes"){
      this.fail(job,lease,"BUDGET_BLOCKED","A current known quote and authorized cap are required before submission.");return;
    }
    if(!job.modelId){this.fail(job,lease,"CAPABILITY_MISMATCH","A provider model is required.");return;}
    const parsedSnapshot=ProviderRequestSnapshotSchema.safeParse(job.requestSnapshot);
    if(!parsedSnapshot.success||parsedSnapshot.data.projectId!==job.projectId||parsedSnapshot.data.jobId!==job.id||parsedSnapshot.data.idempotencyKey!==job.idempotencyKey||parsedSnapshot.data.quoteId!==quote.id||parsedSnapshot.data.providerId!==provider.providerId||parsedSnapshot.data.modelId!==job.modelId||!validateProductionSnapshotForSubmission(this.options.queue.store.read,job,quote,parsedSnapshot.data)){
      this.fail(job,lease,"INVALID_INPUT","The immutable result target, billing mode, and fingerprint must match this project's selected inputs before provider access.");return;
    }
    const eligibility=productionSubmissionEligibilityFingerprint(this.options.queue.store.read,job,quote,parsedSnapshot.data);if(!eligibility){this.fail(job,lease,"INVALID_INPUT","The currently selected story and animatic do not have matching latest approvals.");return;}
    let capability:CapabilityReceipt;
    try{capability=await provider.discoverCapabilities(job.modelId);}catch(error){if(this.ownsLease(job.id,lease))this.retry(job,lease,"MEDIA_UNAVAILABLE",`Provider capability discovery failed: ${clean(error)}`,now);return;}
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    this.persistCapability(capability);
    const operation=requiredProviderOperation(job,quote);
    if(!operation||!capability.supportedOperations.includes(operation)||!canSatisfy(capability,requiredConditioning(job),this.now())){
      this.fail(job,lease,"CAPABILITY_MISMATCH","Current provider capability evidence does not satisfy this request's required inputs.");return;
    }
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    if(!this.options.prepareBudgetContext||!this.options.reserveSubmission){this.fail(job,lease,"BUDGET_BLOCKED","A trusted budget admission service is required before provider submission.");return;}
    let context:PreparedBudgetContext;
    try{context=await this.options.prepareBudgetContext(job,quote,capability);}catch{if(this.ownsLease(job.id,lease))this.fail(job,lease,"BUDGET_BLOCKED","Trusted quote and account evidence could not be prepared for this request.");return;}
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    const admissionTime=this.now();
    if(capability.expiresAt===null||capability.expiresAt<=admissionTime||!canSatisfy(capability,requiredConditioning(job),admissionTime)){
      this.fail(job,lease,"CAPABILITY_MISMATCH","Provider capability evidence expired before submission admission.");return;
    }
    if(quote.expiresAt<=admissionTime||quote.withinAuthorizedCap!=="yes"){
      this.fail(job,lease,"BUDGET_BLOCKED","The quote or authorized cap expired before submission admission.");return;
    }
    let submitting:ProductionJob|null;
    try{submitting=this.options.queue.beginSubmission(job,lease,{quote,capability,eligibilityFingerprint:eligibility,context,reserve:this.options.reserveSubmission,outbox:claimed.outbox});}
    catch{if(this.ownsLease(job.id,lease))this.fail(job,lease,"BUDGET_BLOCKED","The atomic budget admission was denied or could not be committed.");return;}
    if(!submitting)return;
    const beforeSubmit=this.options.queue.get(job.id);if(beforeSubmit?.status==="cancel_requested"){await this.cancelRequested(beforeSubmit,lease,provider,signal);return;}
    if(!this.ownsLease(job.id,lease))return;
    try{
      const ack=await provider.submit(parsedSnapshot.data,capability);
      if(!this.ownsLease(job.id,lease))return;
      this.options.queue.accept(submitting,lease,ack,this.now());
      const accepted=this.options.queue.get(job.id);if(!signal?.aborted&&accepted?.status==="cancel_requested")await this.cancelRequested(accepted,lease,provider,signal);
    }catch(error){
      // C18-UNCERTAIN-SUBMISSION: explicit uncertain-outcome classification at the only
      // boundary where a throw cannot prove the provider never saw the request. A
      // network-class failure (isUncertainSubmissionError) may have been accepted after
      // the request was sent; any other post-admission throw keeps the same fail-safe
      // outcome because the submission may still have landed. Either way the job is
      // never auto-retried or resubmitted: finishOutbox acknowledges the intent and only
      // durable reconciliation (recoverSubmission/resolveSubmissionUnknown) may attach
      // the exact provider receipt, so one paid request can never double-spend.
      const uncertain=isUncertainSubmissionError(error);
      this.options.queue.update({...submitting,status:"submission_unknown",errorCode:"SUBMISSION_UNKNOWN",errorMessage:uncertain?"Provider submission outcome is uncertain; automatic resubmission is disabled.":`Provider submission outcome is uncertain after a non-network failure (${clean(error)}); automatic resubmission is disabled.`},lease,"Provider request may have been accepted; reconciliation is required before another submit.",this.now(),submitting.status);
    }
  }
  private persistCapability(receipt:CapabilityReceipt):void{
    const stored=this.options.queue.store.read.getCapabilityReceipt(receipt.providerId,receipt.modelId);
    if(!stored||receipt.observedAt>stored.observedAt)this.options.queue.store.transaction(tx=>tx.insertCapabilityReceipt(receipt));
  }
  private async poll(job:ProductionJob,lease:JobLease,provider:ProviderPort,signal?:AbortSignal):Promise<void>{
    let result:ProviderMediaResult;let pollCount=0;
    while(true){
      const current=this.options.queue.get(job.id);
      if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
      if(current?.status==="cancel_requested"){await this.cancelRequested(current,lease,provider,signal);return;}
      try{result=await provider.poll(job.providerRef!);}catch(error){if(this.ownsLease(job.id,lease))this.retry(job,lease,"MEDIA_UNAVAILABLE",clean(error),this.now());return;}
      if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
      if(result.state!=="running")break;
      await this.waitOwned(this.pollDelay(pollCount++),signal);
      if(signal?.aborted)return;
    }
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    if(result.state==="failed"||result.state==="canceled"){
      const ended=this.options.queue.update({...job,status:result.state,errorCode:result.errorCode??"MEDIA_UNAVAILABLE",errorMessage:result.errorMessage??`Provider reports ${result.state}.`},lease,`Provider reports ${result.state}.`,this.now(),job.status);if(ended&&result.state==="failed")this.recordGenerationMetric(job,"generation_failed");return;
    }
    if(!result.temporaryUrl||!result.mime){this.options.queue.update({...job,status:"persisting",errorCode:"MEDIA_UNAVAILABLE",errorMessage:"Provider completed without a retrievable media result."},lease,"Completed provider result is not yet available for durable persistence.",this.now(),job.status);return;}
    if(!this.options.queue.update({...job,status:"persisting",errorCode:null,errorMessage:null},lease,"Provider media is ready; storing and verifying local bytes.",this.now(),job.status)){const current=this.options.queue.get(job.id);if(current?.status==="cancel_requested")await this.cancelRequested(current,lease,provider,signal);return;}
    const mime=result.mime;const maxBytes=mime.startsWith("video/")?2*1024*1024*1024:100*1024*1024;
    try{
      const stream=await (this.options.downloadResult??downloadProviderMedia)(result.temporaryUrl,maxBytes);
      if(!this.ownsLease(job.id,lease)||signal?.aborted){if("destroy" in stream&&typeof stream.destroy==="function")stream.destroy();return;}
      const media=await this.options.vault.putStream(stream,{mime,sourceKind:"generation",sourceJobId:job.id,rightsStatus:"provider",maxBytes,now:this.now()});
      if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
      if(!this.options.queue.complete({...job,status:"persisting"},lease,media,this.now()))return;
      this.recordGenerationMetric(job,"generation_completed");
    }catch(error){
      const current=this.options.queue.get(job.id);if(current?.status==="persisting")this.retry(current,lease,"MEDIA_UNAVAILABLE",clean(error),this.now());
    }
  }
  private async cancelRequested(job:ProductionJob,lease:JobLease,provider:ProviderPort|undefined,signal?:AbortSignal):Promise<void>{
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    if(!job.providerRef){
      const events=this.options.queue.store.read.listJobEvents(job.id,0);const uncertain=events.some(event=>event.status==="submitting"||event.status==="submission_unknown");
      if(uncertain&&provider){let reconciled:Reconciliation=null;try{reconciled=await this.options.reconcile?.(provider,job.idempotencyKey)??null;}catch{/* Preserve ambiguous submission for manual reconciliation. */}if(!this.ownsLease(job.id,lease)||signal?.aborted)return;if(reconciled){this.options.queue.recoverSubmission(job,lease,reconciled,this.now());const withReceipt=this.options.queue.get(job.id);if(withReceipt?.providerRef)await this.cancelRequested(withReceipt,lease,provider,signal);return;}}
      if(uncertain)return;
      this.options.queue.update({...job,status:"canceled",errorCode:null,errorMessage:null},lease,"Canceled before provider submission.",this.now(),"cancel_requested");return;
    }
    if(!provider)return;
    try{await provider.cancel(job.providerRef);}catch(error){if(this.ownsLease(job.id,lease))this.options.queue.update({...job,errorCode:"MEDIA_UNAVAILABLE",errorMessage:`Provider cancellation is pending: ${clean(error)}`},lease,"Provider cancellation was not confirmed; retain the same provider reference and retry.",this.now(),"cancel_requested");return;}
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    let result:ProviderMediaResult;
    try{result=await provider.poll(job.providerRef);}catch(error){if(this.ownsLease(job.id,lease))this.options.queue.update({...job,errorCode:"MEDIA_UNAVAILABLE",errorMessage:`Provider cancellation is pending: ${clean(error)}`},lease,"Provider cancellation is pending; retain the same provider reference and retry.",this.now(),"cancel_requested");return;}
    if(!this.ownsLease(job.id,lease)||signal?.aborted)return;
    if(result.state==="running"){await this.waitOwned(this.pollDelay(job.attempt),signal);return;}
    if(result.state==="canceled"){this.options.queue.update({...job,status:"canceled",errorCode:null,errorMessage:null},lease,"Provider confirmed cancellation.",this.now(),"cancel_requested");return;}
    if(result.state==="failed"){this.options.queue.update({...job,status:"failed",errorCode:result.errorCode??"MEDIA_UNAVAILABLE",errorMessage:result.errorMessage??"Provider failed before cancellation completed."},lease,"Provider failed while cancellation was pending.",this.now(),"cancel_requested");return;}
    await this.persistCompletedResult(job,lease,result,"cancel_requested");
  }
  private async persistCompletedResult(job:ProductionJob,lease:JobLease,result:ProviderMediaResult,expectedStatus:ProductionJob["status"]):Promise<void>{
    if(!this.ownsLease(job.id,lease))return;
    if(!result.temporaryUrl||!result.mime){if(this.options.queue.update({...job,status:"failed",errorCode:"MEDIA_UNAVAILABLE",errorMessage:"Provider completed without a retrievable media result."},lease,"Provider completed without a retrievable result.",this.now(),expectedStatus))this.recordGenerationMetric(job,"generation_failed");return;}
    if(expectedStatus!=="cancel_requested"&&!this.options.queue.update({...job,status:"persisting",errorCode:null,errorMessage:null},lease,"Provider media is ready; storing and verifying local bytes.",this.now(),expectedStatus))return;
    const mime=result.mime,maxBytes=mime.startsWith("video/")?2*1024*1024*1024:100*1024*1024;
    try{const stream=await(this.options.downloadResult??downloadProviderMedia)(result.temporaryUrl,maxBytes);if(!this.ownsLease(job.id,lease)){if("destroy" in stream&&typeof stream.destroy==="function")stream.destroy();return;}const media=await this.options.vault.putStream(stream,{mime,sourceKind:"generation",sourceJobId:job.id,rightsStatus:"provider",maxBytes,now:this.now()});if(!this.ownsLease(job.id,lease))return;const archived=expectedStatus==="cancel_requested"?this.options.queue.completeCanceled(job,lease,media,this.now()):this.options.queue.complete({...job,status:"persisting"},lease,media,this.now());if(archived&&expectedStatus!=="cancel_requested")this.recordGenerationMetric(job,"generation_completed");}
    catch(error){const current=this.options.queue.get(job.id);if(current?.status==="persisting"||current?.status==="cancel_requested")this.retry(current,lease,"MEDIA_UNAVAILABLE",clean(error),this.now());}
  }
  /** C19 best-effort product metric at terminal job outcomes; recordGeneration never throws. */
  private recordGenerationMetric(job:ProductionJob,kind:"generation_completed"|"generation_failed"):void{
    const quote=job.quoteId?this.options.queue.store.read.getQuote(job.quoteId):null;
    recordGeneration(this.options.queue.store,{projectId:job.projectId,workspaceId:job.scope?.workspaceId??null,kind,at:this.now(),
      durationMs:Math.max(0,this.now()-job.createdAt),
      costMicros:quote&&quote.currency==="USD"&&quote.estimateMaxMinor!==null?quote.estimateMaxMinor*10_000:null,
      dims:{operation:job.operation,providerId:job.providerId??"unknown",modelId:job.modelId??"unknown",jobId:job.id}});
  }
  private pollDelay(pollCount:number):number{const base=Math.min(10_000,2_000*2**Math.min(Math.max(pollCount,0),3));return Math.max(2_000,Math.min(10_000,Math.round(base*(0.8+this.random()*0.4))));}
  private async waitOwned(ms:number,signal?:AbortSignal):Promise<void>{try{await this.wait(ms,signal);}catch(error){if(!signal?.aborted)throw error;}}
  private retry(job:ProductionJob,lease:JobLease,code:ProductionJob["errorCode"],message:string,now:number):void{const exhausted=job.attempt>=(this.options.maxAttempts??5);const status=exhausted?"failed":job.status;const changed=this.options.queue.update({...job,status,errorCode:code,errorMessage:message.slice(0,1000)},lease,exhausted?`Retry limit exhausted: ${message}`:`Transient failure; retrying the same job: ${message}`,now,job.status);if(changed&&status==="failed")this.recordGenerationMetric(job,"generation_failed");}
  private fail(job:ProductionJob,lease:JobLease,code:ProductionJob["errorCode"],message:string){if(this.options.queue.update({...job,status:"blocked",errorCode:code,errorMessage:message},lease,message,this.now(),job.status))this.recordGenerationMetric(job,"generation_failed");}
  private ownsLease(jobId:string,lease:JobLease):boolean{const current=this.options.queue.get(jobId);return !!current&&current.leaseToken===lease.leaseToken&&current.leaseUntil!==null&&current.leaseUntil>this.now();}
}
function requiredProviderOperation(job:ProductionJob,quote:ProductionQuote):"image"|"video"|"speech"|"music"|null{if(job.operation==="anchor")return"image";if(job.operation==="take")return"video";if(job.operation==="audio")return quote.operation==="music"?"music":quote.operation==="speech"?"speech":null;return null;}
function requiredConditioning(job:ProductionJob){const s=job.requestSnapshot as {inputs?:Array<{role?:string;required?:boolean}>};const inputs=s.inputs??[];return{startFrame:inputs.some(x=>x.required&&x.role==="start_frame"),endFrame:inputs.some(x=>x.required&&x.role==="end_frame"),contextImages:inputs.filter(x=>x.required&&x.role==="context_image").length};}
function clean(error:unknown){return(error instanceof Error?error.message:"Provider failure").replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi,"[redacted]").slice(0,1000);}
async function downloadProviderMedia(raw:string,maxBytes:number):Promise<NodeJS.ReadableStream>{
  let url:URL;try{url=new URL(raw);}catch{throw new ProductionApplicationError("MEDIA_UNAVAILABLE","Provider returned an invalid media address.");}
  if(url.protocol!=="https:"||url.username||url.password||isIP(url.hostname)||/^(localhost|.*\.localhost|.*\.local)$/i.test(url.hostname))throw new ProductionApplicationError("MEDIA_UNAVAILABLE","Provider media address is not allowed.");
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),120_000);timeout.unref?.();
  let response:Response;
  try{response=await fetch(url,{redirect:"error",signal:controller.signal});if(!response.ok||!response.body)throw new Error("Provider media download failed");const length=response.headers.get("content-length");if(length&&Number(length)>maxBytes)throw new Error("Provider media exceeds the allowed size");}
  catch(error){clearTimeout(timeout);throw error;}
  async function* bounded(){let total=0;try{for await(const chunk of Readable.fromWeb(response.body as never)){total+=chunk.length;if(total>maxBytes){controller.abort();throw new Error("Provider media exceeds the allowed size");}yield chunk;}}finally{clearTimeout(timeout);if(!response.body?.locked)await response.body?.cancel().catch(()=>undefined);}}
  return Readable.from(bounded());
}
