import type { Metadata } from "next";
import { CanonEditorPanel } from "@/components/production/project-canon";

export const metadata: Metadata = {
  title: "Canon editor — PeraByte",
  description: "Reusable cast and world canon revisions with provenance and stale notices.",
};

export default async function CanonPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <CanonEditorPanel projectId={projectId} />;
}
