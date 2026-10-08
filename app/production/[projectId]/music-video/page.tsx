import Link from "next/link";
import { notFound } from "next/navigation";
import { IdSchema } from "@/lib/production/contracts";
import { MusicVideoPanel } from "@/components/production/music-video/music-video-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Music video — PeraByte" };

export default async function MusicVideoPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!IdSchema.safeParse(projectId).success) notFound();
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6" data-testid="music-video.page">
      <nav className="text-[12px] text-muted">
        <Link href={`/production/${projectId}`} className="text-primary hover:underline">← Back to project</Link>
      </nav>
      <header className="mt-3 border-b border-border pb-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Production / Music video</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink">Create music video</h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
          Import your song (with its rights declared), split it into sections, and each section becomes a beat of
          the same storyboard every episode uses — one shared path, no separate pipeline. Timing follows the song,
          never narration. Beat-level sync stays out until a detector earns it.
        </p>
      </header>
      <MusicVideoPanel projectId={projectId} />
    </main>
  );
}
