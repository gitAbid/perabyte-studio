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

function fetchCatalog(kind: GenerationKind): Promise<ModelCatalog> {
  let pending = catalogCache.get(kind);
  if (!pending) {
    pending = fetch(`/api/models?kind=${kind}`).then(async (response) => {
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      return (await response.json()) as ModelCatalog;
    });
    pending.catch(() => catalogCache.delete(kind));
    catalogCache.set(kind, pending);
  }
  return pending;
}

export function useModelCatalog(kind: GenerationKind): CatalogState {
  const [state, setState] = useState<CatalogState>({
    models: [],
    defaultModelId: null,
    loading: true,
  });

  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchCatalog(kind)
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
  }, [kind]);

  return state;
}
