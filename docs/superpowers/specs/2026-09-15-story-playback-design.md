# Story Playback — "Play full story" sequential player

Date: 2026-09-15
Branch: fix/story-video-preview (on top of the story-video preview fix)
Status: implemented (autonomous session; decisions recorded below)

## Problem

Story mode renders scenes as separate cards. To watch a finished story you
click through scenes one at a time. The user wants one control that plays
every scene back-to-back, "like an uninterrupted single video".

## Approaches considered

1. **Fullscreen overlay player (chosen).** A dedicated `StoryPlayer`
   component plays scenes back-to-back over a black stage: real mp4s play to
   their natural end and auto-advance; image scenes dwell ~5s with the
   existing `kenburns` motion. Matches the request exactly, works for mixed
   image/video stories, and is one self-contained file.
2. In-grid auto-advancing highlight — rejected: the page scrolls between
   cards; feels like a slideshow, not a film.
3. Server-side concat into one mp4 — rejected: new render pipeline, cache
   and duration math, minutes of latency; YAGNI.

## Design

**Component: `components/StoryPlayer.tsx`** (client). Fullscreen fixed
overlay, `role="dialog"`.

- Props: `scenes: { url: string; mime?: string; label?: string }[]`,
  `sceneSeconds = 5` (image dwell), `onClose`.
- A scene is video when `mime?.startsWith("video/")`, else via
  `isVideoSource(url)` (legacy assets have no mime).
- Playback: `<video>` `onEnded` → next scene; images advance on an
  interval after `sceneSeconds`. Hard cuts, no transitions. Videos play
  muted by default (generated clips are silent); mute toggle available.
- Reaching the end of the last scene stops playback and shows a Replay
  control. Prev/next scene buttons allow manual navigation at any time.
- Chrome: top bar with "Scene i / n" + prompt excerpt + Close; bottom bar
  with one progress segment per scene (current segment fills with elapsed
  time), play/pause, prev/next, mute, fullscreen (same
  `requestFullscreen` pattern as `VideoStage`).
- Keyboard: Esc closes, Space toggles play/pause, ←/→ change scene.
  Body scroll is locked while open.
- A scene whose video fails to load (`onError`) is skipped after a short
  beat rather than stalling the reel.

**Wiring:**

- `app/story/page.tsx` — "Play story" button in the scenes footer
  (next to Download), enabled when at least one scene has media; passes the
  completed scenes in order.
- `app/results/page.tsx` — "Play story" action for story assets with media,
  so saved stories can be re-watched; scenes' mime comes from
  `asset.scenes` when present, legacy assets fall back to URL sniffing.

## Error handling

- No media → buttons hidden, component never mounts.
- Video error → skip scene; the grid/results views still surface the
  broken scene's own retry affordance.
- Fullscreen unsupported (iframe) → button is a no-op via optional call,
  matching `VideoStage`.

## Testing

- Unit: scene classification (video vs image) and ordering logic live in
  pure helpers exported from the component module; vitest covers them
  (mime present, mime absent + .mp4 URL, image URL).
- Browser: mixed story (1 video + 1 image scene) plays through with
  automatic advance; Esc closes; replay works.
