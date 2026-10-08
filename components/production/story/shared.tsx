"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, FieldShell } from "@/components/ui";
import { formatEnvelope, textEngineProviderIds, firstTextEngineModelForProvider, type ErrorEnvelopeView, type TextEngineOptionView } from "@/components/production/project-canon";
import type { TextEngineCatalog } from "@/components/production/story/client";

/* ------------------------------------------------------------------ */
/* Shared Story Studio presentational bits                             */
/* ------------------------------------------------------------------ */

/** Full-surface loading line with a named stage (never an unnamed spinner). */
export function LoadingPanel({ label, testId = "story.loading" }: { label: string; testId?: string }) {
  return (
    <div role="status" data-testid={testId} className="rounded-[12px] border border-border bg-raised px-4 py-6 text-[13px] font-medium text-ink-soft">
      {label}
    </div>
  );
}

/** Read-model / mutation failure alert; keeps every editor value, claims nothing. */
export function ErrorAlert({ view, lead, testId }: { view: ErrorEnvelopeView; lead: string; testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">{lead}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">{formatEnvelope(view)}</p>
      <p className="mt-1 text-[12px] text-muted">Your work is unchanged — nothing was lost. You can retry.</p>
    </div>
  );
}

/**
 * The by-design "not funded yet" state for story generation: the proposal
 * endpoint answers 403 BUDGET_BLOCKED until a text entitlement exists, and the
 * studio reports that decision verbatim instead of pretending.
 */
export function NotEntitledNotice({ testId = "story.idea.not-entitled" }: { testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="rounded-[8px] border border-warning/40 bg-warning-soft/50 px-3.5 py-3">
      <p className="text-[13px] font-bold text-ink">Story generation isn’t funded yet.</p>
      <p className="mt-1 text-[13px] leading-snug text-ink">
        PeraByte received the request but there is no text budget set up, so no draft was written. Nothing was charged and your story is unchanged.
      </p>
      <p className="mt-1 text-[12px] text-muted">
        You can keep writing by hand in the Script editor — proposals never apply automatically.
      </p>
    </div>
  );
}

/** Read-model load failure with a retry action. */
export function ReadModelLoadError({ error, onRetry }: { error: ErrorEnvelopeView; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <ErrorAlert view={error} lead="The story studio could not load this project." testId="story.error" />
      <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} data-testid="story.error.retry">
        Try again
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text-engine picker                                                  */
/* ------------------------------------------------------------------ */

export interface TextEnginePickerProps {
  loading: boolean;
  engines: readonly TextEngineOptionView[];
  providerId: string;
  modelId: string;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
  /** Test id prefix, e.g. "story.engine" → "story.engine.provider". */
  testIdPrefix: string;
  idPrefix: string;
}

const SELECT_CLASS = "h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-55";

/**
 * Provider/model dropdowns fed by GET /api/production/text-engines (the same
 * chain the script editor's proposal form uses). Empty or loading catalogs
 * render honestly disabled selects with a Settings pointer.
 */
export function TextEnginePicker({ loading, engines, providerId, modelId, onProviderChange, onModelChange, testIdPrefix, idPrefix }: TextEnginePickerProps) {
  const providerIdList = textEngineProviderIds(engines);
  const providerEngines = engines.filter((engine) => engine.providerId === providerId);
  const unavailable = loading || providerIdList.length === 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FieldShell label="Writing engine" htmlFor={`${idPrefix}-provider`} hint="Which configured text engine writes the draft.">
        <select
          id={`${idPrefix}-provider`}
          data-testid={`${testIdPrefix}.provider`}
          value={providerId}
          onChange={(event) => onProviderChange(event.target.value)}
          disabled={unavailable}
          className={SELECT_CLASS}
        >
          {loading ? (
            <option value="unconfigured">Loading writing engines…</option>
          ) : providerIdList.length === 0 ? (
            <option value="unconfigured">No writing engines configured</option>
          ) : (
            providerIdList.map((id) => <option key={id} value={id}>{id}</option>)
          )}
        </select>
      </FieldShell>
      <FieldShell label="Model" htmlFor={`${idPrefix}-model`} hint="The engine’s model used for this draft.">
        <select
          id={`${idPrefix}-model`}
          data-testid={`${testIdPrefix}.model`}
          value={modelId}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={unavailable || providerEngines.length === 0}
          className={SELECT_CLASS}
        >
          {loading ? (
            <option value="unconfigured">Loading models…</option>
          ) : providerEngines.length === 0 ? (
            <option value="unconfigured">No models available</option>
          ) : (
            providerEngines.map((engine) => <option key={engine.modelId} value={engine.modelId}>{engine.label}</option>)
          )}
        </select>
      </FieldShell>
      {loading || engines.length > 0 ? null : (
        <p className="text-[12px] text-muted sm:col-span-2">
          Writing engines are configured in Settings — <Link href="/settings" className="font-medium text-ink underline underline-offset-2">open Settings</Link>.
        </p>
      )}
    </div>
  );
}

/** Keeps the provider/model pair valid as the catalog resolves. */
export function useEngineSelection(
  catalog: TextEngineCatalog,
  providerId: string,
  modelId: string,
  setProviderId: (id: string) => void,
  setModelId: (id: string) => void,
): void {
  useEffect(() => {
    const providerIdList = textEngineProviderIds(catalog.engines);
    if (catalog.loading || providerIdList.length === 0) return;
    if (!providerIdList.includes(providerId)) {
      const nextProvider = providerIdList[0] ?? "unconfigured";
      setProviderId(nextProvider);
      const first = firstTextEngineModelForProvider(catalog.engines, nextProvider);
      if (first) setModelId(first.modelId);
      return;
    }
    const providerEngines = catalog.engines.filter((engine) => engine.providerId === providerId);
    if (providerEngines.length > 0 && !providerEngines.some((engine) => engine.modelId === modelId)) {
      const first = firstTextEngineModelForProvider(catalog.engines, providerId);
      if (first) setModelId(first.modelId);
    }
  }, [catalog, providerId, modelId, setProviderId, setModelId]);
}
