import type { Metadata } from "next";
import { StoryStudioPanel } from "@/components/production/story/StoryStudioPanel";

export const metadata: Metadata = {
  title: "Story studio — PeraByte",
  description: "Turn an idea into a structured story: draft, revise conversationally with a visible diff, then approve.",
};

export default async function StoryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <StoryStudioPanel projectId={projectId} />;
}
