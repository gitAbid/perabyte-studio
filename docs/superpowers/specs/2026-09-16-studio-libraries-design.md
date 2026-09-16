# Studio Libraries — Characters, Images & Stories — Design

**Date:** 2026-09-16
**Status:** Draft — awaiting user review
**Scope:** Replace the marketing-style `/character` landing with a server-backed character
asset library; give images/videos and stories the same library treatment (new `/images`
and `/stories` pages over the existing server records); **remove the separate History
page** (nav item, page, and route — old links redirect). Characters additionally migrate
to `.studio/characters.json`; images/stories need **zero backend work**.

Decisions the user delegated or confirmed (veto any in review):
variations = child characters with lineage · layout = poster grid · storage = server-side ·
extras = favorites + tags + where-used · folders deferred · **History page removed**
(user confirmed) · videos fold into the Images library as a kind filter.

## Problem

`/character` renders `CharacterStudio`, whose landing is a marketing hero plus a small
saved-character strip. Characters are the **last client-only entity**: assets, stories,
settings, and jobs all persist server-side (`.studio/*.json`, Phase A), but characters
still live in `localStorage` (`perabyte.characters.v1`) and die with browser data.
Management is minimal: create (4-step wizard), re-open, delete. There is no search, no
duplicate, no variations, no tags/favorites, no rename. `updateCharacter` is exported but
never called — editing a saved character never persists spec changes back. There are no
URLs for library vs. editor, so nothing is deep-linkable or refresh-safe.

Meanwhile all generated media and stories live in one undifferentiated **History list**
(`/history`) — rows, not a visual library — mixing images, videos, and stories in a single
flat view that serves none of them well.

## Goals

- One library experience, three pages, one shared shell:
  - **Characters** (`/character`): poster grid, search, sort, favorites, tags, manage
    mode, lineage variations, where-used, per-character render gallery.
  - **Images** (`/images`, incl. videos): masonry grid preserving native aspect, kind
    chips, search over title/prompt, favorites, tags, manage mode, reuse-prompt,
    download.
  - **Stories** (`/stories`): cover cards with live scene progress, open/rename/
    duplicate/favorite/delete, search over scene prompts.
- Characters move server-side (mirroring the assets stack) with one-time localStorage
  migration.
- Fix the dead `updateCharacter` path: wizard edits persist back to the record.
- History ceases to exist: its jobs (search/filter/manage/bulk-delete, editor entry
  points) are absorbed by the three libraries.

## Non-goals

- No folders/collections, no drag-reorder, no upload-your-own character images, no
  import/export/sharing.
- No new backend for images/stories — they are already server records
  (`.studio/assets.json` + `.studio/stories.json` behind `/api/assets` with
  GET/POST/PATCH ?id=/DELETE ?ids=); libraries are pure UI over the existing
  `useAssets()` store.
- No story *scene* management from the library — the `/story?id=` editor owns scenes;
  the library opens it.
- No video editing; videos are tiles that open/download like images.
- `CharacterSpec` fields and prompt composition are unchanged.

## Approaches considered

1. **Library-first with URL routing (chosen).** Real routes per entity; characters get a
   server repo + API mirroring assets; one shared `LibraryShell` powers all three pages.
   Deep-linkable, refresh-safe, consistent with the Phase-A `/story?id=` direction, and
   the Phase-C server story runner can read casts. Cost: most files touched,
   character migration needed.
2. **Same single page, phases only.** Less routing work, but no deep links, editor state
   lost on refresh, diverges from durable records — rejected.
3. **Modal-driven library.** The 4-step wizard plus live preview panel is too large for
   modals — rejected.
4. **Keep History as an "All" tab.** Rejected by the user: libraries slice the same
   store cleanly, so History is redundant chrome. Removed.

## Shared library shell

`components/library/LibraryShell.tsx` — one component, three pages:

- **Header:** page title + count caption ("12 characters · 3 favorites") · search input ·
  sort dropdown (Newest / Oldest; Name A–Z on characters) · favorites star toggle ·
  filter-chip slot (kind chips, tag chips, family chip — per page) · Manage toggle ·
  primary CTA slot (+ New character / + New image / + New story).
- **Grid area:** passed as children — masonry columns (images) or uniform card grids
  (characters 4:5 tiles, stories 16:9 covers). Shell owns spacing/responsive columns.
- **Manage bar:** sticky bottom bar in manage mode — Favorite, Add tag, Delete (n) via
  `ConfirmDialog`; per-page callbacks, selection state owned by the page.
- **States:** loading skeletons, empty ("No characters yet" / "No images yet — generate
  one" / "No stories yet"), no-matches with clear-filters, server-error with Retry.

Tags: characters store `tags` top-level on `SavedCharacter`; images/stories store
`meta.tags: string[]` — `parseAssetRow` passes unknown fields through, and PATCH merges
top-level fields, so the client sends the full `meta` object with `meta.tags` merged in.
Both feed the same chip-filter UI.

## Character library

### Data model

`CharacterSpec` (`lib/character.ts`) unchanged. `SavedCharacter` gains lineage and
library fields:

```ts
export interface SavedCharacter {
  id: string;
  name: string;
  spec: CharacterSpec;
  /** Media ref / URL of the current poster image. */
  thumbnail?: string;
  /** Lineage: set when this record was saved as a variation of another. */
  parentId?: string;
  favorite?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}
```

- **Duplicate** (card menu) is an instant clone with no lineage: same spec, name
  "{name} (copy)", no `parentId`. **Create variation** is the lineage flow.
- **Create variation** navigates to `/character/new?parent=<id>`: the wizard pre-fills
  from the parent and saving POSTs a child with `parentId` set. Nothing persists until
  the user saves, so abandoned varies leave no rows.
- **Renders gallery is derived, not stored.** History assets already carry
  `meta.characterIds` (the cast attached at generation time, `lib/types.ts:128`; the
  field survives `parseAssetRow`'s pass-through). A character's gallery = assets whose
  `meta.characterIds` includes its id; renders saved from the editor append the edited
  character's id at save time. Legacy characters have an empty gallery until their next
  render (accepted; no backfill). "Set as thumbnail" PATCHes `thumbnail` to the chosen
  asset's `url`.
- Dangling `parentId` (parent deleted) is allowed: UI falls back to "Variation".

### Server layer (mirror the assets stack)

- `lib/repositories/characters.repository.ts` — rewritten as the server repo:
  read/write `.studio/characters.json`, list/put/patch/remove, no demo seed.
- `lib/repositories/character-row.ts` — row parser like `asset-row.ts`: validates shape,
  runs `sanitizeSpec`, clamps age, drops unknown fields; malformed rows degrade to
  "dropped on next load", never a crashed store.
- `lib/services/characters.service.ts` — thin service over the repo (separate from
  `records.service.ts`, which stays assets/stories-scoped).
- `app/api/characters/route.ts` — same contract as assets: `GET` list (newest first),
  `POST` upsert one, `PATCH ?id=` merge patch, `DELETE ?ids=a,b`. `runtime = "nodejs"`,
  structured logging, same error shape (`{ error, retryable }`).

### Client store

- New `lib/character-store.ts` following `lib/store.ts`: hydrate-once from
  `/api/characters`, `useSyncExternalStore`, optimistic updates with server mirroring,
  `useCharacters(): { characters, ready }` — **same signature as today** so
  `CastPicker`, `GeneratorScreen`, `app/story/page.tsx`, and the wizard only change
  their import path.
- Mutations: `addCharacter`, `updateCharacter`, `removeCharacters` (bulk),
  `toggleCharacterFavorite`. Optimistic update → mirror to API; on failure roll back +
  `useToast` error.
- Delete side-effect (client action): remove the id from settings `soloCharacterIds` /
  `storyCharacterIds` (preserves today's detach behavior).

### Migration

One-time, idempotent, client-driven (assets legacy-import pattern): on first library
load, if `perabyte.characters.v1` is non-empty and the
`perabyte.characters.migrated.v2` flag is absent → POST each record (ids preserved) →
set the flag. The old key stays as a backup (tiny payload), never read again.

### Routes

| Route | Renders |
|---|---|
| `/character` | **Character library.** Replaces the marketing landing entirely. |
| `/character/new` | Wizard, create mode. `?parent=<id>` seeds from a parent (variation); save POSTs with `parentId`. |
| `/character/[id]` | Wizard, edit mode: **Save changes** PATCHes; **Save as copy** POSTs a duplicate. |

- Guardrails: unknown `?parent=` falls back to plain create (toast); unknown
  `/character/[id]` renders a not-found EmptyState with a back-to-library link.

### Character page UX

- **Poster grid:** `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5` cards,
  `MediaFrame` ratio 4/5. Card: thumbnail (skeleton / letter fallback tile), favorite
  star top-left, `⋯` menu top-right — Open · Rename · Duplicate · Create variation ·
  Add to Solo cast · Add to Story cast · Delete. Below image: name (semibold, truncate),
  lineage badge ("↳ Ava" for children), ≤2 tag chips (+n), relative updatedAt, where-used
  dots ("Solo"/"Story" when the id is in a settings cast). Click card →
  `/character/[id]`. First grid cell: dashed **+ New character** tile.
- **Filters:** tag chips (toggle multi, union) + family chip ("Family: Ava · 4") when any
  character has children. Search matches name, spec prompt, tags.
- **Manage mode:** multi-select cards → sticky bar: Favorite, Add tag, Delete (n) —
  confirm lists where-used and states that deleting detaches casts.

### Editor (wizard) changes

The 4 steps, live preview panel, LoRA row, and look presets are unchanged. Changes:

- **Edit mode** pre-fills from the saved record; Review actions become **Save changes**
  (PATCH name/spec/tags/favorite) and **Save as copy** (POST) — closing the
  dead-`updateCharacter` gap. Header: inline-renamable name + "Variation of {parent}"
  breadcrumb when `parentId` is set.
- **Renders strip** on the ready step: gallery assets (via `meta.characterIds`), each
  with Set as thumbnail + open/download.
- **Asset tagging:** renders saved from the editor append the character id to
  `meta.characterIds`.
- **Create mode** is today's flow; save POSTs (with `parentId` when varying). Tags and
  favorite are editable in the library UI, keeping the wizard focused on identity.

## Images library (`/images`)

- **Source:** `useAssets()` filtered to `kind === "image" | "video"` — pure client-side
  slicing of the existing merged store; no API change.
- **Grid:** CSS masonry columns (2 / 3 / 4 / 5 by breakpoint) preserving each asset's
  native aspect — no cropping; videos render their poster (`posterUrl` or frame) with a
  duration badge (from `settings.duration`) + play glyph.
- **Header:** "Images & videos" + count · search (title + prompt) · sort Newest/Oldest ·
  favorites toggle · kind chips (All · Images · Videos) · tag chips (`meta.tags`) ·
  Manage · **+ New** → `/generate/image`.
- **Card ops** (click = open; `⋯` menu): Open (same viewer/results behavior History uses
  today) · Download · Favorite · Reuse prompt → `/generate/image` prefilled via a small
  localStorage draft handoff read once by `GeneratorScreen` · Add tag · Delete.
- **Manage mode:** multi-select → Favorite, Add tag, Delete (n) + `ConfirmDialog`
  (deletes remove media records; media files stay in the content-addressed cache, as
  History bulk delete behaves today).

## Stories library (`/stories`)

- **Source:** `useAssets()` filtered to `kind === "story"` — again zero backend.
- **Grid:** 16:9 cover cards — cover = first scene with a `url` (letter-tile fallback);
  scene progress ("3/5 scenes" or status dots), live "Generating" chip when any scene is
  queued/generating (read from the record, no new polling), favorite star, `⋯` menu,
  relative createdAt. Click → `/story?id=<id>` (Phase-A addressing).
- **Card ops:** Open · Rename (dialog → PATCH `title`) · Duplicate · Favorite · Add tag
  (`meta.tags`) · Delete.
- **Duplicate semantics:** client builds a deep copy — new id, title "{title} (copy)",
  `favorite: false`, fresh `createdAt`; completed scenes keep their `url`; non-terminal
  scenes reset to idle with `url: null` (no stuck "generating" ghosts — the copy has no
  jobs attached). POST upserts it.
- **Header:** "Stories" + count · search (title + all scene prompts) · sort
  Newest/Oldest · favorites toggle · tag chips · Manage · **+ New story** → `/story`.

## Retiring History

- Delete `app/history/page.tsx`; **add a permanent redirect `/history → /images`** in
  `next.config` so old links/bookmarks survive.
- Nav: `PRIMARY_NAV` becomes Home · Generate · Story · Character · Images · Stories
  (History item removed). `isActive` needs an exact-match special case so `/story`
  (editor) and `/stories` (library) don't light each other up under `startsWith`.
- Sweep all `/history` references (Results "view all" links, toasts, tests, smoke
  scripts) and repoint them at `/images` or `/stories`.

## Error handling

- Optimistic writes roll back on API failure with a toast (store convention).
- Malformed server rows are dropped by the row parsers, never crash a store.
- Deleted-but-still-cast ids: CastPicker already filters unknown ids; delete also
  detaches from settings casts.
- Migration failure keeps localStorage data and retries next visit (flag set only after
  a fully successful import).
- Duplicate-story POST failure rolls back the optimistic row.

## Testing

- **Unit (vitest):** `character-row` parser (valid/invalid, `sanitizeSpec`, unknown-field
  dropping); characters server repo CRUD on a temp `.studio` path; `/api/characters`
  handlers; character-store (hydrate, optimistic ops, rollback, migration idempotency);
  pure helpers (`cloneForVariation`, `cloneForDuplicate`, `duplicateStoryAsset` — scene
  status reset); library selectors (kind/tag/search/sort for images and stories);
  `isActive` `/story` vs `/stories`.
- **Existing:** rewrite `characters.repository.test.ts` for the server repo;
  `lib/character.test.ts` untouched; update History-page tests → library page tests;
  repoint imports in CastPicker/GeneratorScreen/story tests. Full suite green.
- **GUI smoke (playwright, :3100):** create character → in grid; vary → child with
  lineage badge; edit persists across reload; migration runs exactly once; images:
  search/kind-chip/manage-delete/reuse-prompt; stories: open/rename/duplicate (scene
  reset)/delete; `/history` redirects to `/images`; sidebar `/story` vs `/stories`
  highlight correct.

## Implementation order (feeds the plan doc)

1. Server layer: characters repo + row parser + service + API + tests.
2. Character client store swap + migration + consumer import updates + tests.
3. `LibraryShell` + Character library page + routes; delete marketing landing; tests.
4. Editor save-back, renders strip, asset tagging, variation flow; tests.
5. Images library page + **History retirement** (delete page, nav update, redirect,
   reference sweep) + tests.
6. Stories library page (open/rename/duplicate/favorite/delete) + tests.
7. Tags + manage-mode parity across all three; full GUI smoke; suite green.
