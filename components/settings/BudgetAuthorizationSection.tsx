"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, TextAreaField, useToast } from "@/components/ui";
import { SectionShell } from "@/components/settings/shared";

/**
 * Budget & authorization (F1 entitlement seam): install/rotate/remove the
 * machine-local reviewed provider spend policy through
 * /api/production/policy. While no policy is installed every paid provider
 * path stays fail-closed (BUDGET_BLOCKED); installing one authorizes real
 * spend on this machine.
 */

interface InstalledPolicy {
  providerId: string;
  reviewVersion: string;
  sourceUrl: string;
  sourceCaptureSha256: string;
  capturedAt: number;
  expiresAt: number;
  configCanonicalJson: string;
}
type PolicyView = { configured: boolean; policy: InstalledPolicy | null };

interface PolicyConfig {
  quoteTtlMs: number;
  accountSessionTtlMs: number;
  executionSessionTtlMs: number;
  billingModeByModel: { modelId: string; billingMode: string }[];
  priceByModel: {
    modelId: string;
    operations: string[];
    entitlement: string;
    unit: string;
    currency: string | null;
    estimateMinMinor: number | null;
    estimateMaxMinor: number | null;
  }[];
}

const CAPTURE_MAX = 65_536;
const CONFIG_MAX = 65_536;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function BudgetAuthorizationSection() {
  const toast = useToast();
  const [view, setView] = useState<PolicyView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/production/policy", { cache: "no-store" });
      if (!response.ok) throw new Error(`policy ${response.status}`);
      setView((await response.json()) as PolicyView);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onInstall = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const response = await fetch("/api/production/policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as PolicyView & { error?: { message?: string } };
        if (!response.ok) throw new Error(payload.error?.message ?? "Could not install the reviewed policy.");
        setView(payload);
        toast.push("Reviewed policy installed. Real provider spend is now authorized on this machine.", "success");
      } catch (cause) {
        toast.push((cause as Error).message || "Could not install the reviewed policy.");
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const onRemove = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/production/policy", { method: "DELETE" });
      const payload = (await response.json()) as PolicyView & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Could not remove the reviewed policy.");
      setView(payload);
      toast.push("Reviewed policy removed. Paid generation is blocked again.");
    } catch (cause) {
      toast.push((cause as Error).message || "Could not remove the reviewed policy.");
    } finally {
      setBusy(false);
    }
  }, [toast]);

  return (
    <SectionShell
      icon="lock"
      title="Budget & authorization"
      description="Reviewed provider spend policy for paid generation"
    >
      <div data-testid="settings.budget.section">
        <StatusCard view={view} loadFailed={loadFailed} onRemove={() => setConfirmRemove(true)} busy={busy} />
        <InstallForm current={view?.policy ?? null} onInstall={onInstall} busy={busy} />
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the reviewed policy?"
        body="Paid provider generation returns to fail-closed immediately. Quotes and paid submissions stay blocked until another policy is installed."
        confirmLabel="Remove policy"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          onRemove();
        }}
      />
    </SectionShell>
  );
}

function StatusCard({
  view,
  loadFailed,
  onRemove,
  busy,
}: {
  view: PolicyView | null;
  loadFailed: boolean;
  onRemove: () => void;
  busy: boolean;
}) {
  const config = useMemo<PolicyConfig | null>(() => {
    const raw = view?.policy?.configCanonicalJson;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PolicyConfig;
    } catch {
      return null;
    }
  }, [view?.policy?.configCanonicalJson]);

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4" data-testid="settings.budget.status">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Current authorization</p>
      {loadFailed ? (
        <p className="mt-3 text-[12.5px] text-danger">Could not load the policy state. Is the studio server running?</p>
      ) : view === null ? (
        <p className="mt-3 text-[12.5px] text-muted">Loading…</p>
      ) : !view.configured || !view.policy ? (
        <div className="mt-3">
          <p className="flex items-start gap-1.5 rounded-[10px] bg-warning/10 px-2.5 py-2 text-[12px] font-medium text-warning">
            Not configured — paid provider generation is blocked (BUDGET_BLOCKED) everywhere.
          </p>
          <p className="mt-3 text-[11.5px] leading-snug text-muted">
            Install a reviewed policy below after reviewing the provider&apos;s current pricing. Until then, free
            built-in engines keep working and paid media proposals stay blocked.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
            <span className="text-muted">
              Provider <span className="font-semibold text-ink">{view.policy.providerId}</span>
            </span>
            <span className="text-muted">
              Review version <span className="font-semibold text-ink">{view.policy.reviewVersion}</span>
            </span>
            <span className="text-muted">
              Source <span className="break-all text-ink">{view.policy.sourceUrl}</span>
            </span>
            <span className="text-muted">
              Captured <span className="text-ink">{formatMs(view.policy.capturedAt)}</span>
            </span>
            <span className="text-muted">
              Expires <span className="text-ink">{formatMs(view.policy.expiresAt)}</span>
            </span>
          </div>
          {config ? (
            <div className="overflow-hidden rounded-[10px] border border-border">
              <table className="w-full text-left text-[11.5px]">
                <thead className="bg-raised text-muted">
                  <tr>
                    <th className="px-2.5 py-1.5 font-semibold">Model</th>
                    <th className="px-2.5 py-1.5 font-semibold">Operations</th>
                    <th className="px-2.5 py-1.5 font-semibold">Entitlement</th>
                    <th className="px-2.5 py-1.5 font-semibold">Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {config.priceByModel.map((price) => (
                    <tr key={price.modelId} className="border-t border-border">
                      <td className="px-2.5 py-1.5 font-medium text-ink">{price.modelId}</td>
                      <td className="px-2.5 py-1.5 text-muted">{price.operations.join(", ")}</td>
                      <td className="px-2.5 py-1.5 text-muted">
                        {price.entitlement} ({config.billingModeByModel.find((mode) => mode.modelId === price.modelId)?.billingMode ?? "?"})
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums text-muted">
                        {price.unit === "minor_currency"
                          ? `${(price.estimateMinMinor ?? 0) / 100}–${(price.estimateMaxMinor ?? 0) / 100} ${price.currency}`
                          : "spark tokens"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button variant="danger" size="sm" icon="trash" disabled={busy} onClick={onRemove} data-testid="settings.budget.remove">
              Remove authorization
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function InstallForm({
  current,
  onInstall,
  busy,
}: {
  current: InstalledPolicy | null;
  onInstall: (body: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [providerId, setProviderId] = useState(current?.providerId ?? "");
  const [reviewVersion, setReviewVersion] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceCapture, setSourceCapture] = useState("");
  const [configCanonicalJson, setConfigCanonicalJson] = useState("");
  const [capturedAt, setCapturedAt] = useState(toLocalInput(Date.now()));
  const [expiresAt, setExpiresAt] = useState("");
  const [consent, setConsent] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const ready =
    consent &&
    providerId.trim().length > 0 &&
    reviewVersion.trim().length > 0 &&
    sourceUrl.startsWith("https://") &&
    sourceCapture.length > 0 &&
    configCanonicalJson.length > 0 &&
    expiresAt.length > 0;

  async function submit() {
    const captured = new Date(capturedAt).getTime();
    const expires = new Date(expiresAt).getTime();
    if (!Number.isSafeInteger(captured) || !Number.isSafeInteger(expires) || expires <= captured) {
      setConfirmOpen(false);
      return;
    }
    const body = {
      providerId: providerId.trim(),
      reviewVersion: reviewVersion.trim(),
      sourceUrl: sourceUrl.trim(),
      sourceCapture,
      sourceCaptureSha256: await sha256Hex(sourceCapture),
      capturedAt: captured,
      expiresAt: expires,
      configCanonicalJson,
    };
    setConfirmOpen(false);
    await onInstall(body).catch(() => undefined);
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4" data-testid="settings.budget.install-form">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        {current ? "Rotate policy" : "Install policy"}
      </p>
      <p className="mt-2 rounded-[10px] bg-warning/10 px-2.5 py-2 text-[12px] font-medium text-warning">
        This authorizes real provider spend on this machine. Paste only a policy capture you have reviewed against
        the provider&apos;s current pricing page.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px] font-semibold text-ink-soft">
          Provider ID
          <input
            type="text"
            value={providerId}
            placeholder="sogni"
            aria-label="Provider ID"
            onChange={(event) => setProviderId(event.target.value)}
            className="mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] font-normal text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>
        <label className="block text-[12px] font-semibold text-ink-soft">
          Review version
          <input
            type="text"
            value={reviewVersion}
            placeholder="pricing-review-2026-10"
            aria-label="Review version"
            maxLength={80}
            onChange={(event) => setReviewVersion(event.target.value)}
            className="mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] font-normal text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>
      </div>
      <label className="mt-3 block text-[12px] font-semibold text-ink-soft">
        Policy source URL (HTTPS)
        <input
          type="url"
          value={sourceUrl}
          placeholder="https://…/pricing"
          aria-label="Policy source URL"
          maxLength={2048}
          onChange={(event) => setSourceUrl(event.target.value)}
          className="mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] font-normal text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px] font-semibold text-ink-soft">
          Captured at
          <input
            type="datetime-local"
            value={capturedAt}
            aria-label="Captured at"
            onChange={(event) => setCapturedAt(event.target.value)}
            className="mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] font-normal text-ink focus:border-primary focus:outline-none"
          />
        </label>
        <label className="block text-[12px] font-semibold text-ink-soft">
          Expires at
          <input
            type="datetime-local"
            value={expiresAt}
            aria-label="Expires at"
            onChange={(event) => setExpiresAt(event.target.value)}
            className="mt-1 h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] font-normal text-ink focus:border-primary focus:outline-none"
          />
        </label>
      </div>
      <div className="mt-3">
        <TextAreaField
          label="Captured policy text"
          value={sourceCapture}
          maxLength={CAPTURE_MAX}
          rows={4}
          placeholder="The verbatim pricing text you captured and reviewed."
          onChange={setSourceCapture}
        />
      </div>
      <div className="mt-3">
        <TextAreaField
          label="Canonical policy configuration JSON"
          value={configCanonicalJson}
          maxLength={CONFIG_MAX}
          rows={6}
          placeholder='{"schemaVersion":1,"providerId":"sogni",…} — canonical JSON (sorted keys, no whitespace).'
          onChange={setConfigCanonicalJson}
        />
      </div>
      <label className="mt-3 flex items-start gap-2 text-[12.5px] leading-snug text-ink-soft">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--primary)]"
          data-testid="settings.budget.consent"
        />
        <span>
          I reviewed the captured pricing against the provider&apos;s live page and approve the caps above.
          <span className="block font-semibold text-warning">This authorizes real provider spend on this machine.</span>
        </span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" disabled={!ready || busy} onClick={() => setConfirmOpen(true)} data-testid="settings.budget.install">
          {current ? "Replace policy" : "Install policy"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={current ? "Replace the reviewed policy?" : "Install the reviewed policy?"}
        body="This authorizes real provider spend on this machine for the policy's lifetime. Only continue if you reviewed the captured pricing yourself."
        confirmLabel="Authorize spend"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />
    </div>
  );
}
