import type { Metadata } from "next";
import { StoryboardView } from "@/components/production/storyboard-view/StoryboardView";

export const metadata: Metadata = {
  title: "Storyboard — PeraByte",
  description: "Plan the film scene by scene: shots under each scene, anchor-first generation, approvals and stale indicators.",
};

export default async function ProductionStoryboardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <StoryboardView projectId={projectId} />;
}
