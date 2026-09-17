# Story Scene Edit — design

Date: 2026-09-17
Status: approved (user approved the presented design; full per-scene settings set)

## Problem

Story scenes carry only a prompt, kind, and frame refs. Model, aspect, style,
duration, LoRAs, resolution and negative prompt are story-level: the only way
to change them for one scene is to change them for every scene. The user wants
to click a queued scene, see its settings in the left composer, tweak them, and
update just that scene.

## Interaction

- Clicking a **queued**, **canceled**, or **failed** scene tile puts the left
  composer into **scene edit mode**:
  - The composer loads the scene's prompt, kind, frames, and settings (scene
    overrides merged over story settings — the shown state is what renders).
  - The composer header badge becomes "Editing scene N".
  - The top-right story kind Segmented hides; a kind toggle for **this scene**
    renders in the edit context instead.
  - **Add scene** hides (it would commit the wrong buffer); Continuity and the
    chain-model pill stay (story-level controls).
  - Cast picker, Variations, and Lock seed hide — cast is story-level;
    variations/seed never applied to story scenes (runner forces `count: 1`,
    sends no seed). Negative prompt and Copy prompt stay.
  - Generate becomes **"Update scene"** (⌘+Enter triggers it), next to an
    explicit exit button. Escape and clicking the selected tile again also
    exit (without saving).
- **Update** saves prompt + kind + settings overrides + frames to the scene,
  exits edit mode, and **restores the stashed composer draft exactly as it
  was** — editing a scene never destroys an unsaved draft.
- A **failed** scene's Update also re-queues it (save + retry in one step).
- Works **mid-run**: the runner reads a scene's settings when it starts
  rendering, so a queued scene can be retuned while an earlier one renders.
  Update is disabled only while the selected scene itself is generating.
- Changing the model in edit mode writes the **scene's** override — it must
  not call `setSelectedModel` (the global saved pick).

## Data model & render semantics

- `StoryScene.settings?: Partial<GenerationSettings>` — **sparse overrides**:
  only fields actually changed during the edit session are stored. Fields not
  overridden keep following story-level settings at render time. Scenes never
  edited (writer-split, add-scene) render exactly as today.
- Override computation on Update: diff the edit buffer against the baseline
  snapshot taken when edit mode was entered (the merged view). Touched keys
  are pinned (recorded even when equal to the story value); untouched
  pre-existing overrides persist; an empty result removes `scene.settings`.
- Server runner builds each scene request from
  `{ ...story.settings, ...scene.settings }`. The chain rule is unchanged:
  with a start ref and `chainModelId` set, the chain model wins; with Auto,
  the merged `modelId` applies and the existing family i2v sibling swap
  handles frame capability.
- Tiles render with the scene's effective aspect and duration
  (`scene.settings?.aspect ?? story aspect`), so an override is visible in the
  grid, progress skeleton, and video stage.

## Server changes

- `SceneMutation` gains `{ op: "update"; sceneId; patch }` where patch carries
  `prompt?, kind?, settings?, startImageRef? (null clears), endImageRef?
  (null clears), runPrompt?`.
- `mutateStoryScenes` "update": guards — story exists, scene exists, scene
  status ∈ {queued, canceled, failed} (never generating/completed). Prompt
  clamped to `promptMaxChars`. `settings` stored as given; empty object drops
  the field. Ref `null` clears the ref.
- The client always sends a recomposed `runPrompt`
  (`composeSceneWithCharacters` with the current cast) on prompt changes so a
  mid-run chain never renders a stale composed prompt.
- On Update for a failed scene the client also calls the existing
  `rerun` action after the mutation lands.

## Composer changes

`PromptComposer` gains small optional props — no structural rewrite:

- `actionLabel?: string` — footer action button label (default "Generate");
  the page passes "Update scene" in edit mode. The ⌘+Enter hint follows it.
- `hideRenderCount?: boolean` — hides the Variations pill and the
  Variations + Lock seed rows in AdvancedPanel (negative prompt stays).

Page-level (story page) state:

- `selectedSceneId` + edit buffer (`prompt`, `settings`, `kind`, refs,
  entry baseline). Entering stashes the live draft; exiting restores it.
- Model change in edit mode writes the buffer (with the same
  `snapLorasForModel` snap the composer path applies), never
  `setSelectedModel`.
- Enhance works in edit mode against the scene buffer (sceneIndex = the
  scene's index).

## Edge cases

- Scene deleted while selected (other tab) → selection clears, draft restored
  (poll effect detects the missing id).
- Story deleted (404) → existing reset path clears selection.
- "New story" reset clears selection and the buffer.
- The tile inline prompt editor is hidden for the scene currently open in the
  composer — one editor per scene at a time.
- Update clicked after the scene flipped to generating → refused client-side
  (button disabled) and guarded server-side.

## Out of scope

- Per-scene characters (different cast per scene) — cast folds into prompts
  at Generate and stays story-level.
- Per-scene chain-model pill override (the merge supports `chainModelId` in
  `scene.settings`, but no UI sets it in v1).

## Testing

- `server-runner.test.ts`: update-op guards (generating/completed refused;
  queued/canceled/failed accepted), prompt clamp, ref clearing, settings
  stored/emptied; `sceneRequestBody` merge (scene aspect/duration/model
  override; `chainModelId` precedence over a scene model when a start ref
  exists; scene model applies under Auto).
- Story GUI smoke: select queued scene → composer shows "Editing scene N" →
  change aspect → Update → tile ratio changes and the record carries
  `scene.settings`; failed-scene save + requeue.
