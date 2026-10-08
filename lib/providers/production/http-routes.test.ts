import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilitiesHandler, createQuoteHandler } from "./http-routes";
import type { SogniFactoryOptions } from "./sogni-provider";
import { withProductionStore } from "../../production/runtime";
import { ProductionApplicationError } from "../../production/errors";
import { hashCanonicalJson } from "../../production/hash";
import type { CreateQuoteCommand, ProductionQuote } from "../../production/contracts";

const dirs: string[] = [];
const previousDataDir = process.env.PERABYTE_STUDIO_DATA_DIR;
afterEach(() => { if (previousDataDir === undefined) delete process.env.PERABYTE_STUDIO_DATA_DIR; else process.env.PERABYTE_STUDIO_DATA_DIR = previousDataDir; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function offlineDataDir() { const dir = mkdtempSync(join(tmpdir(), "perabyte-http-routes-")); dirs.push(dir); process.env.PERABYTE_STUDIO_DATA_DIR = dir; return dir; }
function routeCounts(dataDir: string) {
  const db = new Database(join(dataDir, "production.sqlite"), { readonly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    return {
      quotes: count("SELECT COUNT(*) AS count FROM records WHERE kind='quote'"),
      budgetQuotes: count("SELECT COUNT(*) AS count FROM budget_quotes"),
      bindings: count("SELECT COUNT(*) AS count FROM budget_quote_bindings"),
      evidence: count("SELECT COUNT(*) AS count FROM budget_account_evidence"),
      artifacts: count("SELECT COUNT(*) AS count FROM provider_proof_artifacts"),
      quoteProofs: count("SELECT COUNT(*) AS count FROM provider_quote_proofs"),
      generations: count("SELECT COUNT(*) AS count FROM provider_credential_generations"),
    };
  } finally { db.close(); }
}
const insertProject = () => withProductionStore(store => store.transaction(tx => tx.insertProject({ version: 1, id: "project-1", name: "Route fixture", profileId: "profile-1", profile: { id: "profile-1", format: "9:16", language: "en", ageIntent: "family", targetFrames: 124, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 })));
const quoteCommand = (): CreateQuoteCommand => ({ projectId: "project-1", providerId: "sogni", modelId: "image-model", operation: "anchor", inputSnapshot: { revisionIds: [], assetIds: [], parameters: {} } });
function fakeProviderFactory(overrides: { quote?: (command: CreateQuoteCommand) => Promise<ProductionQuote> } = {}) {
  const close = vi.fn(async () => {});
  const factory = vi.fn((options: SogniFactoryOptions) => ({
    providerId: "sogni" as const,
    discoverCapabilities: async (modelId: string) => ({ version: 1 as const, providerId: "sogni", modelId, provenance: "live_catalog" as const, observedAt: 0, expiresAt: Date.now() + 300_000, supportedOperations: ["image" as const, "video" as const], aspectRatios: ["9:16" as const], maxReferenceImages: 9, supportsStartFrame: true, supportsEndFrame: true, supportsContextImages: true, supportsTimedKeyframes: false, minFrames: null, maxFrames: null, frameStep: null, supportsNativeAudio: false }),
    quote: overrides.quote ?? (async (command: CreateQuoteCommand): Promise<ProductionQuote> => ({ version: 1, id: `quote:${randomUUID()}`, projectId: command.projectId, providerId: command.providerId, modelId: command.modelId, operation: command.operation, inputHash: hashCanonicalJson(command.inputSnapshot), entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: Date.now() + 30_000, withinAuthorizedCap: "unknown", createdAt: Date.now() })),
    submit: async () => { throw new Error("offline fixture provider does not submit"); },
    poll: async () => { throw new Error("offline fixture provider does not poll"); },
    cancel: async () => {},
    observeAccount: async () => { throw new Error("offline fixture provider does not observe accounts"); },
    currentSession: () => null,
    close,
  }));
  return { factory, close };
}
const quotePost = (command: CreateQuoteCommand, factory: ReturnType<typeof fakeProviderFactory>["factory"], origin = "http://localhost") => createQuoteHandler(factory)(new Request("http://localhost/api/production/quotes", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(command) }));

describe("provider http route handlers", () => {
  it("persists injected live capability receipts and rejects malformed capability queries", async () => {
    const dir = offlineDataDir();
    const { factory, close } = fakeProviderFactory();
    const GET = createCapabilitiesHandler(factory);
    const ok = await GET(new Request("http://localhost/api/production/providers/capabilities?providerModelIds=image-model"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await ok.json() as { receipts: Array<{ providerId: string; modelId: string; provenance: string }> };
    expect(body.receipts).toEqual([expect.objectContaining({ providerId: "sogni", modelId: "image-model", provenance: "live_catalog" })]);
    expect(factory.mock.calls[0]![0]!.role).toBe("web");
    expect(await withProductionStore(store => store.read.getCapabilityReceipt("sogni", "image-model"))).toMatchObject({ provenance: "live_catalog" });
    for (const url of [
      "http://localhost/api/production/providers/capabilities?providerModelIds=image-model&other=1",
      "http://localhost/api/production/providers/capabilities?providerModelIds=image-model&providerModelIds=image-model",
      "http://localhost/api/production/providers/capabilities",
    ]) expect((await GET(new Request(url))).status).toBe(400);
    // Malformed queries fail closed before the provider is constructed; only the
    // successful request opened and closed one provider.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  it("keeps the legacy media quote route unknown-normalized, guarded, sanitized, and companion-free", async () => {
    const dir = offlineDataDir();
    const command = quoteCommand();
    const { factory, close } = fakeProviderFactory();
    expect((await quotePost(command, factory, "https://evil.example")).status).toBe(400);
    expect((await quotePost({ ...command, providerId: "unknown-provider" }, factory)).status).toBe(400);

    // Unknown project stays a sanitized 404 before any provider construction.
    const missing = await quotePost({ ...command, projectId: "missing-project" }, factory);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json() as { error: { code: string } };
    expect(missingBody.error.code).toBe("UNKNOWN_REFERENCE");
    expect(JSON.stringify(missingBody)).not.toContain(dir);
    expect(factory).not.toHaveBeenCalled();

    // A known project yields the unknown-normalized media-only quote with zero proof companions.
    await insertProject();
    const ok = await quotePost(command, factory);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const quote = await ok.json() as ProductionQuote;
    expect(quote).toMatchObject({ projectId: "project-1", providerId: "sogni", entitlement: "unknown", estimateMinMinor: null, currency: null, withinAuthorizedCap: "unknown" });
    expect(quote.inputHash).toBe(hashCanonicalJson(command.inputSnapshot));
    expect(routeCounts(dir)).toMatchObject({ quotes: 1, budgetQuotes: 0, bindings: 0, evidence: 0, artifacts: 0, quoteProofs: 0, generations: 0 });

    // A budget-blocked provider failure is a sanitized 403 that leaks no store path.
    const blocked = fakeProviderFactory({ quote: async () => { throw new ProductionApplicationError("BUDGET_BLOCKED", "Sogni provider proof could not be validated; submission is blocked."); } });
    const denied = await quotePost(command, blocked.factory);
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { error: { code: string } };
    expect(deniedBody.error.code).toBe("BUDGET_BLOCKED");
    expect(JSON.stringify(deniedBody)).not.toContain(dir);

    // An expired provider quote is rejected before persistence.
    const stale = fakeProviderFactory({ quote: async commandValue => ({ version: 1, id: `quote:${randomUUID()}`, projectId: commandValue.projectId, providerId: commandValue.providerId, modelId: commandValue.modelId, operation: commandValue.operation, inputHash: hashCanonicalJson(commandValue.inputSnapshot), entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: Date.now() - 1, withinAuthorizedCap: "unknown", createdAt: Date.now() - 2 }) });
    expect((await quotePost(command, stale.factory)).status).toBe(400);
    expect(routeCounts(dir)).toMatchObject({ quotes: 1 });
    // Each provider instance that was constructed is closed exactly once by its route.
    expect(close).toHaveBeenCalledTimes(1);
    expect(blocked.close).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
  });
});
