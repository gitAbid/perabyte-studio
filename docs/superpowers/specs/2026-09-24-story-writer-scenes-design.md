# Story Writer scene output and workspace design

## Problem

The Writer's scene outline currently segments draft text locally by prompt
length. This bypasses the existing structured scene-splitting API, so the
configured scene count does not determine the outline and the resulting scenes
are raw prose chunks instead of complete visual prompts. Selected cast names
are sent to the writing model, but the UI only shows a count after the picker
closes. The three workspace panels and preview cards cannot be collapsed.

## Goals

1. Produce a reviewable, consistently structured scene outline from a story
   draft, using the existing writer service and its JSON extraction/retry path.
2. Replace the 1–12 count list with `Smart`, `3`, `5`, `8`, and `12` choices.
   Smart lets the model choose 3–8 scenes from the story beats; a numeric
   choice requests that exact count.
3. Let the user review and expand/collapse scene prompts before creating the
   story asset. Keep the draft intact if splitting or saving fails.
4. Make the Brief, Draft, and Scene outline panels individually collapsible,
   and make each scene card expandable. Use buttons with accessible labels and
   `aria-expanded` state; keep the existing mobile workspace tabs.
5. Show selected character names as visible cast chips and make the writing
   instruction identify those names as available characters to use in the
   story. Preserve the selected character IDs on the saved story so render-time
   identity references continue to work.

## User flow

The user chooses Smart or a scene-count preset in the Brief panel, writes or
generates a prose draft, and requests a scene outline. The client calls the
existing `split` writer action with the selected cast, media kind, and count
mode. The service returns a title and structured visual prompts. The outline
panel shows those prompts as numbered, independently expandable cards. The
user can regenerate the outline or create a story from the reviewed scenes.
Only successful save navigates to Story Mode.

The generated prose remains ordinary editable story text without numbered
scene headings. Smart drafting asks for natural scene breaks; scene numbering
belongs to the outline UI. Existing numeric autosaves remain valid; Smart is
the default for new drafts.

## Architecture

- Extend the pure writer domain contract to represent Smart or a preset and
  build clear write/split instructions for each mode. The Smart split prompt
  requests 3–8 scenes; preset prompts request exactly the selected count.
- Reconnect `WriterView` to `requestWriterAction({ action: "split" })`. Hold
  returned scenes as a reviewable preview and save only after the user chooses
  Create story. Remove the local prompt-length splitter from the export path;
  keep its pure helpers if another consumer still needs them.
- Add disclosure state to the three Writer sections and scene cards. Collapsed
  sections retain their headers and a compact summary; expanding restores the
  existing controls/content.
- Show selected cast names beside the Cast control. Keep the existing cast
  picker and its selection cap/order.

## Errors and compatibility

- On split or save failure, stay in Writer and preserve the draft and any prior
  usable preview. Show the existing inline error/toast affordance.
- Keep support for older local drafts with numeric scene counts.
- No database or story-record schema changes. Saved assets retain the current
  `characterIds` metadata and ordered `scenes` array.

## Verification

- Domain tests cover Smart/preset parsing, instructions, and structured split
  results, including invalid model output and retry behavior.
- Writer UI checks cover the split/review/save sequence, cast visibility, and
  accessible collapse/expand controls for panels and scene cards.
- Run the focused writer tests and project typecheck after implementation.
