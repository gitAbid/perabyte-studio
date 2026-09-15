"use client";

import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Button } from "@/components/ui";
import type { SavedCharacter } from "@/lib/repositories/characters.repository";

const HERO_MAIN = "/character/look-editorial.jpg";
const HERO_SIDE = ["/character/look-golden.jpg", "/character/look-urban.jpg"];

/**
 * Entry screen for the Character studio: the pitch, any saved characters to
 * reopen, and a collage of sample characters. One mode everywhere — adult
 * options follow the global Uncensored Mode gate in Settings.
 */
export function CharacterLanding({
  characters,
  charactersReady,
  onStart,
  onOpenCharacter,
  onDeleteCharacter,
}: {
  characters: SavedCharacter[];
  /** False until the client has mounted (avoids a flash for SSR). */
  charactersReady: boolean;
  onStart: () => void;
  onOpenCharacter: (id: string) => void;
  onDeleteCharacter: (id: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-6 sm:px-6 lg:min-h-0 lg:justify-center lg:py-8">
      <div className="grid flex-1 items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-14">
        <div className="animate-[fade-up_0.4s_ease-out_both]">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
            AI Character Generator
          </p>
          <h1 className="mt-3 max-w-lg text-[30px] font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[38px]">
            Create unique characters for your images and videos.
          </h1>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted sm:text-[14.5px]">
            Design every detail — from appearance to personality. Save your
            characters and reuse them across Solo and Story scenes for a
            consistent look.
          </p>

          <Button
            size="lg"
            iconRight="arrow-right"
            className="mt-6"
            onClick={onStart}
          >
            Get Started
          </Button>

          {charactersReady && characters.length > 0 && (
            <section aria-label="Saved characters" className="mt-8 max-w-xl">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">
                Your characters
              </p>
              <div className="no-scrollbar mt-3 flex gap-3 overflow-x-auto pb-1">
                {characters.map((character) => (
                  <div key={character.id} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenCharacter(character.id)}
                      title={`Open ${character.name}`}
                      className="group block w-24 text-left"
                    >
                      <span className="block overflow-hidden rounded-[12px] border border-border transition-all group-hover:border-primary/50 group-hover:shadow-card">
                        {character.thumbnail ? (
                          <MediaFrame
                            src={character.thumbnail}
                            alt=""
                            ratio="4/5"
                            rounded="rounded-[12px]"
                          />
                        ) : (
                          <span className="flex aspect-[4/5] items-center justify-center bg-surface-2 text-muted">
                            <Icon name="user" size={22} />
                          </span>
                        )}
                      </span>
                      <span className="mt-1.5 block truncate text-[12px] font-semibold text-ink">
                        {character.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${character.name}`}
                      title={`Delete ${character.name}`}
                      onClick={() => onDeleteCharacter(character.id)}
                      className="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full border border-border bg-white text-ink-soft shadow-card transition-colors hover:text-danger"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Sample character collage */}
        <div className="relative hidden animate-[fade-up_0.5s_ease-out_both] lg:block">
          <div className="overflow-hidden rounded-[24px] border border-border bg-surface shadow-lift">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={HERO_MAIN}
              alt="Sample AI character"
              className="aspect-[4/5] w-full object-cover"
            />
          </div>
          <div className="absolute -right-5 -top-5 flex w-[96px] flex-col gap-3">
            {HERO_SIDE.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt={`Sample character ${i + 2}`}
                className="aspect-[4/5] w-full rounded-[14px] border border-border object-cover shadow-card"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}