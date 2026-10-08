import { ContinueWorkingSection } from "./ContinueWorkingSection";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { QuickActionsRow } from "./QuickActionsRow";
import { WorkspacesSection } from "./WorkspacesSection";
import { WorkspaceContextChip } from "@/components/production/primitives/workspace";
import type { StudioHomeReadModel } from "@/lib/studio/home-read-model";

/**
 * /studio screen shell (feature spec 04 primary screen format):
 * header with workspace context, onboarding (first run), Continue working,
 * Workspaces, and Create. Pure server component — all data arrives via the
 * read model; no fetches, no provider calls, no client state.
 */
export function StudioHomeView({ model }: { model: StudioHomeReadModel }) {
  const onboardingComplete = model.onboarding.steps.every((step) => step.done);
  const activeWorkspace = model.workspaces[0] ?? null;

  return (
    <div
      data-testid="studio.home.page"
      className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
    >
      <header
        data-testid="studio.home.header"
        className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="min-w-0">
          <h1 className="editorial-display text-[30px] leading-tight text-ink sm:text-[36px]">
            Studio home
          </h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-soft">
            Welcome back. Pick up an episode where you left it, or start
            something new with the characters and places you already love.
          </p>
        </div>

        {activeWorkspace && (
          <WorkspaceContextChip
            name={activeWorkspace.name}
            rating={activeWorkspace.rating}
            href={`/workspaces/${activeWorkspace.id}`}
            testId="studio.home.workspace-context"
          />
        )}
      </header>

      <div className="mt-8 flex flex-col gap-10">
        {/* First run: the checklist + section empty states already offer every
            create action — showing quick actions too would list the same four
            buttons three times. They return as the create hub once done. */}
        {!onboardingComplete ? (
          <OnboardingChecklist status={model.onboarding} />
        ) : (
          <QuickActionsRow />
        )}
        <ContinueWorkingSection productions={model.recentProductions} />
        <WorkspacesSection workspaces={model.workspaces} />
      </div>
    </div>
  );
}
