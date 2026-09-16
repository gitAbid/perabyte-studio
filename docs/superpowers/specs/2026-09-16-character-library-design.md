# Character Library Redesign — Design

**Date:** 2026-09-16
**Status:** Draft — awaiting user review
**Scope:** Replace the marketing-style `/character` landing with a server-backed character
asset library (browse / search / manage / vary / create), keep the existing wizard as the
create-and-edit editor behind real URLs, and migrate characters to `.studio/*.json`.

Decisions the user delegated (recommended defaults chosen — veto any in review):
variations = child characters with lineage · layout = poster grid · storage = server-side ·
extras = favorites + tags + where-used · folders/collections deferred.

## Problem

`/character` renders `CharacterStudio`, whose landing is a marketing hero plus a small
saved-character strip. Characters are the **last client-only entity**: assets, stories,
settings, and jobs all persist server-side (`.studio/*.json`, Phase A), but characters
still live in `localStorage` (`perabyte.characters.v1`) and die with browser data.
Management is minimal: create (4-step wizard), re-open, delete. There is no search, no
duplicate, no variations, no tags/favorites, no rename. `updateCharacter` is exported but
never called — editing a saved character never persists spec changes back. There are no
URLs for library vs. editor, so nothing is deep-linkable or refresh-safe.

## Goals

- An asset-library page: poster grid, search, sort, filters, favorites, tags, manage mode
  with bulk delete — matching the conventions History already established.
- One-click **Create variation** (lineage: child characters linked to a parent).
- Real routes: `/character` (library), `/character/new` (wizard), `/character/[id]`
  (edit), `/character/new?parent=<id>` (vary).
- Server-side persistence mirroring the assets stack, with one-time migration of
  existing localStorage characters.
- Fix the dead `updateCharacter` path: edits in the wizard persist back to the record.
- Per-character render gallery (from History assets) with "Set as thumbnail".

## Non-goals

- No folders/collections (tags cover grouping for now).
- No per-look-inside-one-record model (lineage variations cover it).
- No manual drag-reorder of the grid, no upload-your-own character images, no
  import/export/sharing.
- Cast *membership* management stays in Solo/Story composers (CastPicker); the library
  only offers one-click "add to Solo/Story cast".
- `CharacterSpec` fields and prompt composition are unchanged.

## Approaches considered

1. **Library-first with URL routing (chosen).** `/character` becomes the library;
   `/character/new` and `/character/[id]` open the existing wizard. Characters get a
   server repo + API mirroring assets. Deep-linkable, refresh-safe, consistent with the
   Phase-A `/story?id=` direction, and the future Phase-C server story runner can read
   casts. Cost: most files touched, migration needed.
2. **Same single page, phases only.** Keep `/character` a client-phase shell with the
   library as the new landing phase. Less routing work, but no deep links, editor state
   lost on refresh, and it diverges from the durable-records direction.
3. **Modal-driven library.** Grid + wizard in dialogs. The 4-step wizard plus live
   preview panel is too large for modals; cramped UX.

## Data model

`CharacterSpec` (`lib/character.ts`) is unchanged. `SavedCharacter`
(`lib/repositories/characters.repository.ts`) gains lineage and library fields:

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
  "{name} (copy)", no `parentId` — a backup copy. **Create variation** is the lineage
  flow below.
- **Create variation** navigates to `/character/new?parent=<id>`: the wizard pre-fills
  from the parent and saving POSTs a child with `parentId` set. Nothing is persisted
  until the user saves, so abandoned varies leave no rows.
- **Renders gallery is derived, not stored.** History assets already carry
  `meta.characterIds` (the cast attached at generation time, `lib/types.ts:128`). A
  character's gallery = assets whose `meta.characterIds` includes its id. No duplicated
  media, works with the existing History page. Renders saved from the editor get the
  edited character's id appended to `meta.characterIds` at save time. Legacy characters
  have an empty gallery until their next render (accepted; no backfill).
- "Set as thumbnail" PATCHes `thumbnail` to the chosen asset's `url`.
- Dangling `parentId` (parent deleted) is allowed: UI falls back to a generic
  "Variation" badge.

## Server layer (mirror the assets stack)

- `lib/repositories/characters.repository.ts` — rewritten as the server repo:
  read/write `lib/config/paths.ts`-based `.studio/characters.json`, list/put/patch/remove,
  seed-once only if empty (no demo characters).
- `lib/repositories/character-row.ts` — row parser like `asset-row.ts`: validates shape,
  runs `sanitizeSpec`, clamps age, drops unknown fields; a malformed row degrades to
  "dropped on next load", never a crashed store.
- `lib/services/characters.service.ts` — thin service over the repo (separate from
  `records.service.ts`, which stays assets/stories-scoped).
- `app/api/characters/route.ts` — same contract as assets: `GET` list (newest first),
  `POST` upsert one, `PATCH ?id=` merge patch, `DELETE ?ids=a,b`. `runtime = "nodejs"`,
  structured logging, same error-shape (`{ error, retryable }`).

### Client store

- New `lib/character-store.ts` following `lib/store.ts`: hydrate-once from
  `/api/characters`, external store via `useSyncExternalStore`, optimistic updates with
  server mirroring, `useCharacters(): { characters, ready }` — **same signature as
  today** so `CastPicker`, `GeneratorScreen`, `app/story/page.tsx`, and the wizard only
  change their import path.
- Mutations: `addCharacter`, `updateCharacter`, `removeCharacters` (bulk),
  `toggleCharacterFavorite`. Each optimistically updates the cache, then mirrors to the
  API; on failure, roll back + `useToast` error.
- Delete side-effect (client action): remove the id from settings `soloCharacterIds` /
  `storyCharacterIds` (preserves today's detach behavior).

### Migration

One-time, idempotent, client-driven (same pattern as the assets legacy import): on first
library load, if `perabyte.characters.v1` is non-empty and the
`perabyte.characters.migrated.v2` flag is absent → POST each record (ids preserved) →
set the flag. The old key is kept as a backup (tiny payload), never read again.

## Routes & information architecture

| Route | Renders |
|---|---|
| `/character` | **CharacterLibrary** — the asset-library grid. Replaces the marketing landing entirely. |
| `/character/new` | Wizard, create mode. `?parent=<id>` seeds the wizard from a parent (variation); saving POSTs with `parentId`. |
| `/character/[id]` | Wizard, edit mode: loads the saved spec; **Save changes** PATCHes; **Save as copy** POSTs a duplicate. |

- Sidebar nav stays `Character → /character`; footer/landing funnel unchanged.
- Wizard state remains client-side (as today); URLs make entry points addressable.
- Guardrails: `/character/new?parent=<id>` with an unknown/deleted parent falls back to
  plain create (with a toast). `/character/[id]` with an unknown id renders a not-found
  EmptyState with a back-to-library link.

## Library page UX

**Header row:** "Characters" + count caption ("12 characters · 3 favorites") · search
input (matches name, spec prompt, tags) · sort dropdown (Recently updated · Name A–Z ·
Newest; default Recently updated) · favorites star toggle · **+ New** primary button
(`bg-primary-strong text-white`).

**Filter row (renders only when useful):** tag chips (toggle multi, union semantics) and
a family chip ("Family: Ava · 4") when any character has children.

**Poster grid:** responsive `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5`
cards on `Card` + `MediaFrame` ratio 4/5 (portrait, matching today's thumbnails).
Card anatomy:
- Image area: thumbnail; skeleton while loading; letter fallback tile when no thumbnail.
- Top-left: favorite star (persisted state always visible; on-hover otherwise).
- Top-right: `⋯` menu — Open · Rename · Duplicate · Create variation · Add to Solo cast ·
  Add to Story cast · Delete.
- In manage mode the star swaps to a checkbox.
- Below image: name (`font-semibold truncate`), lineage badge ("↳ Ava" for children),
  up to 2 tag chips (+n overflow), relative updatedAt (muted, small).
- Where-used: small "Solo"/"Story" dot indicators when the id is in a settings cast.
- Click card → `/character/[id]`. First grid cell is a dashed **+ New character** tile.

**Manage mode:** "Select" toggle (History convention) → multi-select cards + sticky
action bar: Favorite, Add tag, Delete (n) via `ConfirmDialog` — the confirm lists
where-used ("In Solo cast, In Story cast") and states that deleting detaches casts.

**Empty states:** no characters → `EmptyState` + "Create your first character" CTA;
no matches → "No characters match" + clear-filters button. Server fetch failure →
error EmptyState with Retry.

**Mobile:** 2-column grid, header wraps, manage bar sticks to the bottom. Tokens only
(`surface/border/ink/primary-soft/…`) so dark mode flips; no `bg-ink` media scrims.

## Editor (wizard) changes

The 4 steps, live preview panel, LoRA row, and look presets are unchanged. Changes:

- **Edit mode** pre-fills from the saved record; Review actions become
  **Save changes** (PATCH name/spec/tags/favorite) and **Save as copy** (POST). This
  closes the dead-`updateCharacter` gap. Header shows an inline-renamable name and a
  "Variation of {parent}" breadcrumb when `parentId` is set.
- **Renders strip** on the ready step: gallery assets (derived via
  `meta.characterIds`), each with Set as thumbnail + open in History/download.
- **Asset tagging:** every render saved from the editor appends the character id to the
  asset's `meta.characterIds`.
- **Create mode** is today's flow; save POSTs to the server (with `parentId` when
  varying). Tags/favorite default off; they're editable in the library UI (card menu +
  manage bar), keeping the wizard focused on identity.

## Error handling

- Optimistic writes roll back on API failure with a toast (store.ts convention).
- Malformed server rows are dropped by the row parser, never crash the store.
- Deleted-but-still-cast ids: CastPicker already filters unknown ids; the delete action
  also detaches from settings casts, so both layers are safe.
- Migration failure keeps localStorage data and retries on the next visit (flag only set
  after a fully successful import).

## Testing

- **Unit (vitest):** `character-row` parser (valid/invalid, `sanitizeSpec`, unknown-field
  dropping); characters server repo CRUD on a temp `.studio` path (settings-repo test
  pattern); `/api/characters` handlers (happy + malformed bodies); character-store
  (hydrate, optimistic ops, rollback, migration idempotency); pure helpers in
  `lib/character.ts` (`cloneForVariation`, `cloneForDuplicate`); search/sort/filter
  reducer; where-used selector.
- **Existing:** rewrite `characters.repository.test.ts` for the server repo;
  `lib/character.test.ts` untouched; update import paths in CastPicker/GeneratorScreen/
  story tests. Full suite green before merge.
- **GUI smoke (playwright, :3100 dev):** create → appears in grid; vary → child with
  lineage badge; edit persists across reload; delete detaches cast; migration imports
  seeded localStorage characters exactly once.

## Implementation order (feeds the plan doc)

1. Server layer: repo + row parser + service + API + tests.
2. Client store swap + migration + consumer import updates + tests.
3. Library page + routes; delete the marketing landing; tests.
4. Editor save-back, renders strip, asset tagging, variation flow; tests.
5. Manage mode, where-used, family filter; full GUI smoke.
