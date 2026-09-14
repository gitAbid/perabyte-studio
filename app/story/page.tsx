"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import {
  Badge,
  Button,
  Card,
  Segmented,
  SelectField,
  TextAreaField,
  useToast,
} from "@/components/ui";
import {
  ASPECTS,
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_STYLES,
  PROMPT_MAX,
  PROMPT_PLACEHOLDERS,
  RESOLUTIONS,
  VIDEO_STYLES,
  type AspectKey,
  type ResolutionKey,
} from "@/lib/constants";
import { downloadMedia, requestGeneration } from "@/lib/generation";
import { addAsset } from "@/lib/store";
import type { Asset, GenerationSettings, StoryScene } from "@/lib/types";

const STEPS = [
  { n: 1, title: "First Scene", body: "Describe your starting point" },
  { n: 2, title: "Continue", body: "Add the next scene" },
  { n: 3, title: "Generate", body: "Build your story" },
];

const CONTINUATIONS = [
  "an establishing wide shot that sets the scene",
  "the journey continues deeper into the landscape",
  "a quiet turning point with dramatic light",
  "the closing resolve shot, warm and hopeful",
];

export default function StoryPage() {
  const toast = useToast();
  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | undefined>();
  const [aspect, setAspect] = useState<AspectKey>("16:9");
  const [resolution, setResolution] = useState<ResolutionKey>("1080p");
  const [style, setStyle] = useState<string>("Realistic");
  const [scenes, setScenes] = useState<StoryScene[]>([]);
  const [busy, setBusy] = useState(false);
  const [storyId, setStoryId] = useState<string | null>(null);

  const styles = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  const activeStep = scenes.length === 0 ? 1 : scenes.length < 3 ? 2 : 3;

  function settings(): GenerationSettings {
    const base = kind === "video" ? { ...DEFAULT_IMAGE_SETTINGS } : DEFAULT_IMAGE_SETTINGS;
    return { ...base, kind, aspect, resolution, style };
  }

  async function generateScene(index: number, draft: StoryScene[]) {
    const scene = draft[index];
    const settingsValue = settings();
    const response = await requestGeneration({
      settings: settingsValue,
      prompt: scene.prompt,
    });
    const url = response.media[0]?.url ?? null;
    const next = draft.map((s, i) =>
      i === index ? { ...s, url, status: "completed" as const, kind } : s,
    );
    setScenes([...next]);
    persistStory(next, settingsValue);
    return next;
  }

  function persistStory(list: StoryScene[], settingsValue: GenerationSettings) {
    const withMedia = list.filter((s) => s.url);
    if (!withMedia.length) return;
    const asset: Asset = {
      id: storyId ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: "story",
      title: prompt.slice(0, 40) || "Untitled story",
      prompt,
      url: withMedia[0].url as string,
      variants: withMedia.map((s) => s.url as string),
      posterUrl: withMedia[0].url as string,
      settings: settingsValue,
      createdAt: Date.now(),
      favorite: false,
      mode: "Story Mode",
      scenes: list,
      meta: { scenes: withMedia.length, style },
    };
    addAsset(asset);
    setStoryId(asset.id);
  }

  async function handleGenerateAll() {
    if (!prompt.trim()) {
      setPromptError("Describe the first scene of your story before generating.");
      return;
    }
    setPromptError(undefined);
    setBusy(true);

    let draft: StoryScene[] = scenes.length
      ? scenes
      : [
          {
            id: "sc_1",
            prompt: prompt.trim(),
            url: null,
            status: "queued",
            kind,
          },
        ];
    setScenes(draft);

    try {
      for (let i = 0; i < draft.length; i += 1) {
        if (draft[i].url) continue;
        draft = draft.map((s, idx) =>
          idx === i ? { ...s, status: "generating" as const } : s,
        );
        setScenes([...draft]);
        draft = await generateScene(i, draft);
      }
      toast.push(`Story saved with ${draft.filter((s) => s.url).length} scenes.`, "success");
    } catch (error) {
      const message = (error as Error).message ?? "Scene generation failed.";
      setScenes((prev) =>
        prev.map((s) => (s.status === "generating" ? { ...s, status: "failed" } : s)),
      );
      toast.push(message, "error");
    } finally {
      setBusy(false);
    }
  }

  function addScene() {
    const index = scenes.length;
    const continuation = CONTINUATIONS[Math.min(index, CONTINUATIONS.length - 1)];
    setScenes((prev) => [
      ...prev,
      {
        id: `sc_${prev.length + 1}_${Math.random().toString(36).slice(2, 5)}`,
        prompt: `${prompt.trim()}, ${continuation}`,
        url: null,
        status: "queued",
        kind,
      },
    ]);
    toast.push("Scene added. Generate the story to render it.");
  }

  function reset() {
    setScenes([]);
    setStoryId(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-12 pt-8 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted transition-colors hover:text-ink"
      >
        <Icon name="arrow-left" size={15} />
        Back
      </Link>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[-0.03em] text-ink sm:text-[34px]">
            Generate a Story
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Create a sequence of images and videos that tell a story. Add your
            first scene and let the AI continue the journey.
          </p>
        </div>
        <Badge tone="primary">
          <Icon name="story" size={13} /> Story Mode
        </Badge>
      </div>

      {/* Stepper */}
      <ol className="mt-8 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step) => {
          const active = step.n === activeStep;
          const done = step.n < activeStep;
          return (
            <li
              key={step.n}
              className={`flex items-center gap-3 rounded-[16px] border p-4 ${
                active
                  ? "border-primary bg-primary-soft"
                  : "border-border bg-white"
              }`}
            >
              <span
                className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
                  done
                    ? "bg-success text-white"
                    : active
                      ? "bg-primary text-white"
                      : "bg-surface-2 text-muted"
                }`}
              >
                {done ? <Icon name="check" size={15} /> : step.n}
              </span>
              <span>
                <span className="block text-[13.5px] font-bold text-ink">
                  {step.title}
                </span>
                <span className="block text-[12px] text-muted">{step.body}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:gap-8">
        <Card className="h-fit">
          <Segmented
            ariaLabel="Story media type"
            value={kind}
            onChange={(next) => setKind(next)}
            options={[
              { value: "image", label: "Image", icon: "image" },
              { value: "video", label: "Video", icon: "video" },
            ]}
          />

          <div className="mt-6 space-y-5">
            <TextAreaField
              label="Story opening"
              value={prompt}
              maxLength={PROMPT_MAX}
              rows={4}
              error={promptError}
              placeholder={PROMPT_PLACEHOLDERS.story}
              hint="Every scene builds on this starting point."
              onChange={(value) => {
                setPrompt(value);
                if (promptError) setPromptError(undefined);
              }}
            />

            <SelectField
              label="Aspect Ratio"
              value={aspect}
              onChange={(e) => setAspect(e.target.value as AspectKey)}
            >
              {Object.entries(ASPECTS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label} — {value.hint}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Resolution"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as ResolutionKey)}
            >
              {Object.entries(RESOLUTIONS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Style"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            >
              {Object.keys(styles).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="mt-6 flex flex-col gap-2">
            <Button block icon="sparkle" loading={busy} onClick={handleGenerateAll}>
              {scenes.some((s) => s.url) ? "Generate pending scenes" : "Generate story"}
            </Button>
            <Button
              variant="secondary"
              block
              icon="plus"
              disabled={busy || scenes.length >= 6}
              onClick={addScene}
            >
              Add scene
            </Button>
          </div>
        </Card>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(scenes.length ? scenes : Array.from({ length: 3 })).map((scene, index) => {
              const typed = scene as StoryScene | undefined;
              const label = typed?.id ? `Scene ${index + 1}` : `Scene ${index + 1}`;
              return (
                <div key={typed?.id ?? `placeholder-${index}`} className="space-y-2">
                  {typed?.url ? (
                    kind === "video" ? (
                      <VideoStage
                        posterUrl={typed.url}
                        title={typed.prompt}
                        durationSeconds={5}
                      />
                    ) : (
                      <MediaFrame
                        src={typed.url}
                        alt={typed.prompt}
                        ratio={`${ASPECTS[aspect].width}/${ASPECTS[aspect].height}`}
                      />
                    )
                  ) : typed && (typed.status === "generating" || typed.status === "queued") ? (
                    <div
                      className="skeleton w-full rounded-[16px]"
                      style={{
                        aspectRatio: `${ASPECTS[aspect].width}/${ASPECTS[aspect].height}`,
                      }}
                    />
                  ) : (
                    <div
                      className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong bg-surface px-3 text-center"
                      style={{
                        aspectRatio: `${ASPECTS[aspect].width}/${ASPECTS[aspect].height}`,
                      }}
                    >
                      <Icon name="image" size={20} className="text-muted" />
                      <p className="mt-2 text-[12px] font-semibold text-muted">
                        {index === 0 ? "Your first scene" : index === 1 ? "Continue the story" : "Add an end…"}
                      </p>
                    </div>
                  )}
                  <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                    {label}
                  </p>
                  {typed?.prompt && (
                    <p className="line-clamp-2 text-[12px] leading-snug text-ink-soft">
                      {typed.prompt}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {scenes.some((s) => s.url) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                icon="download"
                onClick={() => {
                  const first = scenes.find((s) => s.url);
                  if (first?.url) {
                    downloadMedia(first.url, `perabyte-story-${Date.now()}`);
                    toast.push("Your download has started.", "success");
                  }
                }}
              >
                Download first scene
              </Button>
              {storyId && (
                <Link
                  href={`/results?id=${storyId}`}
                  className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-border-strong bg-white px-4 text-sm font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                >
                  Open in Results
                  <Icon name="arrow-right" size={16} />
                </Link>
              )}
              <Button variant="ghost" icon="refresh" onClick={reset}>
                Start over
              </Button>
            </div>
          )}

          <p className="text-[12px] text-muted">
            Scenes render one at a time so a failed scene never costs you the
            whole story. Every completed scene is stored in History.
          </p>
        </div>
      </div>
    </div>
  );
}