"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Badge, Button, useToast } from "@/components/ui";
import {
  CHARACTER_STEPS,
  StepAppearance,
  StepAdvanced,
  StepDetails,
  StepReview,
  Stepper,
} from "@/components/character/CharacterSteps";
import { CharacterLanding } from "@/components/character/CharacterLanding";
import {
  DEFAULT_CHARACTER_SPEC,
  composeCharacterPrompt,
  characterGenerationSettings,
  lookById,
  type CharacterSpec,
} from "@/lib/character";
import { downloadMedia, useGeneration } from "@/lib/generation";
import { addAsset } from "@/lib/store";
import { titleFromPrompt } from "@/lib/constants";
import type { GenerationResponse } from "@/lib/types";
import type { ReferenceImage } from "@/components/character/CharacterSteps";

type Phase = "landing" | "wizard" | "generating" | "ready";

const GENERATING_STAGES = [
  "Processing your prompt",
  "Generating appearance",
  "Applying details",
  "Finalizing",
];

/**
 * The Character studio: a landing screen followed by a four-step wizard,
 * the generating progress view and the ready view. State lives here; the
 * step components stay presentational.
 */
export function CharacterStudio() {
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>("landing");
  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);
  const [spec, setSpec] = useState<CharacterSpec>({ ...DEFAULT_CHARACTER_SPEC });
  const [promptError, setPromptError] = useState<string | undefined>();
  const [reference, setReference] = useState<ReferenceImage | null>(null);

  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  const [saved, setSaved] = useState(false);

  const { job, run, cancel, reset } = useGeneration();

  // Checklist progress while generating: advance one stage every ~1.6s and
  // hold on the last one until the real response resolves the wait.
  const [stage, setStage] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase !== "generating") return;
    setStage(0);
    const id = window.setInterval(() => {
      setStage((s) => Math.min(s + 1, GENERATING_STAGES.length - 1));
    }, 1600);
    return () => window.clearInterval(id);
  }, [phase]);

  // Every phase change scrolls the workspace back to the top so stepping
  // forward never lands the user mid-page.
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [phase, step]);

  function patchSpec(patch: Partial<CharacterSpec>) {
    setSpec((s) => ({ ...s, ...patch }));
  }

  function goToStep(next: number) {
    setStep(next);
    setMaxVisited((m) => Math.max(m, next));
  }

  function startWizard() {
    goToStep(1);
    setPhase("wizard");
  }

  function handleDetailsNext() {
    if (!spec.prompt.trim()) {
      setPromptError("Describe your character before continuing.");
      return;
    }
    setPromptError(undefined);
    goToStep(2);
  }

  async function handleGenerate() {
    setPhase("generating");
    setSaved(false);
    setActiveVariant(0);

    const response = await run({
      settings: characterGenerationSettings(spec),
      prompt: composeCharacterPrompt(spec),
    });

    if (!response) return; // failure is rendered from job.phase below
    setResult(response);
    setPhase("ready");
    toast.push("Your character is ready.", "success");
  }

  function handleRegenerate() {
    reset();
    setResult(null);
    setSaved(false);
    goToStep(1);
    setPhase("wizard");
  }

  function handleSave() {
    if (!result || saved) return;
    const primary = result.media[activeVariant] ?? result.media[0];
    if (!primary) return;
    const asset = {
      id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind: "image" as const,
      title: titleFromPrompt(spec.prompt || "AI character"),
      prompt: spec.prompt.trim(),
      url: primary.url,
      variants: result.media.map((m) => m.url),
      posterUrl: primary.url,
      settings: characterGenerationSettings(spec),
      createdAt: Date.now(),
      favorite: false,
      mode: "Character Studio",
      meta: {
        requestId: result.requestId,
        seeds: result.media.map((m) => m.seed).join(", "),
        example: false,
        characterMode: spec.mode,
        look: spec.look,
        referenceThumb: reference?.dataUrl ?? "",
      },
    };
    addAsset(asset);
    setSaved(true);
    toast.push("Character saved to History.", "success");
  }

  function handleDownload() {
    if (!result) return;
    const media = result.media[activeVariant] ?? result.media[0];
    if (!media) return;
    downloadMedia(media.url, `perabyte-character-${Date.now()}`);
    toast.push("Your download has started.", "success");
  }

  function handleCancel() {
    cancel();
    goToStep(4);
    setPhase("wizard");
  }

  /* ------------------------------- Landing ------------------------------- */
  if (phase === "landing") {
    return (
      <CharacterLanding
        mode={spec.mode}
        onModeChange={(mode) => patchSpec({ mode })}
        onStart={startWizard}
      />
    );
  }

  /* ------------------------------ Generating ----------------------------- */
  if (phase === "generating") {
    const failed = job.phase === "failed";
    return (
      <div
        ref={scrollRef}
        className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-4 py-8 sm:px-6"
      >
        <div className="rounded-[20px] border border-border bg-white p-6 text-center shadow-card sm:p-10">
          {failed ? (
            <>
              <span className="inline-flex size-14 items-center justify-center rounded-full bg-danger-soft text-danger">
                <Icon name="alert" size={24} />
              </span>
              <h2 className="mt-4 text-[19px] font-extrabold tracking-[-0.02em] text-ink">
                Character generation failed
              </h2>
              <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-ink-soft">
                {job.phase === "failed" ? job.message : undefined}
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                <Button variant="secondary" onClick={() => setPhase("wizard")}>
                  Back to review
                </Button>
                {job.phase === "failed" && job.retryable && (
                  <Button icon="refresh" onClick={handleGenerate}>
                    Try again
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div
                aria-hidden
                className="mx-auto size-14 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary"
              />
              <h2 className="mt-5 text-[19px] font-extrabold tracking-[-0.02em] text-ink">
                Creating your character…
              </h2>
              <p className="mt-1 text-[13px] text-muted">
                Your character is being created. This may take a few moments.
              </p>

              <ul className="mx-auto mt-6 max-w-xs space-y-2.5 text-left">
                {GENERATING_STAGES.map((label, index) => {
                  const done = index < stage || job.phase === "completed";
                  const active = index === stage && job.phase !== "completed";
                  return (
                    <li
                      key={label}
                      className={`flex items-center gap-2.5 text-[13.5px] font-medium transition-colors ${
                        done ? "text-ink" : active ? "text-primary" : "text-muted"
                      }`}
                      aria-current={active ? "step" : undefined}
                    >
                      <span
                        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${
                          done
                            ? "bg-primary text-white"
                            : active
                              ? "bg-primary-soft text-primary"
                              : "bg-surface-2 text-muted"
                        }`}
                      >
                        {done ? (
                          <Icon name="check" size={11} />
                        ) : active ? (
                          <span className="size-2 animate-pulse rounded-full bg-primary" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-border-strong" />
                        )}
                      </span>
                      {label}
                    </li>
                  );
                })}
              </ul>

              <button
                type="button"
                onClick={handleCancel}
                className="mt-7 text-[12.5px] font-semibold text-muted underline-offset-4 hover:text-ink hover:underline"
              >
                Cancel and go back
              </button>

              <div className="mx-auto mt-6 max-w-sm rounded-[14px] border border-border bg-primary-soft/50 p-3.5 text-left">
                <p className="flex items-start gap-2 text-[12.5px] leading-snug text-ink-soft">
                  <Icon name="sparkle" size={14} className="mt-0.5 shrink-0 text-primary" />
                  <span>
                    <span className="font-bold text-ink">Tip — </span>
                    You can create multiple characters with different looks,
                    styles, and personalities.
                  </span>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* -------------------------------- Ready -------------------------------- */
  if (phase === "ready" && result) {
    const [w, h] = spec.aspect.split(":").map(Number);
    const shown = result.media[activeVariant] ?? result.media[0] ?? null;
    const look = lookById(spec.look);
    return (
      <div
        ref={scrollRef}
        className="mx-auto flex w-full max-w-[980px] flex-1 flex-col px-4 py-6 sm:px-6 lg:justify-center lg:py-8"
      >
        <div className="rounded-[20px] border border-border bg-white p-5 shadow-card sm:p-7">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-white">
              <Icon name="check" size={16} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[19px] font-extrabold tracking-[-0.02em] text-ink">
                Character Ready
              </h2>
              <p className="mt-0.5 text-[13px] text-muted">
                Your character has been created successfully.
              </p>
            </div>
            <Badge tone="primary" >
              <Icon name="sparkle" size={11} /> {look ? look.label : "Custom"}
            </Badge>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(250px,320px)]">
            <div className="min-w-0">
              {/* Cap width by the aspect ratio so a portrait render never
                  grows taller than the viewport (which would crop it). */}
              <div
                className="mx-auto w-full"
                style={{ maxWidth: `calc(62vh * ${w} / ${h})` }}
              >
                <MediaFrame
                  src={shown?.url ?? null}
                  alt={spec.prompt || "Generated character"}
                  ratio={`${w}/${h}`}
                  rounded="rounded-[16px]"
                  priority
                  className="w-full border border-border"
                />
              </div>
              {result.media.length > 1 && (
                <div className="mt-3 flex gap-2">
                  {result.media.map((media, index) => (
                    <button
                      key={media.id}
                      type="button"
                      onClick={() => setActiveVariant(index)}
                      aria-label={`Show variation ${index + 1}`}
                      aria-pressed={index === activeVariant}
                      className={`overflow-hidden rounded-[10px] border-2 transition-all ${
                        index === activeVariant
                          ? "border-primary"
                          : "border-transparent hover:border-border-strong"
                      }`}
                    >
                      <MediaFrame
                        src={media.url}
                        alt=""
                        ratio="4/5"
                        rounded="rounded-[8px]"
                        className="w-12"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2.5">
              <Button icon="download" onClick={handleDownload}>
                Download
              </Button>
              <Button variant="secondary" icon="refresh" onClick={handleRegenerate}>
                Generate Another
              </Button>
              <Button
                variant="secondary"
                icon={saved ? "check" : "history"}
                disabled={saved}
                onClick={handleSave}
              >
                {saved ? "Saved to History" : "Save to History"}
              </Button>
              {saved && (
                <Link
                  href="/history"
                  className="text-center text-[12.5px] font-semibold text-primary underline-offset-4 hover:underline"
                >
                  Open in History →
                </Link>
              )}

              <div className="mt-2 rounded-[14px] border border-border bg-surface p-4">
                <h3 className="text-[13px] font-bold text-ink">Character Details</h3>
                <div className="mt-2 space-y-1.5">
                  {[
                    ["Mode", spec.mode === "normal" ? "Normal" : "Uncensored"],
                    ["Aspect Ratio", `${spec.aspect} (Portrait)`],
                    ["Resolution", spec.resolution],
                    ["Style", spec.style],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] text-muted">{label}</span>
                      <span className="text-right text-[12px] font-semibold text-ink">
                        {value}
                      </span>
                    </div>
                  ))}
                  <p className="whitespace-pre-wrap border-t border-border pt-2 text-[12px] leading-snug text-ink-soft">
                    {spec.prompt}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* -------------------------------- Wizard ------------------------------- */
  return (
    <div
      ref={scrollRef}
      className="mx-auto flex w-full max-w-[980px] flex-1 flex-col px-4 py-5 sm:px-6 lg:py-7"
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Back to character overview"
          onClick={() => setPhase("landing")}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
        >
          <Icon name="arrow-left" size={16} />
        </button>
        <h1 className="min-w-0 truncate text-[17px] font-extrabold tracking-[-0.02em] text-ink sm:text-[19px]">
          Character Studio
        </h1>
      </div>

      <div className="mt-4 sm:mt-5">
        <Stepper
          current={step}
          maxVisited={maxVisited}
          onStepClick={(next) => goToStep(next)}
        />
      </div>

      <div className="mt-4 rounded-[20px] border border-border bg-white p-5 shadow-card sm:p-7">
        {step === 1 && (
          <StepDetails
            spec={spec}
            patch={patchSpec}
            promptError={promptError}
            onBack={() => setPhase("landing")}
            onNext={handleDetailsNext}
          />
        )}
        {step === 2 && (
          <StepAppearance
            spec={spec}
            patch={patchSpec}
            onBack={() => goToStep(1)}
            onNext={() => goToStep(3)}
          />
        )}
        {step === 3 && (
          <StepAdvanced
            spec={spec}
            patch={patchSpec}
            reference={reference}
            onReferenceChange={setReference}
            onBack={() => goToStep(2)}
            onNext={() => goToStep(4)}
          />
        )}
        {step === 4 && (
          <StepReview
            spec={spec}
            reference={reference}
            onBack={() => goToStep(3)}
            onGenerate={handleGenerate}
          />
        )}
      </div>

      <p className="mt-3 text-center text-[12px] text-muted">
        Step {step} of {CHARACTER_STEPS.length} · {CHARACTER_STEPS[step - 1]}
      </p>
    </div>
  );
}
