import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "../../logging/logger";
import { logger as rootLogger } from "../../logging/logger";
import { BudgetUtcMillisSchema, IdSchema, Sha256Schema } from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import { ProviderReviewedPolicyPayloadSchema } from "../../production/provider-proof";
import {
  parseReviewedQuotePolicy, ReviewedPolicyInputSchema, ReviewedQuotePolicyConfigSchema,
  type ReviewedPolicyInput, type ReviewedQuotePolicyConfig,
} from "../../production/proof-policy";
import { resolveProductionDataDir } from "../../production/runtime";

/**
 * F1 entitlement seam: durable install/read/remove of the machine-local
 * reviewed provider spend policy. The policy is the reviewed quote capture the
 * budget composer consumes; without it every paid path stays BUDGET_BLOCKED.
 *
 * Persistence: a dedicated `<production data dir>/reviewed-policy.json`
 * (default `.studio/reviewed-policy.json`, next to `.studio/settings.json`),
 * because the production runtime resolves its data dir independently of the
 * provider-settings repository and this file is production-scoped. Writes are
 * atomic (temp file + rename in the same directory); the on-disk copy is
 * re-validated through `parseReviewedQuotePolicy` on every read, so a tampered
 * or corrupt file reads back as not configured (fail closed) instead of
 * poisoning quotes.
 */

export const POLICY_FILE_NAME = "reviewed-policy.json";

export interface PolicyServiceOptions {
  /** Overrides the production data dir (tests). */
  dataDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  log?: Logger;
}

/** Install command: the reviewed policy input fields plus the provider it covers. Hashes arrive pre-computed and are re-verified against the capture. */
export const ReviewedPolicyInstallSchema = z.strictObject({
  providerId: IdSchema,
  reviewVersion: z.string().min(1).max(80),
  sourceUrl: z.string().url().max(2048).refine(value => value.startsWith("https://"), "Policy source must use HTTPS"),
  sourceCapture: z.string().min(1).max(65_536),
  sourceCaptureSha256: Sha256Schema,
  capturedAt: BudgetUtcMillisSchema,
  expiresAt: BudgetUtcMillisSchema,
  configCanonicalJson: z.string().min(1).max(65_536),
}).refine(input => input.expiresAt > input.capturedAt, { path: ["expiresAt"], message: "Reviewed policy must expire after capture" })
  .refine(input => createSha256(input.sourceCapture) === input.sourceCaptureSha256, { path: ["sourceCaptureSha256"], message: "Reviewed policy capture integrity is invalid" });
export type ReviewedPolicyInstallCommand = z.infer<typeof ReviewedPolicyInstallSchema>;

/** Read view: providerId plus the exact composer-facing reviewed policy input. Nothing secret is stored or returned. */
export type InstalledReviewedPolicy = ReviewedPolicyInput & { providerId: string };
export type InstalledPolicyView = Readonly<{ configured: boolean; policy: InstalledReviewedPolicy | null }>;

const StoredReviewedPolicySchema = z.strictObject({ schemaVersion: z.literal(1), providerId: IdSchema, policy: ReviewedPolicyInputSchema });

/** Fixed local producer identity for the install-time payload; quote proofs always re-derive artifacts with the composer's own producer. */
const INSTALL_PRODUCER = { producerId: "studio-policy-install", producerVersion: "studio-policy-install-v1", sourceHash: hashCanonicalJson({ schemaVersion: 1, producerId: "studio-policy-install", producerVersion: "studio-policy-install-v1" }) } as const;

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): never {
  throw new ProductionApplicationError("INVALID_INPUT", message);
}

function serviceLogger(options: PolicyServiceOptions): Logger {
  return options.log ?? rootLogger.child({ scope: "production.policy" });
}

function policyPath(options: PolicyServiceOptions): string {
  const dataDir = options.dataDir ?? resolveProductionDataDir(options.env ?? process.env, options.cwd ?? process.cwd());
  return join(dataDir, POLICY_FILE_NAME);
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Rebuilds the reviewed_policy payload from stored fields; the offline parser re-runs on every install and read. */
function payloadFor(providerId: string, policy: ReviewedPolicyInput) {
  const config = ReviewedQuotePolicyConfigSchema.parse(JSON.parse(policy.configCanonicalJson));
  return ProviderReviewedPolicyPayloadSchema.parse({
    schemaVersion: 1, kind: "reviewed_policy", producer: INSTALL_PRODUCER, providerId,
    reviewVersion: policy.reviewVersion, sourceUrl: policy.sourceUrl, sourceCapture: policy.sourceCapture,
    sourceCaptureSha256: policy.sourceCaptureSha256, reviewedConfigCanonicalJson: policy.configCanonicalJson,
    reviewedConfigHash: hashCanonicalJson(config), capturedAt: policy.capturedAt, expiresAt: policy.expiresAt,
  });
}

export async function installReviewedPolicy(rawCommand: unknown, options: PolicyServiceOptions = {}): Promise<InstalledPolicyView> {
  const parsed = ReviewedPolicyInstallSchema.safeParse(rawCommand);
  if (!parsed.success) invalid(`Reviewed policy install command is invalid: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
  const command = parsed.data;
  let config: ReviewedQuotePolicyConfig;
  try {
    config = ReviewedQuotePolicyConfigSchema.parse(JSON.parse(command.configCanonicalJson));
  } catch {
    invalid("The reviewed configuration is not a valid reviewed quote policy configuration.");
  }
  if (config.providerId !== command.providerId) invalid(`The reviewed configuration covers provider ${config.providerId}, not ${command.providerId}.`);
  const canonical = canonicalJson(config);
  if (canonical !== command.configCanonicalJson) invalid("The reviewed configuration must be canonical JSON (sorted keys, no whitespace).");
  // Full offline validation: payload integrity, capture hash, config/canonical binding and projection.
  const projected = parseReviewedQuotePolicy(payloadFor(command.providerId, {
    reviewVersion: command.reviewVersion, sourceUrl: command.sourceUrl, sourceCapture: command.sourceCapture,
    sourceCaptureSha256: command.sourceCaptureSha256, capturedAt: command.capturedAt, expiresAt: command.expiresAt,
    configCanonicalJson: canonical,
  }));
  await writeAtomic(policyPath(options), `${JSON.stringify({ schemaVersion: 1, providerId: command.providerId, policy: projected }, null, 2)}\n`);
  serviceLogger(options).info("Reviewed provider policy installed", { providerId: command.providerId, reviewVersion: command.reviewVersion, capturedAt: command.capturedAt, expiresAt: command.expiresAt });
  return { configured: true, policy: { ...projected, providerId: command.providerId } };
}

export async function getInstalledPolicy(options: PolicyServiceOptions = {}): Promise<InstalledPolicyView> {
  let raw: string;
  try {
    raw = await readFile(policyPath(options), "utf8");
  } catch {
    return { configured: false, policy: null };
  }
  try {
    const stored = StoredReviewedPolicySchema.parse(JSON.parse(raw));
    const projected = parseReviewedQuotePolicy(payloadFor(stored.providerId, stored.policy));
    return { configured: true, policy: { ...projected, providerId: stored.providerId } };
  } catch (error) {
    serviceLogger(options).warn("Installed reviewed policy failed re-validation; treating it as absent", { error: error instanceof Error ? error.message : String(error) });
    return { configured: false, policy: null };
  }
}

export async function removeReviewedPolicy(options: PolicyServiceOptions = {}): Promise<InstalledPolicyView> {
  await rm(policyPath(options), { force: true });
  serviceLogger(options).info("Reviewed provider policy removed; paid generation returns to fail-closed");
  return { configured: false, policy: null };
}
