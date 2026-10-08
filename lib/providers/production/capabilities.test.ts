import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityFor, normalizeCatalogCapabilities, canSatisfy } from "./capabilities";
import { createCapabilitiesHandler, createQuoteHandler } from "./http-routes";
import { createSogniProductionProvider, type SogniFactoryOptions, type SogniProviderTransport } from "./sogni-provider";
import type { ProviderMediaResult } from "../../repositories/production/ports";
import type { Project } from "../../production/contracts";
import { withProductionStore } from "../../production/runtime";

const now = 1_800_000_000_000;
const model = { id: "minimax-h3-fl2va-fp8_i2v", type: "video", workflowType: "i2v", assets: { referenceImage: "optional", referenceImageEnd: "optional" } };
const tempDirs: string[] = [];
const priorDataDir = process.env.PERABYTE_STUDIO_DATA_DIR;
let routeDataDir = "";
beforeEach(() => {
  routeDataDir = mkdtempSync(join(tmpdir(), "production-capabilities-route-"));
  tempDirs.push(routeDataDir);
  process.env.PERABYTE_STUDIO_DATA_DIR = routeDataDir;
});
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.PERABYTE_STUDIO_DATA_DIR;
  else process.env.PERABYTE_STUDIO_DATA_DIR = priorDataDir;
});

const project = (id: string): Project => ({
  version: 1, id, name: "Capabilities route fixture", profileId: "storybook-short-v1",
  profile: { id: "storybook-short-v1", format: "9:16", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null },
  activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null,
  activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0,
  audioMixVersion: 0, createdAt: 1000, updatedAt: 1000, saveVersion: 1,
});

function offlineProviderFactory() {
  const transport: SogniProviderTransport = {
    sdkVersion: "5.49.0", configured: false,
    discover: vi.fn(async () => []), submit: vi.fn(async () => ({ providerRef: "unused" })),
    poll: vi.fn(async (): Promise<ProviderMediaResult> => ({ providerRef: "unused", state: "running", temporaryUrl: null, mime: null, width: null, height: null, frames: null, errorCode: null, errorMessage: null })),
    cancel: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const factory = vi.fn((options: SogniFactoryOptions) => createSogniProductionProvider({ ...options, env: {}, dataDir: routeDataDir, transport }));
  return { factory, transport };
}

describe("production capability evidence", () => {
  it("keeps provenance and expiry from the source evidence", () => {
    const [receipt] = normalizeCatalogCapabilities("sogni", [model], now, 60_000, now);
    expect(receipt).toMatchObject({ provenance: "live_catalog", observedAt: now, expiresAt: now + 60_000 });
  });
  it("prefers a fresh live fact over stale curated data", () => {
    const live = normalizeCatalogCapabilities("sogni", [model], now, 60_000, now)[0];
    const curated = { ...live, provenance: "curated_fallback" as const, observedAt: now - 10_000, expiresAt: now - 1 };
    expect(capabilityFor("sogni", model.id, [live], [curated], now).provenance).toBe("live_catalog");
  });
  it("does not let unknown or stale support satisfy required references", () => {
    const live = normalizeCatalogCapabilities("sogni", [model], now, 60_000, now)[0];
    expect(canSatisfy({ ...live, provenance: "unknown", supportsStartFrame: null }, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy({ ...live, expiresAt: now - 1 }, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy({ ...live, supportsStartFrame: true, observedAt: now + 1 }, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy({ ...live, provenance: "curated_fallback", supportsStartFrame: true }, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy({ ...live, expiresAt: now + 24 * 60 * 60_000 + 1, supportsStartFrame: true }, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy({ ...live, supportsContextImages: true, maxReferenceImages: 9 }, { contextImages: Number.NaN }, now)).toBe(false);
    expect(canSatisfy({ ...live, supportsContextImages: true, maxReferenceImages: 9 }, { contextImages: -1 }, now)).toBe(false);
  });
  it("does not infer high resolution or timed keyframes by family name", () => {
    const [receipt] = normalizeCatalogCapabilities("sogni", [model], now, 60_000, now);
    expect(receipt.supportsTimedKeyframes).toBe(null);
    expect(canSatisfy(receipt, { timedKeyframes: true }, now)).toBe(false);
  });
  it("counts start frame and context images against one verified reference capacity", () => {
    const [receipt] = normalizeCatalogCapabilities("sogni", [{ ...model, maxReferenceImages: 9, supportsStartFrame: true, supportsContextImages: true }], now, 60_000, now);
    expect(canSatisfy(receipt, { startFrame: true, contextImages: 8 }, now)).toBe(true);
    expect(canSatisfy(receipt, { startFrame: true, contextImages: 9 }, now)).toBe(false);
  });
  it("normalizes explicit endpoint assets while keeping timed keyframes SDK-gated", () => {
    const endpointModel = { ...model, assets: { referenceImage: "optional", referenceImageEnd: "optional" }, supportsTimedKeyframes: true };
    const [oldSdk] = normalizeCatalogCapabilities("sogni", [endpointModel], now, 60_000, now, "5.49.0");
    const [newSdk] = normalizeCatalogCapabilities("sogni", [endpointModel], now, 60_000, now, "5.58.0");
    expect(oldSdk).toMatchObject({ supportsStartFrame: true, supportsEndFrame: true, supportsTimedKeyframes: false });
    expect(newSdk.supportsTimedKeyframes).toBe(true);
  });
  it("does not confuse Ref2VA transport referenceImage with start/end frame conditioning", () => {
    const ref2va = normalizeCatalogCapabilities("sogni", [{
      id: "minimax-h3-ref2va-fp8_r2v", media: "video", assets: { referenceImage: "optional" },
      maxReferenceImages: 9, supportsStartFrame: true, supportsEndFrame: true, supportsContextImages: true,
    }], now, 60_000, now)[0];
    expect(ref2va).toMatchObject({ supportsStartFrame: false, supportsEndFrame: false, supportsContextImages: true });
    expect(canSatisfy(ref2va, { startFrame: true }, now)).toBe(false);
    expect(canSatisfy(ref2va, { endFrame: true }, now)).toBe(false);
    expect(canSatisfy(ref2va, { contextImages: 9 }, now)).toBe(true);
  });
  it("does not infer endpoint semantics from generic SDK asset fields", () => {
    const generic = normalizeCatalogCapabilities("sogni", [{ id: "unknown-video", media: "video", assets: { referenceImage: "optional" }, maxReferenceImages: 1 }], now, 60_000, now)[0];
    expect(generic.supportsStartFrame).toBe(null);
    expect(canSatisfy(generic, { startFrame: true }, now)).toBe(false);
  });
  it("returns an explicit unknown receipt when configured providers have no live catalog", async () => {
    const { factory, transport } = offlineProviderFactory();
    const handler = createCapabilitiesHandler(factory);
    const response = await handler(new Request("http://localhost/api/production/capabilities?providerModelIds=unknown-model"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.receipts[0]).toMatchObject({ modelId: "unknown-model", provenance: "unknown", supportedOperations: [] });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(transport.discover).not.toHaveBeenCalled();
  });
  it("quotes unknown entitlement and unverified price/cap without inventing coverage", async () => {
    await withProductionStore(store => store.transaction(tx => tx.insertProject(project("p1"))));
    const { factory, transport } = offlineProviderFactory();
    const handler = createQuoteHandler(factory);
    const missing = await handler(new Request("http://localhost/api/production/quotes", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ projectId: "missing", providerId: "sogni", modelId: "model-x", operation: "take", inputSnapshot: { revisionIds: [], assetIds: [], parameters: {} } }),
    }));
    expect(missing.status).toBe(404);
    expect(factory).not.toHaveBeenCalled();
    const response = await handler(new Request("http://localhost/api/production/quotes", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1", providerId: "sogni", modelId: "model-x", operation: "take", inputSnapshot: { revisionIds: [], assetIds: [], parameters: {} } }),
    }));
    const quote = await response.json();
    expect(response.status).toBe(200);
    expect(quote).toMatchObject({ entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, withinAuthorizedCap: "unknown" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(transport.discover).not.toHaveBeenCalled();
    expect(transport.submit).not.toHaveBeenCalled();
  });
  it("rejects cross-origin quote mutations", async () => {
    const { factory } = offlineProviderFactory();
    const handler = createQuoteHandler(factory);
    const response = await handler(new Request("http://localhost/api/production/quotes", { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(factory).not.toHaveBeenCalled();
  });
});
