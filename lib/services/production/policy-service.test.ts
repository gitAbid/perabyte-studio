import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logging/logger";
import { canonicalJson } from "../../production/hash";
import { getInstalledPolicy, installReviewedPolicy, removeReviewedPolicy } from "./policy-service";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CAPTURE = "Fixture reviewed policy capture for the policy service tests.";

function fixtureConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    providerId: "sogni",
    quoteTtlMs: 30_000,
    accountSessionTtlMs: 60_000,
    executionSessionTtlMs: 60_000,
    billingModeByModel: [{ modelId: "image-model", billingMode: "subscription" }],
    priceByModel: [{ modelId: "image-model", operations: ["anchor", "take"], entitlement: "subscription", unit: "minor_currency", currency: "USD", estimateMinMinor: 10, estimateMaxMinor: 25 }],
    ...overrides,
  };
}

function installCommand(overrides: Record<string, unknown> = {}, configOverride: Record<string, unknown> = {}) {
  const config = fixtureConfig(configOverride);
  return {
    providerId: "sogni",
    reviewVersion: "review-1",
    sourceUrl: "https://policy.fixture.example/sogni-pricing-v1",
    sourceCapture: CAPTURE,
    sourceCaptureSha256: sha256(CAPTURE),
    capturedAt: 0,
    expiresAt: 10_000_000_000,
    configCanonicalJson: canonicalJson(config),
    ...overrides,
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "perabyte-policy-service-"));
  dirs.push(dataDir);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), timer: vi.fn() } as unknown as Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  return { dataDir, log, options: { dataDir, log } };
}

describe("reviewed policy service", () => {
  it("reads not-configured when no policy is installed", async () => {
    const { options } = fixture();
    await expect(getInstalledPolicy(options)).resolves.toEqual({ configured: false, policy: null });
  });

  it("installs, reads back the exact projected input, and leaves no temp files", async () => {
    const { dataDir, options } = fixture();
    const command = installCommand();
    const view = await installReviewedPolicy(command, options);
    expect(view.configured).toBe(true);
    expect(view.policy).toMatchObject({ providerId: "sogni", reviewVersion: "review-1", configCanonicalJson: command.configCanonicalJson, sourceCaptureSha256: command.sourceCaptureSha256, capturedAt: 0, expiresAt: 10_000_000_000 });
    const reread = await getInstalledPolicy(options);
    expect(reread).toEqual(view);
    expect(readdirSync(dataDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("logs every mutation", async () => {
    const { options, log } = fixture();
    await installReviewedPolicy(installCommand(), options);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("Reviewed provider policy installed", expect.objectContaining({ providerId: "sogni", reviewVersion: "review-1" }));
    await removeReviewedPolicy(options);
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it("rotates by overwriting the installed policy", async () => {
    const { options } = fixture();
    await installReviewedPolicy(installCommand(), options);
    const nextCapture = "Rotated reviewed policy capture.";
    const rotated = await installReviewedPolicy(installCommand({ reviewVersion: "review-2", sourceCapture: nextCapture, sourceCaptureSha256: sha256(nextCapture) }), options);
    expect(rotated.policy?.reviewVersion).toBe("review-2");
    await expect(getInstalledPolicy(options)).resolves.toEqual(rotated);
  });

  it("rejects invalid install commands without writing state", async () => {
    const { dataDir, options } = fixture();
    const badCapture = installCommand({ sourceCaptureSha256: sha256("tampered") });
    await expect(installReviewedPolicy(badCapture, options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({ sourceUrl: "http://policy.fixture.example/pricing" }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({ expiresAt: 0 }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({}, { providerId: "other-provider" }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({ configCanonicalJson: "{not json" }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({ configCanonicalJson: JSON.stringify(fixtureConfig(), null, 2) }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(installReviewedPolicy(installCommand({ extraField: true }), options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(getInstalledPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("reads a tampered or corrupt install as absent and warns (fail closed)", async () => {
    const { dataDir, options, log } = fixture();
    await installReviewedPolicy(installCommand(), options);
    const file = join(dataDir, "reviewed-policy.json");
    writeFileSync(file, "{broken", "utf8");
    await expect(getInstalledPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const command = installCommand();
    const tampered = { schemaVersion: 1, providerId: command.providerId, policy: { reviewVersion: command.reviewVersion, sourceUrl: command.sourceUrl, sourceCapture: command.sourceCapture, sourceCaptureSha256: sha256("tampered"), capturedAt: command.capturedAt, expiresAt: command.expiresAt, configCanonicalJson: command.configCanonicalJson } };
    writeFileSync(file, JSON.stringify(tampered), "utf8");
    await expect(getInstalledPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("removes the policy and tolerates repeated removal", async () => {
    const { dataDir, options } = fixture();
    await installReviewedPolicy(installCommand(), options);
    await expect(removeReviewedPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    await expect(getInstalledPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    await expect(removeReviewedPolicy(options)).resolves.toEqual({ configured: false, policy: null });
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
