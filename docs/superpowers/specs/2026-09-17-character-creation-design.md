# Character creation v2 — two modes + in-page character sheet

Date: 2026-09-17 · Branch: `feat/character-creation` (stacked on `feat/studio-libraries`)

## Problem

Character creation is a rigid 4-step wizard that renders once and swaps the whole
page to a "generating → ready" sequence. The user wants:

1. **Simple mode** — create a character directly from one prompt, no wizard.
2. **Detailed mode** — the full configuration wizard, kept.
3. A **right-side character sheet** that renders multiple views (face, chest,
   hip, butt, full front, full back) like a character design sheet.
4. **In-page rendering** — renders appear in the panel on the same page; any
   view can be re-rendered in place, in both modes. No navigation, no phase swap.

## Design

### Modes (left column, `/character/new` + `/character/[id]`)

A segmented **Simple | Detailed** toggle sits above the workspace. Both modes
share the same `spec` state and the same right-side sheet panel; switching keeps
the prompt and completed renders.

- **Simple** (default): a large prompt textarea, example chips and an art-style
  select — nothing else. The spec sets `freeform: true`, so the user's prompt IS
  the identity: renders use the raw prompt and character reuse composes the
  prompt (not the defaulted anchor fields) into Solo/Story scenes.
- **Detailed**: the existing 4-step wizard (Character → Appearance → Advanced →
  Review) unchanged except that Review's "Generate" triggers the sheet batch and
  its knobs (model, aspect, resolution, LoRAs) feed the sheet renders.
  Switching to Detailed clears `freeform` — the composed anchor becomes valid
  again as the user tunes real fields.

### Character sheet panel (right column, both modes)

Six fixed views in `SHEET_VIEWS` order:

| View       | Framing                                          | Aspect |
| ---------- | ------------------------------------------------ | ------ |
| Full Front | standing front view, head to toe, design-sheet    | 9:16*  |
| Full Back  | standing back view, seen from behind, head to toe | 9:16*  |
| Face       | close-up portrait of the face                     | 1:1    |
| Chest      | close-up of the chest and torso                   | 1:1    |
| Hip        | close-up of the hips and waist                    | 1:1    |
| Butt       | close-up rear view of the hips and butt           | 1:1    |

\* full views use the Review step's aspect (default 9:16); closeups are always 1:1.

**Rendering** (`requestGeneration`, durable jobs — survives navigation):

- `Render sheet` renders views **sequentially**, one job each (`count: 1`).
  Full Front goes first; every other view chains off it — `startImageRef` set to
  the front view's media-cache ref and the prompt prefixed "same character as
  the reference image" — so all views depict the same person (Sogni/apikey-fan
  image models support img2img today; Pollinations degrades to text-only).
- If the front view fails, the batch stops with a per-tile retry.
- Per-view solo render (and re-render) chains off the existing front view when
  one exists. Renders always use the *current* spec — tweak anything and
  re-render, in place.
- Safety follows the global Uncensored Mode gate exactly like the old flow
  (`characterGenerationSettings` semantics: safe flag, negative prompts, count 1).
- Batch progress: per-tile skeleton + "Rendering view k of n" on the batch
  button, which turns into Cancel while a batch is running.

**Save cluster** (enabled once ≥1 view is done, in the panel):

- Name field + **Save character** (new; variation when parented) — poster
  thumbnail = Full Front.
- Edit mode: **Save changes** persists spec+name back; **Save as copy** branches.
- **Save to library**: one asset — poster = Full Front, `variants` = completed
  views in `SHEET_VIEWS` order, `meta.sheetOrder` recording the view ids so the
  panel can restore the latest sheet on edit-mode open, tagged `characterIds`.
- **Download** downloads the focused tile.

Mobile: the panel collapses to a fixed bottom bar ("Sheet 2/6") expanding into
the existing bottom-sheet drawer pattern.

### Character detail page (`/character/[id]`)

Saved characters land on a **detail page**, not the wizard (the wizard moved to
`/character/[id]/edit`):

- **Poster** (thumbnail or front view) with download; **character sheet** grid
  restoring the latest saved sheet (`meta.sheetOrder` + `variants`), each view
  downloadable and promotable to poster; **renders** — every asset tagged
  `characterIds`, newest first, each linking into the `/results?id=` viewer for
  its full render details.
- **Specifications** column: the whole spec (identity rows in Detailed mode,
  "Prompt-only" badge in Simple/freeform), personality, and the raw prompt.
- **Actions**: **Edit** (wizard, loads in the character's own mode),
  **Copy** (instant duplicate via `cloneForDuplicate`, navigates to the copy),
  **New generation** (`/character/new?parent=id` — seeds a re-configurable
  copy), and Modify & re-render. Delete/rename/favourite/cast stay in the
  library; card links open the detail page, the card menu gains an explicit
  "Edit & re-render" entry.

## Removed

The full-page `generating` and `ready` phases of `CharacterStudio` are deleted —
their jobs (progress, failure, save, download, renders strip) move into the
panel. The per-tile poster action ("set as thumbnail") replaces the renders
strip.

## Server impact

None. Verified on `feat/studio-libraries`: `/api/jobs` accepts `startImageRef`
for `kind: "image"`; Sogni image descriptors already carry
`frameInput: { start: true }` and map to `startingImage`; apikey-fan supports
image i2i; Pollinations ignores frames (warn + text-only fallback).

## Files

- `lib/character.ts` — `SheetView`/`SHEET_VIEWS`, `composeCharacterBody` export,
  `composeSheetPrompt(spec, view, chained)`, `characterSheetSettings(...)`,
  `freeform?: boolean` on `CharacterSpec` honored by the compose functions and
  passed through by `sanitizeSpec`.
- `components/character/CharacterSheetPanel.tsx` — new; owns per-view status,
  batch orchestration, save cluster presentation.
- `components/character/CharacterStudio.tsx` — mode toggle, Simple editor,
  panel wiring; wizard/generating/ready phases collapse to the two-mode layout.
- `components/character/CharacterSteps.tsx` — Review step copies ("Render
  character sheet"); everything else untouched.

## Testing

- `lib/character.test.ts`: sheet prompt composition (framing per view, chaining
  prefix, freeform identity), sheet settings (count 1, per-view aspect, gate
  semantics), `sanitizeSpec` freeform passthrough, reuse of freeform characters.
- Full `vitest` suite + `next build` + Playwright GUI smoke of both modes
  (render one view with the fallback-free path mocked, save, re-render).
