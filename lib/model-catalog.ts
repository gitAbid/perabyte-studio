"use client";

import { useEffect, useState } from "react";
import type { GenerationKind } from "@/lib/constants";
import type { ModelVideoLimits } from "@/lib/domain/models";
import type { LoraOption } from "@/lib/providers/sogni/lora-catalog";
import { useCatalogVersion } from "@/lib/repositories/settings.repository";

/**
 * Client-side model catalog: fetches `/api/models?kind=…` and caches the
 * promise per kind so every workspace shares one request. Falls back to an
 * empty list (model pill hidden) when the catalog is unreachable.
 */
export interface ModelOption {
  id: string;
  kind: "image" | "video";
  /** Raw provider model id (e.g. `krea2_turbo_fp8_scaled`). */
  model: string;
  label: string;
  hint?: string;
  providerId: string;
  providerLabel: string;
  /** False when the model can't honour style presets (picker disabled). */
  stylesSupported?: boolean;
  /** False when the model always runs behind a safety checker ("Sensored"). */
  uncensored?: boolean;
  /** Curated placement — pinned to the picker's Recommended section. */
  tier?: "recommended";
  /** One-line "what it's good for" — the picker entry's second row. */
  useCase?: string;
  /** Rough cost signal for a compact badge. */
  costTier?: "free" | "credits" | "key-credits";
  /** Frame conditioning the model accepts. */
  frameInput?: { start: boolean; end: boolean };
  /** i2v sibling the server swaps to when a start frame is present. */
  i2vModelId?: string;
  /** Video render limits — UI option pickers constrain to these. */
  videoLimits?: ModelVideoLimits;
  /** True when the provider exposes LoRA adapters for this model. */
  loraCapable?: boolean;
}

export interface ModelCatalog {
  models: ModelOption[];
  defaultModelId: string;
  /** Sogni LoRA catalog entries (all models; join client-side by modelIds). */
  loras: LoraOption[];
  /** Max LoRAs stackable on one render (server-advertised, 8 today). */
  loraMaxPerRequest: number;
}

interface CatalogState {
  models: ModelOption[];
  defaultModelId: string | null;
  loras: LoraOption[];
  loraMaxPerRequest: number;
  loading: boolean;
}

const catalogCache = new Map<string, Promise<ModelCatalog>>();

function cacheKey(kind: GenerationKind, frame?: "start" | "end"): string {
  return `${kind}:${frame ?? ""}`;
}

function fetchCatalog(kind: GenerationKind, frame?: "start" | "end"): Promise<ModelCatalog> {
  const key = cacheKey(kind, frame);
  let pending = catalogCache.get(key);
  if (!pending) {
    pending = fetch(`/api/models?kind=${kind}${frame ? `&frame=${frame}` : ""}`).then(
      async (response) => {
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        const body = (await response.json()) as Partial<ModelCatalog>;
        return {
          models: body.models ?? [],
          defaultModelId: body.defaultModelId ?? "",
          loras: body.loras ?? [],
          loraMaxPerRequest: body.loraMaxPerRequest ?? 8,
        } satisfies ModelCatalog;
      },
    );
    pending.catch(() => catalogCache.delete(key));
    catalogCache.set(key, pending);
  }
  return pending;
}

/** Drop cached catalog promises so the next useModelCatalog call re-fetches.
 * Called after provider settings change. */
export function invalidateModelCatalog(): void {
  catalogCache.clear();
}

export function useModelCatalog(
  kind: GenerationKind,
  frame?: "start" | "end",
): CatalogState {
  const version = useCatalogVersion();
  const [state, setState] = useState<CatalogState>({
    models: [],
    defaultModelId: null,
    loras: [],
    loraMaxPerRequest: 8,
    loading: true,
  });

  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchCatalog(kind, frame)
      .then((catalog) => {
        if (active) {
          setState({
            models: catalog.models,
            defaultModelId: catalog.defaultModelId,
            loras: catalog.loras,
            loraMaxPerRequest: catalog.loraMaxPerRequest,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (active) {
          setState({
            models: [],
            defaultModelId: null,
            loras: [],
            loraMaxPerRequest: 8,
            loading: false,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [kind, frame, version]);

  return state;
}
