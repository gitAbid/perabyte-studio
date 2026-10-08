import { ProductionJobQueue } from "../../jobs/production/queue";
import type { ProductionStore } from "./ports";

/** Compatibility facade for worker callers; all state remains in C01's primary store. */
export class JobsSqlite extends ProductionJobQueue {
  constructor(store: ProductionStore, now?: () => number) { super(store, now); }
}
