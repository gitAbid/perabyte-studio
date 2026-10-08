import type { Metadata } from "next";
import { TakesPanel } from "@/components/production/storyboard";

export const metadata: Metadata = {
  title: "Take siblings — PeraByte",
  description: "Retake siblings with distinct reversible selection and checklist-gated decisions.",
};

export default async function ProductionTakesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <TakesPanel projectId={projectId} />;
}
