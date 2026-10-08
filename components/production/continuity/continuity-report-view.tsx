import Link from "next/link";
import { Icon } from "@/components/Icon";
import { LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import type { ContinuityAspect, ContinuityFinding, ContinuityResult, ContinuityStatus } from "@/lib/production/continuity";
import {
  BASE_CONTINUITY_ASPECTS,
  CONTINUITY_STATUS_PHRASE,
  firstFailingFinding,
  labelForAspect,
  summarizeRowStatuses,
  type ContinuityReportRow,
  type ContinuitySummary,
} from "./continuity-model";
import { ContinuityChip } from "./continuity-chip";
import { RerollButton } from "./reroll-button";

/* ------------------------------------------------------------------ */
/* ContinuityReportView — spec 11 §6 (production-level report)         */
/* ------------------------------------------------------------------ */
/*
 * Calm, per-shot continuity grid: one row per shot, one column per checked
 * aspect (identity, outfit, environment, lighting first — the report is
 * inherently tabular, which the design system allows). Advisory only:
 * there are no approve/reject controls. "Re-roll with guidance" queues a new
 * take guided by the row's worst failing finding via the re-roll endpoint and
 * confirms inline; nothing is approved, selected or spent by the press.
 *
 * The grid stays server-rendered; only the re-roll button is a client island.
 */

const CELL_STYLES: Record<ContinuityStatus, string> = {
  pass: "text-success",
  warn: "text-warning",
  fail: "text-warning",
  not_checked: "text-muted",
};

const CELL_ICONS: Record<ContinuityStatus, "check" | "alert" | null> = {
  pass: "check",
  warn: "alert",
  fail: "alert",
  not_checked: null,
};

const CELL_LABELS: Record<ContinuityStatus, string> = {
  pass: "Consistent",
  warn: "Check",
  fail: "Mismatch",
  not_checked: "—",
};

/** Aspect columns in stable order: the four base dimensions first, then any extras in first-seen order. */
function aspectColumns(rows: readonly ContinuityReportRow[]): ContinuityAspect[] {
  const columns: ContinuityAspect[] = [];
  const push = (aspect: ContinuityAspect) => {
    if (!columns.includes(aspect)) columns.push(aspect);
  };
  for (const aspect of BASE_CONTINUITY_ASPECTS) {
    if (rows.some((row) => row.result.findings.some((finding) => finding.aspect === aspect))) push(aspect);
  }
  for (const row of rows) {
    for (const finding of row.result.findings) push(finding.aspect);
  }
  return columns;
}

function findingFor(row: ContinuityReportRow, aspect: ContinuityAspect): ContinuityFinding | null {
  return row.result.findings.find((finding) => finding.aspect === aspect) ?? null;
}

export interface ContinuityReportViewProps {
  /** Owning project, used for links and empty-state actions. */
  projectId: string;
  /** One row per shot, in report order; `result` is the frozen engine output. */
  rows: readonly ContinuityReportRow[];
  /** Counts from the frozen `summarizeContinuity`; recomputed from rows when omitted. */
  summary?: ContinuitySummary;
  className?: string;
}

export function ContinuityReportView({ projectId, rows, summary, className = "" }: ContinuityReportViewProps) {
  if (rows.length === 0) {
    return (
      <div data-testid="continuity.report" className={className}>
        <EmptyState
          icon="story"
          title="No shots to check yet"
          body="Build a storyboard with shots first, then PeraByte can watch identity, outfit, environments and lighting as you generate — advisory only, you stay in charge."
          testId="continuity.empty"
          action={
            <LinkButton href={`/production/${projectId}/storyboard`} size="sm">
              Open the storyboard
            </LinkButton>
          }
        />
      </div>
    );
  }

  const counts: ContinuitySummary = summary ?? summarizeRowStatuses(rows);
  const columns = aspectColumns(rows);
  const attentionRows = rows.filter((row) => row.result.status === "warn" || row.result.status === "fail");
  const checkedAnything = counts.notChecked < rows.length;

  const summaryParts: string[] = [];
  if (counts.pass > 0) summaryParts.push(`${counts.pass} ${counts.pass === 1 ? "shot" : "shots"} consistent`);
  if (counts.warn > 0) summaryParts.push(`${counts.warn} worth a look`);
  if (counts.fail > 0) summaryParts.push(`${counts.fail} ${counts.fail === 1 ? "mismatch" : "mismatches"}`);
  if (counts.notChecked > 0) summaryParts.push(`${counts.notChecked} not checked`);

  return (
    <div data-testid="continuity.report" className={`flex w-full flex-col gap-6 ${className}`}>
      <header className="flex flex-col gap-2">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">Continuity report</h1>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
            A calm look at whether characters, outfits, environments and lighting hold steady from
            shot to shot. Advisory only — nothing is approved or rejected automatically.
          </p>
        </div>
        <p data-testid="continuity.summary" className="text-[13px] font-medium text-ink-soft">
          {checkedAnything
            ? summaryParts.join(" · ")
            : "Continuity checks haven't run for this production yet — nothing here is scored."}
        </p>
      </header>

      <div className="overflow-x-auto rounded-[12px] border border-border bg-raised shadow-card">
        <table data-testid="continuity.grid" className="w-full min-w-[560px] border-collapse text-left">
          <caption className="sr-only">
            Continuity checks by shot and aspect. Advisory only; nothing is approved or rejected automatically.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-5 py-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
                Shot
              </th>
              {columns.map((aspect) => (
                <th
                  key={aspect}
                  scope="col"
                  className="px-5 py-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted"
                >
                  {labelForAspect(aspect)}
                </th>
              ))}
              <th scope="col" className="px-5 py-3.5 text-right text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
                <span className="sr-only">Status</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.shotId} data-testid="continuity.shot" data-shot-id={row.shotId} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-5 py-4 align-top">
                  {row.shotHref ? (
                    <Link
                      href={row.shotHref}
                      className="text-[13px] font-semibold text-ink underline-offset-4 hover:text-primary hover:underline"
                    >
                      {row.shotLabel}
                    </Link>
                  ) : (
                    <span className="text-[13px] font-semibold text-ink">{row.shotLabel}</span>
                  )}
                </th>
                {columns.map((aspect) => {
                  const finding = findingFor(row, aspect);
                  const status: ContinuityStatus = finding?.status ?? "not_checked";
                  return (
                    <td
                      key={aspect}
                      data-testid="continuity.aspect"
                      data-aspect={aspect}
                      title={finding?.note ?? "Not checked — this stays clearly marked, never green."}
                      className={`px-5 py-4 align-top text-[12px] font-semibold ${CELL_STYLES[status]}`}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {CELL_ICONS[status] && <Icon name={CELL_ICONS[status]!} size={13} aria-hidden="true" />}
                        <span aria-hidden="true">{CELL_LABELS[status]}</span>
                        <span className="sr-only">{CONTINUITY_STATUS_PHRASE[status]}</span>
                      </span>
                    </td>
                  );
                })}
                <td className="px-5 py-4 text-right align-top">
                  <ContinuityChip result={row.result} testId={`continuity.chip.${row.shotId}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {attentionRows.length > 0 && (
        <section aria-label="Shots that need a look" className="flex flex-col gap-4">
          {attentionRows.map((row) => {
            const failing = row.result.findings.filter((finding) => finding.status === "warn" || finding.status === "fail");
            const guidance = firstFailingFinding(row.result);
            const repairs = row.repairs ?? [];
            const worstRepair = repairs.find((repair) => repair.aspect === guidance?.aspect) ?? repairs[0] ?? null;
            return (
              <div
                key={row.shotId}
                data-testid="continuity.shot.detail"
                data-shot-id={row.shotId}
                className="rounded-[12px] border border-border bg-surface px-5 py-4"
              >
                <p className="text-[13px] font-bold text-ink">{row.shotLabel}</p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {(repairs.length > 0 ? repairs.map((repair) => ({ aspect: repair.aspect, text: repair.line })) : failing.map((finding) => ({ aspect: finding.aspect, text: finding.note }))).map((item) => (
                    <li key={item.aspect} className="text-[13px] leading-relaxed text-ink-soft" data-testid="continuity.shot.repair-line">
                      <span className="font-semibold text-ink">{labelForAspect(item.aspect)}:</span> {item.text}
                    </li>
                  ))}
                </ul>
                {row.hasAnchor && guidance ? (
                  <RerollButton projectId={projectId} shotId={row.shotId} guidance={guidance} note={worstRepair?.note} />
                ) : (
                  <p className="mt-3 text-[12px] text-muted">
                    {row.hasAnchor
                      ? "This shot has no failing check to guide a re-roll."
                      : "This shot has no anchor yet, so there's nothing to re-roll — generate one from the storyboard first."}
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}

      <p data-testid="continuity.advisory-note" className="text-[12px] text-muted">
        Continuity is advisory: it never approves or rejects a shot on its own, and a failed check
        can't erase anything you've generated.
      </p>
    </div>
  );
}
