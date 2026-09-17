"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CastPicker } from "@/components/CastPicker";
import { Icon } from "@/components/Icon";
import { PillSelect } from "@/components/PillSelect";
import { Button, Segmented, useToast } from "@/components/ui";
import { useCharacters } from "@/lib/character-store";
import { WRITER_TONES, type GenerationKind, type WriterToneKey } from "@/lib/constants";
import {
  WRITER_DEFAULT_SCENES,
  WRITER_DRAFT_MAX,
  WRITER_IDEA_MAX,
  WRITER_INSTRUCTION_MAX,
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
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);

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

  /* Writer model options from the provider settings payload. */
  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (data: {
          providers?: Array<{
            label: string;
            enabled: boolean;
            textModels: Array<{ id: string; label: string; enabled: boolean }>;
          }>;
          tasks?: { writer?: string | null };
        } | null) => {
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
          const preferred = data.tasks?.writer;
          if (typeof preferred === "string" && options.some((o) => o.value === preferred)) {
            setModelId(preferred);
          } else if (options.length) {
            setModelId(options[0].value);
          }
        },
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // ~1 scene per 1000 draft characters keeps every scene prompt inside the
  // render-side budget; the split itself also subdivides losslessly, so this
  // is guidance, never a blocker.
  const sceneSuggestion = suggestSceneCount(draft, sceneCount);

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
    if (action !== "write" && !draft.trim()) {
      setError("Write or generate a draft first.");
      return;
    }
    if (action === "enhance" && !instruction.trim()) {
      setError("Tell the writer what to change.");
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
      } else if (action === "enhance") {
        const result = await requestWriterAction({
          action: "enhance",
          draft,
          instruction: instruction.trim(),
          modelId: modelId || undefined,
        });
        setUndoDraft(draft);
        setDraft("text" in result ? result.text : draft);
        setInstruction("");
      } else if (action === "split") {
        const result = await requestWriterAction({
          action: "split",
          draft,
          sceneCount,
          characterNames: characterNames(),
          kind,
          modelId: modelId || undefined,
        });
        if (!("scenes" in result)) return;
        const asset = createWriterStoryAsset({
          title: result.title,
          prose: draft,
          scenes: result.scenes,
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
      } else {
        // "solo": split to one scene, hand the prompt to Solo Mode via the
        // existing ?prompt= prefill (same seam as History regenerate links).
        const result = await requestWriterAction({
          action: "split",
          draft,
          sceneCount: 1,
          modelId: modelId || undefined,
        });
        if (!("scenes" in result) || !result.scenes[0]) return;
        router.push(`/generate/image?prompt=${encodeURIComponent(result.scenes[0])}`);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof WriterError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  /* PillSelect renders the button face from the matched option's label — the
     fallback keeps the face readable while the catalog loads or when no text
     provider is enabled (the pill is disabled then). */
  const modelChoices = modelOptions.length
    ? modelOptions
    : [{ value: "", label: "Writer model" }];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:px-8">
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
          disabled={!modelOptions.length}
          disabledHint={
            modelOptions.length
              ? undefined
              : "No writer models enabled — turn one on in Settings."
          }
        />
      </header>

      {/* BRIEF */}
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <label className="text-[12px] font-bold uppercase tracking-wide text-muted" htmlFor="writer-idea">
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
          <label className="text-[12px] font-bold uppercase tracking-wide text-muted" htmlFor="writer-draft">
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
        <Button variant="secondary" onClick={() => runAction("solo")} disabled={busy !== null || !draft.trim()}>
          {busy === "solo" ? "Preparing…" : "Use in Solo"}
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
          <Button variant="primary" onClick={() => runAction("split")} disabled={busy !== null || !draft.trim()}>
            {busy === "split" ? "Splitting…" : `Split into ${sceneCount} scene${sceneCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </section>

      {error && (
        <p className="text-center text-[12.5px] font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
