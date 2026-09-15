import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import { getGenerationRegistry } from "@/lib/providers/registry";
import { logger } from "@/lib/logging/logger";

/**
 * Model catalog assembly for the UI: the merged, capability-filtered model
 * list plus the default pick per kind. Providers register their catalogs;
 * this service only merges and orders them.
 */
export interface ModelCatalog {
  models: ModelDescriptor[];
  defaultModelId: string;
}

export interface CatalogFilter {
  /** Only models with this frame capability — `end` powers the
   * story-conversion picker (hidden capability models included). */
  frame?: "start" | "end";
}

export function getModelCatalog(kind: ModelKind, filter?: CatalogFilter): ModelCatalog {
  const registry = getGenerationRegistry();
  const source = filter?.frame ? registry.listAllModels(kind) : registry.listModels(kind);
  const models = source.filter((model) =>
    filter?.frame ? model.frameInput?.[filter.frame] === true : true,
  );
  logger.debug("catalog assembled", { kind, frame: filter?.frame, count: models.length });
  return { models, defaultModelId: registry.defaultModel(kind).id };
}
