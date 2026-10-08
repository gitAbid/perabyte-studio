import type { Metadata } from "next";
import { ScriptEditorPanel } from "@/components/production/project-canon";

export const metadata: Metadata = {
  title: "Script editor — PeraByte",
  description: "Import and revise the script; every save creates a new immutable story revision.",
};

export default async function ScriptPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ScriptEditorPanel projectId={projectId} />;
}
