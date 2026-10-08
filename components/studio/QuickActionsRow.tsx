import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";

/**
 * "Create" — quick actions into each creation flow (spec 04 goal 3).
 * Links follow the frozen route table: /workspaces, /character,
 * /environments, /production/new. /workspaces and /environments land in the
 * next wave and intentionally link here now.
 */

type QuickAction = {
  id: string;
  label: string;
  hint: string;
  href: string;
  icon: IconName;
  /** The spec marks Production as the starred flow (Production ✨). */
  starred?: boolean;
};

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "new-workspace",
    label: "New workspace",
    hint: "Keep one show's characters and places together.",
    href: "/workspaces",
    icon: "layers",
  },
  {
    id: "new-character",
    label: "New character",
    hint: "Create a face the camera can return to.",
    href: "/character",
    icon: "character",
  },
  {
    id: "new-environment",
    label: "New environment",
    hint: "Revisit the same places in every scene.",
    href: "/environments",
    icon: "home",
  },
  {
    id: "new-production",
    label: "Start a production",
    hint: "Turn an idea into a first cut.",
    href: "/production/new",
    icon: "play",
    starred: true,
  },
];

export function QuickActionsRow() {
  return (
    <section aria-labelledby="studio-home-create" data-testid="studio.home.quick-actions">
      <h2 id="studio-home-create" className="text-[15px] font-bold tracking-tight text-ink">
        Create
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.id}
            href={action.href}
            data-testid={`studio.home.quick-action.${action.id}`}
            className="group flex h-full flex-col gap-2 rounded-[12px] border border-border bg-raised p-4 shadow-card transition-colors hover:border-border-strong"
          >
            <span className="flex items-center justify-between">
              <span className="inline-flex size-9 items-center justify-center rounded-[9px] bg-surface-2 text-ink-soft transition-colors group-hover:bg-primary-soft group-hover:text-primary">
                <Icon name={action.icon} size={17} />
              </span>
              {action.starred && <Icon name="sparkle" size={15} className="text-accent" />}
            </span>
            <span className="text-[13.5px] font-bold text-ink">{action.label}</span>
            <span className="text-[12px] leading-snug text-muted">{action.hint}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
