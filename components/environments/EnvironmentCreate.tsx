"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button, FieldShell, SelectField, TextAreaField, useToast } from "@/components/ui";
import { CompareModal, VariantGrid, type VariantCandidate } from "@/components/production/primitives/variants";
import type { MediaPreviewState } from "@/components/production/primitives/media";
import {
  EMPTY_STRUCTURED_STATE,
  StructuredStateFields,
  type StructuredStateValue,
} from "@/components/environments/StructuredStateFields";
import {
  createEnvironment,
  type EnvironmentSnapshot,
} from "@/components/environments/environment-store";
import { IMAGE_STYLES, type ImageStyleKey } from "@/lib/constants";
import { GenerationError, requestGeneration } from "@/lib/generation";
import { refFromMediaUrl } from "@/lib/media/frame";

/**
 * Create flow (spec 07 §5): describe the environment → generate 3–4 plates
 * through the same durable job pipeline the character studio uses
 * (requestGeneration → /api/jobs) → compare and select → save the canon
 * entry. Structured canon defaults are captured here so a new environment
 * starts life with structured state, not prompt-only prose.
 */

const PLATE_COUNT = 4;

type PlateSlot = {
  status: "idle" | "rendering" | "done" | "failed";
  url?: string;
  ref?: string | null;
  error?: string;
};

const IDLE_PLATES: PlateSlot[] = Array.from({ length: PLATE_COUNT }, () => ({ status: "idle" as const }));

function composePlatePrompt(description: string, style: ImageStyleKey): string {
  return [
    description.trim(),
    IMAGE_STYLES[style],
    "wide establishing shot of the environment, no people, no text",
  ]
    .filter(Boolean)
    .join(", ");
}

function plateSettings(style: ImageStyleKey) {
  return {
    kind: "image" as const,
    aspect: "16:9" as const,
    resolution: "1080p" as const,
    style,
    duration: "5s" as const,
    count: 1,
    seed: "",
    negativePrompt: "",
    enhance: true,
    safe: true,
  };
}

function previewFor(
  slot: PlateSlot,
  index: number,
  onRetry: (index: number) => void,
): MediaPreviewState {
  if (slot.status === "rendering") return { phase: "loading" };
  if (slot.status === "failed") {
    return {
      phase: "error",
      message: slot.error ?? "This plate could not be generated.",
      onRetry: () => onRetry(index),
    };
  }
  if (slot.status === "done" && slot.url) {
    return {
      phase: "ready",
      media: { kind: "image", src: slot.url, alt: `Environment plate ${index + 1}` },
    };
  }
  return {
    phase: "empty",
    title: "Plate not generated",
    body: "Press “Generate plates” and a candidate will fill this card.",
  };
}

export function EnvironmentCreate() {
  const toast = useToast();
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [palette, setPalette] = useState("");
  const [style, setStyle] = useState<ImageStyleKey>("Cinematic");
  const [state, setState] = useState<StructuredStateValue>(EMPTY_STRUCTURED_STATE);

  const [plates, setPlates] = useState<PlateSlot[]>(IDLE_PLATES);
  const [selectedPlate, setSelectedPlate] = useState<string | null>(null);
  const [compareIndex, setCompareIndex] = useState<number | null>(null);
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const platesRef = useRef(plates);
  platesRef.current = plates;
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  const styleRef = useRef(style);
  styleRef.current = style;
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef(false);

  const busy = batch !== null;
  const canRender = description.trim().length > 0 && !busy;
  const canSave = name.trim().length > 0 && !busy && !saving;
  const doneCount = plates.filter((slot) => slot.status === "done").length;

  /** Render one plate slot; resolves the media url or null on failure/abort. */
  async function renderSlot(index: number): Promise<string | null> {
    const previous = platesRef.current[index];
    const controller = new AbortController();
    abortRef.current = controller;
    patchPlate(index, { status: "rendering", error: undefined });
    try {
      const response = await requestGeneration({
        settings: plateSettings(styleRef.current),
        prompt: composePlatePrompt(descriptionRef.current, styleRef.current),
        signal: controller.signal,
      });
      const media = response.media[0];
      if (!media?.url) throw new GenerationError("The render came back empty. Try again.");
      patchPlate(index, { status: "done", url: media.url, ref: refFromMediaUrl(media.url) });
      return media.url;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        patchPlate(
          index,
          previous.status === "done" && previous.url
            ? { status: "done", url: previous.url, ref: previous.ref }
            : { status: "idle" },
        );
        return null;
      }
      patchPlate(index, {
        status: "failed",
        error: (error as GenerationError).message || "The plate could not be generated. Try again.",
      });
      return null;
    }
  }

  function patchPlate(index: number, patch: Partial<PlateSlot>) {
    setPlates((prev) => prev.map((slot, slotIndex) => (slotIndex === index ? { ...slot, ...patch } : slot)));
  }

  /** Full batch: 3–4 candidates in sequence; a failure leaves its own card
   * retryable and never blocks the rest. */
  async function runBatch() {
    if (busy || !canRender) return;
    cancelRef.current = false;
    setBatch({ index: 0, total: PLATE_COUNT });
    try {
      for (let index = 0; index < PLATE_COUNT; index++) {
        if (cancelRef.current) break;
        setBatch({ index: index + 1, total: PLATE_COUNT });
        await renderSlot(index);
      }
    } finally {
      setBatch(null);
      abortRef.current = null;
    }
  }

  function cancelBatch() {
    cancelRef.current = true;
    abortRef.current?.abort();
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const selectedIndex = selectedPlate === null ? null : Number(selectedPlate);
      const chosen = selectedIndex !== null ? plates[selectedIndex] : undefined;
      const snapshot: Partial<EnvironmentSnapshot> = {
        name,
        description,
        palette,
        style,
        ...state,
      };
      const entry = createEnvironment({
        ...snapshot,
        plateRef: chosen?.ref ?? null,
        plateUrl: chosen?.url ?? null,
      });
      toast.push("Environment saved to the canon library.", "success");
      router.push(`/environments/${entry.id}`);
    } finally {
      setSaving(false);
    }
  }

  const retrySlot = (index: number) => void renderSlot(index);

  const candidates: VariantCandidate[] = plates.map((slot, index) => ({
    id: String(index),
    label: `Plate ${index + 1}`,
    preview: previewFor(slot, index, retrySlot),
    badge: selectedPlate === String(index) ? "Selected" : undefined,
    // Only a finished plate can be selected or compared; the retry affordance
    // lives inside the preview itself, so a failed card stays retryable.
    disabled: slot.status !== "done",
  }));

  const compareSlot = compareIndex !== null ? plates[compareIndex] : null;
  const compareWith = (() => {
    if (compareSlot?.status !== "done" || !compareSlot.url) return null;
    const selectedIndex = selectedPlate === null ? null : Number(selectedPlate);
    const other =
      selectedIndex !== null && selectedIndex !== compareIndex
        ? plates[selectedIndex]
        : plates.find((slot, index) => slot.status === "done" && index !== compareIndex);
    return other?.status === "done" && other.url
      ? { label: selectedIndex !== null && selectedIndex !== compareIndex ? "Selected plate" : "Plate", url: other.url }
      : null;
  })();

  return (
    <div className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="max-w-2xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Environments / New</p>
          <h1 className="mt-2 text-[30px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[38px]">
            New environment
          </h1>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Describe the place, generate candidate plates, and pin structured canon defaults — the
            same identity system your characters use.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="arrow-left"
          onClick={() => router.push("/environments")}
        >
          Library
        </Button>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start">
        {/* Describe + structured canon defaults */}
        <section aria-label="Describe the environment" className="space-y-4 rounded-[14px] border border-border bg-raised p-4 sm:p-5">
          <FieldShell label="Name" htmlFor="environment-name" hint="What your scenes will call this place.">
            <input
              id="environment-name"
              value={name}
              placeholder="e.g. Dragon cave"
              onChange={(event) => setName(event.target.value)}
              data-testid="environments.create.field.name"
              className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </FieldShell>
          <TextAreaField
            label="Description"
            value={description}
            maxLength={600}
            rows={3}
            placeholder="Prose establishing shot: what the camera sees when a scene opens here."
            onChange={setDescription}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell label="Palette" htmlFor="environment-palette" hint="Colour keys the plate should hold across views.">
              <input
                id="environment-palette"
                value={palette}
                placeholder="e.g. teal and rust"
                onChange={(event) => setPalette(event.target.value)}
                data-testid="environments.create.field.palette"
                className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              />
            </FieldShell>
            <SelectField
              label="Render style"
              value={style}
              onChange={(event) => setStyle(event.target.value as ImageStyleKey)}
            >
              {Object.keys(IMAGE_STYLES).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
              Structured canon defaults
            </p>
            <p className="mb-4 mt-1 text-[12px] text-muted">
              Stored as structured values, not prompt prose — scenes inherit and override them per shot.
            </p>
            <StructuredStateFields
              value={state}
              onChange={setState}
              idPrefix="environment-create"
              testIdPrefix="environments.create.state"
            />
          </div>
        </section>

        {/* Plates */}
        <section aria-label="Environment plates" className="space-y-3 rounded-[14px] border border-border bg-raised p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[13.5px] font-bold text-ink">Plates</p>
              <p className="text-[11.5px] leading-tight text-muted">
                {busy
                  ? `Rendering plate ${batch?.index ?? 1} of ${PLATE_COUNT}…`
                  : doneCount > 0
                    ? `${doneCount} of ${PLATE_COUNT} plates ready — compare, then use one.`
                    : "Three to four candidates; pick one as the canonical plate."}
              </p>
            </div>
            {busy ? (
              <Button size="sm" variant="secondary" icon="close" onClick={cancelBatch}>
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                icon="sparkle"
                disabled={!canRender}
                title={description.trim() ? undefined : "Describe the environment to enable plate generation."}
                onClick={() => void runBatch()}
                data-testid="environments.create.generate"
              >
                {doneCount > 0 ? "Re-generate all" : "Generate plates"}
              </Button>
            )}
          </div>
          {!description.trim() && (
            <p className="rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[11.5px] text-muted">
              Write the description first — every plate renders from it.
            </p>
          )}
          <VariantGrid
            candidates={candidates}
            selectedId={selectedPlate}
            onSelect={setSelectedPlate}
            onCompare={(id) => setCompareIndex(Number(id))}
            columns={2}
            ratio="16 / 9"
            ariaLabel="Environment plate candidates"
            testId="environments.create.variants"
            emptyState={{
              title: "No plates yet",
              body: "Generate plates to compare candidate looks for this environment.",
            }}
          />
        </section>
      </div>

      {/* Save bar */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border bg-raised px-4 py-3.5">
        <p className="text-[12px] text-muted">
          {selectedPlate === null
            ? "You can save without a plate and add one later — but a plate is what keeps scenes anchored."
            : `Plate ${Number(selectedPlate) + 1} will be saved as the canonical plate.`}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => router.push("/environments")}>
            Cancel
          </Button>
          <Button
            icon="check"
            loading={saving}
            disabled={!canSave}
            title={name.trim() ? undefined : "Give the environment a name to save."}
            onClick={() => void save()}
            data-testid="environments.create.save"
          >
            Save environment
          </Button>
        </div>
      </div>

      <CompareModal
        open={compareIndex !== null && compareWith !== null}
        left={compareSlot?.url ? { label: `Plate ${(compareIndex ?? 0) + 1}`, preview: { phase: "ready", media: { kind: "image", src: compareSlot.url, alt: `Plate ${(compareIndex ?? 0) + 1}` } } } : null}
        right={compareWith ? { label: compareWith.label, preview: { phase: "ready", media: { kind: "image", src: compareWith.url, alt: compareWith.label } } } : null}
        ratio="16 / 9"
        title="Compare plates"
        onClose={() => setCompareIndex(null)}
        testId="environments.create.compare"
      />
    </div>
  );
}
