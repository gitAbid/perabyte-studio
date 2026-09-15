"use client";

import { useCallback, useEffect, useState } from "react";
import { ContentPreferencesSection } from "@/components/settings/ContentPreferencesSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { RenderTimeoutsSection } from "@/components/settings/RenderTimeoutsSection";
import { TaskModelsSection } from "@/components/settings/TaskModelsSection";
import { useToast } from "@/components/ui";
import { invalidateModelCatalog } from "@/lib/model-catalog";
import { bumpCatalogVersion } from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsPayload,
  ProviderSettingsUpdate,
} from "@/lib/services/provider-settings.service";

export default function SettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<ProviderSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error(`settings ${response.status}`);
        return (await response.json()) as ProviderSettingsPayload;
      })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch(() => {
        if (active) {
          setLoadError(
            "Could not load provider settings. Is the studio server running?",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const onUpdate = useCallback(
    async (patch: ProviderSettingsUpdate) => {
      const previous = data;
      if (previous) setData(optimisticMerge(previous, patch));
      try {
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const payload = (await response.json()) as ProviderSettingsPayload & {
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Could not save settings.");
        setData(payload);
        invalidateModelCatalog();
        bumpCatalogVersion();
      } catch (cause) {
        // Roll the optimistic merge back from server truth.
        const recovery = await fetch("/api/settings").catch(() => null);
        if (recovery?.ok) setData((await recovery.json()) as ProviderSettingsPayload);
        else if (previous) setData(previous);
        toast.push((cause as Error).message || "Could not save settings.");
        throw cause;
      }
    },
    [data, toast],
  );

  return (
    <div className="mx-auto w-full max-w-[720px] flex-1 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-lg font-bold text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-muted">
          Studio-wide preferences, stored on this device.
        </p>
      </header>

      <div className="mt-6 space-y-8 pb-10">
        <ContentPreferencesSection />
        {loadError ? (
          <p className="text-[13px] font-medium text-danger">{loadError}</p>
        ) : data ? (
          <>
            <ProvidersSection providers={data.providers} onUpdate={onUpdate} />
            <TaskModelsSection
              providers={data.providers}
              enhanceModel={data.tasks.enhance}
              onUpdate={onUpdate}
            />
            <RenderTimeoutsSection
              renderTimeouts={data.renderTimeouts}
              onUpdate={onUpdate}
            />
          </>
        ) : (
          <p className="text-[13px] text-muted">Loading settings…</p>
        )}
      </div>
    </div>
  );
}

/** Optimistic client-side mirror of the patch, so toggles feel instant even
 * before the PUT resolves. Server truth replaces it on response. */
function optimisticMerge(
  current: ProviderSettingsPayload,
  patch: ProviderSettingsUpdate,
): ProviderSettingsPayload {
  const providers = current.providers.map((provider) => {
    const change = patch.providers?.[provider.id];
    if (!change) return provider;
    const disabledModels = change.disabledModels ?? null;
    return {
      ...provider,
      enabled: change.enabled ?? provider.enabled,
      keySource:
        change.apiKey === undefined
          ? provider.keySource
          : change.apiKey
            ? ("settings" as const)
            : null,
      keyMasked:
        change.apiKey === undefined || change.apiKey === null
          ? change.apiKey === null
            ? null
            : provider.keyMasked
          : `••••${change.apiKey.slice(-4)}`,
      models: disabledModels
        ? provider.models.map((model) => ({
            ...model,
            enabled: !disabledModels.includes(model.id),
          }))
        : provider.models,
      textModels: disabledModels
        ? provider.textModels.map((model) => ({
            ...model,
            enabled: !disabledModels.includes(model.id),
          }))
        : provider.textModels,
    };
  });
  return {
    providers,
    tasks:
      patch.tasks?.enhance !== undefined
        ? { enhance: patch.tasks.enhance }
        : current.tasks,
    renderTimeouts: patch.renderTimeouts
      ? { ...current.renderTimeouts, ...patch.renderTimeouts }
      : current.renderTimeouts,
  };
}