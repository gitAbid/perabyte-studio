# Frame Dock — first / last / reference frame upload UX

Date: 2026-09-17
Status: approved-by-directive (user asked for the redesign; autonomous session)

## Problem

1. **Solo mode has no frame UI at all.** The pipeline fully supports frames —
   `requestGeneration` accepts `startImageRef`/`endImageRef`, the service
   validates + auto-swaps to i2v siblings, every provider maps them — but
   `/generate/video` and `/generate/image` never send them. The capability is
   invisible.
2. **Story mode's "Scene frames" strip is disconnected.** It sits *below* the
   composer as two small dashed 16:9 slots with a cryptic caption ("optional;
   a start frame overrides chaining"). It reads like a stray settings widget:
   tiny targets, no drag/paste, no way to reuse an existing render, the end
   slot appears/disappears with model capability (layout jumps), and nothing
   explains what each slot does to the scene.

## Design

Frames are **content, not settings** — they belong inside the prompt box,
where the scene is authored (like cast chips). One shared component, the
**FrameDock**, serves Solo and Story.

### Placement

A slim row **inside the tinted prompt surface**, bottom-left; the Enhance
button stays bottom-right:

```
┌──────────────────────────────────────────┐
│ Describe the scene…                      │
│                                          │
│ [＋ First frame] [＋ Last frame]  ✨Enhance│
└──────────────────────────────────────────┘
```

### States

- **Empty slot**: dashed pill `＋ First frame` / `＋ Last frame` (video) /
  `＋ Reference image` (image). Click → file picker.
- **Filled**: h-8 pill thumbnail (object-cover), hover dims it and reveals a
  centered ✕ (remove); click anywhere else = replace. Tooltips name the slot.
- **Busy**: clock icon pulses on the uploading slot; other slots stay usable.
- **Drag & drop** an image onto the dock → fills the first empty slot (dock
  tints while hovering). **Paste** (⌘V) an image anywhere while the composer
  is mounted → first empty slot. Text pastes are untouched.

### Model-aware slots

- Video: First frame always (model takes it or auto-swaps to its i2v
  sibling); Last frame only when `frameInput.end`.
- Image: single Reference image slot (`startingImage` = img2img on every
  provider that declares it; the dock hides entirely when a model declares
  no frame input).

### Smart hints (one muted line under the prompt surface, only when useful)

- Story, video, continuity ON, first frame set: "This scene starts from your
  image — the chain continues from here." (makes the override explicit)
- Solo video, first frame set, model needs the i2v swap: "Renders on {label}
  — picked automatically for frame control."
- Solo image, reference set: "Your image guides composition and style."

### Solo wiring

- `GeneratorScreen` owns `frames { startImageRef?, endImageRef? }`, passes
  them to `run()` (plumbing already exists) and keeps them across renders for
  iteration.
- Completed result gains an overlay action: **Use as first frame** (video) /
  **Use as reference** (image). It reuses the media-cache ref from the result
  URL when cache-backed (`refFromMediaUrl`), else fetches + uploads the blob.
  Toast confirms.

### Story wiring

- The "Scene frames" strip and `SceneRefChips` are removed. The dock is
  rendered by `PromptComposer` via optional props, bound to `draftRefs`
  exactly as today (committed with the next Generate / Add scene).
- Scene tiles keep their existing `start`/`end` mini-badges.

## Files

- NEW `components/FrameDock.tsx`
- `components/PromptComposer.tsx` — optional `frames`/`onFramesChange`/
  `frameEndSupported`/`frameNote` props; dock row in the prompt surface.
- `components/GeneratorScreen.tsx` — frames state, overlay action, swap note.
- `app/story/page.tsx` — drop the strip, wire dock props, override hint.
- DELETE `components/story/SceneRefChips.tsx`.

## Non-goals

- No per-scene frame editing on tiles (composer authors the draft scene only,
  as today). No lightbox preview. No library picker for frames.

## Verification

- `npm run typecheck`, `npm test`, `npm run build`.
- GUI smoke on :3100 — attach/replace/remove via picker + drop on both Solo
  video and Story; overlay "use as frame" flow; slot visibility follows the
  model's `frameInput`.
