# Story scene visibility — chain-frame previews, 2-up grid, scene controls — design & plan

Date: 2026-09-16 · Branch: `feature/story-scene-visibility` (worktree)

## Problem

With Continuity on, each queued story scene renders from the previous scene's final
frame — but that frame is resolved at render time and never shown. For video scenes it
is worse than hidden: the card poster shows the **first** frame while the chaining
frame is the **last** frame, so the actual visual anchor of the chain is invisible
everywhere in the UI. The only signals today are text ("Waiting for Scene 2", a small
link icon), which reads as "no visibility of what's actually happening" while a story
generates.

Two further friction points on the same screen: 3 scene cards per row leaves each
preview small, and scenes are frozen once added (prompts can't be corrected, a bad
completed scene can only be re-rendered by re-running failed/canceled scenes via
Generate, and order can't be changed).

## Decisions (approved)

1. **Corner-thumb chain reference badge** (of three placement options) — a ~52px
   thumbnail + label overlaid bottom-left inside queued and rendering scene cards;
   click the thumb to enlarge. Chosen over a strip under the card (extra height on
   every chain scene) and click-to-inspect-only (fails the at-a-glance goal).
2. **2 cards per row** instead of 3.
3. **Extras included**: inline prompt editing (queued/canceled scenes), per-scene
   re-run (completed/failed scenes), scene reorder (up/down arrows).

## Behavior

### A. Chain reference badge

- New pure helper `effectiveChainRef(scenes, index, continuityOn)` in
  `lib/story/chain.ts`. It reuses the same predecessor rule as the runner by moving
  `chainPredecessor` there (single source of truth; the runner imports it back).
  Resolution order:
  - `manual` — the scene's own `startImageRef` (uploaded or from conversion) →
    thumb + "Your start frame".
  - `chained` — the nearest non-canceled predecessor is completed with a derived
    `endFrameRef` → thumb + "From Scene N".
  - `pending` — the scene will chain but the frame doesn't exist yet: the
    predecessor is queued/generating, or completed without a derived frame
    (backfill is attempted at the next schedule) → pulsing link icon + "Scene N's
    last frame". The existing
    center "Waiting for Scene N" pill stays as the status; the badge label
    complements it rather than duplicating it.
  - `none` — scene 1, Continuity off, or prompt-only degradation → nothing rendered.
- Rendered as a bottom-left overlay inside the card's `relative` container on
  **queued and generating** scenes (generating: below the centered RenderProgress,
  no conflict with the top-right cancel button). Completed scenes don't get one —
  their own media is visible and successors carry the badge.
- Thumb src is `/api/media?f=<ref>`; click opens a full-screen fixed overlay with
  the image contained (same overlay pattern as `ConfirmDialog`/`StoryPlayer`;
  click/Esc closes). This matters most for video chains: the enlarged frame is the
  only way to see the actual last frame, which no card ever displays.
- 18+ veil: when the source scene has `safe === false`, the thumb renders blurred
  (same policy as `MediaFrame`) and the enlarged overlay shows the masked image.
- Image stories: the chaining ref is the predecessor image itself — the badge still
  renders (it makes the chain explicit), thumb identical to the predecessor card.
- Converted stories: clips carry `startImageRef`, so every clip shows "Your start
  frame" with its anchor image — the convert flow gains the same visibility.
- Live: the badge derives from store state, so when a predecessor completes and its
  end frame derives, successors' badges flip from `pending` to the real frame
  automatically — the "what's happening" moment becomes visible mid-run.

### B. Grid

- `sm:grid-cols-3` → `sm:grid-cols-2` on the scenes grid; the empty-slot floor
  drops from `Math.max(3, scenes.length)` to `Math.max(2, …)`. Max 6 scenes
  unchanged (now 3 rows max). Mobile stays 1 column.

### C. Inline prompt editing

- Queued and canceled scenes: click the prompt line → inline textarea (autofocus),
  commit on blur or ✓, Esc cancels. `PROMPT_MAX` enforced; an empty prompt is
  rejected with the composer's validation copy (an empty scene can never render).
- Safe by construction: the runner re-reads the store when a scene starts, so edits
  land as long as the scene hasn't begun. Generating/completed prompts stay
  immutable (a completed scene's prompt is the historical record of what rendered).

### D. Per-scene re-run

- A hover refresh button on completed and failed scene media requeues **only that
  scene** via a new runner method `requeueScene(storyId, sceneId)` (patch status →
  `queued` + `schedule()`; deliberately not `start()`, which would also reset
  unrelated canceled/failed scenes).
- Run in flight → the scheduler picks the scene up after the current one settles
  ("Scene N re-queued — it renders after the current scene."). Story idle → it
  waits for Generate ("Scene N re-queued — press Generate to render it."),
  preserving the Generate-is-the-only-trigger rule.
- Later scenes keep their current results (same chain semantics as cancel). The
  button title says so.

### E. Reorder

- Up/down arrows on the right side of each scene card's label row swap it with the
  adjacent scene in the store. Disabled while any scene is generating and at the
  first/last position. The chain follows automatically (everything is index-based,
  canceled scenes transparent).

## Files

- `lib/story/chain.ts` — `chainPredecessor` moves here; new `effectiveChainRef`.
- `lib/story/runner.ts` — imports the shared `chainPredecessor`; adds `requeueScene`.
- `lib/story/chain.test.ts`, `lib/story/runner.test.ts` — new coverage.
- `components/story/SceneChainBadge.tsx` — new (badge + enlarge overlay).
- `app/story/page.tsx` — grid columns, badge wiring, inline edit, re-run button,
  reorder arrows.

## Test plan

1. `chain.test.ts` — `effectiveChainRef`: manual ref wins; chained from a completed
   predecessor's `endFrameRef`; pending when the predecessor is queued/generating or
   completed without a frame; canceled predecessor skipped (chains across it);
   continuity off → none; index 0 → none.
2. `runner.test.ts` — `requeueScene`: patches a queued/completed/failed scene and
   schedules; no-op for a generating or unknown scene; does not touch other
   canceled/failed scenes; mid-run pickup after the current scene settles.
3. Full suite + typecheck + build.
4. Browser pass with a `/api/generate` route spy (fake NDJSON, no real renders):
   badge states across the queue lifecycle (pending → chained → live flip),
   thumb enlarge + veil blurring, prompt edit round-trip, re-run toast + pickup,
   reorder updates chain targets, 2-column layout with ≥2 scenes, mobile 1-column.

## Out of scope

- Results page scene grid (same treatment could follow later).
- Regenerate-downstream (re-rendering successors after an upstream re-run).
- Drag-and-drop reordering (arrows only for this pass).
