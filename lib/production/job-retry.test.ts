import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdSchema } from "./contracts";
import { changeSomethingCommand, differentTakeCommand, tryAgainCommand } from "./job-retry";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");

// Fixture carries every current ProductionJob field plus the frozen C9 additive fields, so the
// object stays structurally assignable whether or not the implementation has widened JobSchema yet.
const rawJob = {
  version: 1 as const,
  id: "job-take-1",
  projectId: "project-1",
  operation: "take" as const,
  status: "failed" as const,
  idempotencyKey: "idem-take-1",
  requestSnapshot: {
    shotRevisionId: "shot-rev-1",
    prompt: "Luna steps closer to the window, nervous",
    randomness: { seed: 4242 },
    referenceIds: ["charrev-luna-3", "envrev-cafe-1"],
  },
  requestHash: sha("job-take-1-request"),
  providerId: "provider-1",
  modelId: "model-1",
  providerRef: null,
  quoteId: null,
  receiptId: null,
  resultId: null,
  resultAssetIds: [] as string[],
  leaseToken: null,
  leaseUntil: null,
  heartbeatAt: null,
  attempt: 0,
  errorCode: null,
  errorMessage: "provider returned 503",
  createdAt: 1_000,
  updatedAt: 2_000,
  scope: null,
  retryOf: null,
  resolvedReferenceIds: ["charrev-luna-3", "envrev-cafe-1"],
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const job = deepFreeze(rawJob);
const seed = 90210;
const delta = { kind: "take" as const, directionNote: "Hold on her face one beat longer" };

function expectRetryIdentity(command: { id: string; retryOf: unknown }, source: { id: string }): void {
  expect(IdSchema.safeParse(command.id).success).toBe(true);
  expect(command.id).not.toBe(source.id);
  expect(command.retryOf).toBe(source.id);
}

describe("C9 job retry derivations", () => {
  it("tryAgainCommand reuses the identical requestSnapshot under a new id linked to the source job", () => {
    const retry = tryAgainCommand(job);
    expect(retry.requestSnapshot).toEqual(rawJob.requestSnapshot);
    expectRetryIdentity(retry, rawJob);
  });

  it("tryAgainCommand derives a fresh -retry-<n> idempotency key from the source key", () => {
    const retry = tryAgainCommand(job);
    const key = String(retry.idempotencyKey);
    expect(key.startsWith(rawJob.idempotencyKey)).toBe(true);
    expect(key.slice(rawJob.idempotencyKey.length)).toMatch(/^-retry-\d+$/);
    expect(IdSchema.safeParse(key).success).toBe(true);
  });

  it("differentTakeCommand replaces only randomness.seed and leaves the rest of the snapshot intact", () => {
    const retry = differentTakeCommand(job, seed);
    const expectedSnapshot = structuredClone(rawJob.requestSnapshot);
    expectedSnapshot.randomness = { ...expectedSnapshot.randomness, seed };
    expect(retry.requestSnapshot).toEqual(expectedSnapshot);
    expectRetryIdentity(retry, rawJob);
  });

  it("differentTakeCommand issues a fresh idempotency key and is deterministic for the same seed", () => {
    const first = differentTakeCommand(job, seed);
    const second = differentTakeCommand(job, seed);
    expect(first.idempotencyKey).not.toBe(rawJob.idempotencyKey);
    expect(first.requestSnapshot).toEqual(second.requestSnapshot);
  });

  it("changeSomethingCommand applies the delta on a copy and never touches the source job", () => {
    const before = structuredClone(rawJob.requestSnapshot);
    const retry = changeSomethingCommand(job, delta);
    const expectedSnapshot = { ...structuredClone(rawJob.requestSnapshot), directionNote: "Hold on her face one beat longer" };
    expect(retry.requestSnapshot).toEqual(expectedSnapshot);
    expect(retry.requestSnapshot).not.toBe(rawJob.requestSnapshot);
    expect(rawJob.requestSnapshot).toEqual(before);
    expectRetryIdentity(retry, rawJob);
  });

  it("every derivation leaves the source job untouched", () => {
    const before = structuredClone(rawJob);
    tryAgainCommand(job);
    differentTakeCommand(job, seed);
    changeSomethingCommand(job, delta);
    expect(rawJob).toEqual(before);
  });
});
