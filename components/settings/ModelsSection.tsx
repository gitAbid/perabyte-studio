"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";
import { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

type AnyProviderModel =
  | ProviderView["models"][number]
  | ProviderView["textModels"][number];

/** Picker-visibility for every model, grouped per provider. Same payload as
 * the old in-card lists: each change sends the provider's FULL next
 * disabledModels list (image, video, and text models share one list). */
export function ModelsSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  return (
    <SectionShell
      icon="grid"
      title="Models"
      description="Choose which models appear in the pickers"
    >
      <div className="space-y-4">
      <label className="relative block">
        <Icon
          name="search"
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="h-10 w-full rounded-[12px] border border-border-strong bg-raised pl-9 pr-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
      </label>
      {providers.map((provider) => (
        <ProviderModelGroup
          key={provider.id}
          provider={provider}
          filter={query}
          onUpdate={onUpdate}
        />
      ))}
      </div>
    </SectionShell>
  );
}

function ProviderModelGroup({
  provider,
  filter,
  onUpdate,
}: {
  provider: ProviderView;
  filter: string;
  onUpdate: OnUpdate;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const all = [...provider.models, ...provider.textModels];
  const onCount = all.filter((m) => m.enabled).length;
  const matches = (list: AnyProviderModel[]) =>
    filter
      ? list.filter((m) =>
          `${m.label} ${"hint" in m ? (m.hint ?? "") : ""}`.toLowerCase().includes(filter),
        )
      : list;
  const shownModels = matches(provider.models);
  const shownText = matches(provider.textModels);
  if (filter && !shownModels.length && !shownText.length) return null;

  function setAll(nextOn: boolean) {
    const nextDisabled = nextOn ? [] : all.map((m) => m.id);
    onUpdate({
      providers: { [provider.id]: { disabledModels: nextDisabled } },
    }).catch(() => undefined);
  }

  return (
    <div className="rounded-[14px] border border-border bg-raised">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${provider.label} models`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name="chevron-down"
            size={14}
            className={`shrink-0 text-muted transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          <span className="truncate text-[13px] font-bold text-ink">
            {provider.label}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted">
            {onCount} of {all.length} on
          </span>
        </button>
        <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
          All on
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
          All off
        </Button>
      </div>
      {!collapsed ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {shownModels.length ? (
            <ModelPillGrid
              label={provider.textModels.length ? "Image & video" : undefined}
              models={shownModels}
              provider={provider}
              onUpdate={onUpdate}
            />
          ) : null}
          {shownText.length ? (
            <ModelPillGrid
              label="Text"
              models={shownText}
              provider={provider}
              onUpdate={onUpdate}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelPillGrid({
  label,
  models,
  provider,
  onUpdate,
}: {
  label?: string;
  models: AnyProviderModel[];
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  return (
    <div>
      {label ? (
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {label}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {models.map((model) => (
          <ModelPill
            key={model.id}
            model={model}
            provider={provider}
            onUpdate={onUpdate}
          />
        ))}
      </div>
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

function ModelPill({
  model,
  provider,
  onUpdate,
}: {
  model: AnyProviderModel;
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={model.enabled}
      aria-label={`${model.enabled ? "Hide" : "Show"} ${model.label} in model pickers`}
      title={"hint" in model ? (model.hint ?? model.label) : model.label}
      onClick={() => toggleModel(provider, model.id, onUpdate)}
      className={`flex min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors ${
        model.enabled
          ? "border-border bg-raised text-ink hover:border-border-strong"
          : "border-transparent bg-surface-2 text-muted hover:border-border-strong"
      }`}
    >
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-full ${
          model.enabled
            ? "bg-primary-strong text-white"
            : "border border-border-strong bg-transparent"
        }`}
      >
        {model.enabled ? <Icon name="check" size={10} /> : null}
      </span>
      <span className="truncate text-[12.5px] font-medium">{model.label}</span>
    </button>
  );
}
