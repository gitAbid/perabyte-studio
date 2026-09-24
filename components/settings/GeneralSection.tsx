"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog, SelectField, Toggle, useToast } from "@/components/ui";
import { useModelCatalog } from "@/lib/model-catalog";
import { PROMPT_MAX, PROMPT_MAX_RANGE } from "@/lib/constants";
import {
  setMaskUncensored,
  setSelectedModel,
  setSmartMask,
  setUncensoredEnabled,
  useSettings,
} from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";
import { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function GeneralSection({
  providers,
  enhanceModel,
  writerModel,
  promptMaxChars,
  sceneConsistency,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  writerModel: string | null;
  promptMaxChars: number;
  sceneConsistency: boolean;
  onUpdate: OnUpdate;
}) {
  return (
    <SectionShell
      icon="sliders"
      title="General"
      description="Content preferences and default models"
    >
      <ContentPreferencesCard />
      <SceneConsistencyCard sceneConsistency={sceneConsistency} onUpdate={onUpdate} />
      <TaskModelsCard
        providers={providers}
        enhanceModel={enhanceModel}
        writerModel={writerModel}
        onUpdate={onUpdate}
      />
      <PromptLimitCard promptMaxChars={promptMaxChars} onUpdate={onUpdate} />
    </SectionShell>
  );
}

function SceneConsistencyCard({
  sceneConsistency,
  onUpdate,
}: {
  sceneConsistency: boolean;
  onUpdate: OnUpdate;
}) {
  const toast = useToast();
  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Story
      </p>
      <div className="mt-3">
        <Toggle
          label="Scene consistency"
          description="Keyframe every scene from your characters and locations before animating. A vision check scores each keyframe against the scene; a low score re-rolls it once before the animation starts. On by default."
          checked={sceneConsistency}
          onChange={(next) => {
            onUpdate({ sceneConsistency: next })
              .then(() =>
                toast.push(
                  next
                    ? "Scene consistency on — video scenes anchor to keyframes."
                    : "Scene consistency off — scenes animate straight from prompts.",
                ),
              )
              .catch(() => undefined);
          }}
        />
      </div>
    </div>
  );
}

function ContentPreferencesCard() {
  const toast = useToast();
  const { settings } = useSettings();
  const [confirmUncensored, setConfirmUncensored] = useState(false);

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Content
      </p>
      <div className="mt-3">
        <Toggle
          label="Uncensored Mode"
          description="Unlocks the Character Studio Uncensored mode and adult (18+) image and video generation. Off by default."
          checked={settings.uncensoredEnabled}
          onChange={(next) => {
            if (next) {
              setConfirmUncensored(true);
              return;
            }
            setUncensoredEnabled(false);
            toast.push("Uncensored Mode disabled. Renders stay safe.");
          }}
        />
        {settings.uncensoredEnabled ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-[10px] bg-warning/10 px-2.5 py-2 text-[12px] font-medium text-warning">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            Uncensored Mode is on. All content is intended for adults (18+) only.
          </p>
        ) : (
          <p className="mt-3 text-[11.5px] leading-snug text-muted">
            Enabling requires confirming you are 18+ and accept adult-content
            generation.
          </p>
        )}
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <Toggle
          label="Mask 18+ content"
          description="Blur uncensored (18+) images and videos in your library, previews and results until you choose to show each one. On by default."
          checked={settings.maskUncensored}
          onChange={(next) => {
            setMaskUncensored(next);
            toast.push(
              next
                ? "18+ content is masked again."
                : "Masking off — uncensored renders now show directly.",
            );
          }}
        />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <Toggle
          label="AI smart masking"
          description="Judge each render's actual content with a vision model instead of trusting the Uncensored Mode flag — tame uncensored renders stop being blurred and explicit safe-mode renders get masked. Falls back to the render flag when the vision model is unavailable."
          checked={settings.smartMask}
          onChange={(next) => {
            setSmartMask(next);
            toast.push(
              next
                ? "Smart masking on — previews are judged by content."
                : "Smart masking off — the render flag decides masking.",
            );
          }}
        />
      </div>

      <ConfirmDialog
        open={confirmUncensored}
        title="Enable Uncensored Mode?"
        body="This unlocks adult (18+) content, including explicit image, video and character generation. Characters are always adults. You confirm you are 18 or older."
        confirmLabel="Enable 18+ mode"
        onCancel={() => setConfirmUncensored(false)}
        onConfirm={() => {
          setUncensoredEnabled(true);
          setConfirmUncensored(false);
          toast.push("Uncensored Mode enabled.", "success");
        }}
      />
    </div>
  );
}

function TaskModelsCard({
  providers,
  enhanceModel,
  writerModel,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  writerModel: string | null;
  onUpdate: OnUpdate;
}) {
  const { settings, ready } = useSettings();
  const image = useModelCatalog("image");
  const video = useModelCatalog("video");
  const enhanceOptions = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.textModels
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.id,
          label: `${provider.label} — ${model.label}`,
        })),
    );

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Default models
      </p>
      {ready ? (
        <div className="mt-3 space-y-4">
          <SelectField
            label="Default image model"
            value={settings.imageModel ?? ""}
            onChange={(event) =>
              setSelectedModel("image", event.target.value || null)
            }
          >
            <option value="">Workspace default</option>
            {image.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Default video model"
            value={settings.videoModel ?? ""}
            onChange={(event) =>
              setSelectedModel("video", event.target.value || null)
            }
          >
            <option value="">Workspace default</option>
            {video.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Prompt enhancement"
            value={enhanceModel ?? ""}
            onChange={(event) =>
              onUpdate({ tasks: { enhance: event.target.value || null } }).catch(
                () => undefined,
              )
            }
          >
            <option value="">Auto (recommended)</option>
            {enhanceOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Story writer"
            value={writerModel ?? ""}
            onChange={(event) =>
              onUpdate({ tasks: { writer: event.target.value || null } }).catch(
                () => undefined,
              )
            }
          >
            <option value="">Auto (recommended)</option>
            {enhanceOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </SelectField>

          <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
            Per-workspace choices made with the Model badge in each prompt
            window override these defaults.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-muted">Loading models…</p>
      )}
    </div>
  );
}

function PromptLimitCard({
  promptMaxChars,
  onUpdate,
}: {
  promptMaxChars: number;
  onUpdate: OnUpdate;
}) {
  // Draft-commits-on-blur like the render-timeout fields: local state holds
  // the draft, server truth resyncs only when the draft isn't mid-edit.
  const [draft, setDraft] = useState(String(promptMaxChars));
  const [committed, setCommitted] = useState(promptMaxChars);

  useEffect(() => {
    if (promptMaxChars !== committed) {
      setCommitted(promptMaxChars);
      setDraft(String(promptMaxChars));
    }
  }, [promptMaxChars, committed]);

  function commit() {
    const parsed = Number.parseInt(draft.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(committed));
      return;
    }
    const clamped = Math.min(
      PROMPT_MAX_RANGE.max,
      Math.max(PROMPT_MAX_RANGE.min, parsed),
    );
    if (clamped === committed) {
      setDraft(String(committed));
      return;
    }
    setCommitted(clamped);
    setDraft(String(clamped));
    onUpdate({ promptMaxChars: clamped }).catch(() => undefined);
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Prompting
      </p>
      <label className="mt-3 flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[12px] font-semibold text-ink-soft">
            Prompt character limit
          </span>
          <span className="block text-[11px] leading-snug text-muted">
            Applies to Solo, Story, Character prompts and Writer scene
            splitting. Enhancement rewrites stay inside it too. Providers may
            still cap long prompts on their side.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            aria-label="Prompt character limit"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            className="h-8 w-20 rounded-[9px] border border-border-strong bg-raised px-2.5 text-right text-[12.5px] tabular-nums text-ink focus:border-primary focus:outline-none"
          />
          <span className="text-[11.5px] text-muted">chars</span>
        </span>
      </label>
      <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
        Default: {PROMPT_MAX.toLocaleString()} characters (allowed{" "}
        {PROMPT_MAX_RANGE.min.toLocaleString()}–
        {PROMPT_MAX_RANGE.max.toLocaleString()}).
      </p>
    </div>
  );
}
