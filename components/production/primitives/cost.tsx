import { Badge, Button, Card } from "@/components/ui";
import { Icon } from "@/components/Icon";

/* ------------------------------------------------------------------ */
/* CostEstimateCard — UX spec §3 (cost before launch)                  */
/* ------------------------------------------------------------------ */
/* Shown BEFORE money is spent. Says what will be made, what it should */
/* cost, and asks for an explicit go-ahead. Plain numbers in the       */
/* currency's main unit (e.g. dollars); converting a frozen BudgetQuote */
/* minor-unit estimate into display numbers is the caller's job.       */

export type QualityStrategy = "economy" | "balanced" | "best";

const STRATEGY_LABELS: Record<QualityStrategy, string> = {
  economy: "Economy",
  balanced: "Balanced",
  best: "Best",
};

const STRATEGY_NOTES: Record<QualityStrategy, string> = {
  economy: "Lowest cost, a little less polish.",
  balanced: "Good quality at a fair cost.",
  best: "Top quality — costs a bit more and takes a bit longer.",
};

export interface CostEstimateLine {
  /** What goes into the cost, in creator language. */
  label: string;
  /** Preformatted amount for the row, e.g. "$1.20". */
  amount: string;
}

export interface CostEstimateCardProps {
  /** How many items this action will create (drives the headline). */
  itemCount: number;
  /** What is being created, singular noun, e.g. "video" — pluralized with "s". */
  itemNoun: string;
  /** Low end of the estimate, in the currency's main unit (e.g. dollars). */
  estimateMin: number;
  /** High end of the estimate, in the currency's main unit (e.g. dollars). */
  estimateMax: number;
  /** ISO code such as "USD" or a token name such as "Spark". */
  currency: string;
  /** How hard the system will work (CONTRACTS-FROZEN C4 vocabulary). */
  qualityStrategy: QualityStrategy;
  /** Human-readable breakdown rows shown under the headline. */
  breakdown?: CostEstimateLine[];
  /** Closing reassurance line. Defaults to the actual-cost promise. */
  note?: string;
  confirmLabel?: string;
  declineLabel?: string;
  onConfirm?: () => void;
  onDecline?: () => void;
  /** While the go-ahead is being processed both actions are disabled. */
  busy?: boolean;
  /** Stable test id base (feature.entity); buttons become `${testIdBase}.confirm` / `.decline`. */
  testIdBase?: string;
  className?: string;
}

function formatAmount(amount: number, currency: string): string {
  if (/^[a-z]{3}$/i.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(amount);
    } catch {
      // Unrecognized code — fall through to the plain suffix below.
    }
  }
  return `${amount} ${currency}`;
}

export function CostEstimateCard({
  itemCount,
  itemNoun,
  estimateMin,
  estimateMax,
  currency,
  qualityStrategy,
  breakdown,
  note,
  confirmLabel = "Start generating",
  declineLabel = "Not now",
  onConfirm,
  onDecline,
  busy = false,
  testIdBase = "cost.estimate",
  className = "",
}: CostEstimateCardProps) {
  const low = Math.min(estimateMin, estimateMax);
  const high = Math.max(estimateMin, estimateMax);
  const range =
    low === high
      ? formatAmount(low, currency)
      : `${formatAmount(low, currency)} – ${formatAmount(high, currency)}`;
  const noun = itemCount === 1 ? itemNoun : `${itemNoun}s`;

  return (
    // `Card` from components/ui takes no extra props, so the test id
    // lives on this wrapper section.
    <section data-testid={testIdBase} className={`w-full ${className}`}>
      <Card className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
          <Icon name="clock" size={13} />
          Before you spend
        </p>
        <Badge tone="primary">
          {STRATEGY_LABELS[qualityStrategy]} quality
        </Badge>
      </div>

      <p className="text-[15px] leading-[1.6] text-ink">
        This will generate {itemCount} {noun}, estimated{" "}
        <strong
          data-testid={`${testIdBase}.amount`}
          className="font-bold tabular-nums"
        >
          {range}
        </strong>
        .{" "}
        <span className="text-muted">{STRATEGY_NOTES[qualityStrategy]}</span>
      </p>

      {breakdown && breakdown.length > 0 && (
        <ul className="text-[13px]">
          {breakdown.map((line) => (
            <li
              key={line.label}
              className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0 first:pt-0"
            >
              <span className="text-ink-soft">{line.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-ink">
                {line.amount}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[12px] text-muted">
        {note ?? "You'll see the actual cost when it finishes."}
      </p>

      {(onConfirm || onDecline) && (
        <div className="flex flex-wrap gap-2">
          {onConfirm && (
            <Button
              size="sm"
              onClick={onConfirm}
              loading={busy}
              data-testid={`${testIdBase}.confirm`}
            >
              {confirmLabel}
            </Button>
          )}
          {onDecline && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onDecline}
              disabled={busy}
              data-testid={`${testIdBase}.decline`}
            >
              {declineLabel}
            </Button>
          )}
        </div>
      )}
      </Card>
    </section>
  );
}
