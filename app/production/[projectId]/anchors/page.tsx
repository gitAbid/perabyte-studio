import type { Metadata } from "next";
import { AnchorsPanel } from "@/components/production/storyboard";

export const metadata: Metadata = {
  title: "Anchor candidates — PeraByte",
  description: "Per-shot anchor candidate histories with checklist-gated approvals and gated generation.",
};

export default async function ProductionAnchorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <AnchorsPanel projectId={projectId} />;
}
