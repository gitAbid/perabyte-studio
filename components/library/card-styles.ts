/**
 * Shared library-card chrome — one visual system across characters, images,
 * and stories. The card IS the media: edge-to-edge, no caption strip. All
 * info rides on a permanent bottom scrim over the image; hover reveals the
 * prompt/tags. Overlay controls (star / menu / checkbox) sit on the corners.
 */

/** Card shell. NO overflow-hidden — dropdown menus must be able to escape.
 * Height = media height; the media carries the card's rounding (1px inset
 * for the border). */
export const CARD_SHELL =
  "group relative rounded-[16px] border bg-surface-2 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift motion-reduce:hover:transform-none";

export const CARD_SELECTED = "border-primary ring-2 ring-primary/25";

/** Media fills the shell, all corners rounded to the border inset. */
export const CARD_MEDIA = "w-full rounded-[15px]";

/** Permanent info scrim: title + one meta line always visible over the
 * media; the prompt block inside it is hover-revealed. */
export const CARD_INFO =
  "pointer-events-none absolute inset-x-0 bottom-0 z-[5] rounded-b-[15px] bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-9";

export const CARD_TITLE = "min-w-0 truncate text-[13px] font-semibold text-white";
export const CARD_INFO_META =
  "mt-0.5 flex items-center justify-between gap-2 text-[11px] text-white/70";
/** Hover-revealed block inside the scrim (prompt, tags) — expands smoothly
 * instead of popping so the scrim grows with the reveal. */
export const CARD_INFO_REVEAL =
  "max-h-0 overflow-hidden transition-[max-height] duration-200 ease-out group-hover:max-h-16 motion-reduce:transition-none";

/** Favourite star: filled when favourited, ghost on hover otherwise. */
export const CARD_STAR =
  "absolute left-2.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-all duration-150 hover:scale-110 motion-reduce:hover:transform-none";
export const CARD_STAR_ON = "text-amber-300";
export const CARD_STAR_GHOST = "opacity-0 group-hover:opacity-100";

/** Overflow menu trigger, hover-revealed (stays visible while open). */
export const CARD_MENU_BTN =
  "absolute right-2.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-all duration-150 hover:scale-110 hover:bg-black/60 motion-reduce:hover:transform-none group-hover:opacity-100 aria-expanded:opacity-100";

/** Manage-mode select circle, top-left. */
export const CARD_CHECK =
  "absolute left-2.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-full border-2 border-white/80 bg-black/35 text-transparent backdrop-blur-sm transition-colors aria-checked:border-primary aria-checked:bg-primary-strong aria-checked:text-white";

/** Chip over media (video duration, live status). */
export const CARD_OVERLAY_CHIP =
  "inline-flex shrink-0 items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 text-[10.5px] font-semibold text-white backdrop-blur-sm";

/** Tiny uppercase chip in the scrim (cast usage). */
export const CARD_USAGE_CHIP =
  "inline-flex shrink-0 items-center rounded-md bg-white/20 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-white backdrop-blur-sm";

/** Elegant fallback tile when no thumbnail exists. */
export const CARD_FALLBACK =
  "flex w-full items-center justify-center bg-surface-2";
