"use client";

import { useState } from "react";
import { Badge, Toggle, useToast } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function ProvidersSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const enabledCount = providers.filter((provider) => provider.enabled).length;

  return (
    <section>
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
        Providers
      </p>
      <div className="mt-3 space-y-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            lockDisable={provider.enabled && enabledCount <= 1}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </section>
  );
}

function statusOf(provider: ProviderView): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!provider.enabled) return { label: "Off", tone: "neutral" };
  return provider.keySource || !provider.keySupported
    ? { label: "Active", tone: "success" }
    : { label: "Needs API key", tone: "warning" };
}

function ProviderCard({
  provider,
  lockDisable,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  onUpdate: OnUpdate;
}) {
  const toast = useToast();
  const [keyDraft, setKeyDraft] = useState("");
  const status = statusOf(provider);

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: trimmed } } }).catch(
      () => undefined,
    );
  }

  function clearKey() {
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: null } } }).catch(
      () => undefined,
    );
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-bold text-ink">{provider.label}</p>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <Toggle
          label={`Enable ${provider.label}`}
          checked={provider.enabled}
          disabled={lockDisable}
          onChange={(next) => {
            if (!next && lockDisable) {
              toast.push("Keep at least one provider enabled.");
              return;
            }
            onUpdate({ providers: { [provider.id]: { enabled: next } } }).catch(
              () => undefined,
            );
          }}
        />
      </div>
      {lockDisable ? (
        <p className="mt-1 text-[11.5px] text-muted">
          {provider.label} is your only enabled provider.
        </p>
      ) : null}

      {provider.keySupported ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-[12px] font-semibold text-ink-soft">API key</p>
          <p className="mt-0.5 text-[11.5px] text-muted">
            {provider.keySource === "settings"
              ? `Saved in Settings ${provider.keyMasked}`
              : provider.keySource === "env"
                ? `Using environment key ${provider.keyMasked}`
                : "Not configured"}
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={keyDraft}
              placeholder={provider.keySource ? "Replace key…" : "Paste API key…"}
              aria-label={`${provider.label} API key`}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveKey();
              }}
              className="h-9 w-full rounded-[10px] border border-border-strong bg-white px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={saveKey}
              disabled={!keyDraft.trim()}
              className="h-9 shrink-0 rounded-[10px] bg-primary px-3 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
            {provider.keySource === "settings" ? (
              <button
                type="button"
                onClick={clearKey}
                className="h-9 shrink-0 rounded-[10px] border border-border-strong px-3 text-[12.5px] font-semibold text-ink-soft transition-colors hover:bg-surface-2"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {provider.models.length || provider.textModels.length ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {provider.models.length ? (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                Models
              </p>
              <div className="mt-1 divide-y divide-border">
                {provider.models.map((model) => (
                  <ModelRow
                    key={model.id}
                    label={model.label}
                    hint={model.hint}
                    checked={model.enabled}
                    onToggle={() => toggleModel(provider, model.id, onUpdate)}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {provider.textModels.length ? (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                Text models
              </p>
              <div className="mt-1 divide-y divide-border">
                {provider.textModels.map((model) => (
                  <ModelRow
                    key={model.id}
                    label={model.label}
                    checked={model.enabled}
                    onToggle={() => toggleModel(provider, model.id, onUpdate)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Disabled-model updates must send the full next disabled list for the
 * provider — image, video, and text models share one list. */
function toggleModel(
  provider: ProviderView,
  modelId: string,
  onUpdate: OnUpdate,
) {
  const currentlyDisabled = provider.models
    .filter((m) => !m.enabled)
    .map((m) => m.id)
    .concat(provider.textModels.filter((m) => !m.enabled).map((m) => m.id));
  const target = provider.models.some((m) => m.id === modelId)
    ? provider.models.find((m) => m.id === modelId)!.enabled
    : provider.textModels.find((m) => m.id === modelId)!.enabled;
  const nextDisabled = target
    ? [...currentlyDisabled, modelId]
    : currentlyDisabled.filter((id) => id !== modelId);
  onUpdate({
    providers: { [provider.id]: { disabledModels: nextDisabled } },
  }).catch(() => undefined);
}

function ModelRow({
  label,
  hint,
  checked,
  onToggle,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <p className="text-[12.5px] font-medium text-ink">{label}</p>
        {hint ? <p className="text-[11.5px] text-muted">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`Toggle ${label}`}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-border-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}