import { z } from "zod";
import { BudgetUtcMillisSchema, IdSchema, Sha256Schema } from "../../production/contracts";
import { ProviderAccountSessionPayloadSchema, ProviderSessionSchema, type ProviderProofPayload, type ProviderSession } from "../../production/provider-proof";
import type { ProviderPort, ProviderRequestSnapshot } from "../../repositories/production/ports";

const VersionTextSchema=z.string().min(1).max(80);
export const SogniProofMetadataSchema=z.strictObject({sdkVersion:VersionTextSchema,sdkSourceHash:Sha256Schema,adapterVersion:VersionTextSchema});
export type SogniProofMetadata=Readonly<z.infer<typeof SogniProofMetadataSchema>>;

export const CapturedProviderSessionSchema=z.strictObject({session:ProviderSessionSchema,credentialFingerprint:Sha256Schema,accountId:IdSchema.nullable()});
export type CapturedProviderSession=Readonly<{session:ProviderSession;credentialFingerprint:string;accountId:string|null}>;
export const AuthenticatedProviderSessionSchema=z.strictObject({session:ProviderSessionSchema,credentialFingerprint:Sha256Schema,accountId:IdSchema});
export type AuthenticatedProviderSession=Readonly<{session:ProviderSession;credentialFingerprint:string;accountId:string}>;
export type SubscriptionObservation=Extract<ProviderProofPayload,{kind:"account_session"}>["subscription"];
export const ProviderAccountObservationSchema=z.strictObject({
  providerId:IdSchema,
  captured:z.strictObject({session:ProviderSessionSchema,credentialFingerprint:Sha256Schema,accountId:IdSchema}),
  subscription:ProviderAccountSessionPayloadSchema.shape.subscription,
  observedAt:BudgetUtcMillisSchema,
});
export type ProviderAccountObservation=Readonly<{providerId:string;captured:AuthenticatedProviderSession;subscription:SubscriptionObservation;observedAt:number}>;
export type SubmissionProofResolver=(snapshot:Readonly<ProviderRequestSnapshot>,captured:AuthenticatedProviderSession,at:number)=>boolean;
export interface ProductionProofProvider extends ProviderPort {
  observeAccount():Promise<ProviderAccountObservation>;
  currentSession():CapturedProviderSession|null;
}
