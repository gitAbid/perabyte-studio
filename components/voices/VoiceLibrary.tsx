"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { ImportVoicePanel } from "@/components/voices/ImportVoicePanel";
import { VoiceBindingEditor } from "@/components/voices/VoiceBindingEditor";
import { VoiceCard } from "@/components/voices/VoiceCard";
import {
  buildVoiceLibraryModel,
  clearVoiceBinding,
  readVoicesStore,
  unlockVoiceBinding,
  withStoredVoice,
  withVoiceBinding,
  withoutStoredVoices,
  writeVoicesStore,
  EMPTY_VOICES_STORE,
  type HistoryAudioAsset,
  type StoredVoice,
  type VoiceCharacterRef,
  type VoicesStoreV1,
} from "@/lib/voices/read-model";

/**
 * /voices screen (spec 12 §6 primary format, import-first Alpha slice).
 * The server page preloads the canon cast and History audio rows; this
 * client owns the browser-local seam (localStorage `perabyte.voices.v1`,
 * documented in lib/voices/read-model.ts), session playback URLs, and all
 * mutations. Nothing here generates audio — the library is fed by import.
 */
export function VoiceLibrary({
  characters,
  historyAssets,
  charactersError,
}: {
  characters: VoiceCharacterRef[];
  historyAssets: HistoryAudioAsset[];
  charactersError: string | null;
}) {
  const toast = useToast();
  const [store, setStore] = useState<VoicesStoreV1 | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [openBindingId, setOpenBindingId] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [sessionUrls, setSessionUrls] = useState<Record<string, string>>({});
  const editorRef = useRef<HTMLDivElement | null>(null);

  // Hydrate the documented seam after mount (never during SSR).
  useEffect(() => {
    setStore(readVoicesStore(window.localStorage));
  }, []);

  const update = useCallback((mutate: (current: VoicesStoreV1) => VoicesStoreV1) => {
    setStore((current) => {
      const next = mutate(current ?? EMPTY_VOICES_STORE);
      writeVoicesStore(window.localStorage, next);
      return next;
    });
  }, []);

  const model = useMemo(
    () => buildVoiceLibraryModel({ characters, historyAssets, stored: store ?? EMPTY_VOICES_STORE }),
    [characters, historyAssets, store],
  );

  const handleImported = useCallback(
    (voice: StoredVoice, sessionUrl: string) => {
      update((current) => withStoredVoice(current, voice));
      if (sessionUrl) {
        setSessionUrls((previous) => ({ ...previous, [voice.id]: sessionUrl }));
      }
    },
    [update],
  );

  function assignFromCard(characterId: string | null) {
    setOpenBindingId(characterId);
    // Cards without a binding just open the editor near the top of the list.
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const removeTarget = removeTargetId
    ? model.voices.find((voice) => voice.id === removeTargetId) ?? null
    : null;

  function confirmRemove() {
    if (!removeTarget) return;
    update((current) => withoutStoredVoices(current, [removeTarget.id]));
    setSessionUrls((previous) => {
      if (!(removeTarget.id in previous)) return previous;
      const next = { ...previous };
      delete next[removeTarget.id];
      return next;
    });
    setRemoveTargetId(null);
    toast.push(`"${removeTarget.name}" was removed from the library.`, "info");
  }

  const boundCount = model.voices.filter((voice) => voice.boundTo !== null).length;

  return (
    <div className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-14 pt-6 sm:px-6 lg:px-10 lg:pt-9" data-testid="voices.library">
      <header className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">Studio / Voice &amp; Audio</p>
          <h1 className="mt-2 text-[34px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[44px]">Voices</h1>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Your voice library — imported recordings you bind to characters. A character&apos;s bound voice is
            locked, so when narration and dialogue generation arrive they already sound like themselves.
            Voice generation isn&apos;t available yet; import is the way in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon="upload"
            onClick={() => setImportOpen((open) => !open)}
            aria-expanded={importOpen}
            data-testid="voices.import.open"
          >
            Import voice
          </Button>
        </div>
      </header>

      {importOpen && (
        <div className="mt-6">
          <ImportVoicePanel onImported={handleImported} onCancel={() => setImportOpen(false)} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <main aria-label="Voice library" className="min-w-0">
          {model.voices.length === 0 ? (
            <div data-testid="voices.empty">
              <EmptyState
                icon="volume"
                title="No voices yet"
                body="Voices power narration and dialogue once audio generation arrives — and character bindings keep every line consistent. Import a recording (a narration read, a line of dialogue, any vocal take) to start the library."
                action={
                  <Button icon="upload" onClick={() => setImportOpen(true)} data-testid="voices.empty.import">
                    Import your first voice
                  </Button>
                }
                testId="voices.empty.state"
              />
            </div>
          ) : (
            <>
              <p role="status" data-testid="voices.results-count" className="text-[12px] text-muted">
                {model.voices.length} {model.voices.length === 1 ? "voice" : "voices"}
                {boundCount > 0 ? ` · ${boundCount} bound to a character` : ""}
              </p>
              <div
                data-testid="voices.grid"
                className="mt-3 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3"
              >
                {model.voices.map((voice) => (
                  <VoiceCard
                    key={voice.id}
                    voice={voice}
                    sessionUrl={sessionUrls[voice.id] ?? null}
                    onAssign={() => assignFromCard(voice.boundTo?.characterId ?? null)}
                    onRemove={() => setRemoveTargetId(voice.id)}
                  />
                ))}
              </div>
            </>
          )}
        </main>

        <aside aria-label="Voice context" className="space-y-5 lg:sticky lg:top-6" ref={editorRef}>
          <VoiceBindingEditor
            bindings={model.bindings}
            voices={model.voices}
            charactersError={charactersError}
            openCharacterId={openBindingId}
            onOpenCharacterChange={setOpenBindingId}
            onBind={(characterId, voiceId) => {
              update((current) => withVoiceBinding(current, characterId, voiceId, Date.now()));
              toast.push("Voice bound and locked for this character.", "success");
            }}
            onUnlock={(characterId) => {
              update((current) => unlockVoiceBinding(current, characterId));
              toast.push("Binding unlocked — pick the new voice, then save.", "info");
            }}
            onUnbind={(characterId) => {
              update((current) => clearVoiceBinding(current, characterId));
              toast.push("Binding removed — this character has no voice for now.", "info");
            }}
          />

          <section aria-label="How voices work" className="rounded-[12px] border border-border bg-surface p-5">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.1em] text-ink-soft">How voices work</h2>
            <ol className="mt-3 space-y-3 text-[12.5px] leading-relaxed text-muted">
              <li className="flex gap-2.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[10px] font-bold text-primary">1</span>
                <span><span className="font-semibold text-ink">Import</span> a recording into the library. Generation isn&apos;t available yet — imports are the Alpha path.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[10px] font-bold text-primary">2</span>
                <span><span className="font-semibold text-ink">Bind</span> it to a character. The binding locks so the voice stays theirs across every scene.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[10px] font-bold text-primary">3</span>
                <span><span className="font-semibold text-ink">Later</span>, script lines and narration use the bound voice — and the scene audio plan proposes ambience, effects, and music around it in Production audio.</span>
              </li>
            </ol>
            <p className="mt-4 border-t border-border pt-3 text-[11.5px] leading-relaxed text-muted">
              Bindings and the library list are saved in this browser for the Alpha. Server-side voice
              storage and workspace recasts are coming later.
            </p>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove "${removeTarget?.name ?? ""}"?`}
        body={
          removeTarget?.boundTo
            ? `This also unbinds it from ${removeTarget.boundTo.characterName}. The stored file stays in the media vault; only the library entry goes.`
            : "The library entry goes, and the stored file stays in the media vault."
        }
        confirmLabel="Remove voice"
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTargetId(null)}
      />
    </div>
  );
}
