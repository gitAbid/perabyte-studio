import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IdSchema } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { withProductionStore } from "@/lib/production/runtime";
import { checkContinuity, summarizeContinuity, type ContinuityInput } from "@/lib/production/continuity";
import { continuityCheckEntries } from "@/lib/production/continuity";
import { repairGuidance } from "@/lib/production/continuity-guidance";
import { getProjectReadModel, type ProjectReadModelWithScenes } from "@/lib/services/production/revisions";
import { Card } from "@/components/ui";
import {
  ContinuityReportView,
  type ContinuityReportRow,
  type ContinuitySummary,
} from "@/components/production/continuity";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Continuity report — PeraByte",
  description:
    "A calm, per-shot look at whether characters, outfits, environments and lighting stay consistent. Advisory only — you approve every shot.",
};

/**
 * Runs the frozen continuity engine (`checkContinuity`) per shot against the
 * project read model. Each shot's structured scene states come from its scene
 * record (joined via `shotRevision.sceneId` → the projected `scenes` array):
 * `scene.characterStates` / `scene.environmentState` feed `sceneStates` so the
 * engine produces real pass/warn/fail findings, no UI change. A shot without a
 * scene link (or a scene with no pinned states) still answers with honest
 * `not_checked` findings — spec 11 §8: unsupported dimensions display "Not
 * checked", never green.
 */
function buildContinuityReport(
  projectId: string,
  readModel: ProjectReadModelWithScenes,
): { rows: ContinuityReportRow[]; summary: ContinuitySummary } {
  // The frozen projection (spec 11 §9) is the single source for ordering, scene
  // labels and take identifiers — the repair guidance shares it verbatim.
  const entries = continuityCheckEntries(readModel);
  const rows = entries.map((entry) => {
    const result = checkContinuity(entry.input);
    const repairs = repairGuidance({
      shotId: entry.shotId,
      sceneNumber: entry.sceneNumber,
      sceneTitle: entry.sceneTitle,
      selectedTakeId: entry.selectedTakeId,
      input: entry.input,
      result,
    });
    return {
      shotId: entry.shotId,
      shotLabel: `Shot ${entry.shotId}`,
      shotHref: `/production/${projectId}/storyboard`,
      hasAnchor: entry.hasAnchor,
      result,
      sceneNumber: entry.sceneNumber,
      sceneTitle: entry.sceneTitle,
      selectedTakeId: entry.selectedTakeId,
      repairs,
    };
  });
  return { rows, summary: summarizeContinuity(rows.map((row) => row.result)) };
}

function ContinuityLoadErrorPanel({ projectId }: { projectId: string }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      {/* `Card` takes no extra props, so the test id lives on this wrapper. */}
      <div data-testid="continuity.error">
        <Card className="flex flex-col gap-3">
          <h1 className="text-[17px] font-bold text-ink">The continuity report couldn&apos;t load</h1>
          <p className="text-[14px] leading-relaxed text-ink-soft">
            Your project and every shot are safe. Reload the page to try again — if it keeps
            happening, check back in a little while.
          </p>
          <Link href={`/production/${projectId}`} className="text-[13px] text-primary hover:underline">
            Back to the project
          </Link>
        </Card>
      </div>
    </main>
  );
}

export default async function ContinuityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!IdSchema.safeParse(projectId).success) notFound();

  const readModel = await withProductionStore((store) => {
    try {
      return getProjectReadModel(store, projectId, { includeScenes: true });
    } catch (error) {
      if (error instanceof ProductionApplicationError && error.code === "UNKNOWN_REFERENCE") return null;
      throw error;
    }
  });

  if (readModel === null) notFound();

  try {
    const { rows, summary } = buildContinuityReport(projectId, readModel);
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <nav className="mb-5">
          <Link
            href={`/production/${projectId}`}
            data-testid="continuity.back"
            className="text-[13px] font-semibold text-primary hover:underline"
          >
            Back to project
          </Link>
        </nav>
        <ContinuityReportView projectId={projectId} rows={rows} summary={summary} />
      </main>
    );
  } catch {
    return <ContinuityLoadErrorPanel projectId={projectId} />;
  }
}
