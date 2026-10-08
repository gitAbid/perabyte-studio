import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import type { AcceptanceRateProjection, ProductionMetricsSnapshot } from "@/lib/services/production/metrics";

/* ------------------------------------------------------------------ */
/* ProductionSummaryView — spec 01 §7 / M4 exit criteria (C19)         */
/* ------------------------------------------------------------------ */
/* Server-rendered metric cards computed at read time from metric      */
/* events plus cheap domain extras. Every card is honest: when the     */
/* data does not exist yet it says "Not enough data yet", never a      */
/* fabricated zero or green.                                           */
/* `Card` takes no extra props, so each test id lives on a wrapper.    */

const NO_DATA = "Not enough data yet";

function formatDuration(ms: number | null): string {
  if (ms === null) return NO_DATA;
  if (ms < 1_000) return `${ms} ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours} h`;
  return `${Math.round(totalHours / 24)} d`;
}

function formatMicros(micros: number | null): string {
  if (micros === null) return NO_DATA;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);
}

function formatRate(rate: number | null): string {
  if (rate === null) return NO_DATA;
  return `${Math.round(rate * 100)}%`;
}

function formatRatio(ratio: number | null, generated: number, selected: number | null): string {
  if (ratio === null || selected === null) return NO_DATA;
  return `${ratio.toFixed(1)}× (${generated} generated / ${selected} selected)`;
}

function MetricCard({
  testId, label, value, hint, badge,
}: {
  testId: string;
  label: string;
  value: string;
  hint: string;
  badge?: string;
}) {
  const missing = value === NO_DATA;
  return (
    <div data-testid={testId}>
      <Card as="section" className="flex h-full flex-col gap-2">
        <p className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
          {label}
          {badge && <Badge tone={missing ? "neutral" : "primary"}>{badge}</Badge>}
        </p>
        <p className={`text-[22px] font-bold tabular-nums ${missing ? "text-muted" : "text-ink"}`} data-testid={`${testId}.value`}>
          {value}
        </p>
        <p className="text-[12px] leading-relaxed text-muted">{hint}</p>
      </Card>
    </div>
  );
}

function AcceptanceCard({ testId, label, projection }: { testId: string; label: string; projection: AcceptanceRateProjection | undefined }) {
  const rate = projection ? projection.rate : null;
  const decisions = projection ? projection.approved + projection.rejected : 0;
  return (
    <MetricCard
      testId={testId}
      label={label}
      value={formatRate(rate)}
      badge="acceptance"
      hint={rate === null
        ? "Approved vs rejected decisions appear here once reviews are recorded for this asset kind."
        : `${projection!.approved} approved of ${decisions} recorded decisions.`}
    />
  );
}

export function ProductionSummaryView({
  projectId,
  snapshot,
}: {
  projectId: string;
  snapshot: ProductionMetricsSnapshot;
}) {
  const { projection } = snapshot;
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6" data-testid="summary.page">
      <nav className="mb-5">
        <Link
          href={`/production/${projectId}`}
          data-testid="summary.back"
          className="text-[13px] font-semibold text-primary hover:underline"
        >
          Back to project
        </Link>
      </nav>

      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-[19px] font-bold text-ink">Production summary</h1>
          <p className="mt-1 text-[13px] text-muted">
            {snapshot.project.name} · {projection.eventCount === 0 ? "No metric events recorded yet" : `${projection.eventCount} metric events`}
          </p>
        </div>
        <Badge tone="neutral">computed at read</Badge>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          testId="summary.metric.time-to-first-storyboard"
          label="Time to first storyboard"
          value={formatDuration(projection.timeToFirstStoryboardMs)}
          hint="From project creation to the first storyboard (active animatic, or shot plan before it exists)."
        />
        <MetricCard
          testId="summary.metric.time-to-first-cut"
          label="Time to first playable cut"
          value={formatDuration(projection.timeToFirstCutMs)}
          hint="From project creation to the first export that passed technical QC and is ready for review."
        />
        <MetricCard
          testId="summary.metric.generations"
          label="Generations"
          value={`${projection.generations.completed} done · ${projection.generations.failed} failed`}
          badge={`${projection.generations.manualPromptCount} manual`}
          hint="Completed vs failed generation jobs; the manual count is generations with no proposal linkage."
        />
        <AcceptanceCard
          testId="summary.metric.acceptance-character"
          label="Character identity acceptance"
          projection={projection.acceptanceRates.character}
        />
        <AcceptanceCard
          testId="summary.metric.acceptance-environment"
          label="Environment consistency acceptance"
          projection={projection.acceptanceRates.environment}
        />
        <AcceptanceCard
          testId="summary.metric.acceptance-storyboard"
          label="Storyboard acceptance"
          projection={projection.acceptanceRates.storyboard}
        />
        <MetricCard
          testId="summary.metric.generated-selected"
          label="Generated / selected"
          value={formatRatio(projection.generatedSelected.ratio, projection.generatedSelected.generated, projection.generatedSelected.selected)}
          hint="Completed generations per take selected into the delivered cut; lower means fewer tries per keep."
        />
        <MetricCard
          testId="summary.metric.cost-per-finished-minute"
          label="Cost per finished minute"
          value={formatMicros(projection.cost.perFinishedMinuteMicros)}
          badge={projection.cost.totalMicros > 0 ? `total ${formatMicros(projection.cost.totalMicros)}` : undefined}
          hint="Recorded generation cost scaled to one minute of delivered runtime; budget truth stays in the auditable ledger."
        />
        <MetricCard
          testId="summary.metric.review-time-median"
          label="Median review time"
          value={formatDuration(projection.reviewTimeMedianMs)}
          hint="Median time from a generated asset being recommended to its approval decision."
        />
      </div>
    </main>
  );
}
