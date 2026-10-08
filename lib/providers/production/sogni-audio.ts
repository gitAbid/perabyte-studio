import { z } from "zod";
import { BudgetUnitSchema, BudgetUtcMillisSchema, CurrencyCodeSchema, EntitlementSchema, IdSchema, SafeAmountSchema, SchemaVersionSchema, Sha256Schema } from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import { ReviewedQuotePolicyConfigSchema, type ReviewedQuotePolicyConfig } from "../../production/proof-policy";
import { isUncertainSubmissionError } from "./submission-errors";

// C16-AUDIO-ADAPTER (contract-first, offline): Sogni speech/music generation is not a verified
// Sogni SDK surface today. This adapter therefore owns an injected transport seam only; the later
// amendment wires the real SDK endpoint (or a vetted HTTP surface) into SogniAudioTransport. It is
// a seam for callers, not a route dependency: nothing here may be wired into routes or pages.
export type SogniAudioKind="speech"|"music";
export interface SogniAudioCatalogModel { id:string; media?:string }
export interface SogniAudioSdkSubmission { modelId:string; kind:SogniAudioKind; billingMode:"subscription"|"tokens"; text?:string; notation?:string; bars?:number; beatsPerBar?:number; tempoBpm?:number; requestedDurationSeconds?:number; outputFormat:"wav"; sampleRate:48000 }
export interface SogniAudioTransport {
  readonly sdkVersion:string; readonly configured:boolean;
  discoverAudioModels():Promise<SogniAudioCatalogModel[]>;
  submitAudio(request:SogniAudioSdkSubmission):Promise<{providerRef:string}>;
}
export const SOGNI_AUDIO_ADAPTER_VERSION="sogni-production-audio-v1";
export const SogniAudioKindSchema=z.enum(["speech","music"]);
export const SogniAudioGenerationRequestSchema=z.strictObject({
  kind:SogniAudioKindSchema, modelId:IdSchema,
  text:z.string().max(20_000).optional(), notation:z.string().max(20_000).optional(),
  bars:z.number().int().safe().min(1).max(64).optional(), beatsPerBar:z.number().int().safe().min(1).max(12).optional(), tempoBpm:z.number().int().safe().min(20).max(300).optional(),
  requestedDurationSeconds:z.number().safe().positive().max(3_600).optional(),
  outputFormat:z.literal("wav"), sampleRate:z.literal(48000),
});
export type SogniAudioGenerationRequest=Readonly<z.infer<typeof SogniAudioGenerationRequestSchema>>;

// Declared fixture table, not a live claim: only these model IDs map to an audio kind, and kinds
// are never inferred from an undeclared discovery entry. The amendment owns the live mapping.
// Per-request voice cloning only: this adapter neither claims nor performs persistent voice
// training, and no voiceprint or speaker embedding survives a completed request.
export const SOGNI_AUDIO_MODEL_KIND_TABLE={
  "sogni-speech-v1":{kind:"speech",languages:["en"],voiceMode:"per_request_clone"},
  "ace-step-v1-turbo":{kind:"music",languages:[],voiceMode:"text_to_music"},
} as const satisfies Readonly<Record<string,{readonly kind:SogniAudioKind;readonly languages:readonly string[];readonly voiceMode:string}>>;

export interface DiscoveredAudioCapability { readonly modelId:string; readonly kind:SogniAudioKind; readonly languages:string[]; readonly voiceMode:string; readonly persistentVoiceTraining:false }
export interface AudioCapabilityReceipt { readonly schemaVersion:1; readonly providerId:"sogni"; readonly kind:SogniAudioKind; readonly provenance:"declared_fixture"; readonly sdkVersion:string; readonly observedAt:number; readonly models:readonly DiscoveredAudioCapability[] }

// Deterministic declared estimation envelope (characters/second for speech); it is a planning
// bound, not a measured provider guarantee. min duration uses the fastest rate, max the slowest.
const SPEECH_MIN_CHARS_PER_SECOND=11;
const SPEECH_MAX_CHARS_PER_SECOND=17;
const round1=(value:number)=>Math.round(value*10)/10;
export interface AudioCoverageReceipt { readonly schemaVersion:1; readonly kind:SogniAudioKind; readonly modelId:string; readonly inputCharacterCount:number|null; readonly bars:number|null; readonly beatsPerBar:number|null; readonly tempoBpm:number|null; readonly estimatedDurationSecondsMin:number; readonly estimatedDurationSecondsMax:number; readonly coverageSha256:string }

function invalidInput(message:string,reason:string):never { throw new ProductionApplicationError("INVALID_INPUT",message,{details:{reason}}); }
export function validateAudioGenerationRequest(request:unknown):SogniAudioGenerationRequest {
  const parsed=SogniAudioGenerationRequestSchema.safeParse(request);
  if(!parsed.success)invalidInput("The audio generation request is invalid.","REQUEST_INVALID");
  const value=parsed.data;
  if(value.kind==="speech"){
    if(typeof value.text!=="string"||value.text.trim().length===0)invalidInput("Speech generation requires non-empty text.","TEXT_REQUIRED");
    if(value.notation!==undefined||value.bars!==undefined||value.beatsPerBar!==undefined||value.tempoBpm!==undefined)invalidInput("Music-only fields are not allowed on a speech request.","CROSS_KIND_FIELDS");
  } else {
    if(value.bars===undefined||value.beatsPerBar===undefined||value.tempoBpm===undefined)invalidInput("Music generation requires bars, beatsPerBar, and tempoBpm.","MUSIC_TIMING_REQUIRED");
    if(value.text!==undefined)invalidInput("Speech-only fields are not allowed on a music request.","CROSS_KIND_FIELDS");
  }
  return value;
}
export function audioGenerationRequestSha256(request:unknown):string { return hashCanonicalJson(validateAudioGenerationRequest(request)); }
export function estimateAudioCoverage(request:unknown):AudioCoverageReceipt {
  const value=validateAudioGenerationRequest(request);
  const speech=value.kind==="speech";
  const inputCharacterCount=speech?value.text!.length:null;
  const estimatedDurationSecondsMin=speech?round1(value.text!.length/SPEECH_MAX_CHARS_PER_SECOND):round1(value.bars!*value.beatsPerBar!*60/value.tempoBpm!);
  const estimatedDurationSecondsMax=speech?round1(value.text!.length/SPEECH_MIN_CHARS_PER_SECOND):round1(value.bars!*value.beatsPerBar!*60/value.tempoBpm!);
  const receipt:AudioCoverageReceipt={schemaVersion:1,kind:value.kind,modelId:value.modelId,inputCharacterCount,bars:speech?null:value.bars!,beatsPerBar:speech?null:value.beatsPerBar!,tempoBpm:speech?null:value.tempoBpm!,estimatedDurationSecondsMin,estimatedDurationSecondsMax,coverageSha256:""};
  return Object.freeze({...receipt,coverageSha256:hashCanonicalJson(receipt)});
}

export interface ClassifiedSogniAudioFailure { readonly code:"MEDIA_UNAVAILABLE"|"SUBMISSION_UNKNOWN"; readonly retryable:boolean; readonly action:string; readonly message:string }
const TERMINAL_FAILURE_PATTERN=/(?:unsupported|not ?supported|invalid|rejected|denied|unauthorized|forbidden|malformed|400|401|403|404|409|422)/i;
const AMBIGUOUS_FAILURE_PATTERN=/(?:dropped|disconnect(?:ed)?|mid-?flight|ambiguous|unknown state)/i;
const RETRYABLE_FAILURE_PATTERN=/(?:timed? ?out|timeout|temporar|rate.?limit|429|5\d\d|enotfound|eai_again|retry)/i;
// Terminal failures can be retried only after reauthorization; ambiguous failures may have landed
// a provider job, so blind retries risk double spend and stay non-retryable by design. Connection
// drops and transport timeouts during submit are uncertain by the same rule as the job engine: the
// request may have been accepted, so they classify SUBMISSION_UNKNOWN and are never retryable.
export function classifySogniAudioFailure(error:unknown):ClassifiedSogniAudioFailure {
  const message=error instanceof Error?error.message:String(error);
  if(TERMINAL_FAILURE_PATTERN.test(message))return{code:"MEDIA_UNAVAILABLE",retryable:false,action:"Revise the audio request before requesting a new authorization.",message};
  if(isUncertainSubmissionError(error))return{code:"SUBMISSION_UNKNOWN",retryable:false,action:"Verify the provider reference before any resubmission.",message};
  if(AMBIGUOUS_FAILURE_PATTERN.test(message))return{code:"SUBMISSION_UNKNOWN",retryable:false,action:"Verify the provider reference before any resubmission.",message};
  if(RETRYABLE_FAILURE_PATTERN.test(message))return{code:"MEDIA_UNAVAILABLE",retryable:true,action:"Retry the same authorized request.",message};
  return{code:"SUBMISSION_UNKNOWN",retryable:false,action:"Verify the provider reference before any resubmission.",message};
}

// Draft per-request spend authorization issued by the audio-generation service and validated here
// fail-closed before any transport submission. Absent or mismatched proof always means BUDGET_BLOCKED.
export const AudioSpendAuthorizationSchema=z.strictObject({
  schemaVersion:SchemaVersionSchema, kind:z.literal("audio_spend_authorization"), providerId:z.literal("sogni"),
  projectId:IdSchema, modelId:IdSchema, operation:SogniAudioKindSchema,
  requestSha256:Sha256Schema, policySha256:Sha256Schema, authorizationSha256:Sha256Schema, budgetAuthorizationId:IdSchema,
  billingMode:z.enum(["subscription","tokens"]),
  estimate:z.strictObject({unit:BudgetUnitSchema,currency:CurrencyCodeSchema.nullable(),estimateMin:SafeAmountSchema.nullable(),estimateMax:SafeAmountSchema.nullable(),entitlement:EntitlementSchema}),
  withinCap:z.literal(true),
  issuedAt:BudgetUtcMillisSchema, expiresAt:BudgetUtcMillisSchema,
}).refine(value=>value.expiresAt>value.issuedAt,{path:["expiresAt"],message:"Authorization proof must expire after issuance"});
export type AudioSpendAuthorization=Readonly<z.infer<typeof AudioSpendAuthorizationSchema>>;

export interface SogniAudioGenerationResult { readonly schemaVersion:1; readonly providerId:"sogni"; readonly adapterVersion:string; readonly sdkVersion:string; readonly modelId:string; readonly kind:SogniAudioKind; readonly providerRef:string; readonly outputFormat:"wav"; readonly sampleRate:48000; readonly billingMode:"subscription"|"tokens"; readonly coverage:AudioCoverageReceipt; readonly submittedAt:number }
export interface SogniAudioProvider {
  readonly providerId:"sogni"; readonly adapterVersion:string;
  discoverAudioCapabilities(kind:SogniAudioKind):Promise<AudioCapabilityReceipt>;
  generateAudio(request:unknown,authorization:unknown):Promise<SogniAudioGenerationResult>;
}
export interface SogniAudioProviderOptions { transport:SogniAudioTransport; policy?:ReviewedQuotePolicyConfig|null; now?:()=>number }
function budgetBlocked(reason:string,message:string):never { throw new ProductionApplicationError("BUDGET_BLOCKED",message,{details:{reason}}); }

export function createSogniAudioProvider(options:SogniAudioProviderOptions):SogniAudioProvider {
  const now=options.now??Date.now,transport=options.transport;
  return {
    providerId:"sogni" as const, adapterVersion:SOGNI_AUDIO_ADAPTER_VERSION,
    async discoverAudioCapabilities(kind):Promise<AudioCapabilityReceipt> {
      if(kind!=="speech"&&kind!=="music")invalidInput("Audio capability discovery requires the speech or music kind.","KIND_INVALID");
      let discovered:SogniAudioCatalogModel[]=[];
      if(transport.configured){
        try{discovered=await transport.discoverAudioModels();}
        catch(error){
          if(error instanceof ProductionApplicationError)throw error;
          const classified=classifySogniAudioFailure(error);
          throw new ProductionApplicationError(classified.code,classified.message,{retryable:classified.retryable,action:classified.action,details:{reason:"DISCOVERY_FAILED"}});
        }
      }
      const table=SOGNI_AUDIO_MODEL_KIND_TABLE as Readonly<Record<string,{readonly kind:SogniAudioKind;readonly languages:readonly string[];readonly voiceMode:string}>>;
      const models=discovered.filter(model=>table[model.id]?.kind===kind).map(model=>{
        const entry=table[model.id]!;
        return Object.freeze({modelId:model.id,kind:entry.kind,languages:[...entry.languages],voiceMode:entry.voiceMode,persistentVoiceTraining:false as const});
      });
      return Object.freeze({schemaVersion:1 as const,providerId:"sogni" as const,kind,provenance:"declared_fixture" as const,sdkVersion:transport.sdkVersion,observedAt:now(),models:Object.freeze(models)});
    },
    async generateAudio(request,authorization):Promise<SogniAudioGenerationResult> {
      const value=validateAudioGenerationRequest(request);
      const authParsed=AudioSpendAuthorizationSchema.safeParse(authorization);
      if(!authParsed.success)budgetBlocked("AUTHORIZATION_MISSING_OR_INVALID","An explicit per-request audio spend authorization is required; generation never infers one.");
      const authorizationProof=authParsed.data;
      const policyParsed=ReviewedQuotePolicyConfigSchema.safeParse(options.policy);
      if(!policyParsed.success)budgetBlocked("POLICY_MISSING","No reviewed policy covers audio generation; pricing stays blocked.");
      const policy:ReviewedQuotePolicyConfig=policyParsed.data;
      const billing=policy.billingModeByModel.find(entry=>entry.modelId===value.modelId);
      const price=policy.priceByModel.find(entry=>entry.modelId===value.modelId);
      if(!billing||!price)budgetBlocked("MODEL_NOT_COVERED","The reviewed policy has no billing mode or price envelope for this audio model.");
      // ReviewedQuotePolicyConfigSchema admits only "anchor"/"take" in priceByModel.operations today,
      // so audio coverage cannot be read from an operations list. The gate keys on the MODEL being
      // present in the policy (billing mode + price envelope) while the audio operation itself must
      // be explicitly named by the per-request authorization. Anchor/take coverage is never inferred
      // to cover speech or music.
      if(authorizationProof.modelId!==value.modelId||authorizationProof.operation!==value.kind||authorizationProof.billingMode!==billing.billingMode)budgetBlocked("PROOF_MISMATCH","The authorization proof does not bind this model, operation, and billing mode.");
      if(authorizationProof.requestSha256!==audioGenerationRequestSha256(value)||authorizationProof.policySha256!==hashCanonicalJson(policy))budgetBlocked("PROOF_MISMATCH","The authorization proof does not bind this exact request and reviewed policy.");
      const at=now();
      if(authorizationProof.issuedAt>at)budgetBlocked("PROOF_NOT_YET_VALID","The authorization proof is not yet valid.");
      if(authorizationProof.expiresAt<=at)budgetBlocked("PROOF_EXPIRED","The authorization proof has expired; request a new one.");
      if(!transport.configured)budgetBlocked("TRANSPORT_UNAVAILABLE","The Sogni audio transport is not configured.");
      const coverage=estimateAudioCoverage(value);
      const submission:SogniAudioSdkSubmission={modelId:value.modelId,kind:value.kind,billingMode:billing.billingMode,text:value.text,notation:value.notation,bars:value.bars,beatsPerBar:value.beatsPerBar,tempoBpm:value.tempoBpm,requestedDurationSeconds:value.requestedDurationSeconds,outputFormat:value.outputFormat,sampleRate:value.sampleRate};
      try {
        const ack=await transport.submitAudio(submission);
        if(!ack||typeof ack.providerRef!=="string"||ack.providerRef.length===0)throw new ProductionApplicationError("SUBMISSION_UNKNOWN","The audio transport returned no durable provider reference.",{details:{reason:"PROVIDER_REFERENCE_MISSING"}});
        return Object.freeze({schemaVersion:1 as const,providerId:"sogni" as const,adapterVersion:SOGNI_AUDIO_ADAPTER_VERSION,sdkVersion:transport.sdkVersion,modelId:value.modelId,kind:value.kind,providerRef:ack.providerRef,outputFormat:value.outputFormat,sampleRate:value.sampleRate,billingMode:billing.billingMode,coverage,submittedAt:at});
      } catch(error) {
        if(error instanceof ProductionApplicationError)throw error;
        const classified=classifySogniAudioFailure(error);
        throw new ProductionApplicationError(classified.code,classified.message,{retryable:classified.retryable,action:classified.action,details:{reason:"TRANSPORT_FAILURE"}});
      }
    },
  };
}
