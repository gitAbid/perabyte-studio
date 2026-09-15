import { NextResponse } from "next/server";
import type { ModelKind } from "@/lib/domain/models";
import { getStudioEnv } from "@/lib/config/env";
import { logger } from "@/lib/logging/logger";
import { getGenerationRegistry } from "@/lib/providers/registry";
import { warmSogniCatalog } from "@/lib/providers/sogni/catalog";
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
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const kind: ModelKind = searchParams.get("kind") === "video" ? "video" : "image";

  if (getStudioEnv().sogniApiKey) {
    await warmSogniCatalog(2_500).catch(() => undefined);
  }

  const registry = getGenerationRegistry();
  const catalog = getModelCatalog(kind);

  const models = catalog.models.map((model) => ({
    id: model.id,
    kind: model.kind,
    label: model.label,
    hint: model.hint,
    providerId: model.providerId,
    providerLabel: registry.findAnywhere(model.id)?.provider.label ?? model.providerId,
    stylesSupported: model.stylesSupported,
    uncensored: model.uncensored,
  }));

  log.debug("catalog served", { kind, count: models.length });
  return NextResponse.json(
    { models, defaultModelId: catalog.defaultModelId },
    { headers: { "cache-control": "no-store" } },
  );
}
