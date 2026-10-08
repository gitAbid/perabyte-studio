"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { QuoteSchema, type CreateQuoteCommand, type ProductionQuote } from "@/lib/production/contracts";
import type { ProjectBudgetReadModel } from "@/lib/services/production/budget";
import { CostEstimateCard, type QualityStrategy } from "@/components/production/primitives/cost";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { formatMainAmount, minorUnitsToMain } from "./money";

/* ------------------------------------------------------------------ */
/* BatchCostGate — spec 17 §5/§8 (estimate before any batch spend)     */
/* ------------------------------------------------------------------ */
/*
 * Wrap ANY batch action with this gate: it asks the existing quotes API for a
 * real quote for the requested batch, converts the frozen minor-unit estimate
 * into main-unit numbers, and renders CostEstimateCard. Confirm proceeds to
 * the lane's `onConfirm`; Decline calls `onDecline` so the lane can close the
 * gate. No estimate, no spend: while the quote is loading or unavailable the
 * confirm path simply doesn't exist yet (spec 17 §8 "Cost unavailable").
 *
 * The workspace budget policy line is display-only (task boundary): the gate
 * reads the project budget read model after a priced quote and renders one
 * calm line with a /settings link. Backend authorization stays the real
 * authority; when the quote itself says `withinAuthorizedCap: "no"` the gate
 * blocks its own confirm button and explains, per spec 17 §8.
 */

export interface BatchCostGateBudgetPolicy {
  /** Cap in minor units (cents), matching the frozen budget kernel vocabulary. */
  capMinorUnits: number | null;
  /** ISO code such as "USD", or a token name such as "Spark". */
  currency: string;
  /** Cadence phrase rendered after the amount, e.g. "per day" or "per production". */
  periodLabel: string;
}

export interface BatchCostGateProps {
  projectId: string;
  /** How many items the batch creates (drives the headline and the scaled estimate). */
  itemCount: number;
  /** What is being created, singular noun, e.g. "video" — pluralized by the card. */
  itemNoun: string;
  /**
   * The per-item quote request, exactly the frozen `CreateQuoteCommand` minus
   * `projectId`. The gate fetches one quote for these parameters and scales
   * the estimate by `itemCount` for the batch total.
   */
  quoteRequest: Omit<CreateQuoteCommand, "projectId">;
  /** Runs the actual batch action. Only reachable after an estimate is shown. */
  onConfirm: () => void | Promise<void>;
  /** Called when the creator declines; the lane decides what closing means. */
  onDecline?: () => void;
  /** Advisory quote callback (e.g. to keep the quoteId for the real job submission). */
  onQuote?: (quote: ProductionQuote | null) => void;
  /** Quality strategy badge (CONTRACTS-FROZEN C4 vocabulary); defaults to "balanced". */
  qualityStrategy?: QualityStrategy;
  /**
   * Explicit workspace budget policy line, already known to the lane. Omit to
   * let the gate look it up automatically from the project budget read model;
   * pass `null` to hide the line entirely. Display-only either way.
   */
  budgetPolicy?: BatchCostGateBudgetPolicy | null;
  /** Turn off the automatic policy lookup (default: on). */
  showWorkspacePolicy?: boolean;
  confirmLabel?: string;
  declineLabel?: string;
  /** Stable test id base; buttons become `${testIdBase}.estimate.confirm` etc. */
  testIdBase?: string;
  className?: string;
}

/** A quote the gate can actually display: priced and currency-scoped. */
type DisplayableQuote = ProductionQuote & {
  estimateMinMinor: number;
  estimateMaxMinor: number;
  currency: string;
};

type QuotePhase =
  | { phase: "loading" }
  | { phase: "ready"; quote: DisplayableQuote }
  | { phase: "unavailable"; message: string; budgetBlocked: boolean };

type QuoteOutcome =
  | { ok: true; quote: DisplayableQuote }
  | { ok: false; message: string; budgetBlocked: boolean };

function quoteFailureMessage(status: number): { message: string; budgetBlocked: boolean } {
  if (status === 403) {
    return {
      message: "The budget policy for this workspace blocks new spending right now. Nothing was spent — you can review the limits in budget settings.",
      budgetBlocked: true,
    };
  }
  if (status === 404) {
    return { message: "This project can't be priced right now — it may have been removed. Nothing was spent.", budgetBlocked: false };
  }
  if (status === 400 || status === 422) {
    return { message: "These batch settings can't be priced as-is. Nothing was spent — check the generation settings and try again.", budgetBlocked: false };
  }
  return { message: "The cost estimate is unavailable right now. Nothing was spent — try again in a moment.", budgetBlocked: false };
}

async function requestQuote(command: CreateQuoteCommand): Promise<QuoteOutcome> {
  try {
    const response = await fetch("/api/production/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      cache: "no-store",
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = quoteFailureMessage(response.status);
      return { ok: false, ...failure };
    }
    const parsed = QuoteSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        message: "The cost estimate came back in a shape we don't understand, so nothing was estimated. Your project is safe — try again in a moment.",
        budgetBlocked: false,
      };
    }
    const quote = parsed.data;
    if (quote.estimateMinMinor === null || quote.estimateMaxMinor === null || quote.currency === null) {
      return {
        ok: false,
        message: "The provider couldn't price this batch yet, so there's no estimate to show. Nothing was spent — try again in a moment.",
        budgetBlocked: false,
      };
    }
    return { ok: true, quote: quote as DisplayableQuote };
  } catch {
    return {
      ok: false,
      message: "We couldn't reach the cost service, so nothing was estimated. Your project is safe — try again in a moment.",
      budgetBlocked: false,
    };
  }
}

/** One calm display line from the project budget read model; null hides the line. */
function policyLineFromReadModel(readModel: ProjectBudgetReadModel | null, currency: string): string | null {
  const dailyCap = readModel?.policy?.dailyCap;
  if (typeof dailyCap === "number") {
    if (dailyCap === 0) return "New spending is paused for this workspace.";
    return `Workspace daily limit: ${formatMainAmount(minorUnitsToMain(dailyCap), currency)} per day`;
  }
  const projectCap = readModel?.authorization?.projectCap;
  if (typeof projectCap === "number") {
    const used = readModel?.projectTotals?.totalLiability;
    const usedPart = typeof used === "number" ? `, ${formatMainAmount(minorUnitsToMain(used), currency)} used` : "";
    return `Project budget: ${formatMainAmount(minorUnitsToMain(projectCap), currency)}${usedPart}`;
  }
  return null;
}

async function fetchWorkspacePolicyLine(projectId: string, providerId: string, currency: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ providerId, unit: "minor_currency", currency });
    const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/budget?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const readModel = (await response.json().catch(() => null)) as ProjectBudgetReadModel | null;
    return policyLineFromReadModel(readModel, currency);
  } catch {
    return null; // Display-only line: a failed lookup never blocks the preflight.
  }
}

export function BatchCostGate({
  projectId,
  itemCount,
  itemNoun,
  quoteRequest,
  onConfirm,
  onDecline,
  onQuote,
  qualityStrategy = "balanced",
  budgetPolicy,
  showWorkspacePolicy = true,
  confirmLabel,
  declineLabel,
  testIdBase = "cost.batch",
  className = "",
}: BatchCostGateProps) {
  const [quotePhase, setQuotePhase] = useState<QuotePhase>({ phase: "loading" });
  const [policyText, setPolicyText] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;

  // Stable request identity: lanes may pass an inline object literal.
  const requestKey = useMemo(() => JSON.stringify({ projectId, ...quoteRequest }), [projectId, quoteRequest]);

  useEffect(() => {
    let stopped = false;
    setQuotePhase({ phase: "loading" });
    setPolicyText(null);
    setConfirmError(null);
    void (async () => {
      const command = JSON.parse(requestKey) as CreateQuoteCommand;
      const outcome = await requestQuote(command);
      if (stopped) return;
      if (outcome.ok) {
        setQuotePhase({ phase: "ready", quote: outcome.quote });
        onQuoteRef.current?.(outcome.quote);
      } else {
        setQuotePhase({ phase: "unavailable", message: outcome.message, budgetBlocked: outcome.budgetBlocked });
        onQuoteRef.current?.(null);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [requestKey, reloadToken]);

  // Display-only workspace policy line: auto-lookup after a priced, currency-scoped quote.
  useEffect(() => {
    if (budgetPolicy !== undefined || !showWorkspacePolicy) return;
    if (quotePhase.phase !== "ready") return;
    const { providerId, currency } = quotePhase.quote;
    let stopped = false;
    void fetchWorkspacePolicyLine(projectId, providerId, currency).then((line) => {
      if (!stopped) setPolicyText(line);
    });
    return () => {
      stopped = true;
    };
  }, [quotePhase, budgetPolicy, showWorkspacePolicy, projectId]);

  const handleConfirm = useCallback(async () => {
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await onConfirm();
    } catch {
      setConfirmError("Starting the batch didn't work. Anything that did start is still safe — you can try again.");
    } finally {
      setConfirmBusy(false);
    }
  }, [onConfirm]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const explicitPolicyText = useMemo(() => {
    if (budgetPolicy === undefined || budgetPolicy === null) return null;
    if (budgetPolicy.capMinorUnits === null) return "No workspace budget limit is set for this production.";
    return `Workspace limit: ${formatMainAmount(minorUnitsToMain(budgetPolicy.capMinorUnits), budgetPolicy.currency)} ${budgetPolicy.periodLabel}`;
  }, [budgetPolicy]);

  const base = testIdBase;

  if (quotePhase.phase === "loading") {
    return (
      <section data-testid={base} aria-label="Cost before you spend" className={`w-full ${className}`}>
        <Card className="flex w-full flex-col gap-2">
          <p role="status" data-testid={`${base}.loading`} className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
            <Icon name="clock" size={14} aria-hidden="true" className="animate-pulse" />
            Checking the cost before anything runs…
          </p>
        </Card>
      </section>
    );
  }

  if (quotePhase.phase === "unavailable") {
    return (
      <section data-testid={base} aria-label="Cost before you spend" className={`w-full ${className}`}>
        <Card className="flex w-full flex-col gap-3">
          <p className="flex items-center gap-2 text-[13px] font-bold text-ink">
            <Icon name="alert" size={15} aria-hidden="true" className="text-warning" />
            Cost estimate unavailable
          </p>
          <p role="alert" data-testid={`${base}.unavailable`} className="text-[13px] leading-relaxed text-ink-soft">
            {quotePhase.message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon="refresh" onClick={reload} data-testid={`${base}.retry`}>
              Try again
            </Button>
            {quotePhase.budgetBlocked && (
              <Link href="/settings" className="text-[13px] text-primary hover:underline">
                Budget settings
              </Link>
            )}
            {onDecline && (
              <Button size="sm" variant="ghost" onClick={onDecline} data-testid={`${base}.decline`}>
                Not now
              </Button>
            )}
          </div>
        </Card>
      </section>
    );
  }

  const { quote } = quotePhase;
  const overCap = quote.withinAuthorizedCap === "no";
  const perItemMin = minorUnitsToMain(quote.estimateMinMinor);
  const perItemMax = minorUnitsToMain(quote.estimateMaxMinor);
  const totalMinMinor = quote.estimateMinMinor * itemCount;
  const totalMaxMinor = quote.estimateMaxMinor * itemCount;
  const scalablyPriced = Number.isSafeInteger(totalMinMinor) && Number.isSafeInteger(totalMaxMinor);

  if (!scalablyPriced) {
    return (
      <section data-testid={base} aria-label="Cost before you spend" className={`w-full ${className}`}>
        <Card className="flex w-full flex-col gap-3">
          <p role="alert" data-testid={`${base}.unavailable`} className="text-[13px] leading-relaxed text-ink-soft">
            This batch is too large to price in one estimate. Nothing was spent — split it into smaller batches.
          </p>
          {onDecline && (
            <Button size="sm" variant="ghost" onClick={onDecline} data-testid={`${base}.decline`}>
              Not now
            </Button>
          )}
        </Card>
      </section>
    );
  }

  const note = overCap
    ? "This estimate is above what's authorized for this project, so it can't start until the limit is raised. Nothing was spent."
    : quote.entitlement === "spark"
      ? "This batch runs on your Spark credits. You'll see the actual total when it finishes."
      : undefined;

  const policyLine = budgetPolicy === undefined ? policyText : explicitPolicyText;

  return (
    <section data-testid={base} aria-label="Cost before you spend" className={`w-full ${className}`}>
      <CostEstimateCard
        itemCount={itemCount}
        itemNoun={itemNoun}
        estimateMin={minorUnitsToMain(totalMinMinor)}
        estimateMax={minorUnitsToMain(totalMaxMinor)}
        currency={quote.currency}
        qualityStrategy={qualityStrategy}
        breakdown={
          itemCount > 1
            ? [
                {
                  label: `Per ${itemNoun}`,
                  amount: `${formatMainAmount(perItemMin, quote.currency)} – ${formatMainAmount(perItemMax, quote.currency)} each`,
                },
              ]
            : undefined
        }
        note={note}
        confirmLabel={confirmLabel}
        declineLabel={declineLabel}
        onConfirm={overCap ? undefined : handleConfirm}
        onDecline={onDecline}
        busy={confirmBusy}
        testIdBase={`${base}.estimate`}
      />

      {overCap && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <Button
            size="sm"
            disabled
            data-testid={`${base}.estimate.confirm`}
          >
            {confirmLabel ?? "Start generating"}
          </Button>
          <span className="text-[12px] text-muted">
            Raise the limit in <Link href="/settings" className="text-primary hover:underline">budget settings</Link> to continue.
          </span>
        </div>
      )}

      {confirmError && (
        <p role="alert" data-testid={`${base}.error`} className="mt-2 px-1 text-[13px] font-medium text-danger">
          {confirmError}
        </p>
      )}

      {policyLine && (
        <p data-testid={`${base}.policy`} className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-[12px] text-muted">
          <Icon name="sliders" size={13} aria-hidden="true" className="shrink-0" />
          <span>{policyLine}</span>
          <span aria-hidden="true">·</span>
          <Link href="/settings" className="text-primary hover:underline">
            Budget settings
          </Link>
        </p>
      )}
    </section>
  );
}
