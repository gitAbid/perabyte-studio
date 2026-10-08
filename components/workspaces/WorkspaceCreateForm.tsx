"use client";

/**
 * /workspaces/new — create-workspace form (feature spec 05 §5, step 1).
 * Client component: a three-step wizard (Basics → Format → Review & create)
 * built on the shared wizard chrome, matching the Character Studio stepper.
 * Every field keeps its value while stepping; Create posts the same Zod-valid
 * CreateWorkspaceCommand to POST /api/workspaces, then routes to the new
 * workspace's page. Membership, World Bible, and recipe fine-tuning happen on
 * the workspace page after creation, so a fresh studio can start with an
 * empty library.
 */

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Card, FieldShell, LinkButton } from "@/components/ui";
import {
  WizardReviewCard,
  WizardReviewRow,
  WizardStepHeading,
  WizardStepNav,
  WizardSteps,
} from "@/components/workspaces/WizardSteps";
import {
  ASPECT_RATIOS,
  ASPECT_RATIO_LABELS,
  LANGUAGE_MAX,
  LANGUAGE_MIN,
  QUALITY_STRATEGIES,
  QUALITY_STRATEGY_LABELS,
  RATING_DESCRIPTIONS,
  WORKSPACE_NAME_MAX,
  WORKSPACE_RATINGS,
  createWorkspace,
  formatFailure,
  type RequestFailure,
} from "./api";
import type { Workspace } from "@/lib/production/contracts";

const DEFAULT_SHOT_FRAMES = 120; // five seconds at 24 frames per second

/** Wizard step labels — shown in the indicator and the "Step x of y" caption. */
const WORKSPACE_CREATE_STEPS = ["Basics", "Format", "Review & create"] as const;

type FieldErrors = { name?: string; language?: string; shotFrames?: string };

export function WorkspaceCreateForm() {
  const router = useRouter();
  const ratingGroupLabelId = useId();

  const [name, setName] = useState("");
  const [rating, setRating] = useState<Workspace["rating"]>("General");
  const [qualityStrategy, setQualityStrategy] = useState<Workspace["productionRecipe"]["qualityStrategy"]>("balanced");
  const [aspectRatio, setAspectRatio] = useState<Workspace["productionRecipe"]["aspectRatio"]>("16:9");
  const [language, setLanguage] = useState("en");
  const [shotFramesText, setShotFramesText] = useState(String(DEFAULT_SHOT_FRAMES));

  // Wizard position. All field state lives above, so nothing is lost when
  // stepping back and forth between steps.
  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);
  // Inline field errors appear only once a field has been edited; a still
  // pristine invalid step is explained by the reason line on the Next button.
  const [touched, setTouched] = useState({ name: false, language: false, shotFrames: false });

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const frames = Number(shotFramesText);
  const framesValid = Number.isSafeInteger(frames) && frames > 0;

  const stepPanelRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    // After stepping, move focus (and the scroll) to the new step's content.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    stepPanelRef.current?.focus();
  }, [step]);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (name.trim().length < 1 || name.trim().length > WORKSPACE_NAME_MAX) {
      errors.name = `Give the workspace a name between 1 and ${WORKSPACE_NAME_MAX} characters.`;
    }
    const trimmedLanguage = language.trim();
    if (trimmedLanguage.length < LANGUAGE_MIN || trimmedLanguage.length > LANGUAGE_MAX) {
      errors.language = `Language must be ${LANGUAGE_MIN}–${LANGUAGE_MAX} characters, e.g. "en" or "English".`;
    }
    if (!framesValid) {
      errors.shotFrames = "Enter a whole number of frames above zero.";
    }
    return errors;
  }

  // Live per-field errors for the current values (same validate() the submit
  // guard uses), surfaced once a field has been touched.
  const errors = validate();
  const nameError = fieldErrors.name ?? (touched.name ? errors.name : undefined);
  const languageError = fieldErrors.language ?? (touched.language ? errors.language : undefined);
  const shotFramesError = fieldErrors.shotFrames ?? (touched.shotFrames ? errors.shotFrames : undefined);

  function stepValid(candidate: number): boolean {
    if (candidate === 1) return !errors.name;
    if (candidate === 2) return !errors.language && !errors.shotFrames;
    // Review step: everything must still be valid — the stepper allows jumping
    // back to an earlier step, editing it into an invalid state, then jumping
    // straight here. The guard inside handleSubmit stays the single source of
    // truth; this only drives the button/reason state.
    return !errors.name && !errors.language && !errors.shotFrames;
  }

  function goToStep(next: number) {
    setStep(next);
    setMaxVisited((current) => Math.max(current, next));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setFailure(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const result = await createWorkspace({
        name: name.trim(),
        characterCanonIds: [],
        environmentCanonIds: [],
        styleCanonIds: [],
        worldBible: { version: 1, summary: "", entries: [] },
        productionRecipe: {
          version: 1,
          qualityStrategy,
          aspectRatio,
          language: language.trim(),
          defaultShotTargetFrames: frames,
        },
        rating,
        budgetPolicyId: null,
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      router.push(`/workspaces/${result.workspace.id}`);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.workspace.create.page">
      <header className="border-b border-border pb-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Workspaces / New</p>
        <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">New workspace</h1>
        <p className="mt-1 max-w-xl text-[12.5px] text-muted">
          Name your show and set its basics. You&apos;ll add characters, places, and world rules on the next
          screen.
        </p>
      </header>

      <div className="mt-5">
        <WizardSteps
          steps={WORKSPACE_CREATE_STEPS}
          current={step}
          maxVisited={maxVisited}
          onStepClick={goToStep}
          ariaLabel="New workspace wizard progress"
        />
      </div>

      <Card className="mt-4">
        <form onSubmit={(event) => void handleSubmit(event)} noValidate data-testid="workspaces.workspace.create.form">
          <div ref={stepPanelRef} tabIndex={-1} className="space-y-5 focus:outline-none">
            {step === 1 && (
              <section data-testid="workspaces.create.step-1" className="space-y-5">
                <WizardStepHeading
                  title="1. Basics"
                  subtitle="Name your show and choose who it&apos;s for."
                />

                <FieldShell
                  label="Workspace name"
                  htmlFor="workspace-create-name"
                  hint={`The show or project family this workspace is for, 1–${WORKSPACE_NAME_MAX} characters.`}
                  error={nameError}
                  counter={`${name.trim().length}/${WORKSPACE_NAME_MAX}`}
                >
                  <input
                    id="workspace-create-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setTouched((current) => ({ ...current, name: true }));
                    }}
                    placeholder="e.g. Milo & Luna"
                    maxLength={WORKSPACE_NAME_MAX}
                    aria-invalid={nameError ? true : undefined}
                    className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                    data-testid="workspaces.workspace.create.name"
                  />
                </FieldShell>

                <fieldset className="space-y-2" data-testid="workspaces.workspace.create.rating">
                  <legend id={ratingGroupLabelId} className="text-[13px] font-semibold text-ink-soft">
                    Audience rating
                  </legend>
                  <div className="space-y-2">
                    {WORKSPACE_RATINGS.map((option) => (
                      <label
                        key={option}
                        className={`flex cursor-pointer items-start gap-3 rounded-[8px] border px-3.5 py-2.5 transition-colors ${
                          rating === option ? "border-primary bg-primary-soft/50" : "border-border bg-raised hover:border-border-strong"
                        }`}
                      >
                        <input
                          type="radio"
                          name="workspace-rating"
                          value={option}
                          checked={rating === option}
                          onChange={() => setRating(option)}
                          className="mt-1 accent-[var(--color-primary)]"
                          aria-describedby={`rating-note-${option}`}
                        />
                        <span>
                          <span className="block text-sm font-semibold text-ink">{option}</span>
                          <span id={`rating-note-${option}`} className="block text-[12px] text-muted">
                            {RATING_DESCRIPTIONS[option]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[12px] text-muted">
                    Adult workspaces can only be shared by exporting finished video files — public in-app
                    publishing is never available for them.
                  </p>
                </fieldset>

                <WizardStepNav
                  left={
                    <LinkButton href="/workspaces" variant="ghost" size="md" data-testid="workspaces.workspace.create.cancel">
                      Cancel
                    </LinkButton>
                  }
                  onNext={() => goToStep(2)}
                  nextLabel="Next"
                  nextIcon="arrow-right"
                  nextTestId="workspaces.create.next"
                  nextDisabled={!stepValid(1)}
                  reason={errors.name}
                />
              </section>
            )}

            {step === 2 && (
              <section data-testid="workspaces.create.step-2" className="space-y-5">
                <WizardStepHeading
                  title="2. Format"
                  subtitle="Set the picture quality, shape, and language new episodes are made with."
                />

                <FieldShell
                  label="Quality"
                  htmlFor="workspace-create-quality"
                  hint="How much care new episodes get. You can change this later."
                >
                  <select
                    id="workspace-create-quality"
                    value={qualityStrategy}
                    onChange={(event) => setQualityStrategy(event.target.value as Workspace["productionRecipe"]["qualityStrategy"])}
                    data-testid="workspaces.workspace.create.quality"
                    className="h-11 w-full appearance-none rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                  >
                    {QUALITY_STRATEGIES.map((option) => (
                      <option key={option} value={option}>{QUALITY_STRATEGY_LABELS[option]}</option>
                    ))}
                  </select>
                </FieldShell>

                <FieldShell label="Shape" htmlFor="workspace-create-aspect" hint="The video shape new episodes are made in.">
                  <select
                    id="workspace-create-aspect"
                    value={aspectRatio}
                    onChange={(event) => setAspectRatio(event.target.value as Workspace["productionRecipe"]["aspectRatio"])}
                    data-testid="workspaces.workspace.create.aspect"
                    className="h-11 w-full appearance-none rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                  >
                    {ASPECT_RATIOS.map((option) => (
                      <option key={option} value={option}>{ASPECT_RATIO_LABELS[option]}</option>
                    ))}
                  </select>
                </FieldShell>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell
                    label="Language"
                    htmlFor="workspace-create-language"
                    hint="Spoken and written language of new episodes."
                    error={languageError}
                  >
                    <input
                      id="workspace-create-language"
                      value={language}
                      onChange={(event) => {
                        setLanguage(event.target.value);
                        setTouched((current) => ({ ...current, language: true }));
                      }}
                      maxLength={LANGUAGE_MAX}
                      aria-invalid={languageError ? true : undefined}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                      data-testid="workspaces.workspace.create.language"
                    />
                  </FieldShell>
                  <FieldShell
                    label="Shot length (frames)"
                    htmlFor="workspace-create-shot-frames"
                    hint="Default length of one shot. 24 frames = 1 second."
                    error={shotFramesError}
                  >
                    <input
                      id="workspace-create-shot-frames"
                      type="number"
                      min={1}
                      step={1}
                      value={shotFramesText}
                      onChange={(event) => {
                        setShotFramesText(event.target.value);
                        setTouched((current) => ({ ...current, shotFrames: true }));
                      }}
                      aria-invalid={shotFramesError ? true : undefined}
                      className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm tabular-nums text-ink focus:border-primary focus:outline-none"
                      data-testid="workspaces.workspace.create.shotFrames"
                    />
                  </FieldShell>
                </div>

                <WizardStepNav
                  left={
                    <Button type="button" variant="secondary" icon="arrow-left" onClick={() => goToStep(1)} data-testid="workspaces.create.back">
                      Back
                    </Button>
                  }
                  onNext={() => goToStep(3)}
                  nextLabel="Next"
                  nextIcon="arrow-right"
                  nextTestId="workspaces.create.next"
                  nextDisabled={!stepValid(2)}
                  reason={errors.language ?? errors.shotFrames}
                />
              </section>
            )}

            {step === 3 && (
              <section data-testid="workspaces.create.step-3" className="space-y-5">
                <WizardStepHeading
                  title="3. Review &amp; create"
                  subtitle="Check your choices, then create the workspace."
                />

                <div className="space-y-4" data-testid="workspaces.create.review">
                  <WizardReviewCard title="Basics" onEdit={() => goToStep(1)} editLabel="Edit basics (step 1)">
                    <WizardReviewRow label="Name">{name.trim() || "—"}</WizardReviewRow>
                    <WizardReviewRow label="Audience rating">{rating}</WizardReviewRow>
                  </WizardReviewCard>
                  <WizardReviewCard title="Format" onEdit={() => goToStep(2)} editLabel="Edit format (step 2)">
                    <WizardReviewRow label="Quality">{QUALITY_STRATEGY_LABELS[qualityStrategy]}</WizardReviewRow>
                    <WizardReviewRow label="Shape">{ASPECT_RATIO_LABELS[aspectRatio]}</WizardReviewRow>
                    <WizardReviewRow label="Language">{language.trim() || "—"}</WizardReviewRow>
                    <WizardReviewRow label="Shot length">
                      {framesValid
                        ? `${frames} frames${frames % 24 === 0 ? ` (${frames / 24} s)` : ""}`
                        : "—"}
                    </WizardReviewRow>
                  </WizardReviewCard>
                </div>

                {failure ? (
                  <div role="alert" data-testid="workspaces.workspace.create.error" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
                    <p className="text-[13px] font-bold text-ink">The workspace could not be created.</p>
                    <p className="mt-1 text-[13px] leading-snug text-ink">{formatFailure(failure)}</p>
                    <p className="mt-1 text-[12px] text-muted">Nothing was created — your entries above are kept.</p>
                  </div>
                ) : null}

                <WizardStepNav
                  left={
                    <Button type="button" variant="secondary" icon="arrow-left" onClick={() => goToStep(2)} data-testid="workspaces.create.back">
                      Back
                    </Button>
                  }
                  nextLabel="Create workspace"
                  nextIcon="plus"
                  nextType="submit"
                  nextLoading={submitting}
                  nextTestId="workspaces.create.submit"
                  nextDisabled={!stepValid(3)}
                  reason={errors.name ?? errors.language ?? errors.shotFrames}
                />
              </section>
            )}
          </div>
        </form>
      </Card>

      <p className="mt-3 text-center text-[12px] text-muted">
        Step {step} of {WORKSPACE_CREATE_STEPS.length} · {WORKSPACE_CREATE_STEPS[step - 1]}
      </p>
    </div>
  );
}
