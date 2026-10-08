"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Button } from "@/components/ui";
import type { CharacterBindingView, VoiceView } from "@/lib/voices/read-model";

/**
 * Per-character voice binding editor (spec 12 §2: global library, per-
 * character locked binding; workspace-local recast lands post-Alpha).
 *
 * Lock semantics — a binding locks the moment it is saved. Changing a
 * locked binding is deliberately two steps:
 *   1. "Change voice" opens an inline confirmation (nothing changed yet);
 *   2. "Unlock voice" flips the lock (kept in the seam), which enables the
 *      voice picker; saving a new binding locks it again.
 * A locked character shows a Locked badge at all times; Escape or "Keep
 * lock" backs out of step 1 without touching anything.
 */
export function VoiceBindingEditor({
  bindings,
  voices,
  charactersError,
  openCharacterId,
  onOpenCharacterChange,
  onBind,
  onUnlock,
  onUnbind,
}: {
  bindings: CharacterBindingView[];
  voices: VoiceView[];
  /** Set when the canon character store couldn't be read on the server. */
  charactersError: string | null;
  /** Character whose editor row should be open (card "Assign" scrolls here). */
  openCharacterId: string | null;
  onOpenCharacterChange: (characterId: string | null) => void;
  onBind: (characterId: string, voiceId: string) => void;
  onUnlock: (characterId: string) => void;
  onUnbind: (characterId: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});

  // Close any open row when the library-driven focus request clears.
  useEffect(() => {
    if (openCharacterId === null) return;
    const binding = bindings.find((row) => row.character.id === openCharacterId);
    if (binding) {
      setChoices((previous) => ({
        ...previous,
        [openCharacterId]: binding.binding?.voiceId ?? previous[openCharacterId] ?? "",
      }));
    }
  }, [openCharacterId, bindings]);

  // Escape closes the open row without changing anything (no modal, no trap).
  useEffect(() => {
    if (openCharacterId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenCharacterChange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCharacterId, onOpenCharacterChange]);

  function closeRow() {
    onOpenCharacterChange(null);
  }

  function save(characterId: string) {
    const voiceId = choices[characterId];
    if (!voiceId) return;
    onBind(characterId, voiceId);
    closeRow();
  }

  if (charactersError) {
    return (
      <section aria-label="Character voice bindings" data-testid="voices.binding.editor" className="rounded-[12px] border border-border bg-raised p-5 shadow-card">
        <h2 className="text-[15px] font-bold text-ink">Character bindings</h2>
        <div role="alert" data-testid="voices.binding.error" className="mt-3 rounded-[8px] border border-danger/30 bg-danger-soft p-3 text-[12.5px] leading-relaxed text-danger">
          <p className="font-semibold">Your character list couldn&apos;t be loaded</p>
          <p className="mt-1 text-danger/85">{charactersError} Import and playback still work — refresh the page to bring bindings back.</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Character voice bindings" data-testid="voices.binding.editor" className="rounded-[12px] border border-border bg-raised p-5 shadow-card">
      <h2 className="text-[15px] font-bold text-ink">Character bindings</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Decide whose voice is whose. A bound voice is locked so narration and dialogue stay
        consistent later; changing a locked voice needs an explicit unlock.
      </p>

      {bindings.length === 0 ? (
        <div data-testid="voices.binding.empty" className="mt-4 rounded-[8px] border border-dashed border-border-strong bg-surface px-4 py-6 text-center">
          <p className="text-[13px] font-semibold text-ink">No characters yet</p>
          <p className="mx-auto mt-1 max-w-[26ch] text-[12px] leading-relaxed text-muted">
            Create a character first — then bind their voice here so every future line sounds like them.
          </p>
          <a
            href="/character"
            data-testid="voices.binding.empty.create"
            className="mt-3 inline-flex h-9 items-center rounded-[7px] bg-primary-strong px-3.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            Create a character
          </a>
        </div>
      ) : (
        <ul className="mt-4 space-y-2.5" data-testid="voices.binding.list">
          {bindings.map((row) => {
            const open = openCharacterId === row.character.id;
            const choice = choices[row.character.id] ?? "";
            const canSave = choice !== "" && choice !== row.binding?.voiceId;
            return (
              <li
                key={row.character.id}
                data-testid={`voices.binding.row.${row.character.id}`}
                className="rounded-[10px] border border-border bg-surface p-3.5"
              >
                <div className="flex items-center gap-3">
                  {row.character.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- canon portraits come from the local media cache as plain refs
                    <img
                      src={row.character.thumbnailUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-full border border-border object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted" aria-hidden="true">
                      <Icon name="character" size={16} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-ink">{row.character.name}</p>
                    {row.binding ? (
                      row.missingVoice ? (
                        <p className="truncate text-[12px] text-warning" data-testid={`voices.binding.missing.${row.character.id}`}>
                          The bound voice is missing from the library
                        </p>
                      ) : (
                        <p className="truncate text-[12px] text-muted">
                          Voice: <span className="font-medium text-ink-soft">{row.binding.voiceName}</span>
                        </p>
                      )
                    ) : (
                      <p className="text-[12px] text-muted">No voice yet</p>
                    )}
                  </div>
                  {row.binding?.locked ? (
                    <span data-testid={`voices.binding.locked-badge.${row.character.id}`}>
                      <Badge tone="primary">
                        <Icon name="lock" size={11} aria-hidden="true" />
                        Locked
                      </Badge>
                    </span>
                  ) : null}
                  {!open && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenCharacterChange(row.character.id)}
                      data-testid={`voices.binding.change.${row.character.id}`}
                    >
                      {row.binding ? "Change" : "Assign"}
                    </Button>
                  )}
                </div>

                {open && (
                  <div className="mt-3 border-t border-border pt-3" data-testid={`voices.binding.form.${row.character.id}`}>
                    {row.binding?.locked ? (
                      // Step 1 of the two-step unlock: confirm before anything changes.
                      <div role="group" aria-label={`Unlock ${row.character.name}'s voice`} data-testid={`voices.binding.unlock-confirm.${row.character.id}`} className="rounded-[8px] border border-warning/40 bg-warning-soft p-3">
                        <p className="text-[12.5px] font-semibold text-ink">
                          {row.character.name}&apos;s voice is locked
                        </p>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                          The lock keeps their voice steady across scenes. Unlocking lets you pick a
                          different voice; the new binding locks right away.
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" autoFocus onClick={closeRow} data-testid={`voices.binding.unlock-confirm.cancel.${row.character.id}`}>
                            Keep lock
                          </Button>
                          <Button
                            size="sm"
                            icon="lock"
                            onClick={() => {
                              onUnlock(row.character.id);
                              setChoices((previous) => ({ ...previous, [row.character.id]: row.binding?.voiceId ?? "" }));
                            }}
                            data-testid={`voices.binding.unlock-confirm.accept.${row.character.id}`}
                          >
                            Unlock voice
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <label htmlFor={`voices-binding-voice-${row.character.id}`} className="text-[12px] font-semibold text-ink-soft">
                          Voice
                        </label>
                        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                          <div className="relative flex-1">
                            <select
                              id={`voices-binding-voice-${row.character.id}`}
                              value={choice}
                              autoFocus
                              onChange={(e) => setChoices((previous) => ({ ...previous, [row.character.id]: e.target.value }))}
                              data-testid={`voices.binding.voice-select.${row.character.id}`}
                              className="h-10 w-full appearance-none rounded-[8px] border border-border-strong bg-raised pl-3 pr-9 text-[13px] font-medium text-ink focus:border-primary focus:outline-none"
                            >
                              <option value="">{voices.length ? "Choose a voice…" : "No voices in the library yet"}</option>
                              {voices.map((voice) => (
                                <option key={voice.id} value={voice.id}>
                                  {voice.name}
                                </option>
                              ))}
                            </select>
                            <Icon name="chevron-down" size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              icon="check"
                              disabled={!canSave}
                              onClick={() => save(row.character.id)}
                              data-testid={`voices.binding.save.${row.character.id}`}
                            >
                              Save binding
                            </Button>
                            {row.binding && (
                              <Button variant="ghost" size="sm" onClick={() => { onUnbind(row.character.id); closeRow(); }} data-testid={`voices.binding.remove.${row.character.id}`}>
                                Remove
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={closeRow} data-testid={`voices.binding.cancel.${row.character.id}`}>
                              Done
                            </Button>
                          </div>
                        </div>
                        {voices.length === 0 && (
                          <p className="mt-2 text-[12px] text-muted">
                            Import a voice first — the picker fills from your library.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
