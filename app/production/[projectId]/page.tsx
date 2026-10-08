import type { Metadata } from "next";
import { ProjectOverviewPanel } from "@/components/production/project-canon";

export const metadata: Metadata = {
  title: "Production project — PeraByte",
  description: "Project overview: active revisions, provenance and stale downstream work.",
};

export default async function ProductionProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectOverviewPanel projectId={projectId} />;
}
