"use client";

import { EMPTY_VOICES_STORE, readVoicesStore, writeVoicesStore, type VoicesStoreV1 } from "./read-model";

/**
 * Browser-side sync to the server voice store (C16): load the authoritative
 * server library and, once per browser profile, adopt the localStorage
 * snapshot as the migration source. After adoption the localStorage seam is
 * KEPT IN SYNC as a mirror (older tabs still read it), but the server file is
 * authoritative from then on.
 */

export async function loadVoicesStoreClient(): Promise<VoicesStoreV1> {
  try {
    const response = await fetch("/api/production/voices", { cache: "no-store" });
    if (!response.ok) return EMPTY_VOICES_STORE;
    const payload: unknown = await response.json().catch(() => null);
    const store = (payload as { store?: unknown } | null)?.store;
    return store && typeof store === "object" ? (store as VoicesStoreV1) : EMPTY_VOICES_STORE;
  } catch {
    return EMPTY_VOICES_STORE;
  }
}

/** Adopts the localStorage snapshot server-side (one PUT, merge semantics). */
export async function migrateClientVoicesOnce(): Promise<VoicesStoreV1> {
  const local = typeof window === "undefined" ? EMPTY_VOICES_STORE : readVoicesStore(window.localStorage);
  if (local.voices.length === 0 && Object.keys(local.bindings).length === 0) {
    return loadVoicesStoreClient();
  }
  try {
    const response = await fetch("/api/production/voices", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(local),
    });
    const payload: unknown = response.ok ? await response.json().catch(() => null) : null;
    const store = (payload as { store?: unknown } | null)?.store;
    if (store && typeof store === "object") {
      if (typeof window !== "undefined") writeVoicesStore(window.localStorage, store as VoicesStoreV1);
      return store as VoicesStoreV1;
    }
  } catch {
    // Server unreachable: fall through to the local snapshot so the session works offline.
  }
  return local;
}
