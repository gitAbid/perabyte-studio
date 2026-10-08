import { randomUUID } from "node:crypto";
import { hashCanonicalJson } from "../../production/hash";
import { shotsCompatibleWithStory } from "../../production/revisions";
import { latestMatchingApproval } from "../../production/approval-policy";
import { validateMediaBudgetQuoteCompatibility } from "../../production/budget";
import { admitWorkspaceIsolation, type WorkspaceIsolationAdmission } from "../../production/workspace-isolation";
import { AnchorCandidateSchema, ProviderRequestSnapshotSchema, TakeSchema, type AnchorCandidate, type BudgetReservation, type CapabilityReceipt, type ProductionJob, type ProductionQuote, type ProviderRequestSnapshot, type Take } from "../../production/contracts";
import type { DurableMediaRecord, JobLease, OutboxIntent, ProductionReadPort, ProductionStore, ProductionWritePort, ProviderSubmissionAck } from "../../repositories/production/ports";
import { canSatisfy } from "../../providers/production/capabilities";

export interface LeasedProductionJob { job: ProductionJob; outbox: OutboxIntent; lease: JobLease }
export type PreparedBudgetContext = Readonly<{
  accountEvidenceId: string; budgetQuoteId: string; policyId: string;
  expectedPolicyRevision: number; expectedAuthorizationRevision: number;
  expectedQuoteInputHash: string; executionSemanticHash: string; credentialBindingId: string;
}>;
export type ReserveSubmission = (
  tx: ProductionWritePort, currentJob: ProductionJob, quote: ProductionQuote,
  capability: CapabilityReceipt, now: number, context: PreparedBudgetContext
) => BudgetReservation;
export type SubmissionAdmission = Readonly<{
  quote: ProductionQuote; capability: CapabilityReceipt; eligibilityFingerprint: string;
  context: PreparedBudgetContext; reserve: ReserveSubmission; outbox: OutboxIntent;
}>;
const TERMINAL = new Set<ProductionJob["status"]>(["blocked","canceled","failed","completed"]);
/** Queue policy over the accepted C01 store; no duplicate job schema or database. */
export class ProductionJobQueue {
  constructor(readonly store: ProductionStore, private readonly now: () => number = Date.now) {}
  get(id: string): ProductionJob | null { return this.store.read.getJob(id); }
  enqueue(job: ProductionJob, isolation?: WorkspaceIsolationAdmission): { job: ProductionJob; created: boolean } {
    const requestHash = hashCanonicalJson(job.requestSnapshot);
    if (requestHash !== job.requestHash) throw new Error("Job request hash does not match its immutable request snapshot");
    // Workspace isolation admission (C9): a workspace-scoped job must prove its resolved
    // references before it is ever enqueued; the violation throws and nothing is persisted.
    admitWorkspaceIsolation(job, isolation);
    const intent: OutboxIntent = { id: randomUUID(), jobId: job.id, createdAt: this.now(), claimedAt: null, claimToken: null };
    return this.store.transaction(tx => {
      const prior=tx.getJobByIdempotencyKey(job.projectId,job.idempotencyKey);
      if(prior){if(prior.requestHash!==requestHash)throw new Error("Idempotency key conflicts with a different request snapshot");return{job:prior,created:false};}
      tx.insertJob(job,intent);return{job,created:true};
    });
  }
  claimNext(now = this.now(), duration = 30_000): LeasedProductionJob | null {
    const token = randomUUID();
    return this.store.transaction(tx => {
      // Hold each bounded page while scanning so live job leases are not released
      // and selected again forever. The transaction examines at most 1,000 intents.
      const held: OutboxIntent[] = [];
      for (let page = 0; page < 10; page += 1) {
        const intents = tx.claimOutbox(now, token, now + duration, 100);
        if (!intents.length) break;
        held.push(...intents);
        for (const outbox of intents) {
          const stored = tx.getJob(outbox.jobId);
          if (!stored || TERMINAL.has(stored.status)) { tx.acknowledgeOutbox(outbox.id, token); continue; }
          const lease: JobLease = { jobId: outbox.jobId, leaseToken: token, leaseUntil: now + duration, heartbeatAt: now };
          const claimed = tx.claimJob(outbox.jobId, now, lease);
          if (!claimed) continue;
          const job = claimed.status === "submitting" && !claimed.providerRef
            ? { ...claimed, status: "submission_unknown" as const, errorCode: "SUBMISSION_UNKNOWN", errorMessage: "Worker restarted during provider submission; reconciliation is required.", updatedAt: now }
            : claimed;
          if (job !== claimed) {
            if (!tx.updateLeasedJob(job, token)) continue;
            tx.appendJobEvent(this.event(job, "The prior submission may have been accepted; reconcile before retrying.", now));
          }
          for (const unused of held) if (unused.id !== outbox.id) tx.releaseOutbox(unused.id, token);
          return { job, outbox, lease };
        }
      }
      for (const outbox of held) tx.releaseOutbox(outbox.id, token);
      return null;
    });
  }
  heartbeat(lease: JobLease, outbox: OutboxIntent, now = this.now(), duration = 30_000): boolean {
    if(outbox.jobId!==lease.jobId||outbox.claimToken!==lease.leaseToken)return false;
    try{return this.store.transaction(tx=>{
      if(!tx.heartbeatJob(lease.jobId,lease.leaseToken,now,now+duration))throw new Error("Job lease expired");
      if(!tx.heartbeatOutbox(outbox.id,lease.leaseToken,now,now+duration))throw new Error("Outbox claim expired");
      return true;
    });}catch{return false;}
  }
  requestCancellation(jobId:string,requestedAt=this.now()):{job:ProductionJob|null;requested:boolean}{
    return this.store.transaction(tx=>{
      const current=tx.getJob(jobId);if(!current||TERMINAL.has(current.status)||current.status==="cancel_requested")return{job:current,requested:false};
      if(!tx.requestJobCancellation(jobId,current.status,requestedAt))return{job:tx.getJob(jobId),requested:false};
      const next=tx.getJob(jobId);if(!next)throw new Error("Canceled job disappeared inside its transaction");
      tx.appendJobEvent(this.event(next,"Cancellation was requested; the worker will cancel or reconcile the same provider request.",requestedAt));
      return{job:next,requested:true};
    });
  }
  update(job: ProductionJob, lease: JobLease, message: string, now = this.now(), expectedStatus:ProductionJob["status"]=job.status): boolean {
    return this.store.transaction(tx => {
      const current=tx.getJob(job.id);
      if(!current||current.status!==expectedStatus||current.leaseToken!==lease.leaseToken)return false;
      const next = { ...job, attempt:current.attempt, leaseUntil:current.leaseUntil, heartbeatAt:current.heartbeatAt, updatedAt: now }; const changed = tx.updateLeasedJob(next, lease.leaseToken);
      if (changed) tx.appendJobEvent(this.event(next, message, now)); return changed;
    });
  }
  accept(job: ProductionJob, lease: JobLease, ack: ProviderSubmissionAck, now = this.now()): boolean {
    return this.store.transaction(tx => {
      const current=tx.getJob(job.id);
      if(!current||!(current.status==="submitting"||current.status==="cancel_requested")||current.leaseToken!==lease.leaseToken)throw new Error("Job lease or status changed before provider receipt persistence");
      tx.insertHonoredInputsReceipt(ack.honoredInputs);
      const next = { ...current, providerRef: ack.providerRef, receiptId: ack.honoredInputs.id, status: (current.status==="cancel_requested"?"cancel_requested":"running") as ProductionJob["status"], errorCode: null, errorMessage: null, updatedAt: now };
      if (!tx.updateLeasedJob(next, lease.leaseToken)) throw new Error("Job lease expired before provider receipt persistence");
      tx.appendJobEvent(this.event(next,current.status==="cancel_requested"?"Provider acceptance arrived while cancellation was requested; cancel or reconcile this exact provider reference.":"Provider accepted the request; polling its durable reference.",now)); return true;
    });
  }
  recoverSubmission(job:ProductionJob,lease:JobLease,ack:ProviderSubmissionAck,now=this.now()):boolean{
    return this.store.transaction(tx=>{
      const current=tx.getJob(job.id);
      if(!current||!(current.status==="submission_unknown"||current.status==="cancel_requested")||current.leaseToken!==lease.leaseToken)throw new Error("Job lease or reconciliation status changed");
      if(!ack.providerRef||ack.honoredInputs.jobId!==current.id)throw new Error("Reconciliation requires the exact durable provider receipt");
      tx.insertHonoredInputsReceipt(ack.honoredInputs);
      const status:ProductionJob["status"]=current.status==="cancel_requested"?"cancel_requested":"running";
      const next={...current,providerRef:ack.providerRef,receiptId:ack.honoredInputs.id,status,errorCode:null,errorMessage:null,updatedAt:now};
      if(!tx.updateLeasedJob(next,lease.leaseToken))throw new Error("Job lease expired before reconciliation evidence persistence");
      tx.appendJobEvent(this.event(next,"Manual provider reconciliation persisted the exact reference and honored-input receipt.",now));return true;
    });
  }
  /** Trusted server-side operator reconciliation; the caller must supply the full immutable receipt. */
  resolveSubmissionUnknown(jobId:string,ack:ProviderSubmissionAck,now=this.now()):ProductionJob{
    const leaseToken=randomUUID();
    return this.store.transaction(tx=>{
      const current=tx.getJob(jobId);if(!current||current.status!=="submission_unknown")throw new Error("Only an unknown submission can be explicitly reconciled");
      const lease:JobLease={jobId,leaseToken,leaseUntil:now+30_000,heartbeatAt:now};
      const claimed=tx.claimJob(jobId,now,lease);if(!claimed||claimed.status!=="submission_unknown")throw new Error("Another worker owns this job or it is no longer unknown");
      if(!ack.providerRef||ack.honoredInputs.jobId!==jobId)throw new Error("Explicit reconciliation requires the same provider reference and the job's honored-input receipt");
      tx.insertHonoredInputsReceipt(ack.honoredInputs);
      const resolved={...claimed,status:"running" as const,providerRef:ack.providerRef,receiptId:ack.honoredInputs.id,errorCode:null,errorMessage:null,updatedAt:now};
      if(!tx.updateLeasedJob(resolved,leaseToken))throw new Error("Job lease expired before reconciliation commit");
      const outbox:OutboxIntent={id:randomUUID(),jobId,createdAt:now,claimedAt:null,claimToken:null};
      // The unknown job's original outbox row may still exist after a crash.
      // ensureOutbox is insert-if-absent; false means preserve that row and its
      // claim so the same durable intent can be reclaimed after lease expiry.
      tx.ensureOutbox(outbox);
      tx.appendJobEvent(this.event(resolved,"Trusted manual reconciliation persisted the exact provider reference and honored-input receipt; resume polling the same request.",now));
      return resolved;
    });
  }
  beginSubmission(job: ProductionJob, lease: JobLease, admission: SubmissionAdmission): ProductionJob | null {
    return this.store.transaction(tx => {
      // The clock is sampled after SQLite has acquired its immediate write lock.
      const now = this.now();
      const current = tx.getJob(job.id);
      if (!current || current.status !== "queued" || job.status !== "queued" || current.providerRef !== null ||
          current.leaseToken !== lease.leaseToken || current.leaseUntil === null || current.leaseUntil <= now ||
          current.leaseUntil < lease.leaseUntil || lease.jobId !== current.id || current.id !== job.id ||
          current.projectId !== job.projectId || current.idempotencyKey !== job.idempotencyKey ||
          current.requestHash !== job.requestHash || hashCanonicalJson(current.requestSnapshot) !== hashCanonicalJson(job.requestSnapshot) ||
          current.providerId !== job.providerId || current.modelId !== job.modelId || current.quoteId !== job.quoteId ||
          !current.quoteId || !current.providerId || !current.modelId || current.operation !== "anchor" && current.operation !== "take") return null;

      if (admission.outbox.jobId !== current.id || admission.outbox.claimToken !== lease.leaseToken ||
          !tx.heartbeatOutbox(admission.outbox.id, lease.leaseToken, now, current.leaseUntil)) {
        throw new Error("The claimed outbox intent expired before submission admission");
      }
      const quote = tx.getQuote(current.quoteId);
      if (!quote || hashCanonicalJson(quote) !== hashCanonicalJson(admission.quote) || quote.id !== current.quoteId ||
          quote.projectId !== current.projectId || quote.providerId !== current.providerId || quote.modelId !== current.modelId ||
          quote.operation !== current.operation || quote.expiresAt <= now || quote.createdAt > now ||
          quote.entitlement === "unknown" || quote.withinAuthorizedCap !== "yes") throw new Error("The current quote is stale or differs from the prepared admission");

      const capability = admission.capability;
      const operation = current.operation === "anchor" ? "image" : "video";
      const snapshot = ProviderRequestSnapshotSchema.parse(current.requestSnapshot);
      if (capability.providerId !== current.providerId || capability.modelId !== current.modelId || capability.observedAt > now ||
          capability.expiresAt === null || capability.expiresAt <= now || !capability.supportedOperations.includes(operation) ||
          !canSatisfy(capability, requiredConditioning(snapshot), now)) throw new Error("Capability evidence is stale or does not satisfy this job");
      if (snapshot.jobId !== current.id || snapshot.projectId !== current.projectId || snapshot.idempotencyKey !== current.idempotencyKey ||
          snapshot.quoteId !== current.quoteId || snapshot.providerId !== current.providerId || snapshot.modelId !== current.modelId ||
          !validateProductionSnapshotForSubmission(tx, current, quote, snapshot) ||
          productionSubmissionEligibilityFingerprint(tx, current, quote, snapshot) !== admission.eligibilityFingerprint) {
        throw new Error("Submission eligibility changed before the atomic boundary");
      }
      if (tx.listJobEvents(current.id, 0).some(event => event.status === "submitting" || event.status === "submission_unknown") ||
          tx.getReservationByExecution(current.id) || tx.getReservationByIdempotency(current.projectId, current.idempotencyKey)) {
        throw new Error("Submission admission already exists; reconcile before another provider call");
      }

      const budgetQuote = tx.getBudgetQuote(admission.context.budgetQuoteId);
      const binding = budgetQuote && tx.getQuoteAccountBinding(budgetQuote.id);
      const evidence = tx.getAccountEvidence(admission.context.accountEvidenceId);
      if (!budgetQuote || !validateMediaBudgetQuoteCompatibility(quote, budgetQuote, snapshot).allowed) {
        throw new Error("Media and budget quotes do not describe the same provider request");
      }
      if (!budgetQuote || !binding || !evidence || budgetQuote.mediaQuoteId !== quote.id || budgetQuote.projectId !== current.projectId ||
          budgetQuote.providerId !== current.providerId || budgetQuote.modelId !== current.modelId || budgetQuote.operation !== current.operation ||
          budgetQuote.inputHash !== admission.context.expectedQuoteInputHash || budgetQuote.inputHash !== quote.inputHash || budgetQuote.expiresAt <= now || budgetQuote.unit === "unknown" || binding.unit === "unknown" ||
          binding.budgetQuoteId !== budgetQuote.id || binding.accountEvidenceId !== evidence.id ||
          binding.executionSemanticHash !== admission.context.executionSemanticHash ||
          binding.credentialBindingId !== admission.context.credentialBindingId || evidence.credentialBindingId !== admission.context.credentialBindingId ||
          binding.providerId !== current.providerId || binding.accountId !== evidence.accountId || evidence.providerId !== current.providerId ||
          evidence.observedAt > now || evidence.expiresAt <= now || budgetQuote.createdAt > now || binding.quotedAt > now || !snapshot.resultTarget ||
          admission.context.executionSemanticHash !== snapshot.resultTarget.inputsHash ||
          computeProductionInputsHash(tx, current.operation, snapshot) !== admission.context.executionSemanticHash ||
          binding.currency !== budgetQuote.currency || binding.unit !== budgetQuote.unit) throw new Error("Trusted quote and account evidence do not match this execution");

      const policy = tx.getLatestAccountPolicy({providerId:evidence.providerId,accountId:evidence.accountId,currency:binding.currency,unit:binding.unit});
      const authorization = policy && tx.getLatestBudgetAuthorization(current.projectId,policy.policyId);
      if (!policy || !authorization || policy.policyId !== admission.context.policyId || policy.revision !== admission.context.expectedPolicyRevision ||
          authorization.revision !== admission.context.expectedAuthorizationRevision || authorization.policyId !== policy.policyId ||
          policy.revoked || (policy.expiresAt !== null && policy.expiresAt <= now) || policy.dailyCap === null || policy.dailyCap <= 0 ||
          authorization.revoked || (authorization.expiresAt !== null && authorization.expiresAt <= now) ||
          authorization.projectCap === null || authorization.projectCap <= 0 || !authorization.allowedModelIds.includes(current.modelId) ||
          !authorization.allowedOperations.includes(current.operation) || !authorization.entitlementModes.includes(quote.entitlement)) {
        throw new Error("Current account policy or project authorization does not permit this submission");
      }

      const reservation = admission.reserve(tx, current, quote, capability, now, admission.context);
      if (reservation && typeof (reservation as unknown as {then?:unknown}).then === "function") throw new Error("Reservation callback must be synchronous");
      const durable = tx.getReservationByExecution(current.id);
      if (!durable || hashCanonicalJson(durable) !== hashCanonicalJson(reservation) ||
          reservation.execution.kind !== "media_job" || reservation.execution.executionId !== current.id ||
          reservation.execution.operation !== current.operation || reservation.execution.projectId !== current.projectId ||
          reservation.execution.idempotencyKey !== current.idempotencyKey || reservation.execution.requestHash !== current.requestHash ||
          reservation.execution.providerId !== current.providerId || reservation.execution.modelId !== current.modelId ||
          reservation.execution.executionSemanticHash !== admission.context.executionSemanticHash ||
          reservation.budgetQuoteId !== budgetQuote.id || reservation.quoteBindingId !== binding.id ||
          reservation.accountEvidenceId !== evidence.id || reservation.credentialBindingId !== evidence.credentialBindingId ||
          reservation.authorizationRevisionId !== authorization.revisionId || reservation.policyRevisionId !== policy.revisionId ||
          reservation.providerId !== evidence.providerId || reservation.accountId !== evidence.accountId ||
          reservation.currency !== binding.currency || reservation.unit !== binding.unit || reservation.upperEstimate !== budgetQuote.estimateMax ||
          reservation.reservedAt !== now || reservation.utcDay !== new Date(now).toISOString().slice(0,10)) {
        throw new Error("The reservation callback did not persist the exact execution reservation");
      }

      const next = { ...current, status: "submitting" as const, updatedAt: now };
      if (!tx.updateLeasedJob(next, lease.leaseToken)) throw new Error("Job lease changed after budget reservation");
      tx.appendJobEvent({ jobId: current.id, sequence: tx.listJobEvents(current.id, 0).length + 1, at: now,
        status: "submitting", message: "Budget reserved and atomic submission admission committed.", progress: null });
      const refreshed = tx.getJob(current.id);
      if (!refreshed || refreshed.status !== "submitting" || refreshed.leaseToken !== lease.leaseToken) throw new Error("Atomic submission transition did not persist");
      return refreshed;
    });
  }
  complete(job: ProductionJob, lease: JobLease, media: DurableMediaRecord, now = this.now()): boolean {
    return this.store.transaction(tx => {
      const current=tx.getJob(job.id);
      if(!current||current.status!=="persisting"||current.leaseToken!==lease.leaseToken)throw new Error("Job lease or status changed before durable result commit");
      if(!current.receiptId)throw new Error("A durable provider receipt is required before result completion");
      const receipt=tx.getHonoredInputsReceipt(current.receiptId);
      if(!receipt||receipt.jobId!==current.id)throw new Error("The exact provider receipt is missing before result completion");
      const snapshot=ProviderRequestSnapshotSchema.parse(current.requestSnapshot);
      if(snapshot.jobId!==current.id||snapshot.projectId!==current.projectId||!snapshot.resultTarget)throw new Error("A valid immutable result target is required before result completion");
      if(current.operation!=="anchor"&&current.operation!=="take")throw new Error("Only anchor and take jobs can commit generation results");
      if(snapshot.resultTarget.kind!==current.operation)throw new Error("Result target kind does not match the job operation");
      if(!honoredInputsMatch(snapshot,receipt.inputs))throw new Error("The durable provider receipt does not exactly honor the ordered requested input roles and assets");
      if(computeProductionInputsHash(tx,current.operation,snapshot)!==snapshot.resultTarget.inputsHash)throw new Error("Result target inputs hash does not match its immutable pinned inputs");
      const shot=tx.getShotRevision(snapshot.resultTarget.shotRevisionId);
      const story=shot?tx.getStoryRevision(shot.storyRevisionId):null;
      if(!shot||!story||story.projectId!==current.projectId)throw new Error("Result target shot does not belong to the job project");
      tx.insertAsset(media);
      let resultRecord:AnchorCandidate|Take;
      if(snapshot.resultTarget.kind==="anchor"){
        resultRecord=AnchorCandidateSchema.parse({version:1,id:randomUUID(),shotRevisionId:shot.id,assetId:media.asset.id,inputsHash:snapshot.resultTarget.inputsHash,jobId:current.id,visionAssessment:null,receiptId:receipt.id,createdAt:now});
        tx.insertAnchor(resultRecord);
      }else{
        const target=snapshot.resultTarget;
        const anchor=tx.getAnchor(target.anchorId);
        const approval=tx.getApproval(target.anchorApprovalId);
        const pinnedApprovalHash=anchor?computeAnchorApprovalHash(tx,anchor):null;
        if(!anchor||anchor.shotRevisionId!==shot.id||!approval||approval.targetKind!=="anchor"||approval.targetId!==anchor.id||approval.targetHash!==pinnedApprovalHash||approval.decision!=="approved")throw new Error("Take result requires its exact pinned human anchor approval");
        if(!Number.isSafeInteger(media.asset.frames)||media.asset.frames!<=0||!receipt.id)throw new Error("A decoded integral frame count and durable receipt are required for a take result");
        resultRecord=TakeSchema.parse({version:1,id:randomUUID(),shotRevisionId:shot.id,anchorId:anchor.id,approvalId:approval.id,jobId:current.id,assetId:media.asset.id,actualFrames:media.asset.frames,inputsHash:snapshot.resultTarget.inputsHash,receiptId:receipt.id,createdAt:now});
        tx.insertTake(resultRecord);
      }
      const next = { ...current, status: "completed" as const, resultAssetIds: [media.asset.id], resultId: resultRecord.id, errorCode: null, errorMessage: null, updatedAt: now };
      if (!tx.updateLeasedJob(next, lease.leaseToken)) throw new Error("Job lease expired before durable result commit");
      tx.appendJobEvent(this.event(next,"Media bytes and checksum are durable in the local vault.",now)); return true;
    });
  }
  completeCanceled(job:ProductionJob,lease:JobLease,media:DurableMediaRecord,now=this.now()):boolean{
    return this.store.transaction(tx=>{
      const current=tx.getJob(job.id);
      if(!current||current.status!=="cancel_requested"||current.leaseToken!==lease.leaseToken)throw new Error("Job lease or cancellation changed before canceled result archival");
      tx.insertAsset(media);
      const next={...current,status:"canceled" as const,errorCode:null,errorMessage:null,updatedAt:now};
      if(!tx.updateLeasedJob(next,lease.leaseToken))throw new Error("Job lease expired before canceled result archival");
      tx.appendJobEvent(this.event(next,"Provider completed during cancellation; verified media was archived without selecting it as a result.",now));return true;
    });
  }
  finishOutbox(outbox: OutboxIntent, lease: JobLease): boolean {
    const current=this.get(outbox.jobId);
    // Unknown submission outcomes require operator reconciliation. Releasing
    // their intent would hot-loop and could eventually duplicate a paid submit.
    return this.store.transaction(tx=>current&&(TERMINAL.has(current.status)||current.status==="submission_unknown")?tx.acknowledgeOutbox(outbox.id,lease.leaseToken):tx.releaseOutbox(outbox.id,lease.leaseToken));
  }
  private event(job: ProductionJob, message: string, at: number) {
    return { jobId: job.id, sequence: this.store.read.listJobEvents(job.id, 0).length + 1, at, status: job.status, message: message.slice(0, 1000), progress: null };
  }
}

/** Canonical semantic fingerprint shared by C04 worker validation and C06 job creation. */
export function computeProductionInputsHash(read:ProductionReadPort,operation:"anchor"|"take",snapshot:ProviderRequestSnapshot):string{
  const target=snapshot.resultTarget;if(!target||target.kind!==operation)throw new Error("A matching immutable result target is required");
  const shot=read.getShotRevision(target.shotRevisionId);if(!shot)throw new Error("The result target shot revision does not exist");
  const seen=new Set<string>();const canonPins:Array<{revisionId:string;contentHash:string}>=[];
  for(const revisionId of [...shot.castBindings.map(pin=>pin.canonRevisionId),shot.locationRevisionId,...shot.propRevisionIds,shot.styleRevisionId]){
    if(seen.has(revisionId))continue;seen.add(revisionId);const revision=read.getCanonRevision(revisionId);if(!revision)throw new Error(`Pinned canon revision ${revisionId} does not exist`);canonPins.push({revisionId,contentHash:revision.contentHash});
  }
  const references=snapshot.inputs.map(input=>{const asset=read.getAsset(input.assetId);if(!asset)throw new Error(`Pinned input asset ${input.assetId} does not exist`);return{role:input.role,required:input.required,assetSha256:asset.sha256};});
  let anchor:null|{anchorId:string;checksum:string;approvalId:string;approvalTargetHash:string}=null;
  if(target.kind==="take"){
    const candidate=read.getAnchor(target.anchorId);const candidateAsset=candidate?read.getAsset(candidate.assetId):null;const approval=read.getApproval(target.anchorApprovalId);
    if(!candidate||!candidateAsset||candidate.shotRevisionId!==shot.id||!approval||approval.id!==target.anchorApprovalId||approval.targetKind!=="anchor"||approval.targetId!==candidate.id||approval.targetHash!==computeAnchorApprovalHash(read,candidate)||approval.decision!=="approved")throw new Error("The exact approved anchor pin is missing or invalid");
    anchor={anchorId:candidate.id,checksum:candidateAsset.sha256,approvalId:approval.id,approvalTargetHash:approval.targetHash};
  }
  return hashCanonicalJson({recipeVersion:1,operation,shotContentHash:shot.contentHash,canon:canonPins,references,providerId:snapshot.providerId,modelId:snapshot.modelId,prompt:snapshot.prompt,parameters:snapshot.parameters,billingMode:snapshot.billingMode,anchor});
}

export function computeAnchorApprovalHash(read:ProductionReadPort,anchor:{id:string;shotRevisionId:string;inputsHash:string;assetId:string}):string{
  const asset=read.getAsset(anchor.assetId);if(!asset)throw new Error("Approved anchor asset does not exist");
  return hashCanonicalJson({recipeVersion:1,anchorId:anchor.id,shotRevisionId:anchor.shotRevisionId,inputsHash:anchor.inputsHash,assetSha256:asset.sha256});
}

export function validateProductionSnapshotForSubmission(read:ProductionReadPort,job:ProductionJob,quote:{entitlement:string},snapshot:ProviderRequestSnapshot):boolean{
  return productionSubmissionEligibilityFingerprint(read,job,quote,snapshot)!==null;
}
/** Stable server-owned eligibility snapshot for revalidation around async provider work. */
export function productionSubmissionEligibilityFingerprint(read:ProductionReadPort,job:ProductionJob,quote:{entitlement:string},snapshot:ProviderRequestSnapshot):string|null{
  if((job.operation!=="anchor"&&job.operation!=="take")||!snapshot.resultTarget||snapshot.resultTarget.kind!==job.operation)return null;
  const expectedBilling=quote.entitlement==="subscription"?"subscription":quote.entitlement==="spark"?"tokens":null;
  if(!expectedBilling||snapshot.billingMode!==expectedBilling)return null;
  try{
    if(computeProductionInputsHash(read,job.operation,snapshot)!==snapshot.resultTarget.inputsHash)return null;
    const shot=read.getShotRevision(snapshot.resultTarget.shotRevisionId);const origin=shot?read.getStoryRevision(shot.storyRevisionId):null;const project=read.getProject(job.projectId);
    if(!shot||!origin||origin.projectId!==job.projectId||!project?.activeStoryRevisionId||!project.activeShotPlanRevisionId||!project.activeAnimaticRevisionId)return null;
    const activeStory=read.getStoryRevision(project.activeStoryRevisionId);const plan=read.getShotPlanRevision(project.activeShotPlanRevisionId);const animatic=read.getAnimaticRevision(project.activeAnimaticRevisionId);
    if(!activeStory||activeStory.projectId!==project.id||!plan||plan.projectId!==project.id||plan.storyRevisionId!==activeStory.id||!plan.orderedShotRevisionIds.includes(shot.id)||!animatic||animatic.projectId!==project.id||animatic.shotPlanRevisionId!==plan.id||!animatic.slots.some(slot=>slot.shotRevisionId===shot.id))return null;
    const continuationIsValid=validPlanContinuation(read,project.id,plan.orderedShotRevisionIds,shot);if(!continuationIsValid)return null;
    const storyApprovals=latestMatchingApproval(read.listApprovals("story",activeStory.id),"story",activeStory.id,activeStory.contentHash);const animaticApprovals=latestMatchingApproval(read.listApprovals("animatic",animatic.id),"animatic",animatic.id,animatic.contentHash);if(!storyApprovals||!animaticApprovals)return null;
    if(shot.storyRevisionId!==activeStory.id){const lineage=[];let cursor:typeof activeStory|null=activeStory;while(cursor&&lineage.length<=10_000){lineage.push(cursor);cursor=cursor.parentRevisionId?read.getStoryRevision(cursor.parentRevisionId):null;}const canon=project.activeCanonRevisionIds.map(id=>read.getCanonRevision(id)).filter((item):item is NonNullable<typeof item>=>!!item);const {id:_id,contentHash:_hash,createdAt:_created,...candidate}=shot;if(!shotsCompatibleWithStory(shot,origin,activeStory,{projectId:project.id,storyLineage:lineage,selectedCanonRevisions:canon,candidate:{...candidate,storyRevisionId:activeStory.id},continuationIsValid}))return null;}
    const currentCanon=new Set(project.activeCanonRevisionIds);if([...shot.castBindings.map(pin=>pin.canonRevisionId),shot.locationRevisionId,...shot.propRevisionIds,shot.styleRevisionId].some(id=>!currentCanon.has(id)))return null;
    if(!snapshotInputsMatchPinnedShot(read,job,snapshot,shot))return null;
    let anchorApprovalIds:string[]=[];
    if(snapshot.resultTarget.kind==="take"){
      const target=snapshot.resultTarget;const anchor=read.getAnchor(target.anchorId);if(!anchor)return null;const approvals=latestMatchingApproval(read.listApprovals("anchor",target.anchorId),"anchor",target.anchorId,computeAnchorApprovalHash(read,anchor));if(!approvals||!approvals.some(item=>item.id===target.anchorApprovalId))return null;anchorApprovalIds=approvals.map(item=>item.id).sort();
    }
    return hashCanonicalJson({jobId:job.id,operation:job.operation,projectId:project.id,story:{id:activeStory.id,hash:activeStory.contentHash,approvals:storyApprovals.map(item=>item.id).sort()},plan:{id:plan.id,hash:plan.contentHash,storyRevisionId:plan.storyRevisionId,orderedShotRevisionIds:plan.orderedShotRevisionIds},animatic:{id:animatic.id,hash:animatic.contentHash,shotPlanRevisionId:animatic.shotPlanRevisionId,slots:animatic.slots,approvals:animaticApprovals.map(item=>item.id).sort()},shotRevisionId:shot.id,anchorApprovalIds});
  }catch{return null;}
}

function snapshotInputsMatchPinnedShot(read:ProductionReadPort,job:ProductionJob,snapshot:ProviderRequestSnapshot,shot:NonNullable<ReturnType<ProductionReadPort["getShotRevision"]>>):boolean{
    if(job.operation==="take"){
      if(snapshot.resultTarget?.kind!=="take")return false;const anchor=read.getAnchor(snapshot.resultTarget.anchorId);if(!anchor||anchor.shotRevisionId!==shot.id)return false;
      if(snapshot.inputs.filter(input=>input.role==="start_frame").length!==1||snapshot.inputs.filter(input=>input.role==="start_frame"&&input.required&&input.assetId===anchor.assetId).length!==1)return false;
  }
  if(shot.continuation){const endFrames=snapshot.inputs.filter(input=>input.role==="end_frame");if(endFrames.length!==1||!endFrames[0]!.required||endFrames[0]!.assetId!==shot.continuation.endFrameAssetId)return false;}
  return true;
}
function validPlanContinuation(read:ProductionReadPort,projectId:string,orderedShotRevisionIds:string[],shot:NonNullable<ReturnType<ProductionReadPort["getShotRevision"]>>):boolean{
  if(!shot.continuation)return true;const index=orderedShotRevisionIds.indexOf(shot.id);if(index<=0||orderedShotRevisionIds[index-1]!==shot.continuation.previousShotRevisionId)return false;
  const predecessor=read.getShotRevision(shot.continuation.previousShotRevisionId);const predecessorStory=predecessor?read.getStoryRevision(predecessor.storyRevisionId):null;
  return Boolean(predecessor&&predecessorStory?.projectId===projectId&&read.getAsset(shot.continuation.endFrameAssetId));
}
function honoredInputsMatch(snapshot:ProviderRequestSnapshot,inputs:import("../../production/contracts").HonoredInputsReceipt["inputs"]):boolean{
  return inputs.length===snapshot.inputs.length&&snapshot.inputs.every((requested,index)=>{const actual=inputs[index];return !!actual&&actual.role===requested.role&&actual.assetId===requested.assetId&&actual.required===requested.required&&(!requested.required||actual.state==="mapped"||actual.state==="acknowledged");});
}
function requiredConditioning(snapshot:ProviderRequestSnapshot){
  return {startFrame:snapshot.inputs.some(input=>input.required&&input.role==="start_frame"),endFrame:snapshot.inputs.some(input=>input.required&&input.role==="end_frame"),contextImages:snapshot.inputs.filter(input=>input.required&&input.role==="context_image").length};
}
