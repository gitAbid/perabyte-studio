import Link from "next/link";
import { Icon } from "@/components/Icon";
import { EmptyState, LinkButton } from "@/components/ui";
import type { StudioWorkspaceSummary } from "@/lib/studio/home-read-model";

/**
 * "Workspaces" — the dominant organizing concept (spec 04 goal 2).
 * Shows at most the recent slice from the read model (3); "View all"
 * leads to the full list. Cards open the workspace detail directly.
 * Server component fed by the read model.
 */

/** Section-local date formatting (ui.tsx is a client module; keep this server-safe). */
function formatUpdated(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const RATING_TONE: Record<StudioWorkspaceSummary["rating"], string> = {
  General: "text-success bg-success-soft",
  Mature: "text-warning bg-warning-soft",
  Adult: "text-danger bg-danger-soft",
};

export function WorkspacesSection({ workspaces }: { workspaces: StudioWorkspaceSummary[] }) {
  const hasWorkspaces = workspaces.length > 0;

  return (
    <section aria-labelledby="studio-home-workspaces" data-testid="studio.home.workspaces">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="studio-home-workspaces" className="text-[15px] font-bold tracking-tight text-ink">
          Workspaces
        </h2>
        {hasWorkspaces && (
          <Link
            href="/workspaces"
            data-testid="studio.home.workspaces.view-all"
            className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary transition-colors hover:text-primary-strong"
          >
            View all workspaces
            <Icon name="arrow-right" size={13} />
          </Link>
        )}
      </div>

      {hasWorkspaces ? (
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link
                href={`/workspaces/${workspace.id}`}
                data-testid={`studio.home.workspaces.card.${workspace.id}`}
                className="group flex h-full flex-col gap-1.5 rounded-[12px] border border-border bg-raised p-4 shadow-card transition-colors hover:border-border-strong"
              >
                <span className="flex items-center gap-2">
                  <Icon name="layers" size={16} className="shrink-0 text-primary" />
                  <span className="truncate text-[13.5px] font-bold text-ink">{workspace.name}</span>
                  <span
                    className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${RATING_TONE[workspace.rating]}`}
                  >
                    {workspace.rating}
                  </span>
                </span>
                <span className="text-[11.5px] text-muted">Updated {formatUpdated(workspace.updatedAt)}</span>
                <span className="mt-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  Open workspace
                  <Icon name="arrow-right" size={12} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3" data-testid="studio.home.workspaces.empty">
          <EmptyState
            icon="layers"
            title="No workspaces yet"
            body="A workspace is one show's home: its characters, its places, its look. PeraByte uses it to keep every episode consistent."
            action={
              <LinkButton href="/workspaces" size="sm" icon="plus">
                New workspace
              </LinkButton>
            }
          />
        </div>
      )}
    </section>
  );
}
