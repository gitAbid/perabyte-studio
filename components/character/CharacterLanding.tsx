"use client";

import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import type { CharacterMode } from "@/lib/character";

const HERO_MAIN = "/character/look-editorial.jpg";
const HERO_SIDE = ["/character/look-golden.jpg", "/character/look-urban.jpg"];

const MODE_CARDS: {
  id: CharacterMode;
  title: string;
  body: string;
  badge?: string;
}[] = [
  {
    id: "normal",
    title: "Normal Mode",
    body: "Fully clothed adult characters. Safety checker on, NSFW locked at 0.",
  },
  {
    id: "uncensored",
    title: "Uncensored Mode",
    body: "Adult creative control with clothing, nudity and NSFW intensity. 18+ only.",
    badge: "NEW",
  },
];

/**
 * Entry screen for the Character studio: the pitch, the mode choice and a
 * collage of sample characters. Picking a mode here pre-fills step 1. The
 * Uncensored card is locked unless Uncensored Mode is enabled in Settings.
 */
export function CharacterLanding({
  mode,
  onModeChange,
  onStart,
  uncensoredEnabled,
  onLockedUncensored,
}: {
  mode: CharacterMode;
  onModeChange: (mode: CharacterMode) => void;
  onStart: () => void;
  /** Global gate from Settings — disabled by default. */
  uncensoredEnabled: boolean;
  onLockedUncensored: () => void;
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
            Design every detail — from appearance to personality. Bring your
            imagination to life with AI.
          </p>

          <div className="mt-6 grid max-w-xl gap-3 sm:grid-cols-2">
            {MODE_CARDS.map((card) => {
              const active = mode === card.id;
              const locked = card.id === "uncensored" && !uncensoredEnabled;
              return locked ? (
                <button
                  key={card.id}
                  type="button"
                  aria-disabled="true"
                  onClick={onLockedUncensored}
                  className="group flex flex-col items-start gap-2.5 rounded-[16px] border border-border bg-white/70 p-4 text-left"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted">
                      <Icon name="lock" size={15} />
                    </span>
                    <span className="flex-1 text-[13.5px] font-bold text-ink-soft">
                      {card.title}
                    </span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-muted">
                      Locked
                    </span>
                  </span>
                  <span className="text-[12.5px] leading-snug text-muted">
                    {card.body}{" "}
                    <span className="font-semibold text-ink-soft">
                      Enable Uncensored Mode in Settings.
                    </span>
                  </span>
                </button>
              ) : (
                <button
                  key={card.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onModeChange(card.id)}
                  className={`group flex flex-col items-start gap-2.5 rounded-[16px] border bg-white p-4 text-left transition-all hover:-translate-y-0.5 ${
                    active
                      ? "border-primary shadow-[0_1px_2px_rgba(37,99,235,0.18),0_10px_28px_-14px_rgba(37,99,235,0.45)]"
                      : "border-border hover:border-border-strong hover:shadow-card"
                  }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] transition-colors ${
                        active
                          ? "bg-primary text-white"
                          : "bg-surface-2 text-ink-soft group-hover:bg-primary-soft group-hover:text-primary"
                      }`}
                    >
                      <Icon name="user" size={16} />
                    </span>
                    <span className="flex-1 text-[13.5px] font-bold text-ink">
                      {card.title}
                    </span>
                    {card.badge && (
                      <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-danger">
                        {card.badge}
                      </span>
                    )}
                  </span>
                  <span className="text-[12.5px] leading-snug text-muted">
                    {card.body}
                  </span>
                </button>
              );
            })}
          </div>

          <Button
            size="lg"
            iconRight="arrow-right"
            className="mt-7"
            onClick={onStart}
          >
            Get Started
          </Button>
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
