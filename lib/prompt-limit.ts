import { useSyncExternalStore } from "react";

import { PROMPT_MAX } from "@/lib/constants";
import type { ProviderSettingsPayload } from "@/lib/services/provider-settings.service";

/**
 * Client view of the configurable generation-prompt budget (Settings →
 * General). Server truth lives in the provider config; this store lazily
 * fetches it once per session — and again on window focus, so a Settings
 * save reaches already-open pages — and falls back to the compiled default
 * until then, which is the same default the server clamps to.
 */

let value: number = PROMPT_MAX;
let inflight: Promise<void> | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function apply(next: number) {
  if (!Number.isFinite(next) || next <= 0 || next === value) return;
  value = next;
  emit();
}

function fetchLimit() {
  if (typeof window === "undefined" || inflight) return;
  inflight = fetch("/api/settings", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      const payload = (await response.json()) as Partial<ProviderSettingsPayload>;
      if (typeof payload.promptMaxChars === "number") {
        apply(payload.promptMaxChars);
      }
    })
    .catch(() => {
      /* unreachable server — the default budget still applies */
    })
    .finally(() => {
      inflight = null;
    });
}

function ensureInitialized() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("focus", fetchLimit);
  fetchLimit();
}

function subscribe(listener: () => void) {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Push a server-reported budget into the store without a refetch — the
 * settings page calls this with its PUT response so open pages update at
 * once, and focus-based refetching covers everything else.
 */
export function syncPromptLimit(promptMaxChars: number | null | undefined): void {
  if (typeof promptMaxChars === "number") apply(promptMaxChars);
}

/** Current budget for non-reactive contexts (event handlers, effects). */
export function getPromptMax(): number {
  return value;
}

/** Reactive budget for rendered constraints (maxLength, counters). */
export function usePromptMax(): number {
  return useSyncExternalStore(subscribe, getPromptMax, () => PROMPT_MAX);
}
