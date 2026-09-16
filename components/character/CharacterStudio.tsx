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
  type ReferenceImage,
} from "@/components/character/CharacterSteps";
import { CharacterLanding } from "@/components/character/CharacterLanding";
import { CharacterPreviewPanel } from "@/components/character/CharacterPreviewPanel";
import {
  DEFAULT_CHARACTER_SPEC,
  composeCharacterPrompt,
  characterGenerationSettings,
  lookById,
  sanitizeSpec,
  type CharacterRenderParams,
  type CharacterSpec,
} from "@/lib/character";
import { downloadMedia, useGeneration } from "@/lib/generation";
import { useModelCatalog } from "@/lib/model-catalog";
import { snapLorasForModel } from "@/lib/lora-options";
import {
  setSelectedModel,
  setSoloCharacters,
  setStoryCharacters,
  useSettings,
} from "@/lib/repositories/settings.repository";
import {
  addCharacter,
  getCharacter,
  removeCharacter,
  useCharacters,
} from "@/lib/repositories/characters.repository";
import { addAsset } from "@/lib/store";
import { titleFromPrompt } from "@/lib/constants";
import type { GenerationResponse } from "@/lib/types";

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
 * step components stay presentational. Adult options across the wizard
 * follow the global Uncensored Mode gate from Settings.
 */
export function CharacterStudio() {
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>("landing");
  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);
  const [spec, setSpec] = useState<CharacterSpec>({ ...DEFAULT_CHARACTER_SPEC });
  const [renderParams, setRenderParams] = useState<CharacterRenderParams>({
    aspect: "9:16",
    resolution: "1080p",
  });
  const [promptError, setPromptError] = useState<string | undefined>();
  const [reference, setReference] = useState<ReferenceImage | null>(null);

  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  const [saved, setSaved] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedCharacterId, setSavedCharacterId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const { job, run, cancel, reset } = useGeneration();
  const { settings: userSettings, ready: settingsReady } = useSettings();
  const { characters, ready: charactersReady } = useCharacters();
  const catalog = useModelCatalog("image");
  const characterModelId = userSettings.imageModel ?? catalog.defaultModelId;
  const characterModel = catalog.models.find((model) => model.id === characterModelId);
  const uncensored = userSettings.uncensoredEnabled;

  // LoRA selections snap to the render model: entries it doesn't accept drop
  // (same policy as Solo/Story), so the Review step never shows a count the
  // server would silently discard. Adult picks drop with the Uncensored gate
  // too — same reactive snap the other surfaces apply.
  useEffect(() => {
    if (!characterModel?.model || !catalog.loras.length) return;
    setRenderParams((params) => {
      if (!params.loras?.length) return params;
      const snapped = snapLorasForModel(
        params.loras,
        catalog.loras,
        characterModel.model,
        catalog.loraMaxPerRequest,
        uncensored,
      );
      return JSON.stringify(snapped) === JSON.stringify(params.loras)
        ? params
        : { ...params, loras: snapped };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the model identity, catalog, or gate changes
  }, [characterModelId, catalog.models, catalog.loras, catalog.loraMaxPerRequest, uncensored]);

  // The Settings gate is the single switch: when Uncensored Mode is off, an
  // adult selection anywhere in the spec falls back to its safe equivalent
  // (selections are sanitized, never leaked into a safe render). Runs only
  // after hydration so a loaded spec is not reset on reload.
  useEffect(() => {
    if (!settingsReady) return;
    if (!uncensored) {
      setSpec((s) => sanitizeSpec(s, false));
    }
  }, [settingsReady, uncensored]);

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

  function patchRenderParams(patch: Partial<CharacterRenderParams>) {
    setRenderParams((p) => ({ ...p, ...patch }));
  }

  function goToStep(next: number) {
    setStep(next);
    setMaxVisited((m) => Math.max(m, next));
  }

  function startWizard() {
    setSpec({ ...DEFAULT_CHARACTER_SPEC });
    setRenderParams({ aspect: "9:16", resolution: "1080p" });
    setReference(null);
    setSaveName("");
    setSavedCharacterId(null);
    goToStep(1);
    setPhase("wizard");
  }

  function handleOpenCharacter(id: string) {
    const character = getCharacter(id);
    if (!character) return;
    // Sanitize in case the gate has moved since the character was saved.
    setSpec(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, ...character.spec }, uncensored));
    setReference(null);
    setSaveName(character.name);
    setSavedCharacterId(character.id);
    goToStep(1);
    setPhase("wizard");
  }

  function handleDeleteCharacter(id: string) {
    removeCharacter(id);
    // Detach the character from the Solo/Story casts if attached there.
    if (userSettings.soloCharacterIds.includes(id)) {
      setSoloCharacters(userSettings.soloCharacterIds.filter((cid) => cid !== id));
    }
    if (userSettings.storyCharacterIds.includes(id)) {
      setStoryCharacters(userSettings.storyCharacterIds.filter((cid) => cid !== id));
    }
    toast.push("Character deleted.");
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
    setSavedCharacterId(null);
    setActiveVariant(0);

    const response = await run({
      settings: characterGenerationSettings(
        spec,
        { ...renderParams, modelId: characterModelId ?? undefined },
        uncensored,
      ),
      prompt: composeCharacterPrompt(spec),
      uncensored,
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
      settings: characterGenerationSettings(
        spec,
        { ...renderParams, modelId: characterModelId ?? undefined },
        uncensored,
      ),
      createdAt: Date.now(),
      favorite: false,
      mode: uncensored ? "Character Studio (Uncensored)" : "Character Studio",
      meta: {
        requestId: result.requestId,
        seeds: result.media.map((m) => m.seed).join(", "),
        example: false,
        look: spec.look,
        nsfwLevel: spec.nsfwLevel,
        rating: uncensored ? "Uncensored" : "Regular",
        referenceThumb: reference?.dataUrl ?? "",
      },
    };
    addAsset(asset);
    setSaved(true);
    toast.push("Character saved to History.", "success");
  }

  function handleSaveCharacter() {
    if (!result || savedCharacterId) return;
    const primary = result.media[activeVariant] ?? result.media[0];
    const character = addCharacter(saveName, spec, primary?.url);
    setSavedCharacterId(character.id);
    toast.push(
      `“${character.name}” saved — attach it from the Character pill in Solo or Story.`,
      "success",
    );
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
        characters={characters}
        charactersReady={charactersReady}
        onStart={startWizard}
        onOpenCharacter={handleOpenCharacter}
        onDeleteCharacter={handleDeleteCharacter}
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
        <div className="rounded-[20px] border border-border bg-raised p-6 text-center shadow-card sm:p-10">
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
                            ? "bg-primary-strong text-white"
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
                    Save the finished character and reuse it across Solo and
                    Story for a consistent look.
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
    const [w, h] = renderParams.aspect.split(":").map(Number);
    const shown = result.media[activeVariant] ?? result.media[0] ?? null;
    const look = lookById(spec.look);
    return (
      <div
        ref={scrollRef}
        className="mx-auto flex w-full max-w-[980px] flex-1 flex-col px-4 py-6 sm:px-6 lg:justify-center lg:py-8"
      >
        <div className="rounded-[20px] border border-border bg-raised p-5 shadow-card sm:p-7">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-strong text-white">
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
              {/* Save as a reusable character — the reuse path for Solo/Story. */}
              {savedCharacterId ? (
                <p className="flex items-center gap-2 rounded-[12px] border border-primary/30 bg-primary-soft/60 px-3 py-2.5 text-[12.5px] font-semibold text-primary">
                  <Icon name="check" size={14} />
                  Saved — attach it from the Character pill in Solo or Story.
                </p>
              ) : (
                <div className="rounded-[14px] border border-primary/30 bg-primary-soft/40 p-3">
                  <p className="text-[12.5px] font-bold text-ink">
                    Save this character for reuse
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-muted">
                    Keeps the exact look for Solo scenes and Story frames.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="Character name, e.g. Maya"
                      aria-label="Character name"
                      maxLength={40}
                      className="h-9 min-w-0 flex-1 rounded-[10px] border border-border-strong bg-raised px-2.5 text-[12.5px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                    />
                    <Button
                      size="sm"
                      icon="user"
                      disabled={!saveName.trim()}
                      onClick={handleSaveCharacter}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )}

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
                    ["Age", `${spec.age} years old`],
                    ["Ethnicity", spec.ethnicity === "Not specified" ? "—" : spec.ethnicity],
                    ["Country", spec.country === "Not specified" ? "—" : spec.country],
                    ["Build", spec.build],
                    ["Style", spec.style],
                    ["Aspect Ratio", renderParams.aspect],
                    ["Resolution", renderParams.resolution],
                    ...(uncensored
                      ? ([["NSFW Level", String(spec.nsfwLevel)]] as const)
                      : []),
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
  const previewPanel = (
    <CharacterPreviewPanel
      spec={spec}
      uncensored={uncensored}
      modelId={characterModelId}
      loras={renderParams.loras}
    />
  );

  return (
    <div
      ref={scrollRef}
      className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-5 sm:px-6 lg:py-7"
    >
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              aria-label="Back to character overview"
              onClick={() => setPhase("landing")}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
            >
              <Icon name="arrow-left" size={16} />
            </button>
            <h1 className="min-w-0 truncate text-[17px] font-extrabold tracking-[-0.02em] text-ink sm:text-[19px]">
              Character Studio
            </h1>
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-3 py-1.5 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-border-strong hover:text-ink lg:hidden"
            >
              <Icon name="user" size={14} />
              Preview
            </button>
          </div>

          <div className="mt-4 sm:mt-5">
            <Stepper
              current={step}
              maxVisited={maxVisited}
              onStepClick={(next) => goToStep(next)}
            />
          </div>

          <div className="mt-4 rounded-[20px] border border-border bg-raised p-5 shadow-card sm:p-7">
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
                uncensored={uncensored}
                onBack={() => goToStep(1)}
                onNext={() => goToStep(3)}
              />
            )}
            {step === 3 && (
              <StepAdvanced
                spec={spec}
                patch={patchSpec}
                uncensored={uncensored}
                reference={reference}
                onReferenceChange={setReference}
                onBack={() => goToStep(2)}
                onNext={() => goToStep(4)}
              />
            )}
            {step === 4 && (
              <StepReview
                spec={spec}
                uncensored={uncensored}
                reference={reference}
                renderParams={renderParams}
                onRenderParamsChange={patchRenderParams}
                models={catalog.models}
                modelId={characterModelId}
                onModelChange={(nextModel) => setSelectedModel("image", nextModel)}
                loraCatalog={catalog.loras}
                loraMaxPerRequest={catalog.loraMaxPerRequest}
                loraCapable={characterModel?.loraCapable === true}
                loraModel={characterModel?.model}
                allowNsfwLoras={uncensored}
                loras={renderParams.loras}
                onLorasChange={(loras) => patchRenderParams({ loras })}
                onBack={() => goToStep(3)}
                onGenerate={handleGenerate}
              />
            )}
          </div>

          <p className="mt-3 text-center text-[12px] text-muted">
            Step {step} of {CHARACTER_STEPS.length} · {CHARACTER_STEPS[step - 1]}
          </p>
        </div>

        <aside className="mt-6 hidden lg:sticky lg:top-6 lg:mt-0 lg:block">
          {previewPanel}
        </aside>
      </div>

      {/* Mobile preview sheet */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Live preview">
          <button
            type="button"
            aria-label="Close preview"
            onClick={() => setPreviewOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[20px] bg-raised p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[13px] font-bold text-ink">Live preview</span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPreviewOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-full bg-surface-2 text-ink-soft"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            {previewPanel}
          </div>
        </div>
      )}
    </div>
  );
}