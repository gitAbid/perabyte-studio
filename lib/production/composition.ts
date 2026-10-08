import { join } from "node:path";
import type { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { openProductionStore, type SqliteProductionStore } from "../repositories/production/sqlite";
import { resolveProductionDataDir, type ProductionRuntimeOptions } from "./runtime";
import { ProductionApplicationError } from "./errors";
import type { Asset } from "./contracts";
import { LocalMediaVault } from "../media/production/vault";
import { createProductionBudgetComposer } from "../services/production/budget-composer";
import { createProductionBudgetService, type ProductionBudgetService } from "../services/production/budget";
import { createProductionTakeService } from "../services/production/takes";
import { createSogniProductionProvider, readInstalledSogniProofMetadata, type SogniFactoryOptions } from "../providers/production/sogni-provider";
import type { ProductionProofProvider, SubmissionProofResolver } from "../providers/production/proof-port";
import { parseReviewedQuotePolicy, type ReviewedPolicyInput } from "./proof-policy";

export type ProductionCompositionRole = "web" | "worker";
export type ProductionCompositionProviderFactory = (options: SogniFactoryOptions) => ProductionProofProvider & { close(): Promise<void> };
export type ProductionCompositionOptions = {
  role: ProductionCompositionRole;
  store?: SqliteProductionStore;
  reviewedPolicy?: ReviewedPolicyInput | null;
  providerFactory?: ProductionCompositionProviderFactory;
  runtimeOptions?: ProductionRuntimeOptions;
};
export type ProductionComposition = Readonly<{
  role: ProductionCompositionRole;
  dataDir: string;
  store: SqliteProductionStore;
  vault: LocalMediaVault;
  readAssetVerified: (asset: Asset) => Promise<void>;
  provider: ProductionProofProvider;
  composer: ReturnType<typeof createProductionBudgetComposer>;
  budgetService: ProductionBudgetService;
  takeService: ReturnType<typeof createProductionTakeService>;
}>;

/**
 * Per-composition reviewed-policy loader (B6-POLICY-LOAD): an unset path keeps the fail-closed
 * W-WIRE default (null); a set path is freshly read and strictly parsed for every composition with
 * no caching across compositions. Any failure — missing or unreadable file, malformed JSON, schema
 * violation, hash mismatch, expired capture — is a sanitized BUDGET_BLOCKED: an operator who
 * installed a policy never gets a silent fallback to an unpriced composition.
 */
export function loadReviewedPolicyFromPath(path: string | undefined): ReviewedPolicyInput | null {
  if (path === undefined) return null;
  try {
    const policy = parseReviewedQuotePolicy(JSON.parse(readFileSync(path, "utf8")));
    if (policy.expiresAt <= Date.now()) throw new Error("The reviewed policy capture has expired.");
    return policy;
  } catch {
    throw new ProductionApplicationError("BUDGET_BLOCKED", "The reviewed policy could not be loaded; pricing stays blocked.");
  }
}

/**
 * Runtime composition root (I01-B6-W-WIRE): lazily builds the SQLite store, the proof provider,
 * the offline budget composer, and the trusted budget/take services over them. The provider is
 * wired with the installed SDK proof metadata, the composer's synchronous submission proof
 * resolver, and the vault-backed input loader, so no provider submission can bypass durable
 * admission evidence. An explicitly injected reviewed policy wins; otherwise, when the operator
 * set PERABYTE_STUDIO_REVIEWED_POLICY_PATH, the policy file is resolved here per composition
 * (fail-loud on any load failure) before the provider or composer is built. Absent a reviewed
 * policy, every composed value fails closed: quotes are unknown, budget identity is unavailable,
 * and no paid path opens. No import-time I/O; when the caller supplies a store it is reused and
 * only resources created here are closed in `finally`.
 */
export async function withProductionComposition<T>(
  work: (composition: ProductionComposition) => T | Promise<T>,
  options: ProductionCompositionOptions,
): Promise<T> {
  const env = options.runtimeOptions?.env ?? process.env;
  const cwd = options.runtimeOptions?.cwd ?? process.cwd();
  const dataDir = resolveProductionDataDir(env, cwd);
  const createdStore = options.store ? null : (options.runtimeOptions?.storeFactory ?? openProductionStore)({ dataDir });
  const store = options.store ?? createdStore!;
  const vault = new LocalMediaVault({ root: join(dataDir, "media") });
  const readAssetVerified = async (asset: Asset): Promise<void> => {
    try { await vault.readVerified(asset.vaultRef, asset.sha256); }
    catch { throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "A required media asset could not be verified in the local vault."); }
  };
  const readAsset = async (assetId: string): Promise<Buffer> => {
    const asset = store.read.getAsset(assetId);
    if (!asset) throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Provider input asset is unavailable.");
    return vault.readVerified(asset.vaultRef, asset.sha256);
  };
  let provider: ProductionProofProvider & { close(): Promise<void> } | undefined;
  try {
    // Explicit injection wins over the env path; the installed policy file is resolved here, per
    // composition and fail-loud, before any provider or composer resource is ever built.
    const reviewedPolicy = options.reviewedPolicy ?? loadReviewedPolicyFromPath(env.PERABYTE_STUDIO_REVIEWED_POLICY_PATH);
    // The provider receives the composer's resolver before the composer exists; the durable
    // execution proof is only consulted at submission time, so forward it through a cell that
    // fails closed until composition completes.
    let composer: ProductionComposition["composer"] | null = null;
    const submissionProofResolver: SubmissionProofResolver = (snapshot, captured, at) => composer?.submissionProofResolver(snapshot, captured, at) ?? false;
    provider = (options.providerFactory ?? createSogniProductionProvider)({ role: options.role, dataDir, proofMetadata: readInstalledSogniProofMetadata(), submissionProofResolver, readAsset });
    composer = createProductionBudgetComposer({ store, provider, reviewedPolicy });
    const composition: ProductionComposition = {
      role: options.role,
      dataDir,
      store,
      vault,
      readAssetVerified,
      provider,
      composer,
      budgetService: createProductionBudgetService({ store, resolveAccountIdentity: composer.resolveAccountIdentity, prepareExecutionEvidence: composer.prepareExecutionEvidence, currentCredentialBindingId: composer.currentCredentialBindingId }),
      takeService: createProductionTakeService({ store, resolveBillingMode: composer.resolveBillingMode, quoteRecipe: composer.prepareMediaQuoteDraft, commitPreparedQuote: composer.commitPreparedQuote, readAssetVerified }),
    };
    return await work(composition);
  } finally {
    await provider?.close().catch(() => undefined);
    createdStore?.close();
  }
}
