# Library manage-media + mask-uncensored setting — design

Date: 2026-09-15
Status: approved-for-implementation (autonomous session; user request quoted below)

> "Add manage media options to clean and delete media and generations from
> library. Also mask uncensored toggle to mask uncensored images or 18+ images
> and video from setting. Thanks use gitworktree for work"

## Goals

1. **Manage media in History (the library):** bulk actions to *clean* (delete
   everything) and *delete* (selectively, one or many) media and generations.
2. **Mask uncensored content:** a Settings toggle that blurs 18+/uncensored
   images and videos everywhere media is shown until the user chooses to
   reveal them.

Non-goals (explicitly out of scope):

- Server-side media-cache eviction (`lib/repositories/media.repository.ts` is
  content-addressed and shared between assets; library deletion stays a
  client-side history operation).
- Character Studio previews (content is generated inside an explicitly gated
  uncensored session; can adopt the same `sensitive` prop later).
- Automatic NSFW *detection* — sensitivity is derived from the render's
  recorded `safe` flag, not from inspecting pixels.

## Part A — Manage media in History

### Approaches considered

- **A. Manage (selection) mode** — chosen. "Manage" enters a checkbox
  selection mode with a bulk action bar (`Select all`, `Delete selected (n)`,
  `Delete all`). Covers selective cleanup *and* full clean; standard
  library/gallery UX.
- B. Presets-only menu (Delete all / Delete non-favourites) — rejected: less
  flexible, hidden behind a menu, still needs the same confirmations.
- C. Bare "Clear all" button — rejected: no selective path; dangerous single
  click near the grid.

### Design

- **Store** (`lib/store.ts`): add `removeAssets(ids: string[])` (one persist,
  one emit). `removeAsset(id)` delegates to it; `clearAssets()` already exists.
- **History page** (`app/history/page.tsx`):
  - New `manage` boolean state + `selected: Set<string>` state.
  - Header gains a **Manage** button (secondary, `grid` icon) beside
    "Favourites only".
  - In manage mode each row shows a leading round checkbox button; the whole
    row toggles selection (thumbnail/title render as plain elements, not
    `<Link>`s, so tapping never navigates). Per-row action menus hide.
  - A sticky-ish manage bar under the filter row shows:
    `Select all` / `Deselect all` (applies to the rows currently visible
    under the active filters), **Delete selected (n)** (danger), and
    **Delete all (N)** (danger — always the entire library, independent of
    filters), plus **Done** to exit.
  - Both destructive actions open the existing `ConfirmDialog` with counts.
    Delete-all copy states it clears *every* image, video and story from this
    browser and cannot be undone.
  - Exiting manage mode clears the selection; toasts confirm each action.

## Part B — Mask uncensored (18+) content

### Approaches considered

- **Blur + click-to-reveal overlay in the shared media components** — chosen:
  one implementation covers every surface.
- B. Per-page CSS hacks — rejected: five call sites, five chances to drift.
- C. Blocking loads of sensitive media entirely (don't render `<img src>`)
  — rejected: reveal becomes a network round-trip and breaks the preview UX;
  CSS blur never leaks the image even for one frame.

### Sensitivity source of truth

An asset is 18+/uncensored iff it was rendered with the provider safety
checker off, i.e. `asset.settings.safe === false` (GeneratorScreen sets
`safe: !uncensored`; story assets persist the same settings). Everything else
(demos, default renders, `safe: undefined`) is treated as safe — masking only
ever triggers on an explicit `false`.

Pure predicate in `lib/domain/models.ts`:

```ts
export function isSensitiveAsset(asset: { settings?: { safe?: boolean } }): boolean {
  return asset.settings?.safe === false;
}
```

### Setting

- `UserSettings.maskUncensored: boolean`, **default `true`** (masking by
  default is the privacy-safe choice; harmless when no uncensored content
  exists). `setMaskUncensored(value)` in `lib/repositories/settings.repository.ts`.
- `SettingsDialog` gains a "Mask 18+ content" toggle under **Content
  preferences**, below Uncensored Mode: "Blur uncensored (18+) images and
  videos in your library and previews until you choose to show them." No
  confirmation needed (it only ever hides content).

### Media components (`components/Media.tsx`)

- `MediaFrame` and `VideoStage` accept `sensitive?: boolean` (threaded to
  `ImageFrame` / `VideoFrame`).
- Inside Media.tsx: `const { settings } = useSettings()`; `masked = sensitive
  && settings.maskUncensored`; local `revealed` state, reset when `src`
  changes.
- When masked and not revealed, the media element gets `blur-2xl scale-105`
  (scale hides blur edge bleed) and a full-cover overlay renders: an "18+"
  chip, a "Sensitive content" label, and a **Show** control. The overlay
  blocks all interaction with the media beneath; **Show** is a
  `<span role="button" tabIndex={0}>` with `stopPropagation` — the same
  nested-interactive-safe pattern `ImageFrame` already uses for Retry, since
  MediaFrame frequently sits inside `<button>` cards and `<Link>`s.
- VideoStage: masked state blurs the poster/video and covers the transport
  controls until revealed (prevents play-while-masked).

### Call sites passing `sensitive`

History rows, Results main stage + variant strips, Story scene thumbnails,
GeneratorScreen main preview + previous-generations strip. Each computes
`isSensitiveAsset(asset)`.

## Error handling

- Storage failures during bulk delete keep the in-memory session consistent
  (existing `persist()` try/catch covers it).
- `revealed` resets per `src`, so navigating away and back re-masks.
- No new server surface; nothing to retry.

## Testing

- `lib/domain/models.test.ts`: `isSensitiveAsset` — `safe: false` ⇒ true;
  `safe: true`/`undefined`/missing settings ⇒ false.
- `lib/repositories/settings.repository.test.ts`: `maskUncensored` defaults
  true and persists through `setMaskUncensored`; merge-with-stored keeps
  backward compatibility.
- `lib/store.test.ts` (new): `removeAssets` deletes exactly the given ids and
  `removeAsset` still works (node-env memory store).
- Browser verification: run the worktree dev server, exercise manage mode
  (select → delete selected; delete all) and the mask (generate/seed an
  uncensored asset → blurred with Show; toggle off → unmasked) via local
  Playwright per repo convention.
