import type { Metadata } from "next";
import { ShotsPanel } from "@/components/production/storyboard";

export const metadata: Metadata = {
  title: "Storyboard — PeraByte",
  description: "Ordered shots with pinned canon provenance, exact stale notices and approval states.",
};

export default async function ProductionShotsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ShotsPanel projectId={projectId} />;
}
