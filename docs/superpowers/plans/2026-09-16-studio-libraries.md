# Studio Libraries (Characters, Images, Stories) + History Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three asset-library pages — `/character` (server-backed, lineage variations), `/images` (masonry incl. videos), `/stories` (cover cards) — over one shared `LibraryShell`, and the separate History page removed (nav item, page, permanent redirect).

**Architecture:** Characters get the assets stack verbatim (fs repo → service → `/api/characters` route → client mirror store with the existing `useCharacters()` signature). Images/stories are pure UI slicing of the existing `useAssets()` merged store (zero backend). All filtering/sorting/cloning lives in one pure module (`lib/library-selectors.ts`) since vitest here is node-env/lib-only. The wizard survives as a wizard-only component mounted at `/character/new` and `/character/[id]`; the marketing landing is deleted.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind tokens (dark-mode safe), vitest (node env), fs-backed JSON repositories.

**Spec:** `docs/superpowers/specs/2026-09-16-studio-libraries-design.md`

**Worktree:** all work in `.worktrees/feat/studio-libraries` (branch `feat/studio-libraries`). Bootstrap DONE: deps installed, `.env.local` copied, baseline **457 tests green**.

**Known contracts (verified on master):**
- `components/ui.tsx`: `Button{variant,size,icon,aria-pressed}`, `LinkButton`, `Card`, `Badge{tone}`, `FieldShell`, `SelectField`, `TextAreaField`, `Toggle`, `Segmented<T>{ariaLabel,value,onChange,options}`, `useToast()`, `EmptyState{icon,title,body,action}`, `ConfirmDialog{open,title,body,confirmLabel?,onCancel,onConfirm}`, `formatDate(ts)`, `formatTime(ts)`.
- `components/Media.tsx`: `MediaFrame{src: string|null, alt, className, ratio, rounded, sizes, priority, fit, sensitive, detailed}`.
- `components/Icon.tsx` names: `logo home sparkle image video history user arrow-right arrow-left download share play pause volume fullscreen plus trash copy heart more check clock alert close chevron-down layers grid search menu star story character lock refresh upload sliders chip`.
- `Asset` (`lib/types.ts:114`): `{id, kind: "image"|"video"|"story", title, prompt, url, variants, posterUrl?, settings, createdAt, favorite, mode, scenes?: StoryScene[], meta?: Record<string, string|number|boolean|string[]>}`. `parseAssetRow` passes unknown fields through (meta survives).
- `StoryScene.status: JobStatus` = `"queued" | "generating" | "done" | "error" | "canceled"` (verify exact union in `lib/types.ts:10` while implementing).
- History page patterns to reuse: search input classes, `MenuItem` dropdown (copy into `LibraryShell`-adjacent component), `MediaThumb` sensitive blur via `isSensitiveAsset(asset)` (`lib/domain/models`), open target `/results?id=`, regenerate URL `/generate/image?prompt=&style=&aspect=`.
- Server path convention: `path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "<file>.json")` (see `lib/repositories/assets.repository.ts:26`).
- `/history` references to repoint: `app/not-found.tsx:23`, `app/page.tsx:38`, `app/results/page.tsx:57,118`, `components/SiteChrome.tsx:22,342`, `components/character/CharacterStudio.tsx:533`.
- Import sites of the client characters repo: `app/story/page.tsx:56`, `components/CastPicker.tsx:6`, `components/GeneratorScreen.tsx:32`, `components/PromptComposer.tsx:27`, `components/character/CharacterLanding.tsx:6` (deleted), `components/character/CharacterStudio.tsx:42`, `lib/repositories/characters.repository.test.ts`.

---

### Task 0: Worktree bootstrap ✅

Done before this plan was written: `git worktree add .worktrees/feat/studio-libraries -b feat/studio-libraries master`; `.env.local` copied; `npm install`; `npx vitest run` → 51 files / 457 tests green.

---

### Task 1: Character row parser (`lib/repositories/character-row.ts`)

**Files:**
- Create: `lib/repositories/character-row.ts`
- Test: `lib/repositories/character-row.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/repositories/character-row.test.ts
import { describe, expect, it } from "vitest";
import { parseCharacterRow } from "@/lib/repositories/character-row";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";

const base = {
  id: "ch_1",
  name: "Ava",
  spec: { ...DEFAULT_CHARACTER_SPEC },
  createdAt: 1,
  updatedAt: 1,
};

describe("parseCharacterRow", () => {
  it("accepts a valid row and passes extras through", () => {
    const row = parseCharacterRow({
      ...base,
      thumbnail: "/api/media?f=x",
      parentId: "ch_0",
      favorite: true,
      tags: ["main cast"],
      futureField: 1,
    });
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Ava");
    expect(row!.favorite).toBe(true);
    expect((row as Record<string, unknown>).futureField).toBe(1);
  });

  it("rejects rows missing identity or spec", () => {
    expect(parseCharacterRow(null)).toBeNull();
    expect(parseCharacterRow({ ...base, id: "" })).toBeNull();
    expect(parseCharacterRow({ ...base, spec: null })).toBeNull();
    expect(parseCharacterRow({ ...base, name: 5 })).toBeNull();
    expect(parseCharacterRow({ ...base, createdAt: "x" })).toBeNull();
  });

  it("sanitizes the spec and clamps age", () => {
    const row = parseCharacterRow({
      ...base,
      spec: { ...DEFAULT_CHARACTER_SPEC, age: 12, prompt: "  x " },
    });
    expect(row!.spec.age).toBe(18);
  });

  it("coerces favorite/tags types defensively", () => {
    const row = parseCharacterRow({ ...base, favorite: "yes", tags: "solo" });
    expect(row!.favorite).toBe(false); // non-boolean drops to default
    expect(row!.tags).toBeUndefined(); // non-array drops
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run lib/repositories/character-row.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// lib/repositories/character-row.ts
import { clampAge, sanitizeSpec, type CharacterSpec } from "@/lib/character";

/** SavedCharacter row shape (client mirror re-declares it in
 * lib/character-store.ts to avoid importing React there — keep in sync). */
export interface CharacterRow {
  id: string;
  name: string;
  spec: CharacterSpec;
  thumbnail?: string;
  parentId?: string;
  favorite?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Shape check for a character row off disk or the wire, mirroring
 * parseAssetRow: required-field validation only, unknown extras pass
 * through, spec re-sanitized (clamps age, applies uncensored fallbacks).
 * Returns null for anything that would break consumers.
 */
export function parseCharacterRow(raw: unknown): CharacterRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string") return null;
  if (!r.spec || typeof r.spec !== "object") return null;
  if (typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") return null;
  const row = r as unknown as CharacterRow;
  row.spec = sanitizeSpec(row.spec, true) as CharacterSpec;
  row.spec.age = clampAge(row.spec.age);
  if (typeof row.favorite !== "boolean") delete row.favorite;
  if (row.tags !== undefined && !isStringArray(row.tags)) delete row.tags;
  if (row.thumbnail !== undefined && typeof row.thumbnail !== "string") delete row.thumbnail;
  if (row.parentId !== undefined && typeof row.parentId !== "string") delete row.parentId;
  return row;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((t) => typeof t === "string");
}
```

Check while implementing: `sanitizeSpec`'s exact signature in `lib/character.ts` (it may take `(spec, uncensored)` and already clamp age — adjust the test/impl to reality; keep the clamp only if sanitize doesn't do it).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run lib/repositories/character-row.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(characters): server row parser (character-row)"`.

---

### Task 2: Move the client repo to `lib/character-store.ts` (pure rename, stays green)

The current `lib/repositories/characters.repository.ts` is a localStorage client store. It moves to `lib/character-store.ts` byte-identical this task; Task 4 re-plumbs its internals. Server code takes over the old path in Task 3.

**Files:**
- Create: `lib/character-store.ts` (verbatim move of `lib/repositories/characters.repository.ts`)
- Delete: `lib/repositories/characters.repository.ts`
- Modify imports (export names unchanged): `app/story/page.tsx:56`, `components/CastPicker.tsx:6`, `components/GeneratorScreen.tsx:32`, `components/PromptComposer.tsx:27`, `components/character/CharacterStudio.tsx:42`
- Rename test: `lib/repositories/characters.repository.test.ts` → `lib/character-store.test.ts` (update its import only)

- [ ] **Step 1:** `git mv lib/repositories/characters.repository.ts lib/character-store.ts` and `git mv lib/repositories/characters.repository.test.ts lib/character-store.test.ts`.
- [ ] **Step 2:** Update the 6 import sites listed above to `from "@/lib/character-store"`. Header comment in `lib/character-store.ts`: note it is about to become the API mirror.
- [ ] **Step 3:** `npx vitest run` → all green (457). `npx tsc --noEmit` → clean.
- [ ] **Step 4: Commit** — `git commit -am "refactor(characters): move client repo to lib/character-store (rename only)"`.

---

### Task 3: Server repo + service + `/api/characters`

**Files:**
- Create: `lib/repositories/characters.repository.ts` (server, fs-backed — replaces the deleted client file's path)
- Create: `lib/services/characters.service.ts`
- Create: `app/api/characters/route.ts`
- Test: `lib/repositories/characters.repository.test.ts` (new; server-side)
- Reuse the temp-`.studio`-path mocking pattern from `lib/repositories/provider-config.repository.test.ts` (read it first).

Repo (`readCharacters`/`writeCharacters`, mirrors `assets.repository.ts`):

```ts
// lib/repositories/characters.repository.ts
import fs from "node:fs";
import path from "node:path";
import { parseCharacterRow, parseCharacterRows, type CharacterRow } from "@/lib/repositories/character-row";

function charactersPath(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".studio", "characters.json");
}

export function readCharacters(): CharacterRow[] {
  try {
    return parseCharacterRows(JSON.parse(fs.readFileSync(charactersPath(), "utf8")));
  } catch {
    return [];
  }
}

export function writeCharacters(rows: CharacterRow[]): void {
  fs.mkdirSync(path.dirname(charactersPath()), { recursive: true });
  fs.writeFileSync(charactersPath(), JSON.stringify(rows, null, 2));
}
```

Service (mirrors `records.service.ts` semantics; read `lib/services/records.service.ts` first and match its read-modify-write style):

```ts
// lib/services/characters.service.ts
import { readCharacters, writeCharacters } from "@/lib/repositories/characters.repository";
import { parseCharacterRow, type CharacterRow } from "@/lib/repositories/character-row";

export function listCharacters(): CharacterRow[] {
  return readCharacters().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function putCharacter(raw: unknown): CharacterRow | null {
  const row = parseCharacterRow(raw);
  if (!row) return null;
  const rows = readCharacters();
  const next = rows.filter((r) => r.id !== row.id);
  next.unshift(row);
  writeCharacters(next);
  return row;
}

export function patchCharacter(id: string, patch: Record<string, unknown>): CharacterRow | null {
  const rows = readCharacters();
  const current = rows.find((r) => r.id === id);
  if (!current) return null;
  const merged = parseCharacterRow({ ...current, ...patch, id, updatedAt: Date.now() });
  if (!merged) return null;
  writeCharacters(rows.map((r) => (r.id === id ? merged : r)));
  return merged;
}

export function removeCharacters(ids: string[]): number {
  const set = new Set(ids);
  const rows = readCharacters();
  writeCharacters(rows.filter((r) => !set.has(r.id)));
  return rows.filter((r) => set.has(r.id)).length;
}
```

Route (mirrors `app/api/assets/route.ts` exactly — read it first; doc comment: `GET list newest-first · POST upsert one · PATCH ?id= merge · DELETE ?ids=a,b`; `runtime = "nodejs"`; `logger.child({ route: "api/characters" })`; same `{ error, retryable }` error shape and `cache-control: no-store`).

- [ ] **Step 1: Failing tests** — repo CRUD on temp cwd: seed file → `readCharacters` parses; corrupt JSON → `[]`; write → read round-trip. Service: put dedupes by id (upsert), patch merges + bumps `updatedAt` + 404-null on unknown id, remove returns count. Route handlers: happy POST → 200 `{character}`, malformed POST → 400, PATCH unknown id → 404, DELETE removes. Route tests call the exported `GET/POST/PATCH/DELETE` directly with `new Request("http://localhost/api/characters?...")` (same style as existing route tests if any; otherwise test service only — check how assets routes are covered and mirror that depth).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS + full suite green.
- [ ] **Step 5: Commit** — `git commit -am "feat(characters): .studio/characters.json repo + service + /api/characters"`.

---

### Task 4: API-backed client store + library selectors

**Files:**
- Modify: `lib/character-store.ts` (re-plumb internals to `/api/characters`)
- Create: `lib/library-selectors.ts`
- Test: `lib/character-store.test.ts` (extend), `lib/library-selectors.test.ts` (new)

**`lib/character-store.ts` public API stays byte-identical**: `getCharacters()`, `getCharacter(id)`, `addCharacter(name, spec, thumbnail?, opts?)`, `updateCharacter(id, patch)`, `removeCharacter(id)`, `removeCharacters(ids)`, `toggleCharacterFavorite(id)`, `useCharacters(): {characters, ready}`, `resetCharactersForTests()`. `addCharacter` gains an optional 4th arg:

```ts
export interface AddCharacterOptions {
  parentId?: string;
  tags?: string[];
  favorite?: boolean;
}
```

Internals (copy the `lib/store.ts` mirror pattern — read it first): module `cache: CharacterRow[] | null`, `hydrate()` fetches `/api/characters` once (`Promise` guard), `useCharacters` returns cache (or `[]` pre-hydration) + `ready`. Mutations update cache optimistically, `emit()`, then fire the mirror call (`POST` row / `PATCH ?id=` / `DELETE ?ids=`); on failure roll back the cache and `console` via the app logger if importable client-side, else `console.warn` (match `lib/store.ts` behavior — do not introduce toasts in the store; pages own toasts).

`SavedCharacter` type: re-export from `lib/repositories/character-row.ts` as `export type { CharacterRow as SavedCharacter }` so consumers keep the name.

**Migration** inside `hydrate()` after the first successful fetch:

```ts
const LEGACY_KEY = "perabyte.characters.v1";
const MIGRATED_KEY = "perabyte.characters.migrated.v2";
// Only in browser: if localStorage has rows and the flag is absent,
// PUT each row whose id is not already on the server (POST /api/characters),
// merge responses into the cache, then set the flag. Any failure →
// leave flag unset (retry next visit). Never delete the legacy key.
```

**`lib/library-selectors.ts`** — pure functions + tests:

```ts
import type { Asset } from "@/lib/types";
import type { SavedCharacter } from "@/lib/repositories/character-row";

export type MediaFilter = "all" | "image" | "video";
export type SortMode = "newest" | "oldest" | "name";

export interface CharacterLibraryState {
  query: string;
  favouritesOnly: boolean;
  sort: SortMode;               // name → Name A–Z, else updatedAt
  activeTags: string[];
  familyId: string | null;      // family filter (parent + children)
}
export interface MediaLibraryState {
  query: string;
  favouritesOnly: boolean;
  sort: SortMode;
  kind: MediaFilter;            // "all" | image | video
  activeTags: string[];
}

export function assetTags(a: Asset): string[];            // a.meta?.tags if string[]
export function collectAssetTags(assets: Asset[]): string[];
export function collectCharacterTags(rows: SavedCharacter[]): string[];

export function selectCharacters(rows: SavedCharacter[], state: CharacterLibraryState): SavedCharacter[];
// search: name + spec.prompt + tags; family filter: row.id === familyId || row.parentId === familyId

export function selectMedia(assets: Asset[], state: MediaLibraryState): Asset[];
// kind: "all" → image|video only (stories excluded); search: title + prompt (+ scenes' prompts when kind==="story" — used by StoriesLibrary via selectStories)

export function selectStories(assets: Asset[], state: Omit<MediaLibraryState, "kind">): Asset[];
// kind==="story" rows; search: title + prompt + every scene prompt

export function storyCover(a: Asset): string | null;      // first scene with url ?? a.url ?? null
export function storyProgress(a: Asset): { done: number; total: number; live: boolean };
// done = scenes with status "done"; live = any "queued"/"generating"

export function cloneForDuplicate(c: SavedCharacter): SavedCharacter; // name "(copy)", no parentId, favorite:false, tags kept, fresh id/createdAt/updatedAt
export function cloneForVariation(parent: SavedCharacter, name: string, spec: CharacterSpec): SavedCharacter; // parentId set
export function duplicateStoryAsset(a: Asset, now: number): Asset;
// new id `s_<now36>_<rand>`, title "{title} (copy)", favorite:false, createdAt:now,
// scenes: done scenes keep url/status; others → { ...scene, status:"queued"→"idle"? —
// reset to the neutral status the editor uses for never-run scenes (check StoryScene
// defaults in app/story or the runner; likely "canceled" is wrong — use the initial
// status value found in the story page's scene factory), url:null, progress cleared }

export function castUsage(characterId: string, solo: string[], story: string[]): { solo: boolean; story: boolean };
```

- [ ] **Step 1: Failing tests** for every selector above (table-driven: search match/no-match, family grouping, kind filtering excludes stories, duplicate resets non-done scenes, castUsage).
- [ ] **Step 2:** FAIL → **Step 3:** implement (check `MAX_SCENE_CHARACTERS`, id-prefix conventions `ch_`/`s_`/`c_` while implementing) → **Step 4:** PASS + store migration test (fake `fetch`: seed legacy localStorage + flag absent → hydrate POSTs rows, flag set, second hydrate does not re-POST) + full suite.
- [ ] **Step 5: Commit** — `git commit -am "feat(characters): API-backed character store + legacy migration; library selectors"`.

---

### Task 5: Shared library components

**Files:**
- Create: `components/library/LibraryShell.tsx` ("use client")
- Create: `components/library/PromptDialog.tsx` (rename: title/label/initial/confirmLabel → string)
- Create: `components/library/TagEditorDialog.tsx` (initial tags → next tags; input + removable chips)

`LibraryShell` props (dumb shell — pages own state + grids):

```ts
interface LibraryShellProps {
  title: string;
  caption: string;                       // "12 characters · 3 favorites"
  query: string; onQueryChange(v: string): void;
  sort: SortMode; onSortChange(v: SortMode): void;   // native <select>, History's classes
  favouritesOnly: boolean; onToggleFavourites(): void;
  filters?: ReactNode;                   // chip row slot
  cta: ReactNode;                        // "+ New" LinkButton
  manage: boolean; onToggleManage(): void;
  manageBar?: ReactNode;                 // rendered when manage
  loading: boolean; loadingTiles?: number;
  empty: ReactNode;                      // page-owned EmptyState (covers no-data / no-match / error)
  children: ReactNode;                   // the grid
}
```

Layout: History's page paddings (`mx-auto w-full max-w-[1100px] px-4 pb-12 pt-8 sm:px-6`), header block (title `text-[28px] font-extrabold tracking-[-0.03em]`, caption `text-sm text-muted`), controls row (search input = History's exact classes + sort select + favourites `Button variant="secondary" size="sm" icon="star"` + Manage button + CTA), filters row (slot), manage bar (History's manage classes), loading skeletons (grid of `skeleton` tiles), empty slot, children. Tokens only — no `bg-ink`, no `bg-white`.

- [ ] **Step 1:** implement the three components; `npx tsc --noEmit` clean. No unit tests (node-env suite; pages exercise them in GUI smoke).
- [ ] **Step 2: Commit** — `git commit -am "feat(library): shared LibraryShell + prompt/tag dialogs"`.

---

### Task 6: Character library page + routes; wizard becomes wizard-only

**Files:**
- Modify: `app/character/page.tsx` → renders `<CharacterLibrary />`
- Create: `components/character/CharacterLibrary.tsx` ("use client")
- Create: `app/character/new/page.tsx`, `app/character/[id]/page.tsx`
- Modify: `components/character/CharacterStudio.tsx` (remove landing phase; add props; edit-mode save-back; renders strip)
- Delete: `components/character/CharacterLanding.tsx`
- Metadata: keep "Character Studio" title on editor pages; `/character` gets `"Characters"`.

**Routes:**

```tsx
// app/character/new/page.tsx (server component)
export const metadata = { title: "New character — PeraByte" };
export default async function NewCharacterPage({ searchParams }: { searchParams: Promise<{ parent?: string }> }) {
  const { parent } = await searchParams;
  return <CharacterStudio mode="new" parentId={parent} />;
}
// app/character/[id]/page.tsx
export default async function EditCharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CharacterStudio mode="edit" characterId={id} />;
}
```

**`CharacterStudio` changes (precise):**
1. Props: `{ mode: "new" | "edit"; parentId?: string; characterId?: string }`. Delete `Phase`'s `"landing"`; initial `phase = "wizard"`; delete the landing JSX block + `CharacterLanding` import + `onStart` flow (`startWizard` becomes `useEffect` init).
2. Init effect: `mode === "edit"` → wait `charactersReady`; character = `getCharacter(characterId)`; missing → render `EmptyState` "Character not found" + back-to-library `LinkButton href="/character"`. Found → prefill `spec` (sanitized), `saveName`, `tags`/`favorite` local state; `mode === "new"` with `parentId` → prefill from parent (missing parent → toast "Parent character not found — starting fresh" once).
3. Ready-step actions: edit mode → `Save changes` (`updateCharacter(characterId, { name: saveName, spec, tags, favorite })` + toast; disabled while saving) + secondary `Save as copy` (`addCharacter(saveName + " (copy)", spec, primary?.url)` → navigate to the copy). New mode → existing `handleSaveCharacter`, extended with `parentId` + asset tagging (below).
4. `handleSave` (asset): add `characterIds: [characterId]` (edit) to `meta` when known; track `lastSavedAssetId`.
5. `handleSaveCharacter` (new mode): `addCharacter(saveName, spec, primary?.url, { parentId: parentId ?? undefined })`; then if `lastSavedAssetId` → `updateAsset(lastSavedAssetId, { meta: { ...meta, characterIds: [character.id] } })`.
6. Ready step adds **Renders strip** (when an id exists): horizontal scroll of `useAssets()` filtered `meta.characterIds` includes id — each `MediaFrame ratio="4/5" w-[104px]`, click = download; button `Set as thumbnail` per item → `updateCharacter(id, { thumbnail: url })`.
7. Repoint the "Open in History →" link (`CharacterStudio.tsx:533`) → `/images`.
8. Keep everything else (steps, preview panel, LoRA row, generating/ready phases) untouched.

**`CharacterLibrary` (new page component):**
- State: `query, sort ("newest"|"name"), favouritesOnly, activeTags, familyId, manage, selected, dialogs (rename/delete/tag/menu id)`.
- Data: `useCharacters()` + `useSettings()` (cast ids) + `useToast()` + `useRouter()`.
- Shell: title "Characters", caption `${count} characters · ${favourites} favorites`, CTA `LinkButton href="/character/new" icon="plus"` "New character".
- Filters row: tag chips (`collectCharacterTags`) + family chip when any row has children (`Family: {parent.name} · {n}`); toggling `familyId`.
- Grid: `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3` — first cell dashed "+ New character" tile (`border-2 border-dashed`, hover `border-primary`), then cards:
  - `Card` wrapper, `MediaFrame ratio="4/5"` thumbnail (letter-tile fallback: `bg-surface-2` + first letter), star button top-left (`text-warning` when on), `⋯` menu top-right (copy History's `MenuItem` pattern), manage-mode checkbox replaces star (History's circle-checkbox classes).
  - Below: name (truncate, bold), lineage badge when `parentId` (`↳ {parentName}` via lookup, fallback "Variation"), ≤2 tag chips + `+n`, `formatDate(updatedAt)`, where-used dots (`castUsage`) as tiny "Solo"/"Story" badges.
  - Click → `/character/{id}` (not in manage mode; checkbox toggles there).
  - Menu: Open · Rename (`PromptDialog` → `updateCharacter(id, {name})`) · Duplicate (`cloneForDuplicate` → `addCharacter`-equivalent: `addCharacter(c.name, c.spec, c.thumbnail, {...})` — implement via direct `addCharacter(name, spec, thumbnail)` after computing the copy name) · Create variation → `router.push(/character/new?parent=${id})` · Add to Solo cast / Story cast (`setSoloCharacters([...ids, id])` when `!usage.solo`; cap `MAX_SCENE_CHARACTERS` → toast "Solo cast is full (3)") · Add tag (`TagEditorDialog` → `updateCharacter(id, {tags})`) · Delete (`ConfirmDialog`, body lists where-used + "deleting detaches it from Solo/Story casts"; on confirm `removeCharacters([id])` + cast detach + delete children? NO — children keep dangling parentId per spec).
- Manage bar: `Favorite` (bulk `updateCharacter` loop), `Add tag` (union onto selection via dialog), `Delete (n)` (ConfirmDialog with where-used summary + detach), `Done`.
- Empty states: none → EmptyState icon "character" + CTA; no match → clear filters; store error → retry (store exposes `ready` only — treat `ready && characters.length===0 && !query` as empty).

- [ ] **Step 1:** routes + `CharacterLibrary` + `CharacterStudio` changes; delete `CharacterLanding`. **Step 2:** `npx tsc --noEmit` + `npx vitest run` green (update any test importing `CharacterLanding` — none known). **Step 3: Commit** — `git commit -am "feat(characters): /character library page + /character/new + /[id] wizard routes; delete marketing landing"`.

---

### Task 7: Wizard variation flow polish (fold into Task 6 review; separate commit only if non-trivial)

- Verify end-to-end: vary → child saved with `parentId`; child card shows lineage badge; family chip filters; `Save as copy` works; renders strip tags assets; set-thumbnail persists after reload.

---

### Task 8: Images library + History retirement

**Files:**
- Create: `app/images/page.tsx` (server, metadata "Images & videos — PeraByte") + `components/library/ImagesLibrary.tsx` ("use client")
- Delete: `app/history/page.tsx`
- Modify: `components/SiteChrome.tsx` (nav + footer), `app/not-found.tsx`, `app/page.tsx`, `app/results/page.tsx` ×2
- Modify: `next.config.ts` (redirect)

**`ImagesLibrary`:**
- Data: `useAssets()`, `useToast()`. State: `MediaLibraryState` + `manage/selected/dialogs`.
- Grid: masonry — `columns-2 sm:columns-3 lg:columns-4 xl:columns-5 gap-3` ; card = `mb-3 break-inside-avoid`. `MediaFrame` with native ratio: pass `ratio` from `asset.settings.aspect` mapping (`"16:9"→"16/9"`, `"9:16"→"9/16"`, etc.; fallback `"1/1"`), `sensitive={isSensitiveAsset(asset)}`; video: duration badge (from `settings.duration`) + small play glyph overlay.
- Card ops (History's menu pattern): Open (`/results?id=`) · Download · Favorite · Reuse prompt (`/generate/{image|video}?prompt=&style=&aspect=` — History's exact URL) · Copy prompt · Add tag (`meta.tags`) · Delete.
- Manage bar: Favorite / Add tag / Delete (n) via `removeAssets` + `ConfirmDialog`. Tag save: `updateAsset(id, { meta: { ...asset.meta, tags: next } })`.
- Empty: none → "Generate your first image" CTA → `/generate/image`; no match → clear.

**History retirement:**
1. `SiteChrome.tsx`: `PRIMARY_NAV` → Home · Generate · Story · Character · **Images (`/images`, icon "image")** · **Stories (`/stories`, icon "story")** (History removed). `isActive`: exact/`/story/`-prefix match for `/story` (so `/stories` doesn't light it), `startsWith` for `/stories`. Footer link line 342 → Images.
2. `next.config.ts`:

```ts
async redirects() {
  return [{ source: "/history", destination: "/images", permanent: true }];
}
```

3. Repoint: `not-found.tsx:23` → `/images`; `app/page.tsx:38` bento card → `/images` (retitle to "Images & videos" / keep icon); `results/page.tsx:57,118` "view all" → `/images`; `CharacterStudio.tsx:533` already done in Task 6.
4. `grep -rn '"/history"' app components lib` → zero hits.

- [ ] **Step 1:** implement. **Step 2:** `npx tsc --noEmit` + `npx vitest run` green; grep clean. **Step 3: Commit** — `git commit -am "feat(library): /images masonry library; retire History (nav, redirect, links)"`.

---

### Task 9: Stories library

**Files:**
- Create: `app/stories/page.tsx` (metadata "Stories — PeraByte") + `components/library/StoriesLibrary.tsx` ("use client")
- Test: extend `lib/library-selectors.test.ts` (`duplicateStoryAsset` covered in Task 4)

**`StoriesLibrary`:**
- Data: `useAssets()` filtered via `selectStories`. Grid: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`, 16:9 `MediaFrame` cover (`storyCover`) + progress line `{done}/{total} scenes` + live `Badge tone="warning"` "Generating…" when `storyProgress().live` + favorite star + `⋯` menu.
- Ops: Open (`/story?id=`) · Rename (`PromptDialog` → `updateAsset(id, { title })`) · Duplicate (`duplicateStoryAsset` → `addAsset(copy)` + toast) · Favorite (`toggleFavorite`) · Add tag · Delete (`ConfirmDialog`: "This deletes the story and its scene record…").
- CTA: "New story" → `/story`. Search/sort/favourites/tags/manage identical shell wiring.

- [ ] **Step 1:** implement. **Step 2:** tsc + suite green. **Step 3: Commit** — `git commit -am "feat(library): /stories cover-card library (open/rename/duplicate/favorite/delete)"`.

---

### Task 10: Verification + GUI smoke

- [ ] `npx vitest run` → all green; `npx tsc --noEmit` clean; `npm run build` succeeds (catches the dynamic-route/redirect wiring).
- [ ] Browser smoke against `:3100` (`npm run dev` in the worktree — note: single-server lock, stop other dev servers first):
  1. `/character`: grid renders migrated rows; create → appears; vary → wizard prefilled, save → child with "↳" badge; family chip filters; rename/duplicate/tag/favorite/add-to-cast work; edit `/character/[id]` → change spec → Save changes → reload persists; renders strip set-thumbnail persists; delete → confirm shows where-used, cast detached.
  2. `/images`: masonry, kind chips, search, reuse-prompt URL prefills generator, manage bulk delete.
  3. `/stories`: covers + progress; duplicate → copy with done scenes intact, others reset; rename persists; delete works.
  4. `/history` → 308 to `/images`; sidebar: `/story` and `/stories` highlight correctly; dark mode spot-check (tokens flip, no white patches).
  5. Migration: seed legacy `perabyte.characters.v1` in a fresh profile → rows appear once, flag set, no dupes on reload.
- [ ] Fix anything found; final commit; report.

**Merge:** user reviews the branch (no self-merge — per convention the user merges after review).
