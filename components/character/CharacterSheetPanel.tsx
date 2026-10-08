"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Button } from "@/components/ui";
import {
  CompareModal,
  VariantGrid,
  type VariantCandidate,
} from "@/components/production/primitives/variants";
import type { MediaPreviewState } from "@/components/production/primitives/media";
import {
  CharacterRefinePanel,
  type CharacterApproval,
  type RefineAction,
} from "@/components/character/CharacterRefinePanel";
import {
  SHEET_VIEWS,
  characterSheetSettings,
  composeCharacterPrompt,
  composeSheetPrompt,
  type CharacterRenderParams,
  type CharacterSpec,
  type SheetView,
  type SheetViewId,
} from "@/lib/character";
import { GenerationError, downloadMedia, requestGeneration } from "@/lib/generation";

/** One completed sheet view, reported to the parent for saving/tagging. */
export interface CompletedSheetView {
  id: SheetViewId;
  url: string;
  requestId?: string;
  seed?: number;
}

type ViewStatus = "idle" | "rendering" | "done" | "failed";

interface ViewRender {
  status: ViewStatus;
  url?: string;
  requestId?: string;
  seed?: number;
  error?: string;
}

type ViewState = Record<SheetViewId, ViewRender>;

/* ------------------------------------------------------------------ */
/* Identity variants (spec 06: generate → compare → select)            */
/* ------------------------------------------------------------------ */

/** Spec 06 §2: three character variants per batch, compared and selected. */
const IDENTITY_VARIANT_COUNT = 3;

/** The exact request a variant was produced with — "Try Again" resends these
 * verbatim (spec 06 acceptance: Try Again reuses exact params). */
interface ExactRenderInputs {
  settings: ReturnType<typeof characterSheetSettings>;
  prompt: string;
  uncensored: boolean;
  startImageRef?: string;
}

type VariantStatus = "pending" | "rendering" | "done" | "failed";

/** One identity candidate. Candidates are only ever added — a refine never
 * overwrites an earlier one (immutable history, spec 02 §1). */
interface IdentityVariant {
  id: string;
  label: string;
  status: VariantStatus;
  url?: string;
  requestId?: string;
  seed?: number;
  error?: string;
  exact?: ExactRenderInputs;
}

type BatchStage = "variants" | "views";

interface BatchProgress {
  stage: BatchStage;
  index: number;
  total: number;
}

function emptyViews(): ViewState {
  return Object.fromEntries(
    SHEET_VIEWS.map((view) => [view.id, { status: "idle" } as ViewRender]),
  ) as ViewState;
}

/** The bare media-cache ref of a generated `/api/media?f=<ref>` URL. */
function mediaRefFromUrl(url: string): string | null {
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}

function completedFrom(views: ViewState): CompletedSheetView[] {
  return SHEET_VIEWS.flatMap((view) => {
    const render = views[view.id];
    return render.status === "done" && render.url
      ? [{ id: view.id, url: render.url, requestId: render.requestId, seed: render.seed }]
      : [];
  });
}

/**
 * The right-side character sheet: six design-sheet views rendered in place,
 * one durable job each. Full Front renders first as the identity base; every
 * other view chains off its reference image (img2img) so all views depict the
 * same person. Any tile re-renders solo with the current spec — nothing
 * navigates away. The save cluster lives here too, enabled once a view exists.
 */
export function CharacterSheetPanel({
  spec,
  uncensored,
  renderParams,
  batchRequest,
  canRender,
  renderHint,
  mode,
  saveName,
  onNameChange,
  parentName,
  savedCharacterId,
  savingChanges,
  savedToLibrary,
  initialViews,
  onViewsChange,
  onSaveCharacter,
  onSaveChanges,
  onSaveAsCopy,
  onSaveToLibrary,
  onSetPoster,
  approval,
}: {
  spec: CharacterSpec;
  /** Global Uncensored Mode gate — shapes every view render's safety. */
  uncensored: boolean;
  renderParams: CharacterRenderParams;
  /** Monotonic counter: each increment triggers a fresh full-sheet batch. */
  batchRequest: number;
  canRender: boolean;
  renderHint?: string;
  mode: "new" | "edit";
  saveName: string;
  onNameChange: (name: string) => void;
  parentName: string | null;
  savedCharacterId: string | null;
  savingChanges: boolean;
  savedToLibrary: boolean;
  /** Latest saved sheet (edit mode restore): view id → url. */
  initialViews?: Record<SheetViewId, string> | null;
  onViewsChange: (views: CompletedSheetView[]) => void;
  onSaveCharacter: (posterUrl: string) => void;
  onSaveChanges: () => void;
  onSaveAsCopy: (posterUrl: string) => void;
  onSaveToLibrary: () => void;
  onSetPoster: (url: string) => void;
  /** Canon approval state of the saved sheet (C8) — null while unsaved. */
  approval?: CharacterApproval | null;
}) {
  // Refs are authoritative so the async batch loop always reads current
  // values; state mirrors them for rendering.
  const viewsRef = useRef<ViewState>(emptyViews());
  const [views, setViews] = useState<ViewState>(emptyViews());
  const specRef = useRef(spec);
  specRef.current = spec;
  const paramsRef = useRef(renderParams);
  paramsRef.current = renderParams;
  const uncensoredRef = useRef(uncensored);
  uncensoredRef.current = uncensored;

  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const batchRef = useRef(false);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Identity candidates for the current session. Only ever appended to.
  const variantsRef = useRef<IdentityVariant[]>([]);
  const [variants, setVariants] = useState<IdentityVariant[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ leftId: string; rightId: string } | null>(null);
  const variantCounter = useRef(0);
  const selectedVariantRef = useRef<string | null>(null);
  selectedVariantRef.current = selectedVariantId;

  // Universal refine actions (Try Again / More Like This / Change Something).
  const [refineBusy, setRefineBusy] = useState<RefineAction | null>(null);
  const refineBusyRef = useRef<RefineAction | null>(null);
  const [refineError, setRefineError] = useState<string | null>(null);

  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Cancel in-flight renders when the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  function patchView(id: SheetViewId, patch: Partial<ViewRender>) {
    viewsRef.current = { ...viewsRef.current, [id]: { ...viewsRef.current[id], ...patch } };
    setViews(viewsRef.current);
  }

  function patchVariant(id: string, patch: Partial<IdentityVariant>) {
    variantsRef.current = variantsRef.current.map((variant) =>
      variant.id === id ? { ...variant, ...patch } : variant,
    );
    setVariants(variantsRef.current);
  }

  /** Append one planned candidate slot (pending) to the immutable list. */
  function planVariant(): IdentityVariant {
    variantCounter.current += 1;
    const variant: IdentityVariant = {
      id: `variant_${variantCounter.current}_${Date.now().toString(36)}`,
      label: `Variant ${variantCounter.current}`,
      status: "pending",
    };
    variantsRef.current = [...variantsRef.current, variant];
    setVariants(variantsRef.current);
    return variant;
  }

  /** The exact inputs one front-view identity render uses right now. */
  function identityInputs(): ExactRenderInputs {
    const currentSpec = specRef.current;
    const front = SHEET_VIEWS[0];
    return {
      settings: characterSheetSettings(currentSpec, front, paramsRef.current, uncensoredRef.current),
      prompt: composeSheetPrompt(currentSpec, front, false),
      uncensored: uncensoredRef.current,
    };
  }

  /**
   * Render one identity candidate with the given inputs. Resolves the finished
   * candidate on success, null on failure/abort. Failures are per-candidate
   * (spec 06 §8): successful variants stay selectable.
   */
  async function fireIdentityRender(
    variant: IdentityVariant,
    inputs: ExactRenderInputs,
  ): Promise<IdentityVariant | null> {
    patchVariant(variant.id, { status: "rendering", error: undefined });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await requestGeneration({
        settings: inputs.settings,
        prompt: inputs.prompt,
        uncensored: inputs.uncensored,
        ...(inputs.startImageRef ? { startImageRef: inputs.startImageRef } : {}),
        signal: controller.signal,
      });
      const media = response.media[0];
      if (!media?.url) throw new GenerationError("The render came back empty. Try again.");
      patchVariant(variant.id, {
        status: "done",
        url: media.url,
        requestId: response.requestId,
        seed: media.seed,
        error: undefined,
        exact: inputs,
      });
      return variantsRef.current.find((entry) => entry.id === variant.id) ?? null;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        patchVariant(variant.id, { status: "failed", error: "This render was canceled." });
      } else {
        patchVariant(variant.id, {
          status: "failed",
          error:
            (error as GenerationError).message || "The render failed. Try again.",
        });
      }
      return null;
    }
  }

  /** The selected candidate becomes the character's face: the front tile
   * adopts its image (poster, identity pin and saving all follow the front). */
  function adoptVariantAsFront(variant: IdentityVariant) {
    if (variant.status !== "done" || !variant.url) return;
    viewsRef.current = {
      ...viewsRef.current,
      front: {
        status: "done",
        url: variant.url,
        requestId: variant.requestId,
        seed: variant.seed,
      },
    };
    setViews(viewsRef.current);
  }

  function handleSelectVariant(id: string) {
    if (batchRef.current) return;
    setSelectedVariantId(id);
    const variant = variantsRef.current.find((entry) => entry.id === id);
    if (variant) adoptVariantAsFront(variant);
  }

  /** Compare the clicked candidate against the selected one (or its neighbor). */
  function handleCompare(id: string) {
    const done = variantsRef.current.filter((entry) => entry.status === "done" && entry.url);
    if (done.length < 2) return;
    const leftId = selectedVariantRef.current ?? done[0].id;
    const right =
      done.find((entry) => entry.id === id && entry.id !== leftId) ??
      done.find((entry) => entry.id !== leftId);
    if (!right) return;
    setCompare({ leftId, rightId: right.id });
  }

  /** Retry one failed candidate with the same kind of request it started with. */
  async function retryVariant(id: string) {
    if (batchRef.current || refineBusyRef.current) return;
    const variant = variantsRef.current.find((entry) => entry.id === id);
    if (!variant || variant.status === "rendering") return;
    const inputs = variant.exact ?? identityInputs();
    const done = await fireIdentityRender(variant, inputs);
    if (done && viewsRef.current.front.status !== "done") {
      // The sheet had no identity base — adopt this one so saving works.
      setSelectedVariantId(done.id);
      adoptVariantAsFront(done);
    }
  }

  // Report completed views upward whenever they change (save handlers need
  // the urls/order; the mobile bar needs the count). Ref-stable so the
  // effect never depends on the parent's callback identity.
  const onViewsChangeRef = useRef(onViewsChange);
  onViewsChangeRef.current = onViewsChange;
  useEffect(() => {
    onViewsChangeRef.current(completedFrom(viewsRef.current));
  }, [views]);

  // Restore the latest saved sheet once (edit mode): fill idle tiles only.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialViews) return;
    restoredRef.current = true;
    const next = { ...viewsRef.current };
    let changed = false;
    for (const view of SHEET_VIEWS) {
      const url = initialViews[view.id];
      if (url && next[view.id].status === "idle") {
        next[view.id] = { status: "done", url };
        changed = true;
      }
    }
    if (changed) {
      viewsRef.current = next;
      setViews(next);
    }
  }, [initialViews]);

  /**
   * Render one view. `chainRef` carries the front view's media-cache ref —
   * img2img keeps the identity; a null ref degrades to text-only. Resolves
   * null on failure/abort.
   */
  async function renderOne(
    view: SheetView,
    chainRef: string | null,
  ): Promise<CompletedSheetView | null> {
    const previous = viewsRef.current[view.id];
    const chained = chainRef !== null && view.id !== "front";
    const controller = new AbortController();
    abortRef.current = controller;
    patchView(view.id, { status: "rendering", error: undefined });
    try {
      const currentSpec = specRef.current;
      const response = await requestGeneration({
        settings: characterSheetSettings(currentSpec, view, paramsRef.current, uncensoredRef.current),
        prompt: composeSheetPrompt(currentSpec, view, chained),
        uncensored: uncensoredRef.current,
        ...(chained && chainRef ? { startImageRef: chainRef } : {}),
        signal: controller.signal,
      });
      const media = response.media[0];
      if (!media?.url) throw new GenerationError("The render came back empty. Try again.");
      const render: ViewRender = {
        status: "done",
        url: media.url,
        requestId: response.requestId,
        seed: media.seed,
      };
      viewsRef.current = { ...viewsRef.current, [view.id]: render };
      setViews(viewsRef.current);
      return { id: view.id, url: media.url, requestId: response.requestId, seed: media.seed };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        // Cancelled: keep a previous render, otherwise back to idle.
        patchView(
          view.id,
          previous.status === "done" && previous.url
            ? { status: "done", url: previous.url }
            : { status: "idle" },
        );
        return null;
      }
      patchView(view.id, {
        status: "failed",
        error:
          (error as GenerationError).message || "The render failed. Try again.",
      });
      return null;
    }
  }

  /**
   * Full sheet in two phases (spec 06 §5): first IDENTITY_VARIANT_COUNT
   * identity candidates render one by one — compare/select happens on the
   * grid — then the selected candidate becomes the front view and every other
   * view chains off it so all views depict the same person. A failed candidate
   * leaves its card retryable without blocking the others; if every candidate
   * fails, the sheet keeps its previous views and the batch stops.
   */
  async function runBatch() {
    if (batchRef.current || refineBusyRef.current || !canRender) return;
    cancelRef.current = false;
    batchRef.current = true;
    try {
      const planned = Array.from({ length: IDENTITY_VARIANT_COUNT }, () => planVariant());
      setSelectedVariantId(null);
      let chosen: IdentityVariant | null = null;
      for (let index = 0; index < planned.length; index++) {
        if (cancelRef.current) break;
        setBatch({ stage: "variants", index: index + 1, total: planned.length });
        const done = await fireIdentityRender(planned[index], identityInputs());
        if (done && !chosen) {
          chosen = done;
          setSelectedVariantId(done.id);
        }
      }
      if (!chosen?.url) return;
      adoptVariantAsFront(chosen);
      await runChainedViews(mediaRefFromUrl(chosen.url));
    } finally {
      batchRef.current = false;
      setBatch(null);
      abortRef.current = null;
      // Drop candidates that never started; the in-flight one was marked by
      // its own abort handler.
      variantsRef.current = variantsRef.current.filter(
        (entry) => entry.status !== "pending",
      );
      setVariants(variantsRef.current);
    }
  }

  /** Chain the five non-front views off the given identity base. */
  async function runChainedViews(frontRef: string | null) {
    for (let index = 1; index < SHEET_VIEWS.length; index++) {
      if (cancelRef.current) return;
      const view = SHEET_VIEWS[index];
      setBatch({ stage: "views", index, total: SHEET_VIEWS.length - 1 });
      await renderOne(view, frontRef);
    }
  }

  // Review step's "Generate" (and Simple mode's future callers) trigger the
  // batch through the counter prop.
  const lastBatchRequest = useRef(batchRequest);
  useEffect(() => {
    if (batchRequest !== lastBatchRequest.current) {
      lastBatchRequest.current = batchRequest;
      void runBatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the counter drives it
  }, [batchRequest]);

  function cancelBatch() {
    cancelRef.current = true;
    abortRef.current?.abort();
  }

  /* ---------------------------------------------------------------- */
  /* Universal refine actions (spec 06 §5; spec 02 §8 retry rules)     */
  /* ---------------------------------------------------------------- */

  /** The image every refine starts from: the selected candidate, else the
   * current front view. Null while nothing has been rendered yet. */
  function refineTarget(): { exact: ExactRenderInputs; leadRef: string } | null {
    const selected = selectedVariantRef.current
      ? variantsRef.current.find((entry) => entry.id === selectedVariantRef.current)
      : null;
    if (selected?.status === "done" && selected.url && selected.exact) {
      return { exact: selected.exact, leadRef: mediaRefFromUrl(selected.url) ?? "" };
    }
    const front = viewsRef.current.front;
    if (front.status === "done" && front.url && mediaRefFromUrl(front.url)) {
      return { exact: identityInputs(), leadRef: mediaRefFromUrl(front.url) as string };
    }
    return null;
  }

  /**
   * Run one refine: append a NEW candidate (nothing is overwritten) and render
   * it. "Try Again" resends the exact same request; "More Like This" leads
   * with the selected image; "Change Something" appends the described delta —
   * the identity reference keeps the face, the delta text changes the rest.
   */
  async function runRefine(action: RefineAction, instruction?: string) {
    if (refineBusyRef.current || batchRef.current) return;
    const target = refineTarget();
    if (!target || !target.leadRef) {
      setRefineError(
        "Render the character sheet first — refinements start from an existing image.",
      );
      return;
    }
    setRefineBusy(action);
    refineBusyRef.current = action;
    setRefineError(null);
    const planned = planVariant();
    let inputs: ExactRenderInputs;
    if (action === "try-again") {
      inputs = target.exact;
    } else {
      const front = SHEET_VIEWS[0];
      const basePrompt = composeSheetPrompt(specRef.current, front, true);
      const prompt =
        action === "change" && instruction
          ? `${basePrompt}, change: ${instruction}. Keep the same person — same face and body.`
          : basePrompt;
      inputs = {
        settings: characterSheetSettings(
          specRef.current,
          front,
          paramsRef.current,
          uncensoredRef.current,
        ),
        prompt,
        uncensored: uncensoredRef.current,
        startImageRef: target.leadRef,
      };
    }
    try {
      const done = await fireIdentityRender(planned, inputs);
      if (done) {
        setSelectedVariantId(done.id);
        adoptVariantAsFront(done);
      }
    } finally {
      refineBusyRef.current = null;
      setRefineBusy(null);
    }
  }

  const doneCount = completedFrom(views).length;
  const frontUrl = views.front.status === "done" ? views.front.url : undefined;

  /* ------------------------ Variant grid data ------------------------ */
  const variantRatio = `${renderParams.aspect.replace(":", " / ")}`;
  const locked = batch !== null || refineBusy !== null;
  const variantCandidates: VariantCandidate[] = variants.map((variant) => ({
    id: variant.id,
    label: variant.label,
    disabled: locked,
    preview:
      variant.status === "done" && variant.url
        ? {
            phase: "ready",
            media: { kind: "image", src: variant.url, alt: `${variant.label} — character identity` },
          }
        : variant.status === "failed"
          ? { phase: "error", message: variant.error, onRetry: () => void retryVariant(variant.id) }
          : { phase: "loading" },
  }));
  const compareLeft = compare
    ? variants.find((entry) => entry.id === compare.leftId && entry.url)
    : null;
  const compareRight = compare
    ? variants.find((entry) => entry.id === compare.rightId && entry.url)
    : null;
  const compareSides =
    compareLeft?.url && compareRight?.url
      ? {
          left: {
            label: compareLeft.label,
            preview: {
              phase: "ready" as const,
              media: { kind: "image" as const, src: compareLeft.url, alt: `${compareLeft.label} — character identity` },
            },
          },
          right: {
            label: compareRight.label,
            preview: {
              phase: "ready" as const,
              media: { kind: "image" as const, src: compareRight.url, alt: `${compareRight.label} — character identity` },
            },
          },
        }
      : null;
  /** The image the refine actions start from — shown in the refine panel. */
  const refinePreview: MediaPreviewState =
    frontUrl && views.front.status === "done"
      ? {
          phase: "ready",
          media: { kind: "image", src: frontUrl, alt: "Selected character identity" },
        }
      : { phase: "loading" };
  const refineTargetLabel =
    variants.find((entry) => entry.id === selectedVariantId)?.label ?? "Full Front";

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(composeCharacterPrompt(spec));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
            <Icon name="grid" size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-bold text-ink">Character sheet</p>
            <p className="text-[11.5px] leading-tight text-muted">
              {batch
                ? batch.stage === "variants"
                  ? `Rendering identity variant ${batch.index} of ${batch.total}…`
                  : `Rendering view ${batch.index} of ${batch.total}…`
                : doneCount > 0
                  ? `${doneCount} of ${SHEET_VIEWS.length} views rendered`
                  : "Six views of your character, like a design sheet."}
            </p>
          </div>
        </div>
        {batch ? (
          <Button size="sm" variant="secondary" icon="close" onClick={cancelBatch}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            icon="sparkle"
            disabled={!canRender || refineBusy !== null}
            title={canRender ? undefined : renderHint}
            onClick={() => void runBatch()}
          >
            {doneCount > 0 ? "Re-render sheet" : "Render sheet"}
          </Button>
        )}
      </div>

      {!canRender && renderHint && (
        <p className="rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[11.5px] text-muted">
          {renderHint}
        </p>
      )}

      {/* Identity variants (spec 06: V1 V2 V3) — compare, pick the face. */}
      {variants.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <VariantGrid
            candidates={variantCandidates}
            selectedId={selectedVariantId}
            onSelect={handleSelectVariant}
            onCompare={handleCompare}
            columns={3}
            ratio={variantRatio}
            loading={false}
            ariaLabel="Identity variants"
            testId="character.variants"
          />
          <p className="text-[11px] leading-snug text-muted">
            Picking a variant sets the character's face. Views rendered from a
            previous pick keep their look until the sheet is rendered again.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2" data-testid="character.sheet.grid">
        {SHEET_VIEWS.map((view) => (
          <SheetTile
            key={view.id}
            view={view}
            render={views[view.id]}
            disabled={batch !== null || refineBusy !== null}
            onRender={() => {
              if (view.id === "front") setSelectedVariantId(null);
              void renderOne(
                view,
                view.id === "front" ? null : (frontUrl ? mediaRefFromUrl(frontUrl) : null),
              );
            }}
            onDownload={() => {
              const url = views[view.id].url;
              if (url) downloadMedia(url, `character-${view.id}-${Date.now()}`);
            }}
            onSetPoster={
              views[view.id].url
                ? () => onSetPoster(views[view.id].url as string)
                : undefined
            }
          />
        ))}
      </div>

      {/* Save cluster — active once at least one view exists. */}
      {doneCount > 0 && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-primary/30 bg-primary-soft/40 p-3">
          {mode === "edit" && !savedCharacterId ? (
            <>
              <p className="text-[12.5px] font-bold text-ink">Update this character</p>
              <p className="text-[11.5px] text-muted">
                Save the edited look back to “{saveName}”.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Character name"
                  aria-label="Character name"
                  maxLength={40}
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-border-strong bg-raised px-2.5 text-[12.5px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
                <Button
                  size="sm"
                  icon="check"
                  loading={savingChanges}
                  disabled={!saveName.trim()}
                  onClick={onSaveChanges}
                >
                  Save changes
                </Button>
              </div>
              <Button variant="secondary" size="sm" icon="copy" onClick={() => onSaveAsCopy(frontUrl ?? "")}>
                Save as copy
              </Button>
            </>
          ) : savedCharacterId ? (
            <p className="flex items-center gap-2 text-[12.5px] font-semibold text-primary">
              <Icon name="check" size={14} />
              {mode === "edit"
                ? "Changes saved to the character."
                : "Saved — attach it from the Character pill in Solo or Story."}
            </p>
          ) : (
            <>
              <p className="text-[12.5px] font-bold text-ink">Save this character for reuse</p>
              <p className="text-[11.5px] text-muted">
                {parentName
                  ? `Will be saved as a variation of ${parentName}.`
                  : "Keeps the exact look for Solo scenes and Story frames."}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Character name, e.g. Maya"
                  aria-label="Character name"
                  maxLength={40}
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-border-strong bg-raised px-2.5 text-[12.5px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
                <Button
                  size="sm"
                  icon="user"
                  disabled={!saveName.trim() || !frontUrl}
                  onClick={() => frontUrl && onSaveCharacter(frontUrl)}
                >
                  Save
                </Button>
              </div>
            </>
          )}

          <Button
            variant="secondary"
            icon={savedToLibrary ? "check" : "history"}
            disabled={savedToLibrary}
            onClick={onSaveToLibrary}
          >
            {savedToLibrary ? "Saved to library" : "Save sheet to library"}
          </Button>
        </div>
      )}

      {/* Universal refine + approval (spec 06 §5/§6). */}
      <CharacterRefinePanel
        target={
          frontUrl && views.front.status === "done"
            ? {
                id: selectedVariantId ?? "front",
                label: refineTargetLabel,
                preview: refinePreview,
              }
            : null
        }
        busy={refineBusy}
        error={refineError}
        onTryAgain={() => void runRefine("try-again")}
        onMoreLikeThis={() => void runRefine("more-like-this")}
        onChangeSubmit={(instruction) => void runRefine("change", instruction)}
        approval={approval ?? null}
      />

      {/* Composed prompt — collapsed by default, copyable. */}
      <div className="rounded-[14px] border border-border bg-surface">
        <button
          type="button"
          onClick={() => setPromptOpen((open) => !open)}
          aria-expanded={promptOpen}
          className="flex w-full items-center justify-between px-3 py-2 text-left"
        >
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
            Composed prompt
          </span>
          <Icon name="chevron-down" size={13} className={`text-muted transition-transform ${promptOpen ? "rotate-180" : ""}`} />
        </button>
        {promptOpen && (
          <div className="px-3 pb-2.5">
            <p className="max-h-28 overflow-y-auto rounded-[10px] border border-border bg-raised px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-soft">
              {composeCharacterPrompt(spec)}
            </p>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-muted transition-colors hover:text-primary"
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>

      {/* Side-by-side identity comparison (universal CompareModal). */}
      <CompareModal
        open={compareSides !== null}
        left={compareSides?.left ?? null}
        right={compareSides?.right ?? null}
        title="Compare identity variants"
        ratio={variantRatio}
        onClose={() => setCompare(null)}
        testId="character.compare"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet tile                                                          */
/* ------------------------------------------------------------------ */

function SheetTile({
  view,
  render,
  disabled,
  onRender,
  onDownload,
  onSetPoster,
}: {
  view: SheetView;
  render: ViewRender;
  /** While a batch is running, solo actions lock to keep the chain sane. */
  disabled: boolean;
  onRender: () => void;
  onDownload: () => void;
  onSetPoster?: () => void;
}) {
  const ratio = view.kind === "closeup" ? "1/1" : "9/16";
  return (
    <div
      data-testid={`character.sheet.tile-${view.id}`}
      className="group relative overflow-hidden rounded-[12px] border border-border bg-surface"
    >
      <p className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
        {view.label}
      </p>

      {render.status === "rendering" ? (
        <div className="skeleton w-full" style={{ aspectRatio: ratio }} />
      ) : render.status === "done" && render.url ? (
        <MediaFrame src={render.url} alt={`${view.label} view`} ratio={ratio} rounded="rounded-[11px]" sensitive />
      ) : render.status === "failed" ? (
        <div
          className="flex w-full flex-col items-center justify-center gap-1 bg-danger-soft/40 px-2 text-center"
          style={{ aspectRatio: ratio }}
        >
          <Icon name="alert" size={15} className="text-danger" />
          <p className="line-clamp-3 text-[10.5px] font-medium text-danger">{render.error}</p>
        </div>
      ) : (
        <div
          className="flex w-full flex-col items-center justify-center gap-1 border border-dashed border-border-strong bg-raised/50 px-2 text-center"
          style={{ aspectRatio: ratio }}
        >
          <Icon name="image" size={15} className="text-muted" />
          <p className="text-[10.5px] text-muted">Not rendered</p>
        </div>
      )}

      {/* Hover actions: render/retry always; download + poster once done. */}
      <div
        className={`absolute inset-x-1.5 bottom-1.5 z-10 flex items-center justify-center gap-1 transition-opacity ${
          render.status === "rendering" ? "pointer-events-none opacity-0" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        }`}
      >
        <TileAction
          label={render.status === "failed" ? `Retry ${view.label}` : `Render ${view.label}`}
          icon="refresh"
          disabled={disabled}
          onClick={onRender}
        />
        {render.status === "done" && (
          <>
            <TileAction label={`Download ${view.label}`} icon="download" onClick={onDownload} />
            {onSetPoster && (
              <TileAction label={`Set ${view.label} as poster`} icon="star" onClick={onSetPoster} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TileAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: "refresh" | "download" | "star";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75 disabled:opacity-40"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
