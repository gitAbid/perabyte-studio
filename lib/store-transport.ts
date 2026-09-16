import type { Asset } from "@/lib/types";

/**
 * How the client asset store reaches the server records (durable-jobs spec
 * Phase A). Injectable so node-env tests stay synchronous and window-free;
 * the browser transport activates only when a real fetch exists.
 */
export interface StoreTransport {
  list(): Promise<Asset[]>;
  create(asset: Asset): Promise<void>;
  patch(id: string, patch: Partial<Asset>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
  importLegacy(rows: unknown[]): Promise<void>;
}

let override: StoreTransport | null = null;

/** Test hook: force a transport (or null to simulate server absence). */
export function setStoreTransportForTests(transport: StoreTransport | null): void {
  override = transport;
}

/** The active transport, or null outside the browser / under test. */
export function storeTransport(): StoreTransport | null {
  if (override) return override;
  if (typeof window === "undefined" || typeof fetch === "undefined") return null;
  return browserStoreTransport();
}

export function browserStoreTransport(): StoreTransport {
  return {
    async list() {
      const response = await fetch("/api/assets", { cache: "no-store" });
      if (!response.ok) throw new Error(`assets list failed: ${response.status}`);
      const data = (await response.json()) as { assets?: Asset[] };
      return data.assets ?? [];
    },
    async create(asset) {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(asset),
      });
      if (!response.ok) throw new Error(`asset create failed: ${response.status}`);
    },
    async patch(id, patch) {
      const response = await fetch(`/api/assets?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`asset patch failed: ${response.status}`);
    },
    async remove(ids) {
      const response = await fetch(`/api/assets?ids=${ids.map(encodeURIComponent).join(",")}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`asset remove failed: ${response.status}`);
    },
    async clear() {
      const response = await fetch("/api/assets?all=1", { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        throw new Error(`asset clear failed: ${response.status}`);
      }
    },
    async importLegacy(rows) {
      const response = await fetch("/api/assets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!response.ok) throw new Error(`legacy import failed: ${response.status}`);
    },
  };
}
