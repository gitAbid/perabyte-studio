"use client";

import { useCallback, useEffect, useState } from "react";
import { AdvancedSection } from "@/components/settings/AdvancedSection";
import {
  CustomProvidersSection,
  type DiscoverInput,
  type DiscoverResultView,
} from "@/components/settings/CustomProvidersSection";
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
import { PROMPT_MAX } from "@/lib/constants";
import { invalidateModelCatalog } from "@/lib/model-catalog";
import { syncPromptLimit } from "@/lib/prompt-limit";
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
        // A fresh budget reaches open studio pages without waiting for focus.
        syncPromptLimit(payload.promptMaxChars);
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

  const onDiscover = useCallback(async (input: DiscoverInput): Promise<DiscoverResultView> => {
    const response = await fetch("/api/providers/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json()) as DiscoverResultView & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not discover models.");
    return payload;
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Studio / Configuration</p>
          <h1 className="mt-2 text-[34px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[42px]">Settings</h1>
          <p className="mt-2 text-[12px] text-muted">Tune the tools and defaults behind your creative workspace.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 border border-success/25 bg-success-soft px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-success">
          <Icon name="check" size={12} /> Saves automatically
        </span>
      </header>

      <div className="mt-5">
        <SettingsNav section={section} onSelect={onSection} />
      </div>

      <div className="mt-7 min-w-0 flex-1">
        <div className="max-w-[1180px] pb-10">
          {loadError ? (
            <p className="text-[13px] font-medium text-danger">{loadError}</p>
          ) : null}

          {section === "general" ? (
            <GeneralSection
              providers={data?.providers ?? []}
              enhanceModel={data?.tasks.enhance ?? null}
              writerModel={data?.tasks.writer ?? null}
              promptMaxChars={data?.promptMaxChars ?? PROMPT_MAX}
              sceneConsistency={data?.sceneConsistency ?? true}
              onUpdate={onUpdate}
            />
          ) : null}

          {section !== "general" && !loadError ? (
            !data ? (
              <p className="text-[13px] text-muted">Loading settings…</p>
            ) : section === "providers" ? (
              <div className="space-y-4">
                <ProvidersSection
                  providers={data.providers.filter((provider) => !provider.format)}
                  onUpdate={onUpdate}
                />
                <CustomProvidersSection
                  providers={data.customProviders}
                  onUpdate={onUpdate}
                  onDiscover={onDiscover}
                />
              </div>
            ) : section === "models" ? (
              <ModelsSection
                providers={data.providers.filter((provider) => !provider.format)}
                onUpdate={onUpdate}
              />
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
    customProviders: current.customProviders,
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
    promptMaxChars:
      patch.promptMaxChars !== undefined
        ? patch.promptMaxChars
        : current.promptMaxChars,
    sceneConsistency:
      patch.sceneConsistency !== undefined
        ? patch.sceneConsistency
        : current.sceneConsistency,
  };
}
