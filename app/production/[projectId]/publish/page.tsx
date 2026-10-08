import { PublishView } from "@/components/production/publish";

/**
 * Publish & Export Alpha (spec 15): master MP4 export plus the manual publication package.
 * Export-only by design — no YouTube OAuth and no direct publishing; the workspace speaks HTTP
 * through the same frozen export/QC/download routes as the legacy export page it succeeds.
 */
export const metadata = {
  title: "Publish & export — PeraByte",
  description:
    "Export the master MP4, run the technical checks, and download the complete manual publication package. PeraByte never uploads anything for you.",
};

export default async function ProductionPublishPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PublishView projectId={projectId} />;
}
