import { ExportWorkspace } from "@/components/production/export";

/** Thin server wrapper: the workspace fetches the read model and export details over HTTP. */
export const metadata = {
  title: "Export QC & download — PeraByte",
  description: "Measured export QC, human final review, and strictly separated final vs draft downloads.",
};

export default async function ProductionExportPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ExportWorkspace projectId={projectId} />;
}
