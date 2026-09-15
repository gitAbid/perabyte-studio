"use client";

import { useEffect, useState } from "react";
import type { GenerationKind } from "@/lib/constants";

/**
 * Client-side model catalog: fetches `/api/models?kind=…` and caches the
 * promise per kind so every workspace shares one request. Falls back to an
 * empty list (model pill hidden) when the catalog is unreachable.
 */
export interface ModelOption {
  id: string;
  kind: "image" | "video";
  label: string;
  hint?: string;
  providerId: string;
  providerLabel: string;
  /** False when the model can't honour style presets (picker disabled). */
  stylesSupported?: boolean;
  /** False when the model always runs behind a safety checker ("Sensored"). */
  uncensored?: boolean;
  /** Frame conditioning the model accepts. */
  frameInput?: { start: boolean; end: boolean };
  /** i2v sibling the server swaps to when a start frame is present. */
  i2vModelId?: string;
}

export interface ModelCatalog {
  models: ModelOption[];
  defaultModelId: string;
}

interface CatalogState {
  models: ModelOption[];
  defaultModelId: string | null;
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
        return (await response.json()) as ModelCatalog;
      },
    );
    pending.catch(() => catalogCache.delete(key));
    catalogCache.set(key, pending);
  }
  return pending;
}

export function useModelCatalog(
  kind: GenerationKind,
  frame?: "start" | "end",
): CatalogState {
  const [state, setState] = useState<CatalogState>({
    models: [],
    defaultModelId: null,
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
            loading: false,
          });
        }
      })
      .catch(() => {
        if (active) {
          setState({ models: [], defaultModelId: null, loading: false });
        }
      });
    return () => {
      active = false;
    };
  }, [kind, frame]);

  return state;
}
