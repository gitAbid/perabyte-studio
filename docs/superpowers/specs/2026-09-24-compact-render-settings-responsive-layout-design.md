# Compact Render Settings and Responsive Studio Layout

**Date:** 2026-09-24  
**Status:** Design approved; awaiting spec review

## Context

The shared prompt composer currently shows every render control at once. In the
Story Studio screenshot, this uses several rows in the narrow composer column.
The image/video generator and Story Studio also switch to a fixed-height,
two-column workspace at the `lg` breakpoint (1024px), where the reserved
composer width can leave too little room for the preview or storyboard.

## Design

### Compact render settings

- Keep the model selector visible whenever a model picker is available.
- Replace the always-visible aspect, resolution, style, duration, and
  variations fields with one compact summary row showing the current supported
  values.
- Make that row an inline disclosure. It starts collapsed and expands to the
  existing labeled controls when activated; do not use a modal or popover for
  these primary render controls.
- Keep model-aware filtering and snapping behavior. A model change continues
  to update settings through the existing model-change handler. Options the
  active model cannot accept stay unavailable or hidden according to their
  existing behavior.
- Keep the advanced seed/negative-prompt controls, cast picker, and LoRA picker
  available in their current actions row.
- Adapt the expanded control grid to the composer width so narrow layouts can
  use one column and wider composers can use two.
- Expose expanded/collapsed state and the current summary to assistive
  technology. The disclosure remains keyboard-operable.

### Responsive studio layout

- In Story Studio and the image/video studios, keep the current two-panel
  composition only at `xl` (1280px) and above. Keep the existing fixed-height
  workspace and panel-level scrolling at those widths.
- Below 1280px, stack the composer and storyboard/preview and allow the page to
  scroll naturally. Do not constrain the whole workspace to viewport height in
  this layout.
- Preserve the current order: composer first, storyboard or preview second.
- Keep controls and action buttons within the available width, with no
  horizontal page overflow.

## Interaction and state

The disclosure only changes how settings are presented. It does not change
their values, persistence, generation payloads, or model-switch behavior. Its
initial state is collapsed each time the composer mounts. Opening and closing
it does not reset the prompt or other composer state.

## Scope

Update the shared `PromptComposer` and the workspace layout breakpoints in
`app/story/page.tsx` and `components/GeneratorScreen.tsx`. Do not change
generation APIs, provider behavior, settings persistence, or the Story Studio
storyboard interaction model.

## Acceptance criteria

1. The model remains directly accessible while the other render controls are
   collapsed.
2. The collapsed summary reflects the active supported settings; expanding it
   reveals the current values in the existing labeled controls.
3. Unsupported model options retain their existing filtering/disabled
   behavior, and changing models still snaps settings as before.
4. At widths below 1280px, the composer and adjacent panel stack and the page
   can scroll without horizontal overflow or clipped primary actions.
5. At widths of 1280px and above, the two-panel workspace remains viewport
   fitted, with the panels' content scrolling within the available height.
6. Narrow composers use a control grid that remains readable and operable.

## Review note

The request describes the UI as unresponsive and broken at different screen
sizes. This design interprets that as a responsive-layout problem based on the
attached Story Studio screenshot and the existing breakpoint behavior.
