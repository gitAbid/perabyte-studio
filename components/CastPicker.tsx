"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { MAX_SCENE_CHARACTERS } from "@/lib/character";
import type { SavedCharacter } from "@/lib/repositories/characters.repository";

/**
 * Cast picker pill + popover for the composer's badge row. Multi-select over
 * the saved characters (unlike the other pill dropdowns): each checked entry
 * is folded into the scene prompt at generate time, in check order, capped at
 * MAX_SCENE_CHARACTERS because text-only identity degrades fast past that.
 * Thumbnails come from the render that defined each character.
 */

const PILL_IDLE =
  "border-border bg-white text-ink-soft hover:border-border-strong hover:text-ink";

export function CastPicker({
  characters,
  selectedIds,
  onChange,
}: {
  characters: SavedCharacter[];
  /** Attached character ids, in anchor order. */
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const atCap = selectedIds.length >= MAX_SCENE_CHARACTERS;

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((selected) => selected !== id));
    } else if (!atCap) {
      onChange([...selectedIds, id]);
    }
  }

  return (
    // `contents` keeps pill and popover as flex items of the badge row while
    // the ref still covers both for the outside-click handler.
    <div ref={shellRef} className="contents">
      <button
        type="button"
        aria-label="Character cast"
        aria-expanded={open}
        title="Attach saved characters — their look and outfit are folded into the scene"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${
          open || selectedIds.length ? "border-primary bg-primary-soft text-primary" : PILL_IDLE
        }`}
      >
        <Icon name="user" size={13} />
        Cast
        {selectedIds.length > 0 && (
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-bold leading-4 text-white">
            {selectedIds.length}
          </span>
        )}
      </button>

      {open && (
        <div className="order-last w-full rounded-[14px] border border-border bg-white p-3.5 shadow-card sm:absolute sm:bottom-full sm:right-0 sm:z-30 sm:mb-2 sm:w-80 sm:shadow-lift">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Attached characters
            </p>
            <p className="text-[11px] font-semibold tabular-nums text-muted">
              {selectedIds.length}/{MAX_SCENE_CHARACTERS}
            </p>
          </div>

          {characters.length === 0 ? (
            <p className="mt-2.5 text-[12px] text-muted">
              No saved characters yet — build one in the Character studio and it
              shows up here.
            </p>
          ) : (
            <div className="mt-2.5 max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
              {characters.map((character) => {
                const active = selectedIds.includes(character.id);
                const blocked = !active && atCap;
                return (
                  <button
                    key={character.id}
                    type="button"
                    role="checkbox"
                    aria-checked={active}
                    disabled={blocked}
                    onClick={() => toggle(character.id)}
                    className={`flex w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "border-primary/40 bg-primary-soft/40"
                        : blocked
                          ? "cursor-not-allowed border-border bg-surface opacity-60"
                          : "border-border bg-white hover:bg-surface-2"
                    }`}
                  >
                    {character.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local media URLs, no optimizer needed
                      <img
                        src={character.thumbnail}
                        alt=""
                        className="size-9 shrink-0 rounded-[8px] border border-border object-cover"
                      />
                    ) : (
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface text-muted">
                        <Icon name="user" size={14} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
                      {character.name}
                    </span>
                    <span
                      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border-strong bg-white text-transparent"
                      }`}
                    >
                      <Icon name="check" size={10} />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {atCap && (
            <p className="mt-2 text-[11.5px] font-medium text-warning">
              Cap reached — {MAX_SCENE_CHARACTERS} characters per scene keeps the
              faces distinct. Deselect one to add another.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
