import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui";
import type { StudioOnboardingStatus } from "@/lib/studio/home-read-model";

/**
 * First-run guided onboarding (spec 04 section 8: "First run: onboarding card").
 * Server component; step `done` flags come verbatim from the read model so
 * Wave 1 can light steps up from real signals without UI changes.
 *
 * The first not-done step is the single "Up next" action; finished steps stay
 * visibly checked rather than disappearing, so progress feels real.
 */
export function OnboardingChecklist({ status }: { status: StudioOnboardingStatus }) {
  const doneCount = status.steps.filter((step) => step.done).length;
  const totalCount = status.steps.length;
  const allDone = doneCount === totalCount;
  const upNext = status.steps.find((step) => !step.done) ?? null;

  return (
    <Card as="section" className="border-primary/30" >
      <div data-testid="studio.home.onboarding" aria-labelledby="studio-home-onboarding">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="studio-home-onboarding" className="text-[15px] font-bold tracking-tight text-ink">
            {allDone ? "Your studio is set up" : "Set up your studio"}
          </h2>
          <p data-testid="studio.home.onboarding.progress" className="text-[12px] font-semibold text-muted">
            {doneCount} of {totalCount} done
          </p>
        </div>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
          {allDone
            ? "Everything is in place. Start your next episode whenever you're ready."
            : "Four short steps and your show has a consistent cast, world, and first episode."}
        </p>

        <ol className="mt-4 grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {status.steps.map((step) => {
            const isUpNext = upNext?.id === step.id;
            return (
              <li key={step.id} data-testid={`studio.home.onboarding.step.${step.id}`}>
                <Link
                  href={step.href}
                  aria-label={
                    step.done
                      ? `${step.label} — done`
                      : isUpNext
                        ? `${step.label} — up next`
                        : step.label
                  }
                  className={`group flex h-full items-start gap-3 rounded-[10px] border p-3.5 transition-colors ${
                    isUpNext
                      ? "border-primary/40 bg-primary-soft/50 hover:border-primary"
                      : "border-border bg-surface hover:border-border-strong"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border ${
                      step.done
                        ? "border-success bg-success text-white"
                        : "border-border-strong bg-raised text-transparent"
                    }`}
                  >
                    <Icon name="check" size={12} strokeWidth={2.4} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`text-[13px] font-bold ${step.done ? "text-ink-soft" : "text-ink"}`}>
                        {step.label}
                      </span>
                      {isUpNext && (
                        <span className="rounded-[5px] bg-primary-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-white">
                          Up next
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-muted">{step.description}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}
