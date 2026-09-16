"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Button, Toggle, useToast } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";
import { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

function statusOf(provider: ProviderView): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!provider.enabled) return { label: "Off", tone: "neutral" };
  return provider.keySource || !provider.keySupported
    ? { label: "Active", tone: "success" }
    : { label: "Needs API key", tone: "warning" };
}

/** Compact provider rows: enable toggle + status on the row, API-key editor
 * behind an expand. Model visibility lives in ModelsSection. */
export function ProvidersSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const enabledCount = providers.filter((p) => p.enabled).length;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <SectionShell
      icon="chip"
      title="Providers"
      description="Enable providers and manage API keys"
    >
      <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-raised">
      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          lockDisable={provider.enabled && enabledCount <= 1}
          expanded={expanded === provider.id}
          onToggleExpanded={() =>
            setExpanded((cur) => (cur === provider.id ? null : provider.id))
          }
          onUpdate={onUpdate}
        />
      ))}
      </div>
    </SectionShell>
  );
}

function ProviderRow({
  provider,
  lockDisable,
  expanded,
  onToggleExpanded,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: OnUpdate;
}) {
  const status = statusOf(provider);

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${provider.label} details`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name="chevron-down"
            size={14}
            className={`shrink-0 text-muted transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <span className="truncate text-[13px] font-bold text-ink">
            {provider.label}
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {!expanded && provider.keyMasked ? (
            <span className="hidden truncate text-[11.5px] text-muted sm:inline">
              {provider.keyMasked}
            </span>
          ) : null}
        </button>
        <ProviderEnableToggle
          provider={provider}
          lockDisable={lockDisable}
          onUpdate={onUpdate}
        />
      </div>
      {lockDisable && !expanded ? (
        <p className="-mt-1 px-4 pb-3 text-[11.5px] text-muted">
          {provider.label} is your only enabled provider.
        </p>
      ) : null}
      {expanded && provider.keySupported ? (
        <KeyEditor provider={provider} onUpdate={onUpdate} />
      ) : null}
    </div>
  );
}

function ProviderEnableToggle({
  provider,
  lockDisable,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  onUpdate: OnUpdate;
}) {
  const toast = useToast();
  return (
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
  );
}

function KeyEditor({
  provider,
  onUpdate,
}: {
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  const [keyDraft, setKeyDraft] = useState("");

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
    <div className="border-t border-border px-4 py-3">
      <p className="text-[11.5px] text-muted">
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
          className="h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
        <Button size="sm" onClick={saveKey} disabled={!keyDraft.trim()}>
          Save
        </Button>
        {provider.keySource === "settings" ? (
          <Button variant="secondary" size="sm" onClick={clearKey}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
