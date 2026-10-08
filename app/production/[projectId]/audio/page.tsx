import { AudioCueWorkspace } from "@/components/production/audio";

/** Thin server wrapper: the workspace fetches its own read model over HTTP. */
export default async function ProductionAudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <AudioCueWorkspace projectId={projectId} />;
}
