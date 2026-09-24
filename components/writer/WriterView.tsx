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
import { usePromptMax } from "@/lib/prompt-limit";
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
  const [activePane, setActivePane] = useState<"brief" | "draft" | "outline">("draft");
  const [sceneCount, setSceneCount] = useState(WRITER_DEFAULT_SCENES);
  const [tone, setTone] = useState<WriterToneKey>("none");
  const [kind, setKind] = useState<GenerationKind>("image");
  const [castIds, setCastIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const [undoDraft, setUndoDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "write" | "enhance" | "split" | "solo">(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPane, setErrorPane] = useState<"brief" | "draft" | "outline">("draft");
  // "" = Auto — the Settings "Story writer" pick (or chain order) resolves at
  // request time, so Settings changes apply without touching this page.
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [tasksWriterId, setTasksWriterId] = useState<string | null>(null);
  // Live scene-prompt budget (Settings → General): guides the scene-count
  // suggestion and the split preview's per-scene packing.
  const promptMax = usePromptMax();

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

  // ~1 scene per prompt-budget of draft characters keeps every scene prompt
  // inside the render-side budget; the split itself also subdivides
  // losslessly, so this is guidance, never a blocker.
  const sceneSuggestion = suggestSceneCount(draft, sceneCount, promptMax);

  // The live split preview: the exact scenes Split will commit, derived from
  // the draft alone. A `---` line is an explicit divider; without one the
  // draft packs at ~one budget per scene. Updates as you type.
  const previewScenes = useMemo(
    () => segmentDraftIntoScenes(draft, promptMax),
    [draft, promptMax],
  );

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
    setErrorPane(action === "write" ? "brief" : action === "split" || action === "solo" ? "outline" : "draft");
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
      router.push(`/generate/${kind}?prompt=${encodeURIComponent(previewScenes[0])}`);
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
        setActivePane("draft");
      } else {
        const result = await requestWriterAction({
          action: "enhance",
          draft,
          instruction: instruction.trim(),
          uncensored: userSettings.uncensoredEnabled,
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
    <div className="mx-auto flex h-[calc(100dvh-58px)] min-h-0 w-full max-w-[1680px] flex-none flex-col gap-3 overflow-hidden px-3 py-3 sm:px-5 md:h-dvh md:px-6 xl:px-9">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-accent">Create / Narrative</p>
          <h1 className="mt-1 text-[26px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[30px]">Story writer</h1>
          <p className="mt-1 hidden text-[11px] text-muted sm:block">Shape an idea, write the draft, then send scenes to the studio.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-[10px] font-bold uppercase tracking-[0.12em] text-muted 2xl:inline">Writer model</span>
          <PillSelect
            icon="chip"
            label="Writer model"
            placement="down"
            value={modelId}
            options={modelChoices}
            onChange={(next) => setModelId(next)}
            align="right"
          />
        </div>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-2 xl:hidden">
        <p className="hidden text-[10px] font-bold uppercase tracking-[0.14em] text-muted sm:block">Workspace</p>
        <Segmented
          ariaLabel="Writer workspace view"
          size="sm"
          value={activePane}
          onChange={(next) => setActivePane(next)}
          options={[
            { value: "brief", label: "Brief", icon: "sparkle" },
            { value: "draft", label: "Draft", icon: "pen" },
            { value: "outline", label: `Scenes ${previewScenes.length}`, icon: "story" },
          ]}
        />
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 gap-3 xl:grid-cols-[minmax(230px,0.72fr)_minmax(360px,1.35fr)_minmax(260px,0.8fr)] xl:items-stretch">
        <section aria-label="Story brief" className={`${activePane === "brief" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col border border-border bg-surface p-3.5 sm:p-4 xl:flex`}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border pb-3">
            <span className="grid size-7 place-items-center bg-primary-soft text-primary"><Icon name="sparkle" size={14} /></span>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Step 01 · Setup</p>
              <h2 className="mt-0.5 text-[14px] font-bold text-ink">Story brief</h2>
            </div>
          </div>
          <label className="sr-only" htmlFor="writer-idea">Story brief</label>
          <textarea
            id="writer-idea"
            value={idea}
            onChange={(event) => setIdea(event.target.value.slice(0, WRITER_IDEA_MAX))}
            rows={6}
            placeholder="Who is this about? What happens, and what makes it matter?"
            className="mt-3 min-h-20 w-full min-w-0 flex-1 resize-none border-0 border-l-2 border-accent/50 bg-transparent py-1 pl-3 text-[13px] leading-[1.75] text-ink placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-0"
          />
          <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3">
            <PillSelect
              icon="layers"
              label="Scene count"
              placement="up"
              value={String(sceneCount)}
              options={SCENE_CHOICES.map((n) => ({ value: String(n), label: `${n} scene${n === 1 ? "" : "s"}` }))}
              onChange={(next) => setSceneCount(Number(next))}
            />
            <PillSelect
              icon="sliders"
              label="Tone"
              placement="up"
              value={tone}
              options={Object.entries(WRITER_TONES).map(([value, label]) => ({ value, label }))}
              onChange={(next) => setTone(next as WriterToneKey)}
            />
            <div className="relative">
              <CastPicker characters={characters} selectedIds={castIds} onChange={setCastIds} />
            </div>
          </div>
          <div className="mt-3 shrink-0">
            {error && errorPane === "brief" && <p className="mb-2 text-[11px] font-medium text-danger" role="alert">{error}</p>}
            <Button variant="primary" block icon="sparkle" onClick={() => runAction("write")} disabled={busy !== null}>
              {busy === "write" ? "Writing story…" : "Write the story"}
            </Button>
          </div>
        </section>

        <section aria-label="Story draft" className={`${activePane === "draft" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-raised p-3.5 sm:p-4 xl:flex`}>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border pb-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Step 02 · Write</p>
              <label className="mt-0.5 block text-[14px] font-bold text-ink" htmlFor="writer-draft">Your draft</label>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted">Autosaved</span>
              {undoDraft !== null && (
                <button type="button" className="text-[11px] font-semibold text-primary hover:underline" onClick={() => { setDraft(undoDraft); setUndoDraft(null); }}>Undo rewrite</button>
              )}
            </div>
          </div>
          <textarea
            id="writer-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, WRITER_DRAFT_MAX))}
            rows={20}
            placeholder="Start writing here, or create a first draft from your brief."
            className="mt-2 min-h-20 w-full min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1 text-[14px] leading-[1.8] text-ink placeholder:text-muted/70 focus:outline-none focus:ring-0"
          />
          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3">
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value.slice(0, WRITER_INSTRUCTION_MAX))}
              placeholder="Ask for a change: tighten the opening…"
              aria-label="Draft refinement instruction"
              className="h-10 min-w-[150px] flex-1 border border-border bg-canvas px-3 text-[12px] text-ink placeholder:text-muted/70 focus:border-primary focus:outline-none"
            />
            <Button variant="secondary" size="sm" icon="sparkle" onClick={() => runAction("enhance")} disabled={busy !== null}>
              {busy === "enhance" ? "Rewriting…" : "Refine"}
            </Button>
          </div>
          {error && errorPane === "draft" && <p className="mt-2 shrink-0 text-[11px] font-medium text-danger" role="alert">{error}</p>}
          <div className="mt-2 flex shrink-0 justify-between gap-2 text-[10px] text-muted"><span>{draft.length.toLocaleString()} / {WRITER_DRAFT_MAX.toLocaleString()} characters</span><span>Saved on this device</span></div>
        </section>

        <aside aria-label="Scene outline and export" className={`${activePane === "outline" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-surface p-3.5 sm:p-4 xl:flex`}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Step 03 · Send to studio</p>
              <h2 className="mt-0.5 text-[14px] font-bold text-ink">Scene outline</h2>
            </div>
            <span className="grid size-8 place-items-center rounded-full bg-primary-soft font-mono text-[11px] font-bold text-primary">{String(previewScenes.length).padStart(2, "0")}</span>
          </div>

          <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Build for</span>
            <Segmented
              ariaLabel="Story media type"
              size="sm"
              value={kind}
              onChange={(next) => setKind(next)}
              options={[{ value: "image", label: "Images", icon: "image" }, { value: "video", label: "Video", icon: "video" }]}
            />
          </div>

          {sceneSuggestion !== null && (
            <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border border-primary/20 bg-primary-soft/50 px-3 py-2">
              <p className="text-[10px] leading-relaxed text-ink-soft">Long draft · {sceneSuggestion} scenes may fit better.</p>
              <button type="button" onClick={() => setSceneCount(sceneSuggestion)} className="shrink-0 text-[10px] font-bold text-primary hover:underline">Apply</button>
            </div>
          )}

          {previewScenes.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-5 text-center">
              <span className="grid size-10 shrink-0 place-items-center border border-dashed border-border-strong text-muted"><Icon name="story" size={17} /></span>
              <p className="mt-3 text-[12px] font-semibold text-ink">Scenes show up here</p>
              <p className="mt-1 max-w-[230px] text-[11px] leading-relaxed text-muted">Add text to your draft. Use <code className="font-mono text-primary">---</code> on its own line to choose a scene break.</p>
            </div>
          ) : (
            <div className="thin-scrollbar mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {previewScenes.map((scene, index) => (
                <article key={index} className="border-l-2 border-primary bg-raised px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-primary">Scene {String(index + 1).padStart(2, "0")}</span>
                    <span className="font-mono text-[9px] text-muted">{scene.length} ch</span>
                  </div>
                  <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-soft">{scene}</p>
                </article>
              ))}
            </div>
          )}

          <div className="mt-3 shrink-0 border-t border-border pt-3">
            <p className="mb-2 text-[10px] leading-relaxed text-muted">{previewScenes.length ? `${previewScenes.length} scene${previewScenes.length === 1 ? "" : "s"} ready. Save the sequence or continue with the first scene.` : "Your draft is split into scenes automatically."}</p>
            {error && errorPane === "outline" && <p className="mb-2 text-[11px] font-medium text-danger" role="alert">{error}</p>}
            <div className="flex flex-col gap-2">
              <Button variant="primary" block icon="arrow-right" onClick={() => runAction("split")} disabled={busy !== null || !previewScenes.length}>
                {busy === "split" ? "Saving story…" : `Create ${previewScenes.length} scene${previewScenes.length === 1 ? "" : "s"}`}
              </Button>
              <Button variant="secondary" block size="sm" icon={kind === "image" ? "image" : "video"} onClick={() => runAction("solo")} disabled={busy !== null || !previewScenes.length}>
                Open first scene in {kind === "image" ? "image" : "video"} studio
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
