# Multi-Reference Image Generation — Design

**Date:** 2026-09-19
**Status:** Awaiting user review
**Scope decision taken by default (question unanswered):** image mode only; video untouched.

## Problem

Today a user can attach at most one image in image mode (the single "Reference image"
slot → img2img `startingImage`). There is no way to give the model several reference
images, and no way to say "transform THIS input image using THESE references."

## Verified provider reality (live catalog, 2026-09-19)

Sogni ships an edit-model class purpose-built for this. Verified on
`GET /v1/model-catalog?mediaType=image&network=fast&include=parameters`:

| Model | Input-image capability |
| --- | --- |
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | `maxContextImages: 16` |
| `qwen_image_edit_2511_fp8` (+ `_lightning`) | `requiresContextImage: true` — SDK doc: up to **3** context images |
| `krea2_identity_edit_v1_2` (+ `_sogni_v0_3_alpha`, `dark_beast_…`) | `requiresContextImage: true` |

SDK `ImageProjectParams` (5.49) accepts, alongside `startingImage`:

- `contextImages?: InputMedia[]` — multi-reference; uploaded into the
  `contextImage1..16` asset slots.
- GPT Image validation treats `contextImages[0]` as the image being edited
  (`gptImageMask requires a first reference image`).

So on Sogni the payload semantics are: **`contextImages[0]` = the input image to
transform, `contextImages[1..]` = the references.**

Everything else degrades as it does today: apikey-fan (Grok) takes a single input
image only; Pollinations takes none.

These models are currently **invisible in the app**: `EXCLUDED_ID_PATTERNS`
(`lib/providers/sogni/catalog.ts`) filters out `"edit"`, and no plumbing exists
beyond one ref.

## Approach

**Chosen — A: true multi-reference through the edit-model class.** Un-hide the
edit families, add a multi-ref capability flag, extend the pipeline
(`referenceImages[]`), and make the frame dock model-aware. GPT Image / Qwen Edit
/ Krea2 Identity are exactly "transform this image using these references."

**Rejected — B: vision-described references** (describe each ref into the prompt
via the existing Sogni vision chain). Works on every model but is lossy, slow,
and not real identity transfer. Future enhancement, not v1.

**Rejected — C: A + B fallback.** Doubles the surface for v1.

## Design

### 1. Model capability (`lib/providers/sogni/catalog.ts`, `lib/domain/models.ts`)

- New descriptor flag: `contextImages?: { min: number; max: number }` on
  `ModelDescriptor` (image models only). Derived from live-catalog params:
  `maxContextImages` → `{ min: 0, max: N }`; `requiresContextImage` →
  `{ min: 1, max: 3 }` (3 from the SDK doc; live-tested during implementation).
  Models with neither keep `undefined`.
- Cold-start catalog rows in `model-meta.ts` for the three families, curated into
  the recommended tier with a distinct use-case ("edit / multi-reference").
- Catalog exclusion: replace the blanket `"edit"` pattern with precise
  exclusions so the three families pass (and birefnet/sam3-class utilities stay
  excluded via their own patterns: `segment`, `sam3`, `removal`).

### 2. Request surface

- Client → server: `referenceImageRefs?: string[]` (media-cache refs), separate
  from the existing `startImageRef`.
- `NormalizedGenerationRequest`: new `referenceImages?: FrameImage[]`.
- `generation.service.ts`: validate + load each ref (existing `loadFrame`);
  cap at the effective model's `contextImages.max` — extras are **dropped with a
  warn log** (same degrade-don't-fail pattern as end frames). A model with
  `min ≥ 1` and zero attached images fails validation server-side with a clear
  message (belt-and-braces behind the client check). When the effective model
  has no `contextImages` capability, all extra refs drop with a warn; behavior
  for a single ref is unchanged.

### 3. Provider mapping (`request-maps.ts` → `toImageParams`)

- Edit-class model (has `contextImages`): send
  `contextImages = [startImage?, ...referenceImages]` — the transform input
  leads, references follow, matching the `<Picture 1..N>` ordering GPT/Qwen use.
- Classic model: exactly today's mapping (`startingImage`, refs dropped upstream).
- apikey-fan / Pollinations: unchanged — they ignore `referenceImages` (already
  true of anything they don't read), warns logged in the service.

### 4. Composer UI (`FrameDock`, `PromptComposer`)

- Image mode slots become model-aware:
  - Classic model → today's single "Reference image" slot (fills
    `startImageRef`). No new controls — per the standing UI rule, options a
    model can't use stay hidden.
  - Edit-class model → "Input image" slot (`startImageRef`) + a growing row of
    "Reference" chips (up to the model's max; one dashed add-pill when there's
    room). Chips ride the existing FrameDock look.
- New client state: `referenceImageRefs: string[]` on the composer frame state,
  persisted where `startImageRef` persists today.
- Model switch away from an edit-class model with refs attached → drop the
  reference chips with a visible toast (mirrors the end-frame-drop warning).
  The Input image slot needs no migration — it is `startImageRef`, the slot a
  classic model already consumes as its img2img reference.
- Models with `min ≥ 1` (`requiresContextImage`) refuse to generate without at
  least one attached image: Generate surfaces the standard validation error
  ("Attach an input image to edit…") instead of a cryptic provider failure.

### 5. Shared paths that inherit this

- `/generate` (Solo) and `/story` both render `PromptComposer`, so both screens
  get the slots. Story scenes keep their chained-frame behavior: scene chaining
  writes `startImageRef` and that still maps to the transform slot on edit
  models.
- Job records (`job-store`) persist `referenceImageRefs` alongside
  `startImageRef` so restart recovery re-loads every ref (Phase-B executor
  pattern).

### 6. Moderation / uncensored

Unchanged: existing safe-mode gating, NSFW-filter flag and LoRA gating apply
verbatim to edit models; refs are inputs and follow the same treatment as
`startImageRef` today (no additional moderation on inputs).

### 7. Testing

- Unit: service capping/dropping rules; request-map `contextImages` ordering
  (input first); catalog capability derivation; exclusion-list precision.
- Contract: client fetch body carries `referenceImageRefs` (lesson from the
  LoRA client-drop bug — assert on the serialized body).
- Live smoke: one real render on `qwen_image_edit_2511_fp8` with input + 2
  references; one on a classic model to prove zero regression.

## Out of scope (v1)

- Video multi-reference (r2v families — premium, separate render path).
- Reference strength controls (`startingImageStrength` stays default).
- GPT Image mask (`gptImageMask`) and quality knobs.
- Vision-described references (Approach B).
