# Sogni LoRA Controls — Design

Date: 2026-09-15
Branch: `feature/sogni-lora-controls`
Status: approved (Approach A — data-driven LoRA popover, Solo + Story)

## Goal

Let the artist attach Sogni LoRA adapters (style/character/lighting sliders) to
image and video renders from the prompt composer, in **both Solo and Story
mode**, with the control only appearing for models that actually accept LoRAs.
Selections ride the existing `GenerationSettings` → `NormalizedGenerationRequest`
→ provider request-map pipeline; no other provider changes.

Verified API facts (live 2026-09-15, see `docs/sogni-api-guide.md` §8):

- Catalog: `GET https://api.sogni.ai/v1/loras/comfy` — public, no key, cached
  5 min server-side. Response `{ status, data: { loras[], models[], constraints } }`.
- Submit: `projects.create({ …, loras: string[], loraStrengths: number[] })`,
  positionally matched. Max 8 per render. Strengths are bipolar (negative =
  inverse effect, 0 = off); server clamps out-of-range to the LoRA's
  `ui.min`/`ui.max`. Order is significant. Omitting strengths = 1.0 each
  (NOT each LoRA's `ui.default`).
- 25 image LoRAs on the 5 Krea 2 models (incl. our `krea2_turbo_fp8_scaled`);
  7 video LoRAs on 15 MiniMax H3 variants; zero for Wan/LTX/Seedance/Chroma/
  Flux/Z-Image. `ui.nsfw`/`ui.sexual` entries require the Sensitive Content
  Filter off — maps to our Uncensored Mode (`safe === false`).

## Non-goals

- No BYOL (bring-your-own LoRA upload) — not exposed by the Sogni SDK/API.
- No LoRA presets yet (phase 2: presets are just saved `{loraId, strength}[]`
  bundles over the same plumbing).
- No changes to Pollinations / apikey.fan providers.

## Architecture (follows existing layers)

```
/api/models route ──▶ lora-catalog.ts (fetch + 5-min cache)
        │                    │
        ▼                    ▼
 ModelOption.loraCapable   loras: LoraOption[]   (client, one fetch)
        │
 GeneratorScreen ──▶ snap on model switch (drop invalid LoRAs)
        │
 PromptComposer ──▶ LoraPicker (chip → popover, category sections, sliders)
        │
 settings.loras ──▶ runGeneration body ──▶ NormalizedGenerationRequest.loras
        │                                    (stripped when !loraCapable)
        ▼
 sogni/request-maps.ts ──▶ loras[] + loraStrengths[] ──▶ projects.create
```

Story mode needs **no new code path**: `story/runner.ts` already spreads
`story.settings` into `requestGeneration`, so scene renders carry the same
`loras` field automatically.

## Components

### 1. Domain (`lib/domain/models.ts`, `lib/types.ts`)

- `LoraSelection = { loraId: string; strength: number }` (in `lib/types.ts`,
  used by both settings and request types).
- `GenerationSettings.loras?: LoraSelection[]` — optional; absent everywhere
  today keeps old payloads valid.
- `ModelDescriptor.loraCapable?: boolean` — capability flag like
  `stylesSupported`/`uncensored`; absent/`false` = chip hidden.

### 2. Server catalog (`lib/providers/sogni/lora-catalog.ts`, new)

- `fetchLoraCatalog(force?)`: plain `fetch` to `/v1/loras/comfy` (no SDK
  connection needed — endpoint is public), 5-minute in-memory cache
  (mirrors the SDK's contract), returns trimmed client shape:
  `LoraOption = { loraId, name, description, category, modelIds[],
  nsfw, sexual, min, max, default, step, recommendedMin, recommendedMax,
  rangeLabels?, creator? }`.
- Failure → returns `null` (route serves models without the loras block; UI
  hides the chip). Never throws into the request path.

### 3. Wiring (`/api/models` route, `catalog.service`)

- Route awaits `fetchLoraCatalog()` (bounded ~2.5 s like `warmSogniCatalog`;
  stale cache serves otherwise) and appends `loras: LoraOption[]` +
  `loraConstraints: { maxPerRequest }` to the JSON.
- Sogni catalog marks `loraCapable: true` on models present in the catalog's
  `models[]` list; route projects the flag into `ModelOption`.

### 4. Provider (`lib/providers/sogni/request-maps.ts`)

- `SogniImageParams`/`SogniVideoParams` gain `loras?: string[]` +
  `loraStrengths?: number[]`.
- `toImageParams`/`toVideoParams` split `request.loras` positionally. Belt and
  braces at this layer: slice to 8, drop unknown-shaped entries, pass strengths
  through (server clamps range).

### 5. Service normalization (`lib/services/generation.service.ts`)

- Parse `body.loras` leniently (array of `{loraId, strength}`; invalid entries
  dropped, strengths coerced finite). When the resolved model is not
  `loraCapable`, drop `loras` entirely (same pattern as the `safe` flag).
- Clamp count to `constraints.maxPerRequest` (8) as defense in depth.

### 6. Pure helpers (`lib/lora-options.ts`, new — testable core)

- `lorasForModel(catalog, modelId)` — entries whose `modelIds` include the
  model (client-side join is authoritative, same as the SDK).
- `snapLorasForModel(selection, catalog, modelId)` — keep only valid entries;
  used by `GeneratorScreen`'s existing model-switch effect.
- `groupLorasByCategory(entries)` — ordered category sections for the popover.
- `visibleLoras(entries, allowNsfw)` — filters `nsfw`/`sexual` unless
  Uncensored Mode (`settings.safe === false`).

### 7. UI (`components/LoraPicker.tsx`, new; `PromptComposer.tsx` hook-up)

- Pill-row chip "LoRA" — rendered only when `activeModel.loraCapable`
  (mirrors `allowed.aspects.length > 0` gating).
- Chip opens a popover: category sections, one row per LoRA — name + toggle;
  when active, a range slider bound to `ui.min`/`ui.max` (step from `ui.step`,
  default from `ui.default`). Bipolar LoRAs show their `rangeLabels` captions
  (e.g. "Cooler & Darker ↔ Warmer & Golden").
- The pill carries a count badge ("LoRA 2"); selections are removed from the
  popover rows (toggle off). Reorder not supported in v1 (order = add order).
- Nsfw/sexual rows hidden unless Uncensored Mode is on. Max 8 enforced by
  disabling further toggles (tooltip states the cap).
- Styling: existing dark theme, **no focus rings** (tint shift only, per
  workspace convention), native range input styled minimally.

## Error handling

- Catalog fetch fails → chip hidden, renders proceed unaffected.
- Unknown/over-cap LoRA ids at submit → service strips; Sogni would reject
  otherwise. `loraStrengths` omitted when all strengths are exactly 1.0? No —
  always send both arrays; explicit > implicit given the 1.0-vs-default trap.
- Provider errors from Sogni surface through the existing `ProviderError`
  retryable contract unchanged.

## Testing

- `lora-options.test.ts`: model filtering, snap (drops invalid, keeps order),
  nsfw gating, grouping.
- `request-maps.test.ts` (extend): loras split positional, >8 sliced,
  video params include them for H3 models.
- `generation.service` normalization test: non-capable model strips loras;
  malformed entries dropped.
- `lora-catalog.test.ts`: cache hit/miss (fetch mocked), failure → null.
- All existing suites stay green.

## Verification plan

1. `vitest run` + `next build` green in the worktree.
2. Live smoke: `/api/models` shows `loraCapable` on `sogni:krea2_turbo_fp8_scaled`
   and a populated `loras[]`; one real Solo render (krea2 turbo + 1 LoRA)
   completes; story scene render with the same settings carries LoRAs
   (server log line confirms `loras` in the outbound params).
3. Story: queue a 2-scene story with a LoRA selected, confirm both scenes
   render with it and cancel/regenerate still work.

---

# Phase 2 — LoRA Presets (added 2026-09-15, branch `feature/lora-presets`)

One-click looks over the phase-1 plumbing: a preset is a named
`{ id, label, hint, loras: LoraSelection[], mature? }` bundle in
`lib/lora-presets.ts`. No new request fields, no provider changes.

- **UI**: a "Preset" `PillSelect` beside the LoRA pill, rendered under the same
  gate (LoRA-capable model + entries exist). Options: `None` + normal presets
  (group "Looks") + `mature: true` presets (group "Mature") — the mature group
  only appears under Uncensored Mode, same gate as nsfw rows. The active value
  is **derived**, not stored: the preset whose `loras` deep-equals
  `settings.loras`; `Custom` when a non-empty selection matches no preset;
  `None` clears the selection. Hand-tweaking after a preset simply turns the
  value to `Custom` — no state to keep in sync.
- **Mature table (2026-09-16)**: Uncensored (bypass-2 + mystic-x 0.8),
  Uncensored Strong (bypass-3 + mystic-x 0.8), Unlock (bypass-2 only),
  Engine Realism (realism-engine 0.8 + bypass-2; no `krea2-realism` stack),
  Mystic (mystic-x 1), Candid Adult, Raw Amateur, Glamour Nude, Wet Look,
  Aberrant (body-horror + bypass-2). Filter-bypass is unflagged in the catalog
  but mature-gated because it is the actual adult-prompt unlock. Body-shape
  sliders (chest/firmness/nipple/hourglass) stay in the picker, never in presets.
- **Server**: `resolveLoras` additionally drops `nsfw`/`sexual` entries when
  `safe === true` (airtight regardless of client state; nsfw adapters require
  the Sensitive Content Filter off). Filter-bypass is *not* stripped on the
  server — Sogni does not flag it — so the Uncensored Mode UI gate is the
  product control. Edge accepted: a selected mature preset stays visible in
  the pill until re-picked after toggling Uncensored off — cosmetic only;
  flagged adapters are stripped, bypass may still ride if already selected.
- **Scope**: image presets only (Krea 2 ids). Video presets await MiniMax H3
  models in the picker; unknown-id stripping already degrades renamed
  catalog entries gracefully.
- **Tests**: preset schema sanity (unique ids, finite strengths, ≥1 entry),
  matcher (exact / custom / none), mature table (order, bypass pairing,
  no body sliders, Aberrant labelled as horror).
