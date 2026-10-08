import type { Metadata } from "next";
import { WorkspaceDetailView } from "@/components/workspaces/WorkspaceDetailView";

export const metadata: Metadata = {
  title: "Workspace",
  description: "One show's home: cast, environments, World Bible, production recipe, and episodes.",
};

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkspaceDetailView workspaceId={id} />;
}
