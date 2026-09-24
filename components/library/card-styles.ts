/**
 * Shared library-card chrome — one visual system across characters, images,
 * stories, and locations. Media stays edge-to-edge, with readable metadata
 * in a compact panel below it. Overlay controls sit on the image corners.
 */

/** Card shell. NO overflow-hidden — dropdown menus must be able to escape.
 * Height = media height; the media carries the card's rounding (1px inset
 * for the border). */
export const CARD_SHELL =
  "group relative rounded-[8px] border border-border/70 bg-raised shadow-card transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lift motion-reduce:hover:transform-none";

export const CARD_SELECTED = "border-primary ring-2 ring-primary/25";

/** Media fills the shell, all corners rounded to the border inset. */
export const CARD_MEDIA = "w-full rounded-t-[7px]";

/** Permanent info scrim: title + one meta line always visible over the
 * media; the prompt block inside it is hover-revealed. */
export const CARD_INFO =
  "relative z-[5] rounded-b-[7px] border-t border-border/60 bg-raised px-3 pb-3 pt-2.5";

export const CARD_TITLE = "min-w-0 truncate text-[13px] font-semibold text-ink";
export const CARD_INFO_META =
  "mt-1 flex items-center justify-between gap-2 text-[11px] text-muted";
/** Prompt and tags stay visible below the image so important card context
 * does not depend on hover or pointer precision. */
export const CARD_INFO_REVEAL =
  "mt-1.5 max-h-16 overflow-hidden";

/** Favourite star: filled when favourited, ghost on hover otherwise. */
export const CARD_STAR =
  "absolute left-2.5 top-2.5 z-10 flex size-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors duration-150 hover:bg-black/65";
export const CARD_STAR_ON = "text-amber-300";
export const CARD_STAR_GHOST = "opacity-100 sm:opacity-0 sm:group-hover:opacity-100";

/** Overflow menu trigger, hover-revealed (stays visible while open). */
export const CARD_MENU_BTN =
  "absolute right-2.5 top-2.5 z-10 flex size-8 items-center justify-center rounded-full bg-black/45 text-white opacity-100 backdrop-blur-sm transition-opacity duration-150 hover:bg-black/65 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100";

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
