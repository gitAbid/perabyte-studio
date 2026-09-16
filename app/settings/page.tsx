"use client";

import { useCallback, useEffect, useState } from "react";
import { AdvancedSection } from "@/components/settings/AdvancedSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ModelsSection } from "@/components/settings/ModelsSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import {
  isSettingsSection,
  SettingsNav,
  type SettingsSectionId,
} from "@/components/settings/SettingsNav";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/ui";
import { invalidateModelCatalog } from "@/lib/model-catalog";
import { bumpCatalogVersion } from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsPayload,
  ProviderSettingsUpdate,
} from "@/lib/services/provider-settings.service";

export default function SettingsPage() {
  const toast = useToast();
  const [section, setSection] = useState<SettingsSectionId>("general");
  const [data, setData] = useState<ProviderSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Read the deep link after mount — avoids SSR/hydration mismatch.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("section");
    if (isSettingsSection(value)) setSection(value);
  }, []);

  const onSection = useCallback((next: SettingsSectionId) => {
    setSection(next);
    window.history.replaceState(null, "", `/settings?section=${next}`);
    window.scrollTo({ top: 0 });
  }, []);

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
    <div className="mx-auto flex w-full max-w-[980px] flex-1 flex-col gap-4 px-4 py-8 sm:px-6 md:flex-row md:gap-8">
      <SettingsNav section={section} onSelect={onSection} />
      <div className="min-w-0 flex-1">
        <header>
          <h1 className="text-lg font-bold text-ink">Settings</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
            <span>Studio-wide preferences, stored on this device.</span>
            <span className="inline-flex items-center gap-1 text-[12px]">
              <Icon name="check" size={12} className="text-success" />
              Changes save automatically.
            </span>
          </p>
        </header>

        <div className="mt-6 pb-10">
          {loadError ? (
            <p className="text-[13px] font-medium text-danger">{loadError}</p>
          ) : null}

          {section === "general" ? (
            <GeneralSection
              providers={data?.providers ?? []}
              enhanceModel={data?.tasks.enhance ?? null}
              writerModel={data?.tasks.writer ?? null}
              onUpdate={onUpdate}
            />
          ) : null}

          {section !== "general" && !loadError ? (
            !data ? (
              <p className="text-[13px] text-muted">Loading settings…</p>
            ) : section === "providers" ? (
              <ProvidersSection providers={data.providers} onUpdate={onUpdate} />
            ) : section === "models" ? (
              <ModelsSection providers={data.providers} onUpdate={onUpdate} />
            ) : (
              <AdvancedSection
                renderTimeouts={data.renderTimeouts}
                onUpdate={onUpdate}
              />
            )
          ) : null}
        </div>
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
    tasks: {
      enhance:
        patch.tasks?.enhance !== undefined
          ? patch.tasks.enhance
          : current.tasks.enhance,
      writer:
        patch.tasks?.writer !== undefined
          ? patch.tasks.writer
          : current.tasks.writer,
    },
    renderTimeouts: patch.renderTimeouts
      ? { ...current.renderTimeouts, ...patch.renderTimeouts }
      : current.renderTimeouts,
  };
}
