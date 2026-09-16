"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Button } from "@/components/ui";
import {
  composeCharacterPrompt,
  characterGenerationSettings,
  type CharacterSpec,
} from "@/lib/character";
import { GenerationError, requestGeneration } from "@/lib/generation";
import type { GenerationResponse, LoraSelection } from "@/lib/types";

/**
 * The wizard's live preview: an attribute summary, the composed prompt that
 * updates as options change, and a real single-render quick preview so the
 * user can see the actual character before committing to the full render.
 */
export function CharacterPreviewPanel({
  spec,
  uncensored,
  modelId,
  loras,
}: {
  spec: CharacterSpec;
  /** Global Uncensored Mode gate — shapes the quick render's safety. */
  uncensored: boolean;
  modelId?: string | null;
  /** LoRA selections from the Review step — the preview matches the render. */
  loras?: LoraSelection[];
}) {
  const composed = composeCharacterPrompt(spec);
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<GenerationResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel an in-flight quick preview when the spec changes or the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function runPreview() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      // One cheap image instead of the full four-variation render.
      const settings = {
        ...characterGenerationSettings(
          spec,
          {
            aspect: "9:16",
            resolution: "720p",
            modelId: modelId ?? undefined,
            ...(loras?.length ? { loras } : {}),
          },
          uncensored,
        ),
        count: 1,
      };
      const response = await requestGeneration({
        settings,
        prompt: composed,
        uncensored,
        signal: controller.signal,
      });
      setPreview(response);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      setPreviewError(
        (error as GenerationError).message || "The quick preview failed. Try again.",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPreviewing(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(composed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }

  const summary: [string, string][] = [
    ["Gender", spec.gender],
    ["Age", `${spec.age} years old`],
    ["Ethnicity", spec.ethnicity === "Not specified" ? "—" : spec.ethnicity],
    ["Country", spec.country === "Not specified" ? "—" : spec.country],
    ["Build", spec.build],
    ["Hair", `${spec.hairColor} · ${spec.hairStyle}`],
    ["Eyes", `${spec.eyeColor} · ${spec.eyeShape}`],
    ["Outfit", spec.outfit],
    ["Style", spec.style],
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
            <Icon name="user" size={15} />
          </span>
          <p className="text-[13.5px] font-bold text-ink">Live preview</p>
        </div>

        <dl className="mt-3 space-y-1">
          {summary.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11.5px] text-muted">{label}</dt>
              <dd className="max-w-[60%] truncate text-right text-[11.5px] font-semibold text-ink">
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Composed prompt
            </p>
            <button
              type="button"
              onClick={() => void handleCopy()}
              title="Copy the composed prompt"
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-primary"
            >
              <Icon name={copied ? "check" : "copy"} size={12} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-1.5 max-h-24 overflow-y-auto rounded-[10px] border border-border bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-soft">
            {composed}
          </p>
        </div>
      </div>

      {/* Quick preview — a real one-image render of the current character. */}
      <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[13.5px] font-bold text-ink">Quick preview</p>
            <p className="mt-0.5 text-[11.5px] text-muted">
              One image at 720p to check the look.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={previewing ? undefined : "sparkle"}
            disabled={previewing}
            onClick={() => void runPreview()}
          >
            {previewing ? "Rendering…" : preview ? "Again" : "Render"}
          </Button>
        </div>

        <div className="mt-3">
          {previewing ? (
            <div className="skeleton aspect-[9/16] w-full rounded-[12px]" />
          ) : preview ? (
            <MediaFrame
              src={preview.media[0]?.url ?? null}
              alt="Quick character preview"
              ratio="9/16"
              rounded="rounded-[12px]"
            />
          ) : previewError ? (
            <div className="rounded-[12px] border border-danger/30 bg-danger-soft/50 px-3 py-3 text-center">
              <p className="text-[12px] font-semibold text-danger">{previewError}</p>
              <button
                type="button"
                onClick={() => void runPreview()}
                className="mt-1.5 text-[11.5px] font-semibold text-ink-soft underline-offset-4 hover:text-ink hover:underline"
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-border-strong bg-surface px-3 py-6 text-center">
              <Icon name="image" size={18} className="text-muted" />
              <p className="text-[11.5px] text-muted">
                Render a sample to see the character.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}