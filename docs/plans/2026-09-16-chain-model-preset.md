# Chain-model preset (t2v + i2v pairing) — design & plan

Date: 2026-09-16 · Branch: `fix/story-model-jump` (builds on c919147, the visibility fix)

## Problem

With Continuity on, chained story scenes must render on a frame-capable model. Every
Sogni video family ships that capability on a separate `_i2v` workflow variant, so the
service silently swapped chained scenes to it while the picker kept claiming the t2v
pick — experienced as "the story jumps between models". The swap itself is correct
(Sogni rejects i2v renders without a reference image, so the sibling can never render
scene 1); what was missing is making the pairing a **first-class, visible, overridable
preset**.

## Decisions (approved)

- **Chain pill in the story composer** (next to Continuity), per story — not a global
  Settings entry. Appears only for video stories whose picked model can't take a start
  frame (Seedance/Grok picks are self-chaining → no decision → no pill).
- **Auto is the out-of-the-box default**: Auto = the picked model's family i2v sibling,
  resolved live from the catalog. Implemented by leaving `chainModelId` unset, which
  keeps the existing server-side capability swap as the Auto path (battle-tested,
  legacy stories and solo untouched).
- **Override stores `chainModelId` on the story settings**; the runner sends it as the
  per-request `modelId` for frame-carrying scenes (chained or manual start frame). No
  new render-API surface.
- Runner-side per-scene choice (approach 1 of 3 considered); client-resolves-everything
  and server-API-field approaches rejected (loses server fallback / needless API
  surface).

## Behavior

| Scene | Model used |
|---|---|
| Scene 1, no start frame | picked model (`settings.modelId`) |
| Frame-carrying (chained or manual start) | `settings.chainModelId` when set, else picked model → server swaps to family i2v |

- Chain pill label: `Auto · <sibling label>` (or `Auto · none` when the family has no
  i2v — chained scenes then degrade to prompt-only, existing warning applies).
- Options: every start-frame-capable video model across providers (hidden i2v siblings
  included, Grok/Seedance included). `flf2v` variants excluded — they require both
  frames and a chained scene has only a start.
- Switching the Model pill to a self-chaining model hides the Chain pill and clears the
  override. A stale override (model gone from the catalog) drops to Auto at Generate
  instead of failing the run.
- Generate toast names the effective chain model (Auto or override).
- Scene tiles stay truthful: override path records the chain model id on the scene
  (chip label resolved from the start-capable catalog); server-swap path keeps
  `effectiveModelLabel`.

## Catalog changes (all families pair)

- `i2vSiblingId` also maps dashed vendor families: `happyhorse-1.1-t2v` →
  `happyhorse-1.1-i2v` (alongside `_t2v` → `_i2v`).
- Cold-start curated WAN 2.2 LightX2V and LTX 2.5 entries get explicit
  `i2vModelId` links (targets already registered in `COLD_START_HIDDEN`) so the
  pairing works before Sogni's live catalog warms. Sibling existence is always
  verified against the catalog — no ghost selections.

## Test plan

1. `catalog.test.ts` — dashed + underscore sibling mapping, null otherwise.
2. `model-meta.test.ts` — cold-start WAN/LTX descriptors carry `i2vModelId`; Seedance doesn't.
3. `runner.test.ts` — chained scene uses `chainModelId`; manual-start scene uses it;
   scene 1 uses the pick; chain-path scene records `effectiveModelId`; no
   `chainModelId` → pick sent unchanged (server swap path).
4. Full suite + typecheck + build.
5. Browser pass with a `/api/generate` route spy (fulfilled fake NDJSON — no real
   renders): pill appears with Auto resolved, override sticks, scene 1 body carries the
   pick and scene 2 body carries the override, toast copy correct, chip label renders.

## Out of scope

Solo generator, image stories (image models all take start frames), image→video
conversion (end-capable pick already renders one model throughout).
