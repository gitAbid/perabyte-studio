import { resolve } from "node:path";
import { openProductionStore, type SqliteProductionStore, type SqliteStoreOptions } from "../repositories/production/sqlite";

export type CloseableProductionStore = Pick<SqliteProductionStore, "close"> & SqliteProductionStore;
export type ProductionStoreFactory = (options: SqliteStoreOptions) => CloseableProductionStore;
export interface ProductionRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  storeFactory?: ProductionStoreFactory;
}

export function resolveProductionDataDir(env: Readonly<Record<string, string | undefined>> = process.env, cwd = process.cwd()): string {
  const configured = env.PERABYTE_STUDIO_DATA_DIR?.trim();
  return resolve(cwd, configured || ".studio");
}

export async function withProductionStore<T>(
  operation: (store: SqliteProductionStore) => T | Promise<T>,
  options: ProductionRuntimeOptions = {},
): Promise<T> {
  const dataDir = resolveProductionDataDir(options.env ?? process.env, options.cwd ?? process.cwd());
  const store = (options.storeFactory ?? openProductionStore)({ dataDir });
  try {
    return await operation(store);
  } finally {
    store.close();
  }
}
