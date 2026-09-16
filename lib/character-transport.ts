import type { CharacterRow } from "@/lib/repositories/character-row";

/**
 * How the client character store reaches the server store. Injectable so
 * node-env tests stay synchronous and window-free — same contract as
 * `lib/store-transport.ts`.
 */
export interface CharacterTransport {
  list(): Promise<CharacterRow[]>;
  create(row: CharacterRow): Promise<void>;
  patch(id: string, patch: Partial<CharacterRow>): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

let override: CharacterTransport | null = null;

/** Test hook: force a transport (or null to simulate server absence). */
export function setCharacterTransportForTests(transport: CharacterTransport | null): void {
  override = transport;
}

/** The active transport, or null outside the browser / under test. */
export function characterTransport(): CharacterTransport | null {
  if (override) return override;
  if (typeof window === "undefined" || typeof fetch === "undefined") return null;
  return browserCharacterTransport();
}

export function browserCharacterTransport(): CharacterTransport {
  return {
    async list() {
      const response = await fetch("/api/characters", { cache: "no-store" });
      if (!response.ok) throw new Error(`characters list failed: ${response.status}`);
      const data = (await response.json()) as { characters?: CharacterRow[] };
      return data.characters ?? [];
    },
    async create(row) {
      const response = await fetch("/api/characters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
      if (!response.ok) throw new Error(`character create failed: ${response.status}`);
    },
    async patch(id, patch) {
      const response = await fetch(`/api/characters?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`character patch failed: ${response.status}`);
    },
    async remove(ids) {
      const response = await fetch(
        `/api/characters?ids=${ids.map(encodeURIComponent).join(",")}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(`character remove failed: ${response.status}`);
    },
  };
}
