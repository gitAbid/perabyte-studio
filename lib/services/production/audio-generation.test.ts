import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  audioGenerationRequestSha256,
  createSogniAudioProvider,
  type SogniAudioTransport,
} from "../../providers/production/sogni-audio";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import type { ReviewedPolicyInput, ReviewedQuotePolicyConfig } from "../../production/proof-policy";
import { createAudioGenerationService, type AudioBudgetTotals } from "./audio-generation";

const NOW = 1_700_000_001_000;

const audioPolicyConfig: ReviewedQuotePolicyConfig = {
  schemaVersion: 1,
  providerId: "sogni",
  quoteTtlMs: 60_000,
  accountSessionTtlMs: 60_000,
  executionSessionTtlMs: 60_000,
  billingModeByModel: [{ modelId: "sogni-speech-v1", billingMode: "tokens" }],
  priceByModel: [
    { modelId: "sogni-speech-v1", operations: ["anchor"], entitlement: "spark", unit: "spark_token", currency: null, estimateMinMinor: 100, estimateMaxMinor: 400 },
  ],
};

const reviewedPolicy: ReviewedPolicyInput = {
  reviewVersion: "sogni-pilot-2026-10-04",
  sourceUrl: "https://docs.sogni.ai/pricing/reviewed",
  sourceCapture: "reviewed pricing capture for the pilot",
  sourceCaptureSha256: createHash("sha256").update("reviewed pricing capture for the pilot", "utf8").digest("hex"),
  capturedAt: 1_699_990_000_000,
  expiresAt: 4_000_000_000_000,
  configCanonicalJson: canonicalJson(audioPolicyConfig),
};

const budgetAuthorization = {
  schemaVersion: 1,
  revisionId: "authzrev-1",
  authorizationId: "authz-1",
  revision: 1,
  projectId: "project-1",
  policyId: "account-policy-1",
  policyRevisionIdAtAuthorization: "policyrev-1",
  projectCap: 1_000,
  allowedModelIds: ["sogni-speech-v1"],
  allowedOperations: ["anchor", "take", "speech"],
  entitlementModes: ["spark"],
  expiresAt: null,
  revoked: false,
  actorId: "actor-1",
  createdAt: 1_699_995_000_000,
};

const speechCommand = {
  projectId: "project-1",
  modelId: "sogni-speech-v1",
  kind: "speech" as const,
  text: "Hello from Perabyte Studio.",
};

function service(overrides: {
  reviewedPolicy?: ReviewedPolicyInput | null;
  totals?: AudioBudgetTotals | null;
  withLoader?: boolean;
  authorization?: unknown;
} = {}) {
  const reviewed = overrides.reviewedPolicy === undefined ? reviewedPolicy : overrides.reviewedPolicy;
  const totals = overrides.totals === undefined ? { totalLiability: 0 } : overrides.totals;
  return createAudioGenerationService({
    reviewedPolicy: reviewed,
    ...(overrides.withLoader === false ? {} : {
      loadProjectBudgetTotals: async () => (totals === null ? null : totals),
    }),
    now: () => NOW,
  });
}

const prepare = (overrides: { authorization?: unknown; command?: Record<string, unknown> } = {}) =>
  service().prepareAudioGeneration({
    ...speechCommand,
    ...(overrides.command ?? {}),
    authorization: "authorization" in overrides ? overrides.authorization : budgetAuthorization,
  });

const blockedReason = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(() => null, (value: unknown) => value);
  expect(error).toMatchObject({ code: "BUDGET_BLOCKED", name: "ProductionApplicationError" });
  return (error as { details?: { reason?: string } }).details?.reason ?? "";
};

describe("audio generation service", () => {
  it("blocks speech generation when no reviewed policy is installed (fail-closed BUDGET_BLOCKED)", async () => {
    const reason = await blockedReason(service({ reviewedPolicy: null }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }));
    expect(reason).toBe("POLICY_MISSING");
    const invalidPolicy = await blockedReason(service({ reviewedPolicy: { ...reviewedPolicy, sourceCaptureSha256: "0".repeat(64) } }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }));
    expect(invalidPolicy).toBe("POLICY_MISSING");
  });

  it("blocks when the reviewed policy does not cover the audio model", async () => {
    const reason = await blockedReason(prepare({ command: { modelId: "ace-step-v1-turbo" } }));
    expect(reason).toBe("MODEL_NOT_COVERED");
  });

  it("blocks when the reviewed policy is expired", async () => {
    const reason = await blockedReason(service({ reviewedPolicy: { ...reviewedPolicy, expiresAt: NOW - 1 } }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }));
    expect(reason).toBe("POLICY_EXPIRED");
  });

  it("blocks when the budget authorization is missing, malformed, or for another project", async () => {
    expect(await blockedReason(prepare({ authorization: undefined }))).toBe("AUTHORIZATION_INVALID");
    expect(await blockedReason(prepare({ authorization: { authorizationId: "authz-1" } }))).toBe("AUTHORIZATION_INVALID");
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, projectId: "project-2" } }))).toBe("AUTHORIZATION_PROJECT_MISMATCH");
  });

  it("blocks revoked, not-yet-valid, and expired authorizations", async () => {
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, revoked: true } }))).toBe("AUTHORIZATION_REVOKED");
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, createdAt: NOW + 1 } }))).toBe("AUTHORIZATION_NOT_YET_VALID");
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, expiresAt: NOW - 1 } }))).toBe("AUTHORIZATION_EXPIRED");
  });

  it("blocks when the authorization does not list the audio operation or the model or the entitlement", async () => {
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, allowedOperations: ["anchor", "take"] } }))).toBe("OPERATION_NOT_ALLOWED");
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, allowedModelIds: ["ace-step-v1-turbo"] } }))).toBe("MODEL_NOT_ALLOWED");
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, entitlementModes: ["subscription"] } }))).toBe("ENTITLEMENT_NOT_ALLOWED");
  });

  it("blocks when the cap is unknown or the committed liability plus the estimate exceeds the cap", async () => {
    expect(await blockedReason(prepare({ authorization: { ...budgetAuthorization, projectCap: null } }))).toBe("PROJECT_CAP_UNKNOWN");
    expect(await blockedReason(service({ totals: { totalLiability: 700 } }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }))).toBe("PROJECT_CAP_EXCEEDED");
    const withinCap = await service({ totals: { totalLiability: 600 } }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization });
    expect(withinCap.authorization.withinCap).toBe(true);
  });

  it("blocks when the budget read model totals are unavailable or the estimate is unknown", async () => {
    expect(await blockedReason(service({ withLoader: false }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }))).toBe("PROJECT_TOTALS_UNKNOWN");
    expect(await blockedReason(service({ totals: null }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }))).toBe("PROJECT_TOTALS_UNKNOWN");
    const unknownEstimate: ReviewedQuotePolicyConfig = {
      ...audioPolicyConfig,
      priceByModel: audioPolicyConfig.priceByModel.map((entry) => ({ ...entry, estimateMinMinor: null, estimateMaxMinor: null })),
    };
    const unknownPolicy: ReviewedPolicyInput = { ...reviewedPolicy, configCanonicalJson: canonicalJson(unknownEstimate) };
    const reason = await blockedReason(service({ reviewedPolicy: unknownPolicy }).prepareAudioGeneration({ ...speechCommand, authorization: budgetAuthorization }));
    expect(reason).toBe("ESTIMATE_UNKNOWN");
  });

  it("blocks malformed commands and empty speech text", async () => {
    expect((await prepare({}).then(() => null, (error: { code?: string }) => error))?.code).toBeUndefined();
    await expect(prepare({ command: { kind: "anchor" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(prepare({ command: { text: "   " } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(prepare({ command: { kind: "music" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns a draft authorization proof with hashes plus the exact generation request on the happy path", async () => {
    const prepared = await prepare({});
    expect(prepared.providerId).toBe("sogni");
    expect(prepared.request).toEqual({
      kind: "speech",
      modelId: "sogni-speech-v1",
      text: "Hello from Perabyte Studio.",
      notation: undefined,
      bars: undefined,
      beatsPerBar: undefined,
      tempoBpm: undefined,
      requestedDurationSeconds: undefined,
      outputFormat: "wav",
      sampleRate: 48000,
    });
    expect(prepared.authorization).toMatchObject({
      schemaVersion: 1,
      kind: "audio_spend_authorization",
      providerId: "sogni",
      projectId: "project-1",
      modelId: "sogni-speech-v1",
      operation: "speech",
      billingMode: "tokens",
      estimate: { unit: "spark_token", currency: null, estimateMin: 100, estimateMax: 400, entitlement: "spark" },
      withinCap: true,
      budgetAuthorizationId: "authz-1",
      issuedAt: NOW,
      expiresAt: NOW + audioPolicyConfig.quoteTtlMs,
    });
    expect(prepared.authorization.requestSha256).toBe(audioGenerationRequestSha256(prepared.request));
    expect(prepared.authorization.policySha256).toBe(hashCanonicalJson(audioPolicyConfig));
    expect(prepared.authorization.authorizationSha256).toBe(hashCanonicalJson(budgetAuthorization));
    expect(prepared.coverage.estimatedDurationSecondsMin).toBeGreaterThan(0);
  });

  it("composes with the provider seam: the draft proof authorizes an offline transport submission", async () => {
    const prepared = await prepare({});
    const submissions: unknown[] = [];
    const transport: SogniAudioTransport = {
      sdkVersion: "5.49.0-test",
      configured: true,
      discoverAudioModels: async () => [{ id: "sogni-speech-v1", media: "audio" }],
      submitAudio: async (submission) => {
        submissions.push(submission);
        return { providerRef: "audio-job-9" };
      },
    };
    const provider = createSogniAudioProvider({ transport, policy: audioPolicyConfig, now: () => NOW });
    const result = await provider.generateAudio(prepared.request, prepared.authorization);
    expect(result).toMatchObject({ providerRef: "audio-job-9", modelId: "sogni-speech-v1", kind: "speech" });
    expect(submissions).toHaveLength(1);
  });
});
