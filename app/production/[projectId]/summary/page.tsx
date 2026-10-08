import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IdSchema } from "@/lib/production/contracts";
import { withProductionStore } from "@/lib/production/runtime";
import { loadProductionMetricsSnapshot } from "@/lib/services/production/metrics";
import { ProductionSummaryView } from "@/components/production/summary/production-summary-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Production summary — PeraByte",
  description:
    "Product metrics for this production: acceptance rates, generated/selected ratio, cost per finished minute, time to first storyboard and cut.",
};

/**
 * Pure-read server page (C19): metric cards are computed at read time from the
 * project's metric events plus cheap domain extras. Unknown or invalid project
 * IDs 404; a project without any events still renders with honest empty cards.
 */
export default async function ProductionSummaryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!IdSchema.safeParse(projectId).success) notFound();
  const snapshot = await withProductionStore((store) => loadProductionMetricsSnapshot(store, projectId));
  if (!snapshot) notFound();
  return <ProductionSummaryView projectId={projectId} snapshot={snapshot} />;
}
