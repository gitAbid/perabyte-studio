"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { EmptyState, LinkButton, Segmented, useToast } from "@/components/ui";
import {
  CHARACTER_STEPS,
  StepAppearance,
  StepAdvanced,
  StepDetails,
  StepReview,
  Stepper,
  type ReferenceImage,
} from "@/components/character/CharacterSteps";
import { StepSimple } from "@/components/character/StepSimple";
import {
  CharacterSheetPanel,
  type CompletedSheetView,
} from "@/components/character/CharacterSheetPanel";
import {
  DEFAULT_CHARACTER_SPEC,
  characterSheetSettings,
  composeCharacterPrompt,
  sanitizeSpec,
  sheetViewById,
  type CharacterRenderParams,
  type CharacterSpec,
  type SheetViewId,
} from "@/lib/character";
import { useModelCatalog } from "@/lib/model-catalog";
import { snapLorasForModel } from "@/lib/lora-options";
import { setSelectedModel, useSettings } from "@/lib/repositories/settings.repository";
import {
  addCharacter,
  ensureCharactersHydrated,
  getCharacter,
  updateCharacter,
} from "@/lib/character-store";
import type { CharacterIdentity } from "@/lib/repositories/character-row";
import { addAsset, updateAsset, useAssets } from "@/lib/store";
import { titleFromPrompt } from "@/lib/constants";
import type { Asset } from "@/lib/types";

type CreationMode = "simple" | "details";

/** The bare media-cache ref of a generated `/api/media?f=<ref>` URL (same
 * extraction the sheet panel uses for its img2img chaining). */
function mediaRefFromUrl(url: string): string | null {
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}

/** Minimal model-picker entry shared by Simple mode and the Review step. */
export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  providerLabel: string;
}

/**
 * The Character studio: a Simple mode (one prompt, straight to the sheet) and
 * a Detailed mode (the four-step wizard), both rendering into the same
 * right-side character sheet. Nothing navigates away — every view renders in
 * place and can be re-rendered solo. Mounted at /character/new (create,
 * optionally seeded from a parent = variation) and /character/[id] (edit —
 * "Save changes" persists spec edits back). Adult options follow the global
 * Uncensored Mode gate from Settings.
 */
export function CharacterStudio({
  mode = "new",
  parentId,
  characterId,
}: {
  mode?: "new" | "edit";
  parentId?: string;
  characterId?: string;
}) {
  const toast = useToast();
  const router = useRouter();

  // Creating starts in Simple mode; editing an existing character starts in
  // Detailed (and re-follows the character's own mode once its spec loads).
  const [creationMode, setCreationMode] = useState<CreationMode>(mode === "edit" ? "details" : "simple");
  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);
  const [spec, setSpec] = useState<CharacterSpec>({
    ...DEFAULT_CHARACTER_SPEC,
    freeform: mode !== "edit",
  });
  // 720p keeps a six-view sheet quick and cheap; Review can bump it.
  const [renderParams, setRenderParams] = useState<CharacterRenderParams>({
    aspect: "9:16",
    resolution: "720p",
  });
  const [promptError, setPromptError] = useState<string | undefined>();
  const [reference, setReference] = useState<ReferenceImage | null>(null);

  const [completedViews, setCompletedViews] = useState<CompletedSheetView[]>([]);
  const [batchRequest, setBatchRequest] = useState(0);
  const [savedToLibrary, setSavedToLibrary] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedCharacterId, setSavedCharacterId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savingChanges, setSavingChanges] = useState(false);

  /** Library-mode init: prefill from the saved record or the variation parent. */
  const [initialized, setInitialized] = useState(mode === "new" && !parentId);
  const [missing, setMissing] = useState(false);
  const [parentName, setParentName] = useState<string | null>(null);
  /** The History asset this session produced, for post-save character tagging. */
  const [lastSavedAsset, setLastSavedAsset] = useState<{ id: string; meta: Asset["meta"] } | null>(null);

  const { settings: userSettings, ready: settingsReady } = useSettings();
  const { assets } = useAssets();
  const catalog = useModelCatalog("image");
  const characterModelId = userSettings.imageModel ?? catalog.defaultModelId;
  const characterModel = catalog.models.find((model) => model.id === characterModelId);
  const uncensored = userSettings.uncensoredEnabled;

  /** The character this session's renders belong to (edit id or just-saved id). */
  const galleryId = characterId ?? savedCharacterId;

  useEffect(() => {
    if (initialized) return;
    if (!settingsReady) return;
    let cancelled = false;
    // Hydration is async (server store) — resolve it before the one-shot
    // lookup, otherwise a not-yet-loaded cache reads as "character missing".
    void ensureCharactersHydrated().then((rows) => {
      if (cancelled) return;
      if (mode === "edit") {
        const character = characterId
          ? rows.find((r) => r.id === characterId) ?? getCharacter(characterId)
          : undefined;
        if (!character) {
          setMissing(true);
          setInitialized(true);
          return;
        }
        setSpec(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, ...character.spec }, uncensored));
        setSaveName(character.name);
        // Reopen in the mode the character was created in.
        setCreationMode(character.spec.freeform === true ? "simple" : "details");
        setInitialized(true);
        return;
      }
      if (parentId) {
        const parent =
          rows.find((r) => r.id === parentId) ?? getCharacter(parentId);
        if (parent) {
          setSpec(sanitizeSpec({ ...DEFAULT_CHARACTER_SPEC, ...parent.spec }, uncensored));
          setSaveName("");
          setParentName(parent.name);
          setCreationMode(parent.spec.freeform === true ? "simple" : "details");
        } else {
          toast.push("Parent character not found — starting fresh.");
        }
      }
      setInitialized(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time library-mode init
  }, [initialized, mode, characterId, parentId, settingsReady]);

  // LoRA selections snap to the render model: entries it doesn't accept drop
  // (same policy as Solo/Story). Adult picks drop with the Uncensored gate
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
  // adult selection anywhere in the spec falls back to its safe equivalent.
  // Runs only after hydration so a loaded spec is not reset on reload.
  useEffect(() => {
    if (!settingsReady) return;
    if (!uncensored) {
      setSpec((s) => sanitizeSpec(s, false));
    }
  }, [settingsReady, uncensored]);

  // Stepping (and mode switching) scrolls the workspace back to the top.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step, creationMode]);

  // Latest saved sheet for this character — restores the tiles on edit open.
  const initialViews = useMemo(() => {
    if (!galleryId) return null;
    const latestSheet = assets
      .filter((a) => {
        const ids = a.meta?.characterIds;
        return (
          Array.isArray(a.meta?.sheetOrder) &&
          Array.isArray(ids) &&
          (ids as string[]).includes(galleryId)
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latestSheet) return null;
    const order = latestSheet.meta?.sheetOrder as string[];
    const entries: [SheetViewId, string][] = [];
    order.forEach((id, index) => {
      const url = latestSheet.variants[index];
      if (url && sheetViewById(id)) entries.push([id as SheetViewId, url]);
    });
    return entries.length
      ? (Object.fromEntries(entries) as Record<SheetViewId, string>)
      : null;
  }, [assets, galleryId]);

  const handleViewsChange = useCallback((views: CompletedSheetView[]) => {
    setCompletedViews(views);
  }, []);

  function patchSpec(patch: Partial<CharacterSpec>) {
    setSpec((s) => ({ ...s, ...patch }));
  }

  function patchRenderParams(patch: Partial<CharacterRenderParams>) {
    setRenderParams((p) => ({ ...p, ...patch }));
  }

  /** Mode switches move the identity source with them: Simple renders the
   * raw prompt, Detailed composes the anchor from the tuned fields. */
  function switchMode(next: CreationMode) {
    setCreationMode(next);
    patchSpec({ freeform: next === "simple" });
  }

  function goToStep(next: number) {
    setStep(next);
    setMaxVisited((m) => Math.max(m, next));
  }

  function backToLibrary() {
    // Edit mode returns to the character's detail page; creating returns to
    // the library.
    router.push(mode === "edit" && characterId ? `/character/${characterId}` : "/character");
  }

  function handleDetailsNext() {
    if (!spec.prompt.trim()) {
      setPromptError("Describe your character before continuing.");
      return;
    }
    setPromptError(undefined);
    goToStep(2);
  }

  /** Trigger a full sheet render — the panel owns the batch. */
  function requestSheetBatch() {
    if (!spec.prompt.trim()) {
      setPromptError("Describe your character before rendering.");
      return;
    }
    setPromptError(undefined);
    setSavedToLibrary(false);
    setBatchRequest((count) => count + 1);
  }

  /** Poster for saving: the front view, else the first completed view. */
  function posterUrl(): string | null {
    return (
      completedViews.find((view) => view.id === "front")?.url ??
      completedViews[0]?.url ??
      null
    );
  }

  /** Identity auto-pin: the front view's media-cache ref, recording the seed
   * and active model it was produced with — null when there is no front view
   * or its URL carries no extractable ref (plain-URL renders are skipped). */
  function autoIdentityPatch(): { identity: CharacterIdentity } | null {
    const front = completedViews.find((view) => view.id === "front");
    const frontRef = front ? mediaRefFromUrl(front.url) : null;
    if (!frontRef) return null;
    return {
      identity: {
        front: frontRef,
        ...(front?.seed !== undefined ? { seed: front.seed } : {}),
        ...(characterModelId ? { modelId: characterModelId } : {}),
      },
    };
  }

  function handleSaveCharacter() {
    const poster = posterUrl();
    if (!poster || savedCharacterId) return;
    const character = addCharacter(
      saveName,
      spec,
      poster,
      parentId ? { parentId } : undefined,
    );
    setSavedCharacterId(character.id);
    // Fresh saves start without a canonical identity — auto-pin the front
    // view's ref so story keyframes can re-anchor to this face.
    const identityPatch = autoIdentityPatch();
    if (identityPatch) updateCharacter(character.id, identityPatch);
    // If the sheet was already saved to History, tag it to the character so
    // the library picks it up even though the save order was reversed.
    if (lastSavedAsset) {
      updateAsset(lastSavedAsset.id, {
        meta: { ...lastSavedAsset.meta, characterIds: [character.id] },
      });
    }
    toast.push(
      `“${character.name}” saved — attach it from the Character pill in Solo or Story.`,
      "success",
    );
  }

  /** Edit mode: persist spec/name edits back to the saved record, keeping the
   * poster in sync with the freshly rendered front view. */
  function handleSaveChanges() {
    if (!characterId || !saveName.trim() || savingChanges) return;
    setSavingChanges(true);
    const poster = posterUrl();
    // Auto-pin the front view's ref while the record has no canonical identity.
    const identityPatch =
      getCharacter(characterId)?.identity?.front ? null : autoIdentityPatch();
    updateCharacter(characterId, {
      name: saveName.trim(),
      spec,
      ...(poster ? { thumbnail: poster } : {}),
      ...(identityPatch ?? {}),
    });
    setSavingChanges(false);
    setSavedCharacterId(characterId);
    toast.push("Character updated.", "success");
  }

  /** Edit mode: branch a copy from the current state. */
  function handleSaveAsCopy() {
    const poster = posterUrl();
    if (!poster) return;
    const character = addCharacter(
      `${saveName || "Character"} (copy)`,
      spec,
      poster,
    );
    toast.push(`“${character.name}” created.`, "success");
    router.push(`/character/${character.id}`);
  }

  /** Save the whole sheet as one library asset (poster = front view). */
  function handleSaveToLibrary() {
    if (savedToLibrary || completedViews.length === 0) return;
    const front = completedViews.find((view) => view.id === "front") ?? completedViews[0];
    const frontView = sheetViewById(front.id);
    const asset = {
      id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind: "image" as const,
      title: titleFromPrompt(spec.prompt || "AI character"),
      prompt: composeCharacterPrompt(spec),
      url: front.url,
      variants: completedViews.map((view) => view.url),
      posterUrl: front.url,
      settings: characterSheetSettings(
        spec,
        frontView!,
        renderParams,
        uncensored,
      ),
      createdAt: Date.now(),
      favorite: false,
      mode: uncensored ? "Character Studio (Uncensored)" : "Character Studio",
      meta: {
        requestId: front.requestId ?? "",
        seeds: completedViews.map((view) => view.seed ?? "").join(", "),
        example: false,
        look: spec.look,
        nsfwLevel: spec.nsfwLevel,
        rating: uncensored ? "Uncensored" : "Regular",
        referenceThumb: reference?.dataUrl ?? "",
        // View order mirrors `variants` so the panel can restore the sheet.
        sheetOrder: completedViews.map((view) => view.id),
        ...(galleryId ? { characterIds: [galleryId] } : {}),
      } as Asset["meta"],
    };
    addAsset(asset);
    setLastSavedAsset({ id: asset.id, meta: asset.meta });
    setSavedToLibrary(true);
    toast.push("Character sheet saved to your library.", "success");
  }

  /** Promote a sheet view to the character's poster image. */
  function handleSetPoster(url: string) {
    if (!galleryId) return;
    updateCharacter(galleryId, { thumbnail: url });
    toast.push("Poster updated.", "success");
  }

  /** Sheet renders use the Review step's knobs plus the task model — the
   * model is resolved here (settings pill) and handed to the panel. Kept
   * with the other hooks: it must run before any early return. */
  const sheetParams: CharacterRenderParams = useMemo(
    () => ({ ...renderParams, modelId: characterModelId ?? undefined }),
    [renderParams, characterModelId],
  );

  /* ------------------------------ Not found ------------------------------ */
  if (missing) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6">
        <EmptyState
          icon="character"
          title="Character not found"
          body="This character may have been deleted, or the link is out of date."
          action={
            <LinkButton href="/character" variant="secondary">
              Back to library
            </LinkButton>
          }
        />
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6">
        <div className="flex justify-center">
          <div
            aria-hidden
            className="size-10 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary"
          />
        </div>
      </div>
    );
  }

  const canRender = spec.prompt.trim().length > 0;


  return (
    <div
      ref={scrollRef}
      className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-5 sm:px-6 lg:py-7"
    >
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              aria-label="Back to character library"
              onClick={backToLibrary}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
            >
              <Icon name="arrow-left" size={16} />
            </button>
            <div className="min-w-0">
              <h1 className="min-w-0 truncate text-[17px] font-extrabold tracking-[-0.02em] text-ink sm:text-[19px]">
                {mode === "edit" && characterId
                  ? saveName || "Edit character"
                  : parentName
                    ? `Variation of ${parentName}`
                    : "Character Studio"}
              </h1>
              {parentName && (
                <p className="text-[11.5px] text-muted">
                  Seeded from {parentName} — tweak anything, then save as a new variation.
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Segmented<CreationMode>
              ariaLabel="Creation mode"
              value={creationMode}
              onChange={switchMode}
              options={[
                { value: "simple", label: "Simple", icon: "sparkle" },
                { value: "details", label: "Detailed", icon: "sliders" },
              ]}
            />
            <p className="hidden text-[12px] text-muted sm:block">
              {creationMode === "simple"
                ? "One prompt, straight to the sheet."
                : "Full control, step by step."}
            </p>
          </div>

          {creationMode === "details" && (
            <div className="mt-4 sm:mt-5">
              <Stepper
                current={step}
                maxVisited={maxVisited}
                onStepClick={(next) => goToStep(next)}
              />
            </div>
          )}

          <div className="mt-4 rounded-[20px] border border-border bg-raised p-5 shadow-card sm:p-7">
            {creationMode === "simple" ? (
              <StepSimple
                spec={spec}
                patch={patchSpec}
                promptError={promptError}
                onSwitchToDetailed={() => switchMode("details")}
                models={catalog.models}
                modelId={characterModelId}
                onModelChange={(nextModel) => setSelectedModel("image", nextModel)}
              />
            ) : (
              <>
                {step === 1 && (
                  <StepDetails
                    spec={spec}
                    patch={patchSpec}
                    promptError={promptError}
                    onBack={backToLibrary}
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
                    onGenerate={requestSheetBatch}
                  />
                )}
              </>
            )}
          </div>

          {creationMode === "details" && (
            <p className="mt-3 text-center text-[12px] text-muted">
              Step {step} of {CHARACTER_STEPS.length} · {CHARACTER_STEPS[step - 1]}
            </p>
          )}
        </div>

        {/* Mobile drawer backdrop */}
        {sheetOpen && (
          <button
            type="button"
            aria-label="Close character sheet"
            onClick={() => setSheetOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
          />
        )}

        {/* One sheet instance: a sticky aside on desktop, a bottom drawer on
            mobile — never two mounts, so renders always keep running. */}
        <aside
          className={
            sheetOpen
              ? "fixed inset-x-0 bottom-0 z-50 max-h-[86dvh] overflow-y-auto rounded-t-[20px] border-t border-border bg-raised p-3 shadow-2xl"
              : "mt-6 hidden lg:sticky lg:top-6 lg:mt-0 lg:block"
          }
        >
          {sheetOpen && (
            <div className="mb-1 flex justify-end px-1">
              <button
                type="button"
                aria-label="Close"
                onClick={() => setSheetOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-full bg-surface-2 text-ink-soft"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <CharacterSheetPanel
            spec={spec}
            uncensored={uncensored}
            renderParams={sheetParams}
            batchRequest={batchRequest}
            canRender={canRender}
            renderHint="Describe your character first — then render the sheet."
            mode={mode}
            saveName={saveName}
            onNameChange={setSaveName}
            parentName={parentName}
            savedCharacterId={savedCharacterId}
            savingChanges={savingChanges}
            savedToLibrary={savedToLibrary}
            initialViews={initialViews}
            onViewsChange={handleViewsChange}
            onSaveCharacter={handleSaveCharacter}
            onSaveChanges={handleSaveChanges}
            onSaveAsCopy={handleSaveAsCopy}
            onSaveToLibrary={handleSaveToLibrary}
            onSetPoster={handleSetPoster}
          />
        </aside>
      </div>

      {/* Mobile launcher pill */}
      {!sheetOpen && (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-primary-strong px-3.5 py-2 text-[12.5px] font-bold text-white shadow-lg lg:hidden"
        >
          <Icon name="grid" size={14} />
          Sheet {completedViews.length}/6
        </button>
      )}
    </div>
  );
}
