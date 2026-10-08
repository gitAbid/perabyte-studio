import { z } from "zod";
import { CapabilitiesQuerySchema, CapabilitiesResponseSchema, CreateQuoteCommandSchema, QuoteSchema } from "../../production/contracts";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "../../production/http";
import { ProductionApplicationError } from "../../production/errors";
import { withProductionStore } from "../../production/runtime";
import { hashCanonicalJson } from "../../production/hash";
import {
  productionModelOptions,
  type ProductionCatalogEntry,
} from "./sogni-h3";
import { h3FrameCountLegal, h3ModeForModel } from "./sogni-h3";
import { createSogniProductionProvider, type SogniFactoryOptions } from "./sogni-provider";
import { getModelCatalog } from "../../services/catalog.service";
import type { ModelKind } from "../../domain/models";

type ProviderFactory = (options: SogniFactoryOptions) => ReturnType<typeof createSogniProductionProvider>;

export function createCapabilitiesHandler(providerFactory: ProviderFactory = createSogniProductionProvider) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = getRequestId(request);
    let provider: ReturnType<typeof createSogniProductionProvider> | undefined;
    try {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some(key => key !== "providerModelIds")) throw new ProductionApplicationError("INVALID_INPUT","Only providerModelIds query parameters are supported.");
      const query = CapabilitiesQuerySchema.safeParse({ providerModelIds: url.searchParams.getAll("providerModelIds") });
      if(!query.success)throw new ProductionApplicationError("INVALID_INPUT","Capability query is invalid.");
      if(new Set(query.data.providerModelIds).size!==query.data.providerModelIds.length)throw new ProductionApplicationError("INVALID_INPUT","A provider model may appear only once per capability request.");
      provider = providerFactory({ role: "web" });
      const receipts = await Promise.all(query.data.providerModelIds.map(id => provider!.discoverCapabilities(id)));
      await withProductionStore(store => store.transaction(tx => { for (const receipt of receipts) {const prior=tx.getCapabilityReceipt(receipt.providerId,receipt.modelId);if(!prior||receipt.observedAt>prior.observedAt)tx.insertCapabilityReceipt(receipt);} }));
      return Response.json(CapabilitiesResponseSchema.parse({ receipts }), { headers: { "cache-control": "no-store" } });
    } catch (error) { return productionErrorResponse(error, requestId); }
    finally { await provider?.close().catch(()=>undefined); }
  };
}

/* ---------------- GET /api/production/models?kind=anchor|take ---------------- */

const ProductionModelsQuerySchema = z.strictObject({ kind: z.enum(["anchor", "take"]) });
export const ProductionModelsResponseSchema = z.strictObject({
  provider: z.strictObject({ id: z.string(), label: z.string() }),
  models: z.array(z.strictObject({ id: z.string(), label: z.string(), mode: z.enum(["image", "image-to-video"]) })),
});

/**
 * The studio's live model catalog slice for the generate-form dropdowns. `kind=anchor` serves Sogni
 * image models; `kind=take` serves only the production-drivable video takes (FL2VA i2v variants —
 * takes always ride the approved anchor). The accepted pilot baseline is always merged in, and a
 * catalog failure degrades to the baseline-only response instead of throwing, so the route stays
 * deterministic offline (the catalog hides Sogni models entirely without SOGNI_API_KEY).
 */
export type ProductionCatalogLoader = (kind: "image" | "video") => ReadonlyArray<ProductionCatalogEntry>;

export function loadSogniProductionCatalog(kind: "image" | "video"): ReadonlyArray<ProductionCatalogEntry> {
  const catalog = kind === "video" ? getModelCatalog("video", { frame: "start" }) : getModelCatalog("image");
  return catalog.models
    .filter((model) => model.providerId === "sogni")
    .map((model) => ({ id: model.model, label: model.label }));
}

export function createProductionModelsHandler(loadCatalog: ProductionCatalogLoader = loadSogniProductionCatalog) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = getRequestId(request);
    try {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some(key => key !== "kind")) throw new ProductionApplicationError("INVALID_INPUT", "Only the kind query parameter is supported.");
      const query = ProductionModelsQuerySchema.safeParse({ kind: url.searchParams.get("kind") });
      if (!query.success) throw new ProductionApplicationError("INVALID_INPUT", "Model kind must be anchor or take.");
      const catalogKind: ModelKind = query.data.kind === "anchor" ? "image" : "video";
      let catalogModels: ReadonlyArray<ProductionCatalogEntry> = [];
      try {
        catalogModels = loadCatalog(catalogKind);
      } catch {
        catalogModels = []; // Offline/stale catalog: the baseline merge keeps the dropdown usable.
      }
      const models = productionModelOptions(query.data.kind, catalogModels);
      return Response.json(ProductionModelsResponseSchema.parse({ provider: { id: "sogni", label: "Sogni AI" }, models }), { headers: { "cache-control": "no-store" } });
    } catch (error) { return productionErrorResponse(error, requestId); }
  };
}

export function createQuoteHandler(providerFactory: ProviderFactory = createSogniProductionProvider) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = getRequestId(request);
    let provider: ReturnType<typeof createSogniProductionProvider> | undefined;
    try {
      assertSameOriginMutation(request);
      const command = await readProductionJson(request, CreateQuoteCommandSchema);
      if (command.providerId !== "sogni") throw new ProductionApplicationError("INVALID_INPUT", "Unknown provider.");
      const projectExists=await withProductionStore(store=>Boolean(store.read.getProject(command.projectId)));
      if(!projectExists)throw new ProductionApplicationError("UNKNOWN_REFERENCE","Project does not exist.",{field:"projectId",action:"Choose an existing project."});
      const frames = command.inputSnapshot.parameters.frameCount ?? command.inputSnapshot.parameters.durationFrames;
      if (command.operation === "take" && typeof frames === "number" && h3ModeForModel(command.modelId) !== "unknown" && !h3FrameCountLegal(frames)) {
        throw new ProductionApplicationError("CAPABILITY_MISMATCH", "H3 frame count must satisfy 124 + 17n and be at most 362.", { field: "inputSnapshot.parameters.frameCount", action: "Choose a supported H3 duration." });
      }
      provider = providerFactory({ role: "web" });
      const quote = QuoteSchema.parse(await provider.quote(command));
      if(quote.projectId!==command.projectId||quote.providerId!==command.providerId||quote.modelId!==command.modelId||quote.operation!==command.operation||quote.inputHash!==hashCanonicalJson(command.inputSnapshot)||quote.expiresAt<=Date.now())throw new ProductionApplicationError("INVALID_INPUT","Provider quote does not match the request or has expired.");
      await withProductionStore(store => store.transaction(tx => tx.insertQuote(quote)));
      return Response.json(quote, { headers: { "cache-control": "no-store" } });
    } catch (error) { return productionErrorResponse(error, requestId); }
    finally { await provider?.close().catch(()=>undefined); }
  };
}
