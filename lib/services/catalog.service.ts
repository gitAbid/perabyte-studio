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

export function getModelCatalog(kind: ModelKind): ModelCatalog {
  const registry = getGenerationRegistry();
  const models = registry.listModels(kind);
  logger.debug("catalog assembled", { kind, count: models.length });
  return { models, defaultModelId: registry.defaultModel(kind).id };
}
