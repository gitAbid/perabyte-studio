"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame, VideoStage } from "@/components/Media";
import {
  Badge,
  Button,
  Card,
  Segmented,
  SelectField,
  TextAreaField,
  Toggle,
  useToast,
} from "@/components/ui";
import {
  ASPECTS,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  DURATIONS,
  IMAGE_STYLES,
  PROMPT_MAX,
  PROMPT_PLACEHOLDERS,
  RESOLUTIONS,
  VIDEO_STYLES,
  VARIANT_COUNTS,
  type AspectKey,
  type DurationKey,
  type ResolutionKey,
} from "@/lib/constants";
import { downloadMedia, useGeneration } from "@/lib/generation";
import { displaySrc } from "@/lib/renderer";
import { addAsset, assetFromResponse, toggleFavorite, updateAsset } from "@/lib/store";
import type { GenerationSettings } from "@/lib/types";

const COPY = {
  image: {
    title: "Generate Image",
    blurb:
      "Turn your idea into stunning images. Adjust the settings below to get the perfect result.",
    previewTitle: "Your image will appear here",
    previewBody: "Add a prompt and configure your settings to get started.",
    ratio: "16/9",
  },
  video: {
    title: "Generate Video",
    blurb:
      "Bring your ideas to life with motion. Adjust the settings below to create your video.",
    previewTitle: "Your video will appear here",
    previewBody: "Add a prompt and configure your settings to get started.",
    ratio: "16/9",
  },
} as const;

export function GeneratorScreen({ kind }: { kind: "image" | "video" }) {
  const router = useRouter();
  const toast = useToast();
  const copy = COPY[kind];

  const [settings, setSettings] = useState<GenerationSettings>(
    kind === "video" ? { ...DEFAULT_VIDEO_SETTINGS } : { ...DEFAULT_IMAGE_SETTINGS },
  );
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState<"basic" | "advanced">("basic");
  const [promptError, setPromptError] = useState<string | undefined>();
  const [assetId, setAssetId] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);

  const { job, run, cancel, reset } = useGeneration();

  // Prefill from History / Results "Regenerate" links.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incoming = params.get("prompt");
    if (!incoming) return;
    setPrompt(incoming.slice(0, PROMPT_MAX));
    const style = params.get("style");
    const aspect = params.get("aspect");
    if (style) {
      const table = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
      if (style in table) setSettings((s) => ({ ...s, style }));
    }
    if (aspect && aspect in ASPECTS) {
      setSettings((s) => ({ ...s, aspect: aspect as AspectKey }));
    }
  }, [kind]);

  const styles = kind === "video" ? VIDEO_STYLES : IMAGE_STYLES;
  const busy = job.phase === "queued" || job.phase === "generating";
  const result = job.phase === "completed" ? job.response : null;
  const primaryUrl = result?.media[0]?.url ?? null;
  const [activeVariant, setActiveVariant] = useState(0);

  useEffect(() => setActiveVariant(0), [result?.requestId]);

  const shownUrl = result?.media[activeVariant]?.url ?? primaryUrl;

  const aspectRatio = useMemo(() => {
    const [w, h] = settings.aspect.split(":").map(Number);
    return `${w}/${h}`;
  }, [settings.aspect]);

  async function handleGenerate() {
    if (!prompt.trim()) {
      setPromptError("Describe what you want to create before generating.");
      promptRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    setPromptError(undefined);
    setAssetId(null);

    const response = await run({ settings: { ...settings, kind }, prompt: prompt.trim() });
    if (!response) return;

    const asset = assetFromResponse(
      response,
      { ...settings, kind },
      prompt.trim(),
    );
    addAsset(asset);
    setAssetId(asset.id);
    setFavorite(false);
    toast.push(
      `${kind === "video" ? "Video" : "Image"} generated and saved to History.`,
      "success",
    );
  }

  function handleFavorite() {
    if (!assetId) return;
    toggleFavorite(assetId);
    setFavorite((f) => !f);
    toast.push("Saved to favourites.", "success");
  }

  function handleDownload() {
    if (!shownUrl) return;
    downloadMedia(shownUrl, `perabyte-${kind}-${Date.now()}`);
    toast.push("Your download has started.", "success");
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
            {copy.title}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            {copy.blurb}
          </p>
        </div>
        <Segmented
          ariaLabel="Generation type"
          value={kind}
          onChange={(next) => router.push(`/generate/${next}`)}
          options={[
            { value: "image", label: "Image", icon: "image" },
            { value: "video", label: "Video", icon: "video" },
          ]}
        />
      </div>

      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:gap-8">
        {/* ------------------------------- Controls ------------------------------ */}
        <Card className="h-fit lg:sticky lg:top-24">
          <h2 className="text-[15px] font-bold text-ink">Generation Settings</h2>

          <div className="mt-4">
            <Segmented
              ariaLabel="Settings detail level"
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "basic", label: "Basic" },
                { value: "advanced", label: "Advanced" },
              ]}
            />
          </div>

          <div className="mt-6 space-y-5">
            <SelectField
              label="Aspect Ratio"
              value={settings.aspect}
              onChange={(e) =>
                setSettings((s) => ({ ...s, aspect: e.target.value as AspectKey }))
              }
            >
              {Object.entries(ASPECTS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label} — {value.hint}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Resolution"
              value={settings.resolution}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  resolution: e.target.value as ResolutionKey,
                }))
              }
            >
              {Object.entries(RESOLUTIONS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Style"
              value={settings.style}
              onChange={(e) => setSettings((s) => ({ ...s, style: e.target.value }))}
            >
              {Object.keys(styles).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </SelectField>

            {kind === "video" && (
              <SelectField
                label="Duration"
                value={settings.duration}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    duration: e.target.value as DurationKey,
                  }))
                }
              >
                {DURATIONS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </SelectField>
            )}

            {tab === "advanced" && (
              <div className="space-y-5 border-t border-border pt-5">
                <TextAreaField
                  label="Negative prompt"
                  value={settings.negativePrompt}
                  maxLength={240}
                  rows={2}
                  placeholder="blurry, watermark, low detail"
                  hint="Describe what should stay out of the render."
                  onChange={(value) =>
                    setSettings((s) => ({ ...s, negativePrompt: value }))
                  }
                />
                <SelectField
                  label="Variations"
                  value={String(settings.count)}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, count: Number(e.target.value) }))
                  }
                >
                  {VARIANT_COUNTS.map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "output" : "outputs"}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Seed"
                  value={settings.seed === "" ? "random" : "fixed"}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      seed:
                        e.target.value === "random"
                          ? ""
                          : s.seed || String(Math.floor(Math.random() * 1_000_000)),
                    }))
                  }
                >
                  <option value="random">Random seed each run</option>
                  <option value="fixed">Lock seed (reproducible)</option>
                </SelectField>
                {settings.seed !== "" && (
                  <TextAreaField
                    label="Seed value"
                    value={settings.seed}
                    maxLength={9}
                    rows={1}
                    onChange={(value) =>
                      setSettings((s) => ({
                        ...s,
                        seed: value.replace(/[^\d]/g, ""),
                      }))
                    }
                  />
                )}
                <Toggle
                  label="Prompt enhancement"
                  description="Let the studio expand short prompts with extra detail."
                  checked={settings.enhance}
                  onChange={(value) => setSettings((s) => ({ ...s, enhance: value }))}
                />
              </div>
            )}

            <div ref={promptRef} className="border-t border-border pt-5">
              <TextAreaField
                label="Prompt"
                value={prompt}
                maxLength={PROMPT_MAX}
                rows={4}
                error={promptError}
                placeholder={PROMPT_PLACEHOLDERS[kind]}
                onChange={(value) => {
                  setPrompt(value);
                  if (promptError) setPromptError(undefined);
                }}
              />
            </div>
          </div>

          <div className="mt-6">
            {busy ? (
              <Button variant="secondary" block onClick={cancel}>
                Cancel generation
              </Button>
            ) : (
              <Button block icon="sparkle" onClick={handleGenerate}>
                Generate
              </Button>
            )}
          </div>
          <p className="mt-3 text-center text-[11.5px] text-muted">
            Renders are saved to History automatically.
          </p>
        </Card>

        {/* ------------------------------- Preview ------------------------------- */}
        <div className="space-y-4">
          <div className="rounded-[20px] border border-border bg-surface p-3 sm:p-4">
            {job.phase === "idle" && (
              <div
                className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-strong bg-white px-6 py-16 text-center"
                style={{ aspectRatio: aspectRatio }}
              >
                <span className="inline-flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
                  <Icon name={kind === "video" ? "video" : "image"} size={22} />
                </span>
                <p className="mt-4 text-[14px] font-bold text-ink">
                  {copy.previewTitle}
                </p>
                <p className="mt-1 max-w-xs text-[12.5px] text-muted">
                  {copy.previewBody}
                </p>
              </div>
            )}

            {busy && (
              <div className="space-y-3">
                <div
                  className="skeleton w-full rounded-[16px]"
                  style={{ aspectRatio: aspectRatio }}
                />
                <div className="flex items-center justify-center gap-2 text-[13px] font-medium text-muted">
                  <Icon name="clock" size={15} />
                  {job.phase === "queued"
                    ? "Queued — waiting for a free render slot…"
                    : "Generating your render…"}
                </div>
              </div>
            )}

            {job.phase === "failed" && (
              <div
                className="flex flex-col items-center justify-center rounded-[16px] border border-[#fecaca] bg-danger-soft px-6 py-14 text-center"
                style={{ aspectRatio: aspectRatio }}
              >
                <span className="inline-flex size-12 items-center justify-center rounded-full bg-white text-danger shadow-card">
                  <Icon name="alert" size={22} />
                </span>
                <p className="mt-4 text-[14px] font-bold text-ink">
                  Generation failed
                </p>
                <p className="mt-1 max-w-sm text-[12.5px] text-ink-soft">
                  {job.message}
                </p>
                {job.retryable && (
                  <Button
                    size="sm"
                    className="mt-5"
                    icon="refresh"
                    onClick={handleGenerate}
                  >
                    Retry with same settings
                  </Button>
                )}
              </div>
            )}

            {job.phase === "completed" && result && (
              <div className="space-y-4">
                {kind === "video" ? (
                  <VideoStage
                    posterUrl={shownUrl}
                    title={prompt || "Generated video"}
                    durationSeconds={Number(settings.duration.replace("s", ""))}
                  />
                ) : (
                  <MediaFrame
                    src={shownUrl}
                    alt={prompt || "Generated image"}
                    ratio={aspectRatio}
                    rounded="rounded-[16px]"
                    className="bg-white"
                    priority
                  />
                )}

                {result.media.length > 1 && (
                  <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
                    {result.media.map((media, index) => (
                      <button
                        key={media.id}
                        type="button"
                        onClick={() => setActiveVariant(index)}
                        aria-label={`Show variation ${index + 1}`}
                        aria-pressed={index === activeVariant}
                        className={`shrink-0 overflow-hidden rounded-[12px] border-2 transition-all ${
                          index === activeVariant
                            ? "border-primary"
                            : "border-transparent hover:border-border-strong"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={displaySrc(media.url) as string}
                          alt=""
                          className="size-[76px] object-cover"
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button icon="download" onClick={handleDownload}>
                    Download
                  </Button>
                  <Button
                    variant="secondary"
                    icon="heart"
                    onClick={handleFavorite}
                    disabled={!assetId || favorite}
                  >
                    {favorite ? "Saved" : "Save"}
                  </Button>
                  <Button
                    variant="secondary"
                    icon="copy"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(prompt)
                        .then(() => toast.push("Prompt copied.", "success"))
                        .catch(() => toast.push("Could not copy the prompt.", "error"));
                    }}
                  >
                    Copy prompt
                  </Button>
                  {assetId && (
                    <Link
                      href={`/results?id=${assetId}`}
                      className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-border-strong bg-white px-4 text-sm font-semibold text-ink transition-colors hover:border-muted hover:bg-surface"
                    >
                      Open in Results
                      <Icon name="arrow-right" size={16} />
                    </Link>
                  )}
                  <Button variant="ghost" icon="refresh" onClick={reset}>
                    Generate another
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <Badge tone="primary">{settings.style}</Badge>
            <Badge>{settings.resolution}</Badge>
            <Badge>{settings.aspect}</Badge>
            {kind === "video" && <Badge>{settings.duration}</Badge>}
            {result && (
              <span className="ml-auto">
                {result.media.length} render
                {result.media.length === 1 ? "" : "s"} · request{" "}
                {result.requestId.slice(0, 12)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Kept here so History can reuse the same favouriting behaviour. */
export function markFavorite(id: string, value: boolean) {
  updateAsset(id, { favorite: value });
}
