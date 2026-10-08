import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProductionStore } from "../../../../../../lib/repositories/production/sqlite";
import type { ProductionStore } from "../../../../../../lib/repositories/production/ports";
import { createBudgetRouteHandlers } from "../../../../../../lib/services/production/budget";

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
function setup(withProducer = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "production-budget-route-")); dirs.push(dataDir);
  const store = openProductionStore({ dataDir });
  stores.push(store);
  store.transaction(tx => tx.insertProject({ version: 1, id: "project-1", name: "Route budget", profileId: "profile-1", profile: { id: "profile-1", format: "9:16", language: "en", ageIntent: "family", targetFrames: 124, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 }));
  const identity = { providerId: "provider-1", accountId: "secret-account", accountEvidenceId: "evidence-1", credentialBindingId: "secret-binding" };
  if (withProducer) store.transaction(tx => tx.insertAccountEvidence({ schemaVersion: 1, id: identity.accountEvidenceId, providerId: identity.providerId, accountId: identity.accountId, source: "trusted producer", reference: "private-proof-reference", observedAt: 1, expiresAt: 100_000, credentialBindingId: identity.credentialBindingId }));
  const resolveAccountIdentity = vi.fn(async () => identity);
  const handlers = createBudgetRouteHandlers({
    withStore: async <T>(work: (store: ProductionStore) => T | Promise<T>) => work(store),
    serviceOptions: withProducer ? { now: () => 10_000, resolveAccountIdentity, currentCredentialBindingId: () => identity.credentialBindingId } : {},
  });
  return { store, handlers, resolveAccountIdentity };
}
function routeContext(url: string) { const parts = new URL(url).pathname.split("/").filter(Boolean); return { params: Promise.resolve({ projectId: parts[parts.indexOf("projects") + 1] ?? "" }) }; }
function get(url: string, handler: ReturnType<typeof createBudgetRouteHandlers>["GET"]): Promise<Response> { return handler(new Request(url), routeContext(url)); }
function post(value: unknown, handler: ReturnType<typeof createBudgetRouteHandlers>["POST"], origin = "http://localhost"): Promise<Response> {
  const url = "http://localhost/api/production/projects/project-1/budget";
  return handler(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) }), routeContext(url));
}
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("production project budget route", () => {
  it("accepts only one complete GET monetary scope and does not discover accounts for invalid queries", async () => {
    const { handlers, resolveAccountIdentity } = setup();
    for (const url of [
      "http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=minor_currency",
      "http://localhost/api/production/projects/project-1/budget?providerId=provider-1&providerId=provider-1&unit=minor_currency&currency=USD",
      "http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=spark_token&currency=USD",
      "http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=minor_currency&currency=usd",
      "http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=minor_currency&currency=USD&accountId=secret-account",
    ]) expect((await get(url, handlers.GET)).status).toBe(400);
    expect(resolveAccountIdentity).not.toHaveBeenCalled();
    expect((await get("http://localhost/api/production/projects/missing/budget?providerId=provider-1&unit=spark_token", handlers.GET)).status).toBe(404);
  });

  it("rejects same-origin, strict-envelope, nested-extra, malformed, and oversize POSTs before trusted resolution", async () => {
    const { handlers, resolveAccountIdentity } = setup();
    const valid = { kind: "create_policy", providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" };
    expect((await post(valid, handlers.POST, "https://evil.example")).status).toBe(400);
    expect((await post({ ...valid, accountId: "secret-account" }, handlers.POST)).status).toBe(400);
    expect((await post({ ...valid, expiresAt: Number.MAX_SAFE_INTEGER }, handlers.POST)).status).toBe(400);
    expect((await post({ kind: "authorize", providerId: "provider-1", unit: "minor_currency", currency: "USD", command: { policyId: "policy-1", expectedPolicyRevision: 1, expectedAuthorizationRevision: null, projectCap: 100, allowedModelIds: ["model-1"], allowedOperations: ["text_proposal"], entitlementModes: ["subscription"], expiresAt: null, revoked: false, actorId: "creator-1", billingMode: "free" } }, handlers.POST)).status).toBe(400);
    const malformedUrl = "http://localhost/api/production/projects/project-1/budget";
    const malformed = handlers.POST(new Request(malformedUrl, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" }), routeContext(malformedUrl));
    expect((await malformed).status).toBe(400);
    const oversize = handlers.POST(new Request(malformedUrl, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ ...valid, actorId: "x".repeat(20_000) }) }), routeContext(malformedUrl));
    expect((await oversize).status).toBe(413);
    expect(resolveAccountIdentity).not.toHaveBeenCalled();
  });

  it("returns sanitized no-store read views, scoped writes, and fail-closed unavailable behavior", async () => {
    const { handlers, store } = setup();
    const created = await post({ kind: "create_policy", providerId: "provider-1", unit: "minor_currency", currency: "USD", dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" }, handlers.POST);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await created.json() as { kind: string; policy: Record<string, unknown> };
    expect(body.kind).toBe("create_policy");
    expect(body.policy).not.toHaveProperty("accountId");
    expect(JSON.stringify(body)).not.toMatch(/secret-account|secret-binding|private-proof-reference|\/tmp\//);
    const read = await get("http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=minor_currency&currency=USD", handlers.GET);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toMatchObject({ availability: "available", policy: { dailyCap: 100 }, authorization: null, projectTotals: { totalLiability: 0 } });
    expect((await post({ kind: "update_policy", providerId: "provider-1", unit: "minor_currency", currency: "USD", command: { policyId: body.policy.policyId, expectedPolicyRevision: 1, dailyCap: 90, expiresAt: null, revoked: false, actorId: "creator-1" } }, handlers.POST)).status).toBe(200);
    const stale = await post({ kind: "update_policy", providerId: "provider-1", unit: "minor_currency", currency: "USD", command: { policyId: body.policy.policyId, expectedPolicyRevision: 1, dailyCap: 80, expiresAt: null, revoked: false, actorId: "creator-1" } }, handlers.POST);
    expect(stale.status).toBe(409);
    const mismatch = await post({ kind: "update_policy", providerId: "provider-1", unit: "minor_currency", currency: "USD", command: { policyId: "foreign-policy", expectedPolicyRevision: 1, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" } }, handlers.POST);
    expect(mismatch.status).toBe(404);
    const unavailable = setup(false);
    const unavailableRead = await get("http://localhost/api/production/projects/project-1/budget?providerId=provider-1&unit=spark_token", unavailable.handlers.GET);
    expect(await unavailableRead.json()).toMatchObject({ availability: "unavailable", projectTotals: null, reasons: ["ACCOUNT_IDENTITY_UNAVAILABLE"] });
    const denied = await post({ kind: "create_policy", providerId: "provider-1", unit: "spark_token", currency: null, dailyCap: 100, expiresAt: null, revoked: false, actorId: "creator-1" }, unavailable.handlers.POST);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toMatch(/secret-account|secret-binding|private-proof-reference/);
  });
});
