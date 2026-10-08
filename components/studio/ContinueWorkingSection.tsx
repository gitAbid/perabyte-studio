import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import {
  type StudioProductionStage,
  type StudioProductionSummary,
} from "@/lib/studio/home-read-model";

/**
 * "Continue working" — the first returning-user affordance (spec 04 goal 1).
 * Server component: renders straight from the read model, no client state.
 *
 * Empty state teaches the FIRST step only (create a workspace, acceptance
 * test 1); provider/model vocabulary never appears here.
 */

type StagePresentation = {
  badge: string;
  tone: "neutral" | "primary" | "success" | "warning";
  /** Calm CTA. A ready first cut says "Review Episode" (spec 04 section 8). */
  cta: string;
};

const STAGE_PRESENTATION: Record<StudioProductionStage, StagePresentation> = {
  drafting: { badge: "Drafting", tone: "neutral", cta: "Resume" },
  in_progress: { badge: "In progress", tone: "primary", cta: "Resume" },
  first_cut_ready: { badge: "First cut ready", tone: "success", cta: "Review Episode" },
  needs_attention: { badge: "Needs attention", tone: "warning", cta: "Open episode" },
};

/** Section-local date formatting (ui.tsx is a client module; keep this server-safe). */
function formatUpdated(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function ContinueWorkingSection({
  productions,
}: {
  productions: StudioProductionSummary[];
}) {
  return (
    <section aria-labelledby="studio-home-continue-working" data-testid="studio.home.continue-working">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="studio-home-continue-working" className="text-[15px] font-bold tracking-tight text-ink">
          Continue working
        </h2>
      </div>

      {productions.length === 0 ? (
        <div className="mt-3" data-testid="studio.home.continue-working.empty">
          <EmptyState
            icon="play"
            title="Nothing in progress yet"
            body="A workspace keeps one show's characters and places together, so every episode stays consistent. Create your first workspace to begin."
            action={
              <LinkButton href="/workspaces" size="sm" icon="plus">
                Create a workspace
              </LinkButton>
            }
          />
        </div>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {productions.map((production) => (
            <ContinueWorkingCard key={production.id} production={production} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ContinueWorkingCard({ production }: { production: StudioProductionSummary }) {
  const presentation = STAGE_PRESENTATION[production.stage];
  return (
    <li>
      <Link
        href={`/production/${production.id}`}
        data-testid={`studio.home.continue-working.card.${production.id}`}
        className="group flex h-full flex-col gap-3 rounded-[12px] border border-border bg-raised p-5 shadow-card transition-colors hover:border-border-strong"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-ink">{production.name}</p>
            {production.workspaceName && (
              <p className="mt-0.5 truncate text-[12px] text-muted">{production.workspaceName}</p>
            )}
          </div>
          <Badge tone={presentation.tone}>{presentation.badge}</Badge>
        </div>

        {production.statusNote && (
          <p className="text-[12.5px] leading-relaxed text-ink-soft">{production.statusNote}</p>
        )}

        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
            {production.stage === "needs_attention" && (
              <Icon name="alert" size={14} className="text-warning" />
            )}
            Updated {formatUpdated(production.updatedAt)}
          </span>
          <span className="inline-flex items-center gap-1 text-[12.5px] font-bold text-primary">
            {presentation.cta}
            <Icon name="arrow-right" size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Link>
    </li>
  );
}
