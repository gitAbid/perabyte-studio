"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Button, Toggle, useToast } from "@/components/ui";
import type {
  CustomProviderView,
  ProviderSettingsUpdate,
} from "@/lib/services/provider-settings.service";
import type {
  CustomModelEntry,
  CustomModelKind,
  CustomProviderEntry,
} from "@/lib/repositories/provider-config.repository";
import { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export interface DiscoverInput {
  id?: string;
  format?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface DiscoverResultView {
  models: CustomModelEntry[];
  lastDiscoveredAt: string;
}

const FORMAT_LABELS: Record<CustomProviderView["format"], string> = {
  openai: "OpenAI-compatible",
  google: "Google Gemini",
  anthropic: "Anthropic",
};

const KIND_LABELS: Record<CustomModelKind, string> = {
  image: "Image",
  video: "Video",
  text: "Text",
  off: "Off",
};

const selectClasses =
  "h-8 max-w-[7.5rem] rounded-[10px] border border-border-strong bg-raised px-2 text-[12.5px] text-ink focus:border-primary focus:outline-none";

/** Views never carry the raw key; an omitted apiKey keeps the stored one. */
function entryFromView(
  provider: CustomProviderView,
  overrides: Partial<CustomProviderEntry> = {},
): CustomProviderEntry {
  return { ...provider, ...overrides } as unknown as CustomProviderEntry;
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "provider"
  );
}

/** Management block for user-registered providers: add a gateway (URL + key),
 * discover its models, classify each as image / video / text / off. */
export function CustomProvidersSection({
  providers,
  onUpdate,
  onDiscover,
}: {
  providers: CustomProviderView[];
  onUpdate: OnUpdate;
  onDiscover: (input: DiscoverInput) => Promise<DiscoverResultView>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <SectionShell
      icon="chip"
      title="Custom providers"
      description="Add any OpenAI-compatible, Gemini, or Anthropic gateway"
    >
      <div
        className={`divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-raised ${
          providers.length === 0 && !adding ? "hidden" : ""
        }`}
      >
        {providers.map((provider) => (
          <CustomProviderRow
            key={provider.id}
            provider={provider}
            expanded={expanded === provider.id}
            onToggleExpanded={() =>
              setExpanded((cur) => (cur === provider.id ? null : provider.id))
            }
            onUpdate={onUpdate}
            onDiscover={onDiscover}
          />
        ))}
        {adding ? (
          <AddProviderForm
            existingIds={providers.map((p) => p.id)}
            onCancel={() => setAdding(false)}
            onUpdate={onUpdate}
            onDiscover={onDiscover}
          />
        ) : null}
      </div>
      {!adding ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={14} />
          Add provider
        </Button>
      ) : null}
    </SectionShell>
  );
}

function CustomProviderRow({
  provider,
  expanded,
  onToggleExpanded,
  onUpdate,
  onDiscover,
}: {
  provider: CustomProviderView;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: OnUpdate;
  onDiscover: (input: DiscoverInput) => Promise<DiscoverResultView>;
}) {
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rediscovering, setRediscovering] = useState(false);

  function toggleEnabled(next: boolean) {
    onUpdate({
      customProviders: { upsert: entryFromView(provider, { enabled: next }) },
    }).catch(() => undefined);
  }

  async function rediscover() {
    setRediscovering(true);
    try {
      const result = await onDiscover({ id: provider.id });
      await onUpdate({
        customProviders: {
          upsert: entryFromView(provider, {
            models: result.models,
            lastDiscoveredAt: result.lastDiscoveredAt,
          }),
        },
      });
      toast.push(`${provider.label}: ${result.models.length} models.`);
    } catch (cause) {
      toast.push((cause as Error).message || "Could not discover models.");
    } finally {
      setRediscovering(false);
    }
  }

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
          <span className="truncate text-[13px] font-bold text-ink">{provider.label}</span>
          <Badge tone="neutral">{FORMAT_LABELS[provider.format]}</Badge>
          {provider.keyMasked ? (
            <span className="hidden truncate text-[11.5px] text-muted sm:inline">
              {provider.keyMasked}
            </span>
          ) : null}
        </button>
        <Toggle
          label={`Enable ${provider.label}`}
          checked={provider.enabled}
          onChange={toggleEnabled}
        />
      </div>
      {expanded ? (
        <div className="border-t border-border px-4 py-3">
          <p className="truncate text-[11.5px] text-muted">{provider.baseUrl}</p>
          <CustomKeyEditor provider={provider} onUpdate={onUpdate} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={rediscover} disabled={rediscovering}>
              {rediscovering ? "Discovering…" : "Re-discover models"}
            </Button>
            {confirmingDelete ? (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmingDelete(false);
                    onUpdate({ customProviders: { remove: provider.id } }).catch(() => undefined);
                  }}
                >
                  Confirm delete
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            )}
            {provider.lastDiscoveredAt ? (
              <span className="text-[11.5px] text-muted">
                Discovered {new Date(provider.lastDiscoveredAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>
          <div className="mt-3 space-y-1.5">
            {provider.models.length === 0 ? (
              <p className="text-[12.5px] text-muted">
                No models yet — run discovery to list this gateway's models.
              </p>
            ) : null}
            {provider.models.map((model) => (
              <div
                key={model.model}
                className="flex items-center gap-3 rounded-[10px] bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={model.model}>
                  {model.label ?? model.model}
                </span>
                <select
                  aria-label={`Kind for ${model.model}`}
                  value={model.kind}
                  onChange={(event) =>
                    onUpdate({
                      customProviders: {
                        setModel: {
                          providerId: provider.id,
                          model: model.model,
                          kind: event.target.value as CustomModelKind,
                        },
                      },
                    }).catch(() => undefined)
                  }
                  className={selectClasses}
                >
                  {(Object.keys(KIND_LABELS) as CustomModelKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <Toggle
                  label={`Enable ${model.model}`}
                  checked={model.enabled}
                  onChange={(next) =>
                    onUpdate({
                      customProviders: {
                        setModel: {
                          providerId: provider.id,
                          model: model.model,
                          enabled: next,
                        },
                      },
                    }).catch(() => undefined)
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CustomKeyEditor({
  provider,
  onUpdate,
}: {
  provider: CustomProviderView;
  onUpdate: OnUpdate;
}) {
  const [keyDraft, setKeyDraft] = useState("");

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setKeyDraft("");
    onUpdate({
      customProviders: { upsert: { ...provider, apiKey: trimmed } },
    }).catch(() => undefined);
  }

  function clearKey() {
    setKeyDraft("");
    onUpdate({
      customProviders: { upsert: { ...provider, apiKey: null } },
    }).catch(() => undefined);
  }

  return (
    <div className="mt-2">
      <p className="text-[11.5px] text-muted">
        {provider.keyMasked
          ? `Saved in Settings ${provider.keyMasked}`
          : provider.format === "openai"
            ? "No key — fine for local servers"
            : "Not configured"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          type="password"
          value={keyDraft}
          placeholder={provider.keyMasked ? "Replace key…" : "Paste API key…"}
          aria-label={`${provider.label} API key`}
          onChange={(event) => setKeyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveKey();
          }}
          className="h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none sm:min-w-[16rem] sm:max-w-[22rem] sm:flex-1"
        />
        <Button size="sm" onClick={saveKey} disabled={!keyDraft.trim()}>
          Save
        </Button>
        {provider.keyMasked ? (
          <Button size="sm" variant="secondary" onClick={clearKey}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const FORM_PREVIEW = ["openai", "google", "anthropic"] as const;

function AddProviderForm({
  existingIds,
  onCancel,
  onUpdate,
  onDiscover,
}: {
  existingIds: string[];
  onCancel: () => void;
  onUpdate: OnUpdate;
  onDiscover: (input: DiscoverInput) => Promise<DiscoverResultView>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [format, setFormat] = useState<CustomProviderView["format"]>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [preview, setPreview] = useState<CustomModelEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const inputClasses =
    "h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none";

  async function fetchModels() {
    if (!label.trim() || !baseUrl.trim()) {
      toast.push("Give the provider a name and base URL first.");
      return;
    }
    setBusy(true);
    try {
      const result = await onDiscover({
        format,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setPreview(result.models);
    } catch (cause) {
      toast.push((cause as Error).message || "Could not discover models.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    let id = slugify(label);
    while (existingIds.includes(id)) {
      id = `${id}-${Math.floor(Math.random() * 90 + 10)}`;
    }
    setBusy(true);
    try {
      await onUpdate({
        customProviders: {
          upsert: {
            id,
            label: label.trim(),
            format,
            baseUrl: baseUrl.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : { apiKey: null }),
            enabled: true,
            models: preview,
          },
        },
      });
      toast.push(`${label.trim()} added.`);
      onCancel();
    } catch (cause) {
      toast.push((cause as Error).message || "Could not save the provider.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Add provider</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11.5px] text-muted">Name</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="My relay"
            className={`mt-1 ${inputClasses}`}
          />
        </label>
        <label className="block">
          <span className="text-[11.5px] text-muted">Format</span>
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as CustomProviderView["format"])}
            className={`mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-2 text-[13px] text-ink focus:border-primary focus:outline-none`}
          >
            {FORM_PREVIEW.map((id) => (
              <option key={id} value={id}>
                {FORMAT_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11.5px] text-muted">Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://apikey.fan/v1"
            className={`mt-1 ${inputClasses}`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11.5px] text-muted">API key{format === "openai" ? " (optional)" : ""}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-…"
            className={`mt-1 ${inputClasses}`}
          />
        </label>
      </div>

      {preview ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[11.5px] text-muted">
            {preview.length} models found — adjust kinds before saving.
          </p>
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {preview.map((model, index) => (
              <div
                key={model.model}
                className="flex items-center gap-3 rounded-[10px] bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={model.model}>
                  {model.label ?? model.model}
                </span>
                <select
                  aria-label={`Kind for ${model.model}`}
                  value={model.kind}
                  onChange={(event) => {
                    const next = [...preview];
                    next[index] = {
                      ...model,
                      kind: event.target.value as CustomModelKind,
                      enabled: event.target.value === "image" || event.target.value === "video",
                    };
                    setPreview(next);
                  }}
                  className={selectClasses}
                >
                  {(Object.keys(KIND_LABELS) as CustomModelKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={fetchModels} disabled={busy}>
          {busy && !preview ? "Fetching…" : preview ? "Re-fetch models" : "Fetch models"}
        </Button>
        {preview ? (
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save provider"}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
