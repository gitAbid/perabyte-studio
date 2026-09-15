# Model Selection: Curated Tiers + Structured Metadata

**Date:** 2026-09-16
**Status:** Proposed

## Problem

The model pill is a flat ~30–110-row scrollable dropdown with no sense of what to
pick. Verified against the live catalog (2026-09-16, `network=fast`): Sogni exposes
**118 image** and **58 video** models; nearly all land in the picker.

1. **No use-case guidance.** Hints are speed-tier words ("budget", "flagship",
   "4-step"); every un-curated model gets a regex guess from its id
   (`speedHint` in `lib/providers/sogni/catalog.ts`) → most rows read
   "Sogni · standard/fast/quality", which tells the user nothing.
2. **The only grouping is Uncensored vs Sensored** — a content-policy split used
   as navigation. Cost (free vs credits vs key credits), frame input, and LoRA
   capability exist in the data but are invisible in the list.
3. **Provider name renders twice**: hints embed "Sogni · …" and the composer
   appends `providerLabel` again → "WAN 2.2 LightX2V — Sogni · budget · Sogni AI".
4. **Non-drivable models leak into the picker.** `EXCLUDED_ID_PATTERNS` misses
   the audio/reference/utility families: `…_a2v` (audio-to-video),
   `…_ia2v` (image+audio), `flfa2v`, `…_r2v` / `ref2va` (reference image),
   and `birefnet…background_removal` (a utility). The studio cannot drive any of
   these (no audio/reference input) — selecting them produces prompt-only
   requests those workflows reject or misinterpret.
5. **No recommendation signal.** Default = first model in registry order.

Non-goal (explicit follow-up): an "Auto" intent mode ("best quality / fastest /
free" → resolved model). Trivial to add later once tiers exist; not in this spec.

## Design

### 1. Descriptor metadata (`lib/domain/models.ts`)

Three optional fields on `ModelDescriptor` (mirrored onto client `ModelOption`
in `lib/model-catalog.ts`):

```ts
/** Curated placement. Set only on hand-picked models; absent = tail. */
tier?: "recommended";
/** One-line "what it's good for" — second row of the picker entry. */
useCase?: string;
/** Rough cost signal for a compact chip. */
costTier?: "free" | "credits" | "key-credits";
```

- `hint` stays as the short inline qualifier (speed/price), cleaned of provider
  prefixes.
- Absent `tier` → the model renders in the collapsed tail. No "standard/
  advanced" enum — the only distinction that matters is curated vs not.

### 2. Sogni model meta table (`lib/providers/sogni/model-meta.ts`, new)

Exact-id map with longest-prefix fallback for family aliases (same pattern as
the existing `CURATED` map, which it absorbs):

```ts
export function sogniModelMeta(modelId: string): SogniModelMeta | null;
// e.g. sogniModelMeta("ltx25-22b-int8_t2v_distilled")
//   → { tier: "recommended", useCase: "Flagship motion quality, 2–20s",
//        hint: "flagship" }
```

Curated picks (kept small — 6 image, 5 video):

| Model | tier | useCase |
| --- | --- | --- |
| `krea2_turbo_fp8_scaled` | rec | Flagship all-rounder — crisp subjects, fast |
| `z_image_turbo_bf16` | rec | Sharp detail, strong text rendering |
| `flux1-schnell-fp8` | rec | Fast 4-step workhorse |
| `chroma1-hd_fp8_scaled` | rec | Maximum-detail renders |
| `apikey-fan:grok-imagine-image-2.0` | rec | Flagship realism (key credits) |
| `pollinations:flux` (free) | rec | Free fallback, no key needed |
| `ltx25-22b-int8_t2v_distilled` | rec | Flagship motion quality, 2–20s |
| `wan_v2.2-14b-fp8_t2v_lightx2v` | rec | Budget-friendly quick clips, 1–10s |
| `seedance-2-0` | rec | Cinematic vendor model, start-frame capable |
| `seedance-2-0-mini` | rec | Fastest, prompt-only (no style presets) |
| `apikey-fan:grok-imagine-video-1.5` | rec | Flagship realism (key credits), start-frame |

Curated Sogni models are exact-id entries; un-curated live models resolve to
`null` and render unclaimed (prettified label, no use case, tail section). We
never regex-guess a use case.

### 3. Picker hygiene (`lib/providers/sogni/catalog.ts`)

- Extend `EXCLUDED_ID_PATTERNS` with `"a2v"`, `"r2v"`, `"removal"` (covers
  `a2v`/`ia2v`/`flfa2v`, `_r2v`/`ref2va`, and BiRefNet). Verified no false
  positives on drivable ids (`fl2va` does not contain `a2v`; checked against the
  full live list). Unlike i2v/flf2v, they are not registered as hidden
  capability models — the studio has no audio/reference input, so there is no
  swap target to preserve.
- `speedHint` regex guessing is **removed**: un-curated models get no hint.
- `toDescriptors` stamps `tier`/`useCase`/`costTier` from `sogniModelMeta`.

### 4. Provider catalogs

- `apikey-fan/request-maps.ts`: add `tier: "recommended"` + `useCase` on the
  two flagship entries; hints cleaned (`"flagship"`, `"fast · budget"`).
- `pollinations.provider.ts`: `costTier: "free"`, `useCase: "Free fallback —
  no key needed"`.

### 5. Default model resolution (`lib/providers/registry.ts`)

`defaultModel(kind)` returns the first `tier === "recommended"` model in the
merged list (configured providers in registration order); falls back to
`models[0]` as today.

### 6. Picker UI (`components/PillSelect.tsx` + `PromptComposer.tsx`)

`PillOption` gains optional `description?: string` and `badges?: string[]`.
`PillSelect` renders two-line rows (label / muted description) and small
uppercase chips for badges, and gains an opt-in `tail?: { label; options }`
prop that renders a collapsed "Show all N models" section inside the dropdown
(expands in place; state resets on close). Dropdown widened `w-56` → `w-72`.

```
┌──────────────────────────────────────┐
│ MODEL                                │
│ ✓ Krea 2 Turbo           spark cr.   │
│   Flagship all-rounder, fast         │
│   Z-Image Turbo                      │
│   Sharp detail, strong text          │
│   … (4 more recommended rows)        │
├──────────────────────────────────────┤
│ ▸ Show all 104 more models           │
└──────────────────────────────────────┘
```

Model options mapping in `PromptComposer` (and `ConvertDialog`, which shares the
row rendering):

- Group 1 "Recommended": `tier === "recommended"`.
- Tail (via `tail` prop): everything else, subgrouped by provider
  (Sogni AI / apikey.fan / Pollinations).
- Badges per row: `Sensored` when `uncensored === false`; `Free` when
  `costTier === "free"`; `No styles` when `stylesSupported === false`;
  `Start frame` when `frameInput?.start`; `LoRA` when `loraCapable`.
- Hint composition fix: provider label is **not** appended to the hint anymore
  (provider is the tail subgroup; recommended rows show the cleaned hint).
- The Uncensored/Sensored top-level split is replaced by the Sensored chip —
  sensored models are 3 of 118 and already behave differently behind the
  Uncensored Mode toggle; the chip plus tail placement is enough signal.

### 7. Surfaces touched

Solo image/video (`GeneratorScreen` → `PromptComposer`), Character studio
(uses `PromptComposer`), Story conversion dialog (`ConvertDialog`), and the
`/api/models` payload (fields pass through). Settings per-model toggles are out
of scope.

### 8. Errors & edge cases

- Catalog unreachable → pill hides exactly as today; no behavior change.
- A recommended model's provider is disabled/key missing → it doesn't appear
  (registry filters configured providers already); default resolution walks to
  the next recommended entry, then `models[0]`.
- Stored `imageModel`/`videoModel` id that no longer exists → falls back to the
  new default (existing behavior preserved).
- Live Sogni lineup drifts → new models arrive in the tail with no claims;
  curation is additive.

## Testing

- `model-meta.test.ts`: exact + prefix resolution, unknown → null.
- `catalog.test.ts` (updated): exclusion of `a2v`/`r2v`/`removal` families;
  descriptors carry `tier`/`useCase`; no `speedHint` on un-curated models;
  curated entries first.
- `registry` default: recommended-wins ordering, fallback chain.
- Composer mapping test: grouping, badges, no duplicated provider in hint.
- PillSelect: two-line rows render, tail expands/collapses, badges show.

## Rollout

Single branch, no migration (fields optional end to end). Old stored settings
keep working; the only visible change is the picker itself.
