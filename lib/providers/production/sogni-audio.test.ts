import { describe, expect, it } from "vitest";
import {
  AudioSpendAuthorizationSchema,
  SOGNI_AUDIO_ADAPTER_VERSION,
  SOGNI_AUDIO_MODEL_KIND_TABLE,
  audioGenerationRequestSha256,
  classifySogniAudioFailure,
  createSogniAudioProvider,
  estimateAudioCoverage,
  validateAudioGenerationRequest,
  type SogniAudioGenerationRequest,
  type SogniAudioTransport,
} from "./sogni-audio";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import type { ReviewedQuotePolicyConfig } from "../../production/proof-policy";

const NOW = 1_700_000_001_000;

const audioPolicy: ReviewedQuotePolicyConfig = {
  schemaVersion: 1,
  providerId: "sogni",
  quoteTtlMs: 60_000,
  accountSessionTtlMs: 60_000,
  executionSessionTtlMs: 60_000,
  billingModeByModel: [
    { modelId: "sogni-speech-v1", billingMode: "tokens" },
    { modelId: "ace-step-v1-turbo", billingMode: "subscription" },
  ],
  priceByModel: [
    { modelId: "sogni-speech-v1", operations: ["anchor"], entitlement: "spark", unit: "spark_token", currency: null, estimateMinMinor: 100, estimateMaxMinor: 400 },
    { modelId: "ace-step-v1-turbo", operations: ["take"], entitlement: "subscription", unit: "minor_currency", currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 40 },
  ],
};

const speechRequest = {
  kind: "speech" as const,
  modelId: "sogni-speech-v1",
  text: "Hello from Perabyte Studio.",
  outputFormat: "wav" as const,
  sampleRate: 48000 as const,
};

const musicRequest = {
  kind: "music" as const,
  modelId: "ace-step-v1-turbo",
  notation: "intro verse chorus",
  bars: 8,
  beatsPerBar: 4,
  tempoBpm: 120,
  outputFormat: "wav" as const,
  sampleRate: 48000 as const,
};

function spendAuthorization(request: SogniAudioGenerationRequest, overrides: Record<string, unknown> = {}) {
  const speech = request.kind === "speech";
  return AudioSpendAuthorizationSchema.parse({
    schemaVersion: 1,
    kind: "audio_spend_authorization",
    providerId: "sogni",
    projectId: "project-1",
    modelId: request.modelId,
    operation: request.kind,
    requestSha256: audioGenerationRequestSha256(request),
    policySha256: hashCanonicalJson(audioPolicy),
    authorizationSha256: "b".repeat(64),
    budgetAuthorizationId: "authz-1",
    billingMode: speech ? "tokens" : "subscription",
    estimate: speech
      ? { unit: "spark_token", currency: null, estimateMin: 100, estimateMax: 400, entitlement: "spark" }
      : { unit: "minor_currency", currency: "USD", estimateMin: 10, estimateMax: 40, entitlement: "subscription" },
    withinCap: true,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    ...overrides,
  });
}

function fakeTransport(overrides: Partial<SogniAudioTransport> = {}) {
  const submissions: unknown[] = [];
  const transport: SogniAudioTransport = {
    sdkVersion: "5.49.0-test",
    configured: true,
    discoverAudioModels: async () => [
      { id: "sogni-speech-v1", media: "audio" },
      { id: "ace-step-v1-turbo", media: "audio" },
      { id: "flux-dev", media: "image" },
    ],
    submitAudio: async (submission) => {
      submissions.push(submission);
      return { providerRef: "audio-job-1" };
    },
  };
  return { transport: { ...transport, ...overrides }, submissions };
}

const budgetBlocked = async (promise: Promise<unknown>, reason?: string) => {
  const error = await promise.then(() => null, (value: unknown) => value);
  expect(error).toBeInstanceOf(ProductionApplicationError);
  const productionError = error as ProductionApplicationError;
  expect(productionError.code).toBe("BUDGET_BLOCKED");
  if (reason) expect(productionError.details).toMatchObject({ reason });
  return productionError;
};

describe("Sogni audio adapter", () => {
  it("blocks generation when no reviewed policy covers the model (fail-closed BUDGET_BLOCKED)", async () => {
    const { transport, submissions } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, now: () => NOW });
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest)), "POLICY_MISSING");
    expect(submissions).toHaveLength(0);
  });

  it("blocks generation when the policy exists but the model is not covered", async () => {
    const { transport } = fakeTransport();
    const uncovered: ReviewedQuotePolicyConfig = {
      ...audioPolicy,
      billingModeByModel: audioPolicy.billingModeByModel.filter((entry) => entry.modelId !== speechRequest.modelId),
      priceByModel: audioPolicy.priceByModel.filter((entry) => entry.modelId !== speechRequest.modelId),
    };
    const provider = createSogniAudioProvider({ transport, policy: uncovered, now: () => NOW });
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest)), "MODEL_NOT_COVERED");
  });

  it("blocks generation without an explicit per-request spend authorization", async () => {
    const { transport } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    await budgetBlocked(provider.generateAudio(speechRequest, undefined), "AUTHORIZATION_MISSING_OR_INVALID");
    await budgetBlocked(provider.generateAudio(speechRequest, { schemaVersion: 1 }), "AUTHORIZATION_MISSING_OR_INVALID");
  });

  it("blocks when the authorization proof does not bind this exact request, policy, model, operation, or billing mode", async () => {
    const { transport } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { requestSha256: "c".repeat(64) })), "PROOF_MISMATCH");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { policySha256: "d".repeat(64) })), "PROOF_MISMATCH");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { modelId: "ace-step-v1-turbo", operation: "music", billingMode: "subscription" })), "PROOF_MISMATCH");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { operation: "music" })), "PROOF_MISMATCH");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { billingMode: "subscription" })), "PROOF_MISMATCH");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { expiresAt: NOW - 1 })), "PROOF_EXPIRED");
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest, { issuedAt: NOW + 1 })), "PROOF_NOT_YET_VALID");
  });

  it("blocks generation when the transport is not configured", async () => {
    const { transport } = fakeTransport({ configured: false });
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    await budgetBlocked(provider.generateAudio(speechRequest, spendAuthorization(speechRequest)), "TRANSPORT_UNAVAILABLE");
  });

  it("submits the contract request shape and returns a frozen stamped result on the happy path", async () => {
    const { transport, submissions } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    const result = await provider.generateAudio(speechRequest, spendAuthorization(speechRequest));
    expect(submissions).toEqual([
      {
        modelId: "sogni-speech-v1",
        kind: "speech",
        billingMode: "tokens",
        text: "Hello from Perabyte Studio.",
        notation: undefined,
        bars: undefined,
        beatsPerBar: undefined,
        tempoBpm: undefined,
        requestedDurationSeconds: undefined,
        outputFormat: "wav",
        sampleRate: 48000,
      },
    ]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      providerId: "sogni",
      adapterVersion: SOGNI_AUDIO_ADAPTER_VERSION,
      sdkVersion: "5.49.0-test",
      modelId: "sogni-speech-v1",
      kind: "speech",
      providerRef: "audio-job-1",
      outputFormat: "wav",
      sampleRate: 48000,
      billingMode: "tokens",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("submits music notation with bar/beat timing against a music-covered model", async () => {
    const { transport, submissions } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    const result = await provider.generateAudio(musicRequest, spendAuthorization(musicRequest));
    expect(submissions[0]).toMatchObject({ modelId: "ace-step-v1-turbo", kind: "music", billingMode: "subscription", bars: 8, beatsPerBar: 4, tempoBpm: 120, notation: "intro verse chorus", outputFormat: "wav", sampleRate: 48000 });
    expect(result).toMatchObject({ kind: "music", providerRef: "audio-job-1" });
  });

  it("classifies retryable transport failures as retryable and terminal ones as not", async () => {
    const capturedError = async (promise: Promise<unknown>): Promise<ProductionApplicationError> => {
      const error = await promise.then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(ProductionApplicationError);
      return error as ProductionApplicationError;
    };
    const retryable = createSogniAudioProvider({ transport: fakeTransport({ submitAudio: async () => { throw new Error("upstream timeout after 30s"); } }).transport, policy: audioPolicy, now: () => NOW });
    const failure = await capturedError(retryable.generateAudio(speechRequest, spendAuthorization(speechRequest)));
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("MEDIA_UNAVAILABLE");
    const terminal = createSogniAudioProvider({ transport: fakeTransport({ submitAudio: async () => { throw new Error("model rejected the request: unsupported parameter"); } }).transport, policy: audioPolicy, now: () => NOW });
    const terminalFailure = await capturedError(terminal.generateAudio(speechRequest, spendAuthorization(speechRequest)));
    expect(terminalFailure.retryable).toBe(false);
    const ambiguous = createSogniAudioProvider({ transport: fakeTransport({ submitAudio: async () => { throw new Error("connection dropped mid-flight"); } }).transport, policy: audioPolicy, now: () => NOW });
    const ambiguousFailure = await capturedError(ambiguous.generateAudio(speechRequest, spendAuthorization(speechRequest)));
    expect(ambiguousFailure.code).toBe("SUBMISSION_UNKNOWN");
    expect(ambiguousFailure.retryable).toBe(false);
    const passthrough = createSogniAudioProvider({ transport: fakeTransport({ submitAudio: async () => { throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "already typed"); } }).transport, policy: audioPolicy, now: () => NOW });
    await expect(passthrough.generateAudio(speechRequest, spendAuthorization(speechRequest))).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: false });
  });

  it("maps failure classes deterministically from error text", () => {
    expect(classifySogniAudioFailure(new Error("request timed out"))).toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: true });
    expect(classifySogniAudioFailure(new Error("HTTP 429 rate limited"))).toMatchObject({ retryable: true });
    expect(classifySogniAudioFailure(new Error("socket ECONNRESET"))).toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
    expect(classifySogniAudioFailure(new Error("HTTP 503 temporarily unavailable"))).toMatchObject({ retryable: true });
    expect(classifySogniAudioFailure(new Error("HTTP 400 bad request"))).toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: false });
    expect(classifySogniAudioFailure(new Error("endpoint not supported for this model"))).toMatchObject({ retryable: false });
    expect(classifySogniAudioFailure(new Error("connection dropped mid-flight"))).toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
  });

  it("never marks mid-submit transport failures retryable (C18 review follow-up)", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET", cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    expect(classifySogniAudioFailure(fetchFailed)).toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
    const timedOut = Object.assign(new Error("request aborted while reading headers"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    expect(classifySogniAudioFailure(timedOut)).toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
    const etimedout = Object.assign(new Error("submit request failed"), { code: "ETIMEDOUT" });
    expect(classifySogniAudioFailure(etimedout)).toMatchObject({ code: "SUBMISSION_UNKNOWN", retryable: false });
  });

  it("discovers speech and music capabilities only from the declared fixture table and never infers kinds", async () => {
    const { transport } = fakeTransport();
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    const speech = await provider.discoverAudioCapabilities("speech");
    expect(speech).toMatchObject({ schemaVersion: 1, providerId: "sogni", kind: "speech", provenance: "declared_fixture", sdkVersion: "5.49.0-test" });
    expect(speech.models).toEqual([
      { modelId: "sogni-speech-v1", kind: "speech", languages: ["en"], voiceMode: "per_request_clone", persistentVoiceTraining: false },
    ]);
    const music = await provider.discoverAudioCapabilities("music");
    expect(music.models).toEqual([
      { modelId: "ace-step-v1-turbo", kind: "music", languages: [], voiceMode: "text_to_music", persistentVoiceTraining: false },
    ]);
    expect(Object.isFrozen(speech)).toBe(true);
    expect(Object.isFrozen(speech.models[0])).toBe(true);
    expect(SOGNI_AUDIO_MODEL_KIND_TABLE["flux-dev" as keyof typeof SOGNI_AUDIO_MODEL_KIND_TABLE]).toBeUndefined();
  });

  it("returns an empty declared capability list when the transport is unconfigured", async () => {
    const { transport } = fakeTransport({ configured: false });
    const provider = createSogniAudioProvider({ transport, policy: audioPolicy, now: () => NOW });
    const speech = await provider.discoverAudioCapabilities("speech");
    expect(speech.models).toEqual([]);
  });

  it("estimates speech duration from character bounds and blocks empty text", () => {
    expect(() => validateAudioGenerationRequest({ ...speechRequest, text: "   " })).toThrow(ProductionApplicationError);
    expect(() => estimateAudioCoverage({ ...speechRequest, text: "" })).toThrow(ProductionApplicationError);
    const coverage = estimateAudioCoverage({ ...speechRequest, text: "ab".repeat(5_000) });
    expect(coverage.kind).toBe("speech");
    expect(coverage.estimatedDurationSecondsMin).toBeLessThanOrEqual(coverage.estimatedDurationSecondsMax);
    expect(Number.isFinite(coverage.estimatedDurationSecondsMin)).toBe(true);
    expect(Number.isFinite(coverage.estimatedDurationSecondsMax)).toBe(true);
    expect(coverage.estimatedDurationSecondsMax).toBeLessThanOrEqual((10_000 / 11) + 1);
    expect(coverage.estimatedDurationSecondsMin).toBeGreaterThanOrEqual(10_000 / 17 - 1);
    const short = estimateAudioCoverage(speechRequest);
    expect(short.estimatedDurationSecondsMin).toBeGreaterThan(0);
  });

  it("computes music duration exactly from bars, beats per bar, and tempo", () => {
    const coverage = estimateAudioCoverage(musicRequest);
    expect(coverage.estimatedDurationSecondsMin).toBe(16);
    expect(coverage.estimatedDurationSecondsMax).toBe(16);
    expect(coverage.coverageSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
