import type { Metadata } from "next";
import { PlanBuilderPanel } from "@/components/production/plan-builder";

export const metadata: Metadata = {
  title: "Plan builder — PeraByte",
  description: "Build the shot plan and animatic from the approved story, then approve both.",
};

export default async function ProductionPlanPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PlanBuilderPanel projectId={projectId} />;
}
