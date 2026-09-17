"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CastPicker } from "@/components/CastPicker";
import { Icon } from "@/components/Icon";
import { PillSelect } from "@/components/PillSelect";
import { Button, Segmented, useToast } from "@/components/ui";
import { useCharacters } from "@/lib/character-store";
import {
  WRITER_TONES,
  titleFromPrompt,
  type GenerationKind,
  type WriterToneKey,
} from "@/lib/constants";
import {
  WRITER_DEFAULT_SCENES,
  WRITER_DRAFT_MAX,
  WRITER_IDEA_MAX,
  WRITER_INSTRUCTION_MAX,
  segmentDraftIntoScenes,
  suggestSceneCount,
} from "@/lib/domain/writer";
import { requestWriterAction, WriterError } from "@/lib/writer";
import { putStoryAsset } from "@/lib/story/records";
import { useSettings } from "@/lib/repositories/settings.repository";
import { addAsset } from "@/lib/store";
import { createWriterStoryAsset } from "@/lib/writer-story";

const DRAFT_KEY = "perabyte.writer.draft.v1";
const SCENE_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface SavedWriterDraft {
  idea: string;
  sceneCount: number;
  tone: WriterToneKey;
  kind: GenerationKind;
  draft: string;
  updatedAt: number;
}

export function WriterView() {
  const router = useRouter();
  const toast = useToast();
  const { characters } = useCharacters();
  const { settings: userSettings } = useSettings();

  const [idea, setIdea] = useState("");
  const [sceneCount, setSceneCount] = useState(WRITER_DEFAULT_SCENES);
  const [tone, setTone] = useState<WriterToneKey>("none");
  const [kind, setKind] = useState<GenerationKind>("image");
  const [castIds, setCastIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const [undoDraft, setUndoDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "write" | "enhance" | "split" | "solo">(null);
  const [error, setError] = useState<string | null>(null);
  // "" = Auto — the Settings "Story writer" pick (or chain order) resolves at
  // request time, so Settings changes apply without touching this page.
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [tasksWriterId, setTasksWriterId] = useState<string | null>(null);

  /* Restore the autosaved draft once on mount. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<SavedWriterDraft>;
      if (typeof saved.idea === "string") setIdea(saved.idea);
      if (typeof saved.draft === "string") setDraft(saved.draft);
      if (typeof saved.sceneCount === "number") setSceneCount(saved.sceneCount);
      if (saved.tone && saved.tone in WRITER_TONES) setTone(saved.tone);
      if (saved.kind === "image" || saved.kind === "video") setKind(saved.kind);
    } catch {
      /* corrupted draft — start clean */
    }
  }, []);

  /* Autosave (debounced). */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const payload: SavedWriterDraft = {
          idea,
          sceneCount,
          tone,
          kind,
          draft,
          updatedAt: Date.now(),
        };
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
      } catch {
        /* storage full/blocked — non-fatal */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [idea, sceneCount, tone, kind, draft]);

  /* Writer model options from the provider settings payload — re-fetched on
     window focus so Settings edits reach an open Writer without a reload. */
  useEffect(() => {
    let alive = true;
    async function loadSettings() {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        const data = response.ok
          ? ((await response.json()) as {
              providers?: Array<{
                label: string;
                enabled: boolean;
                textModels: Array<{ id: string; label: string; enabled: boolean }>;
              }>;
              tasks?: { writer?: string | null };
            } | null)
          : null;
        if (!alive || !data) return;
        // Registered providers already include enabled custom gateways and
        // their text models — this list needs no separate custom mapping.
        const options = (data.providers ?? [])
          .filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.textModels
              .filter((model) => model.enabled)
              .map((model) => ({ value: model.id, label: `${provider.label} — ${model.label}` })),
          );
        setModelOptions(options);
        setTasksWriterId(typeof data.tasks?.writer === "string" ? data.tasks.writer : null);
      } catch {
        /* settings unreachable — keep current state */
      }
    }
    void loadSettings();
    window.addEventListener("focus", loadSettings);
    return () => {
      alive = false;
      window.removeEventListener("focus", loadSettings);
    };
  }, []);

  // ~1 scene per 1000 draft characters keeps every scene prompt inside the
  // render-side budget; the split itself also subdivides losslessly, so this
  // is guidance, never a blocker.
  const sceneSuggestion = suggestSceneCount(draft, sceneCount);

  // The live split preview: the exact scenes Split will commit, derived from
  // the draft alone. A `---` line is an explicit divider; without one the
  // draft packs at ~1,000 characters per scene. Updates as you type.
  const previewScenes = useMemo(() => segmentDraftIntoScenes(draft), [draft]);

  const characterNames = useCallback(
    () =>
      castIds
        .map((id) => characters.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n)),
    [castIds, characters],
  );

  async function runAction(action: "write" | "enhance" | "split" | "solo") {
    if (busy) return;
    setError(null);
    if (action === "write" && !idea.trim()) {
      setError("Describe your story idea first.");
      return;
    }
    if (action !== "write" && !previewScenes.length) {
      setError("Write or generate a draft first.");
      return;
    }
    if (action === "enhance" && !instruction.trim()) {
      setError("Tell the writer what to change.");
      return;
    }

    // Split and Use in Solo are instant: they commit the previewed scenes —
    // no engine call, nothing to wait for beyond the record save.
    if (action === "split") {
      setBusy("split");
      try {
        const asset = createWriterStoryAsset({
          title: titleFromPrompt(draft),
          prose: draft,
          scenes: previewScenes,
          characterIds: castIds,
          kind,
        });
        const created = await putStoryAsset(asset);
        if (!created) {
          toast.push("We could not save the story. Your draft is still here — retry.", "error");
          return;
        }
        // Mirror the story page's own create sequence: the server has the
        // record, the local store cache adopts it too (upsert is idempotent).
        addAsset(asset);
        router.push(`/story?id=${asset.id}`);
      } finally {
        setBusy(null);
      }
      return;
    }

    if (action === "solo") {
      router.push(`/generate/image?prompt=${encodeURIComponent(previewScenes[0])}`);
      return;
    }

    setBusy(action);
    try {
      if (action === "write") {
        const result = await requestWriterAction({
          action: "write",
          brief: {
            idea: idea.trim(),
            sceneCount,
            // "none" means no tone — the service folds the tone key into the
            // writing instruction, and a literal "Tone: none." reads wrong.
            tone: tone === "none" ? null : tone,
            characterNames: characterNames(),
            uncensored: userSettings.uncensoredEnabled,
          },
          modelId: modelId || undefined,
        });
        setUndoDraft(draft || null);
        setDraft("text" in result ? result.text : draft);
      } else {
        const result = await requestWriterAction({
          action: "enhance",
          draft,
          instruction: instruction.trim(),
          modelId: modelId || undefined,
        });
        setUndoDraft(draft);
        setDraft("text" in result ? result.text : draft);
        setInstruction("");
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof WriterError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  /* PillSelect renders the button face from the matched option's label. Auto
     (empty value) defers to the Settings pick / chain order at request time. */
  const tasksWriterLabel =
    modelOptions.find((option) => option.value === tasksWriterId)?.label ?? null;
  const autoLabel = tasksWriterLabel ? `Auto — ${tasksWriterLabel}` : "Auto — Settings default";
  const modelChoices = [
    { value: "", label: autoLabel },
    ...modelOptions,
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="pen" className="h-5 w-5 text-ink-soft" />
          <h1 className="text-[19px] font-bold tracking-tight text-ink">Writer</h1>
        </div>
        <PillSelect
          icon="chip"
          label="Writer model"
          placement="down"
          value={modelId}
          options={modelChoices}
          onChange={(next) => setModelId(next)}
          align="right"
        />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {/* BRIEF */}
          <section className="rounded-[14px] border border-border bg-surface p-4">
            <label
              className="text-[12px] font-bold uppercase tracking-wide text-muted"
              htmlFor="writer-idea"
            >
              Brief
            </label>
            <textarea
              id="writer-idea"
              value={idea}
              onChange={(event) => setIdea(event.target.value.slice(0, WRITER_IDEA_MAX))}
              rows={3}
              placeholder="A neon-noir chase through a rainy megacity where the courier discovers the package is a person…"
              className="mt-2 w-full resize-y rounded-[10px] border border-border bg-raised p-3 text-[13.5px] leading-relaxed text-ink placeholder:text-muted/70"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <PillSelect
                icon="layers"
                label="Scene count"
                placement="down"
                value={String(sceneCount)}
                options={SCENE_CHOICES.map((n) => ({
                  value: String(n),
                  label: `${n} scene${n === 1 ? "" : "s"}`,
                }))}
                onChange={(next) => setSceneCount(Number(next))}
              />
              <PillSelect
                icon="sliders"
                label="Tone"
                placement="down"
                value={tone}
                options={Object.entries(WRITER_TONES).map(([value, label]) => ({ value, label }))}
                onChange={(next) => setTone(next as WriterToneKey)}
              />
              <CastPicker characters={characters} selectedIds={castIds} onChange={setCastIds} />
              <span className="grow" />
              <Button variant="primary" onClick={() => runAction("write")} disabled={busy !== null}>
                {busy === "write" ? "Writing…" : "Write for me"}
              </Button>
            </div>
          </section>

          {/* DRAFT */}
          <section className="rounded-[14px] border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <label
                className="text-[12px] font-bold uppercase tracking-wide text-muted"
                htmlFor="writer-draft"
              >
                Draft
              </label>
              {undoDraft !== null && (
                <button
                  type="button"
                  className="text-[12px] font-semibold text-muted hover:text-ink"
                  onClick={() => {
                    setDraft(undoDraft);
                    setUndoDraft(null);
                  }}
                >
                  Undo rewrite
                </button>
              )}
            </div>
            <textarea
              id="writer-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, WRITER_DRAFT_MAX))}
              rows={12}
              placeholder="Write your story here, or describe it in the brief and hit “Write for me”…"
              className="mt-2 w-full resize-y rounded-[10px] border border-border bg-raised p-3 text-[13.5px] leading-relaxed text-ink placeholder:text-muted/70"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value.slice(0, WRITER_INSTRUCTION_MAX))}
                placeholder="Enhance with: make it darker and half the length…"
                className="h-8 grow rounded-full border border-border bg-raised px-3 text-[12.5px] text-ink placeholder:text-muted/70"
              />
              <Button variant="primary" onClick={() => runAction("enhance")} disabled={busy !== null}>
                {busy === "enhance" ? "Rewriting…" : "Enhance"}
              </Button>
            </div>
          </section>

          {/* HAND-OFF */}
          <section className="flex flex-col items-center gap-2">
            {sceneSuggestion !== null && (
              <p className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-muted">
                <span>
                  Long draft — about {sceneSuggestion} scenes keeps each prompt under 1,000 characters.
                </span>
                <button
                  type="button"
                  onClick={() => setSceneCount(sceneSuggestion)}
                  className="font-semibold text-primary hover:underline"
                >
                  Use {sceneSuggestion} scenes
                </button>
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                variant="secondary"
                onClick={() => runAction("solo")}
                disabled={busy !== null || !previewScenes.length}
              >
                Use in Solo
              </Button>
              <Segmented
                ariaLabel="Story media type"
                size="sm"
                value={kind}
                onChange={(next) => setKind(next)}
                options={[
                  { value: "image", label: "Image story", icon: "image" },
                  { value: "video", label: "Video story", icon: "video" },
                ]}
              />
              <Button
                variant="primary"
                onClick={() => runAction("split")}
                disabled={busy !== null || !previewScenes.length}
              >
                {busy === "split"
                  ? "Saving…"
                  : `Split into ${previewScenes.length} scene${previewScenes.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </section>

          {error && (
            <p className="text-center text-[12.5px] font-medium text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        {/* SPLIT PREVIEW */}
        <aside className="lg:sticky lg:top-8">
          <section className="rounded-[14px] border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-bold uppercase tracking-wide text-muted">
                Split preview
              </label>
              {previewScenes.length > 0 && (
                <span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] font-bold text-muted">
                  {previewScenes.length} scene{previewScenes.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {previewScenes.length === 0 ? (
              <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
                Your draft appears here as scene cards as you write. Separate scenes with a
                line containing <code className="font-mono">---</code> to place the cuts
                yourself; otherwise scenes break at ~1,000 characters. Split commits exactly
                these cards.
              </p>
            ) : (
              <div className="thin-scrollbar mt-3 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
                {previewScenes.map((scene, index) => (
                  <article key={index} className="rounded-[10px] border border-border bg-raised p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
                        Scene {index + 1}
                      </span>
                      <span className="text-[10.5px] text-muted">{scene.length} chars</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-soft">
                      {scene}
                    </p>
                  </article>
                ))}
              </div>
            )}
            <p className="mt-3 text-[11px] leading-snug text-muted">
              Split creates one story scene per card — instant, no AI call. The scene-count
              setting guides “Write for me”, not this preview.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
