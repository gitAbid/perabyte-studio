import Link from "next/link";
import { notFound } from "next/navigation";
import { IdSchema } from "@/lib/production/contracts";
import { listProjectAutoRuns } from "@/lib/services/production/auto-run";
import { withProductionStore } from "@/lib/production/runtime";
import { ProductionApplicationError } from "@/lib/production/errors";
import { AutoRunPanel } from "@/components/production/auto-run/auto-run-panel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Auto Draft — PeraByte" };

export default async function AutoRunPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!IdSchema.safeParse(projectId).success) notFound();
  const loaded = await withProductionStore((store) => {
    const found = store.read.getProject(projectId);
    if (!found) return null;
    return { project: { id: found.id, name: found.name }, runs: listProjectAutoRuns(store, projectId) };
  }).catch((error: unknown) => {
    if (error instanceof ProductionApplicationError && error.code === "UNKNOWN_REFERENCE") return null;
    throw error;
  });
  if (!loaded) notFound();
  const { project, runs } = loaded;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6" data-testid="auto-run.page">
      <nav className="text-[12px] text-muted">
        <Link href={`/production/${projectId}`} className="text-primary hover:underline">
          ← {project.name}
        </Link>
      </nav>
      <header className="mt-3 border-b border-border pb-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Production / Auto Draft</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink">Create episode ✨</h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
          One sentence in, a rough first cut out. PeraByte writes the story draft, builds the storyboard, and
          tracks generation — you stay in charge of every approval and every paid step.
        </p>
      </header>
      <AutoRunPanel projectId={projectId} initialRuns={runs} />
    </main>
  );
}
