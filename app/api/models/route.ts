import { NextResponse } from "next/server";
import type { ModelKind } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import { logger } from "@/lib/logging/logger";
import { getGenerationRegistry } from "@/lib/providers/registry";
import { warmSogniCatalog } from "@/lib/providers/sogni/catalog";
import { fetchLoraCatalog } from "@/lib/providers/sogni/lora-catalog";
import { getModelCatalog } from "@/lib/services/catalog.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/models" });

/**
 * Model catalog for the prompt-window picker. `?kind=image|video` filters by
 * capability; the service merges the registered providers' catalogs.
 *
 * Sogni's lineup is fetched live; when our copy is stale the refresh gets a
 * short bounded window so a page load usually sees the full lineup without
 * ever blocking on a slow network (the last good list is served otherwise).
 *
 * The LoRA catalog rides along (`loras[]` + `loraMaxPerRequest`) so the
 * composer's LoRA picker needs no second fetch; it is public data with its
 * own server-side cache, and a failure just omits the block.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const kind: ModelKind = searchParams.get("kind") === "video" ? "video" : "image";
  const frameParam = searchParams.get("frame");
  const frame = frameParam === "start" || frameParam === "end" ? frameParam : undefined;

  const loraCatalog = await fetchLoraCatalog().catch(() => null);

  if (getStudioEnv().sogniApiKey) {
    await warmSogniCatalog(2_500).catch(() => undefined);
  }

  const registry = getGenerationRegistry();
  const catalog = getModelCatalog(kind, frame ? { frame } : undefined);

  const models = catalog.models.map((model) => ({
    id: model.id,
    kind: model.kind,
    /** Raw provider model id (e.g. `krea2_turbo_fp8_scaled`) — the LoRA
     * catalog joins on this. */
    model: model.model,
    label: model.label,
    hint: model.hint,
    providerId: model.providerId,
    providerLabel: registry.findAnywhere(model.id)?.provider.label ?? model.providerId,
    stylesSupported: model.stylesSupported,
    uncensored: model.uncensored,
    frameInput: model.frameInput,
    i2vModelId: model.i2vModelId,
    videoLimits: model.videoLimits,
    loraCapable: model.loraCapable === true,
  }));

  log.debug("catalog served", {
    kind,
    frame,
    count: models.length,
    loras: loraCatalog?.loras.length ?? 0,
  });
  return NextResponse.json(
    {
      models,
      defaultModelId: catalog.defaultModelId,
      loras: loraCatalog?.loras ?? [],
      loraMaxPerRequest: loraCatalog?.maxPerRequest ?? 8,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
