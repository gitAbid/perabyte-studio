import type { Metadata } from "next";
import { WorkspaceCreateForm } from "@/components/workspaces/WorkspaceCreateForm";

export const metadata: Metadata = {
  title: "New workspace",
  description: "Create a workspace: name your show and set its rating, quality, shape, and language.",
};

export default function NewWorkspacePage() {
  return <WorkspaceCreateForm />;
}
