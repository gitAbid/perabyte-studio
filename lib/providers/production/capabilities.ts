import { randomUUID } from "node:crypto";
import { CapabilityReceiptSchema, QuoteSchema, type CapabilityReceipt, type CreateQuoteCommand, type ProductionQuote } from "../../production/contracts";
import { hashCanonicalJson } from "../../production/hash";
import { h3ModeForModel, timedKeyframesStatus } from "./sogni-h3";

export interface CatalogModel {
  id: string;
  media?: string;
  type?: string;
  workflowType?: string;
  assets?: Record<string, string>;
  aspectRatios?: string[];
  maxReferenceImages?: number;
  minFrames?: number;
  maxFrames?: number;
  frameStep?: number;
  supportsStartFrame?: boolean;
  supportsEndFrame?: boolean;
  supportsContextImages?: boolean;
  supportsTimedKeyframes?: boolean;
  supportsNativeAudio?: boolean;
}

const RATIOS = new Set(["1:1", "9:16", "16:9", "4:3", "3:4"]);
const MAX_CAPABILITY_TTL_MS = 24 * 60 * 60_000;
const nullable = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const numOrNull = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const nonnegativeOrNull = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const freshLive = (item: CapabilityReceipt, now: number): boolean => Number.isSafeInteger(now) && now >= 0 && item.provenance === "live_catalog" && Number.isSafeInteger(item.observedAt) && item.observedAt >= 0 && item.observedAt <= now && item.expiresAt !== null && Number.isSafeInteger(item.expiresAt) && item.expiresAt > now && item.expiresAt - item.observedAt <= MAX_CAPABILITY_TTL_MS;
function endpointSupport(explicit: boolean | undefined, asset: string | undefined, mode: ReturnType<typeof h3ModeForModel>): boolean | null {
  if (mode === "Ref2VA" || mode === "T2V") return false;
  if (explicit === false || asset === "forbidden") return false;
  if (explicit === true) return true;
  if (mode === "FL2VA" || mode === "FLF2V") return asset === "forbidden" ? false : true;
  return null;
}

/** Normalize only facts actually present in the provider's live discovery response. */
export function normalizeCatalogCapabilities(providerId: string, models: CatalogModel[], observedAt = Date.now(), ttlMs = 5 * 60_000, now = Date.now(), sdkVersion?: string): CapabilityReceipt[] {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > now || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CAPABILITY_TTL_MS) {
    throw new RangeError("Capability observation timestamp or expiry is outside the accepted range.");
  }
  return models.map((model) => {
    const media = model.media ?? model.type;
    const h3Mode = h3ModeForModel(model.id);
    const supportedOperations = media === "video" ? ["video"] : media === "image" ? ["image"] : [];
    const receipt = {
      version: 1 as const,
      providerId,
      modelId: model.id,
      provenance: "live_catalog" as const,
      observedAt,
      expiresAt: observedAt + ttlMs,
      supportedOperations,
      aspectRatios: Array.isArray(model.aspectRatios) ? [...new Set(model.aspectRatios.filter((ratio): ratio is CapabilityReceipt["aspectRatios"][number] => RATIOS.has(ratio)))] : [],
      maxReferenceImages: nonnegativeOrNull(model.maxReferenceImages),
      supportsStartFrame: endpointSupport(model.supportsStartFrame, model.assets?.referenceImage, h3Mode),
      supportsEndFrame: endpointSupport(model.supportsEndFrame, model.assets?.referenceImageEnd, h3Mode),
      supportsContextImages: nullable(model.supportsContextImages),
      // Timed keyframe requests are gated by SDK compatibility separately; a catalog label is insufficient.
      supportsTimedKeyframes: model.supportsTimedKeyframes === false
        ? false
        : model.supportsTimedKeyframes === true
          ? timedKeyframesStatus(sdkVersion)
          : null,
      minFrames: numOrNull(model.minFrames),
      maxFrames: numOrNull(model.maxFrames),
      frameStep: numOrNull(model.frameStep),
      supportsNativeAudio: nullable(model.supportsNativeAudio),
    };
    return CapabilityReceiptSchema.parse(receipt);
  });
}

export function unknownCapability(providerId: string, modelId: string, observedAt = Date.now()): CapabilityReceipt {
  return CapabilityReceiptSchema.parse({ version: 1, providerId, modelId, provenance: "unknown", observedAt, expiresAt: null, supportedOperations: [], aspectRatios: [], maxReferenceImages: null, supportsStartFrame: null, supportsEndFrame: null, supportsContextImages: null, supportsTimedKeyframes: null, minFrames: null, maxFrames: null, frameStep: null, supportsNativeAudio: null });
}

export function capabilityFor(providerId: string, modelId: string, live: CapabilityReceipt[], curated: CapabilityReceipt[], now = Date.now()): CapabilityReceipt {
  const fresh = live.find((item) => item.providerId === providerId && item.modelId === modelId && freshLive(item, now));
  if (fresh) return fresh;
  const fallback = curated.find((item) => item.providerId === providerId && item.modelId === modelId && item.provenance === "curated_fallback" && item.observedAt <= now && item.expiresAt !== null && item.expiresAt > now);
  return fallback ?? unknownCapability(providerId, modelId, now);
}

export interface RequiredCapabilities { startFrame?: boolean; endFrame?: boolean; contextImages?: number; timedKeyframes?: boolean }
export function canSatisfy(receipt: CapabilityReceipt, required: RequiredCapabilities, now = Date.now()): boolean {
  if (!freshLive(receipt, now)) return false;
  if (required.contextImages !== undefined && (!Number.isSafeInteger(required.contextImages) || required.contextImages < 0)) return false;
  if (required.startFrame && receipt.supportsStartFrame !== true) return false;
  if (required.endFrame && receipt.supportsEndFrame !== true) return false;
  const imageReferences = (required.contextImages ?? 0) + Number(required.startFrame === true);
  if (imageReferences > 0 && (receipt.maxReferenceImages === null || imageReferences > receipt.maxReferenceImages)) return false;
  if ((required.contextImages ?? 0) > 0 && receipt.supportsContextImages !== true) return false;
  if (required.timedKeyframes && receipt.supportsTimedKeyframes !== true) return false;
  return true;
}

export interface ProductionCapabilityDiscovery {
  sdkVersion?: string;
  discover(providerId: string, modelIds: string[]): Promise<CatalogModel[]>;
}
export interface ProductionQuoteProvider {
  quote(command: CreateQuoteCommand): Promise<ProductionQuote>;
}
let discovery: ProductionCapabilityDiscovery | null = null;
let quoteProvider: ProductionQuoteProvider | null = null;
export function setProductionCapabilityDiscovery(value: ProductionCapabilityDiscovery | null): void { discovery = value; }
export function getProductionCapabilityDiscovery(): ProductionCapabilityDiscovery | null { return discovery; }
export function setProductionQuoteProvider(value: ProductionQuoteProvider | null): void { quoteProvider = value; }

/** Data-only estimate placeholder. Billing authorization remains an independent service boundary. */
export function unknownProductionQuote(command: CreateQuoteCommand, now = Date.now()): ProductionQuote {
  return QuoteSchema.parse({ version: 1, id: `quote:${randomUUID()}`, projectId: command.projectId, providerId: command.providerId, modelId: command.modelId, operation: command.operation, inputHash: hashCanonicalJson(command.inputSnapshot), entitlement: "unknown", estimateMinMinor: null, estimateMaxMinor: null, currency: null, expiresAt: now + 30_000, withinAuthorizedCap: "unknown", createdAt: now });
}

export async function quoteProductionRequest(command: CreateQuoteCommand): Promise<ProductionQuote> {
  const quote = QuoteSchema.parse(quoteProvider ? await quoteProvider.quote(command) : unknownProductionQuote(command));
  const expectedHash = hashCanonicalJson(command.inputSnapshot);
  if (quote.projectId !== command.projectId || quote.providerId !== command.providerId || quote.modelId !== command.modelId || quote.operation !== command.operation || quote.inputHash !== expectedHash || quote.expiresAt <= Date.now()) {
    throw new Error("Quote provider returned mismatched or expired evidence.");
  }
  return quote;
}
