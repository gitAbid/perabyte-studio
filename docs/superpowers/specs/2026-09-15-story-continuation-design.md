# Story Mode Continuation — Design

Date: 2026-09-15
Status: pending review
Related: `docs/sogni-api-guide.md` (verified provider facts), `docs/superpowers/specs/2026-09-15-sogni-provider-design.md`

## Goal

Story mode scenes should form a coherent story: each new scene starts from the last frame of the
previous generation (image or video), with optional manual start/end frame references, and a real
generation queue — chained scenes render one-by-one, independent scenes render in parallel.

## Decisions (agreed with the user)

1. **Model switch**: when the selected model can't take a start frame and an i2v sibling exists,
   auto-switch and mark the scene with a small `i2v` note (no modal/toast).
2. **Scope**: frame chaining applies to **both** image and video stories.
3. **Manual end frame**: upload slot **hidden** on models that can't condition on an end frame.
4. **Control**: a `Continuity` on/off toggle in the story composer (default ON, per story).
5. **Queue**: with Continuity ON, scenes render **sequentially** through a persistent queue, each
   chained to the previous scene's end frame; with Continuity OFF, all queued scenes render **in
   parallel**. Queue state survives reload.
6. **One-click conversion**: a completed image story can be converted into a video story where
   consecutive images become first/last-frame pairs — clip *i* animates image *i* (first frame) into
   image *i*+1 (last frame); N images yield N−1 clips, rendered in parallel.

## Research basis (verified)

See `docs/sogni-api-guide.md` for the full reference. Key facts this design relies on:

- Sogni SDK: `referenceImage` / `referenceImageEnd` (video), `startingImage` (image), all accepting
  `Buffer` with SDK-managed presigned uploads; `returnLastFrame: true` on `seedance-2-5` yields the
  exact end frame as `job.lastFrameUrl`; `InputMedia = File | Buffer | Blob | true`.
- i2v siblings are systematic: `t2v → i2v` in the model id, all confirmed present in the live catalog
  (2026-09-15), with per-model capability flags available from `GET /v1/model-catalog`.
- apikey.fan (Grok): `/v1/videos/generations` accepts `image: { url }` (first frame; data-URI support
  on the relay **unverified** — adaptive fallback required); `/v1/images/edits` accepts
  `image: { url, type: "image_url" }` with data URIs; no end-frame capability.
- Pollinations: no image input; prompt-only degradation.

## Architecture: Approach 1 (client-orchestrated chain, media-ref transport)

The story page drives nothing but UI. A module-level **story runner** owns execution and reads/writes
queue state in the persisted asset store. Frames travel as **content-addressed cache refs**
(`<sha256>.<ext>`), never as fat JSON bodies; the server loads bytes via the existing
`MediaRepository` and hands them to providers (Sogni: Buffers; Grok: data URIs). Video end frames are
extracted **client-side** (canvas seek) except on `seedance-2-5`, which returns `job.lastFrameUrl`.

Rejected alternatives: inline data-URI bodies (fat, no dedup); server-side runner with ffmpeg
extraction (no ffmpeg on Vercel serverless; loses per-scene NDJSON progress; worse retry story).

---

## 1. Capability model (`lib/domain/models.ts`)

`ModelDescriptor` gains optional flags (same pattern as `stylesSupported` / `uncensored`):

```ts
/** Frame conditioning the model accepts. Absent = prompt-only. */
frameInput?: { start: boolean; end: boolean };
/** Model id (`<provider>:<model>`) to swap to when a start frame is present.
 *  Absent when the same model already takes frames. */
i2vModelId?: string;
```

Population:

- **Sogni** (`catalog.ts`): the catalog produces a **full descriptor set** and a **picker list**. i2v
  ids stay out of the picker list, but they ARE built as descriptors (with their capability flags)
  and registered, so the service can resolve an `i2vModelId` through the registry. Each picker-listed
  video model gains a hidden `i2vModelId` when its `t2v→i2v` sibling exists in the fetched live
  catalog with `workerCount > 0`; curated fallbacks hard-code the three curated models' siblings
  (verified live: `wan_v2.2-14b-fp8_i2v_lightx2v`, `ltx25-22b-int8_i2v_distilled`;
  `seedance-2-0-mini` takes frames itself — `frameInput.start`, no sibling).
  Capability family rules (app-side maps, like `STYLELESS_ID_PATTERNS`):
  - `start: true` in place (no sibling needed): `seedance-2-0*` and `seedance-2-5`
    (`acceptInputImage`), plus every registered `*_i2v*` descriptor.
  - `end: true`: `ltx23-*_i2v`, `minimax-h3-*_i2v` and `*_flf2v`, `seedance-2-5`.
  - `end: false`: `wan_*`, `ltx25-*`, `seedance-2-0*`, `happyhorse-*`.
  Sogni image models: `frameInput: { start: true, end: false }` (via `startingImage`).
  **Picker hygiene**: `*_flf2v` models (they *require* both frames and reject prompt-only renders)
  are also excluded from the picker list and registered as hidden descriptors with
  `frameInput: { start: true, end: true }` — they become conversion targets, never stray picks.
- **apikey.fan**: video and image models get `frameInput: { start: true, end: false }`, no
  `i2vModelId` (same model id takes frames: video `image.url`, images via `/images/edits`).
- **Pollinations**: no flags → prompt-only.

The flags flow to the client through the existing `/api/models` → `useModelCatalog` path so the story
UI can show/hide the end-frame slot and predict a swap.

## 2. API contract

### New: `POST /api/media` (upload)

Raw image body + `content-type` header. Sniffs magic bytes (reuse the repository sniffer), accepts
`image/png|jpeg|webp` only, 10 MB cap, stores via `MediaRepository`, returns
`{ ref, url, contentType }`. Errors: plain-JSON `{ error, retryable }` per the app contract.

### Extended: `POST /api/generate`

Body gains optional `startImageRef` / `endImageRef` (cache refs). Validation
(`validateGenerationRequest`): must pass `isValidMediaRef` and reference an image extension;
otherwise 400 on field `startImage` / `endImage`. The service loads bytes through `MediaRepository`
into the normalized request:

```ts
// NormalizedGenerationRequest additions
startImage?: { bytes: Buffer; contentType: string };
endImage?: { bytes: Buffer; contentType: string };
```

### Model resolution (service)

When `startImage` is present:

1. Resolved model has `frameInput.start` → use as-is (Grok; Sogni i2v already selected).
2. Else it has a resolvable, configured `i2vModelId` → switch to it (log the swap).
3. Else → prompt-only, `frameUsed: false`.

`endImage` is forwarded only when the **effective** model has `frameInput.end`; otherwise dropped
with a warn log. `GenerationResponse` gains optional `effectiveModelId` and `frameUsed: boolean`.

## 3. Provider adapters

- **Sogni** (`request-maps.ts` / `sogni.provider.ts` / `client.ts`):
  - Image + start → `startingImage: Buffer` (default `startingImageStrength`).
  - Video → `referenceImage: Buffer`; plus `referenceImageEnd: Buffer` when an end frame is supplied
    and `frameInput.end` (LTX 2.3 keyframe semantics; MiniMax H3 `flf2v` requires both — we only ever
    send both or start-only).
  - `seedance-2-5`: set `returnLastFrame: true` whenever the model renders with or without frames.
    `client.ts`'s `SogniProject` gains a `jobCompleted` listener to capture `job.lastFrameUrl`; the
    provider materializes it into the media cache and returns it on the artifact as
    `companionFrameUrl`. `persistArtifacts` stores it and surfaces `GeneratedMedia.endFrameUrl` —
    the client then chains on the exact final frame with no extraction.
- **apikey.fan**:
  - Video + start → payload gains `image: { url: "data:<mime>;base64,…" }`. If the create call fails
    with a 400, retry once **without** the image field (mirrors the existing `image_config`
    adaptive-retry), log a warn, and report `frameUsed: false`.
  - Image + start → route to `/v1/images/edits` with `image: { url: dataURI, type: "image_url" }`
    (same adaptive fallback).
  - `endImage` never sent (capability gate upstream).
- **Pollinations**: unchanged; `frameUsed: false`.

## 4. Frame plumbing (client)

New `lib/media/frame.ts`:

- `uploadFrameRef(blob: Blob): Promise<string>` — POST to `/api/media`, returns the ref.
- `extractLastFrame(videoUrl: string): Promise<Blob>` — `<video>` seek to `duration − ε`, canvas
  `drawImage`, JPEG blob. Same-origin media URLs keep the canvas untainted.
- `refFromMediaUrl(url: string): string | null` — parses `f=<ref>` from `/api/media` URLs (image
  scenes need no upload).

## 5. Story queue runner (`lib/story/runner.ts`) — persistent queue

The story asset in the existing store (`lib/store.ts`, localStorage-persisted) **is** the queue: each
`StoryScene` already carries `status`. The runner is a module-level singleton, not component state.

`StoryScene` gains: `startImageRef?`, `endImageRef?` (manual refs), `endFrameRef?` (derived from the
completed scene), `effectiveModelId?`, `frameUsed?`.

### Scheduling rules

- **Runnable(scene)**: `status ∈ {queued}` AND (Continuity OFF OR scene has manual `startImageRef`
  OR it is the first scene OR its predecessor completed with an `endFrameRef` available).
- **Continuity ON**: at most **one** scene in flight; on completion, derive + upload the end frame,
  write `endFrameRef`, then the next scene starts with `startImageRef = predecessor.endFrameRef`
  (manual refs override).
- **Continuity OFF**: all runnable scenes start **immediately in parallel** (max 6 scenes), no frame
  refs.
- **Toggle mid-run**: OFF→ON chains the remaining queued scenes from the latest completed frame;
  ON→OFF releases every queued scene in parallel. Scenes already rendering are untouched.
- **Failure**: a failed predecessor leaves dependents in `queued` with a visible
  "Waiting for Scene N" note. Retrying the failed scene resumes the chain automatically on success.
- **Cancel**: aborts in-flight requests; queued scenes stay queued. **Generate** resumes the queue
  (dedupe: never two runners for one story).

- **Persistence & resume**: all transitions write through `updateAsset`, so the queue survives
  reloads. On story-page mount (and `StoreBootstrap`), the runner rehydrates: `generating` scenes
  flip back to `queued` and scheduling re-runs. Stories reopened from History continue where they
  left off.
- **Kind switches chain too**: an image predecessor feeds a video scene via `referenceImage` and a
  video predecessor feeds an image scene via `startingImage`, subject to the effective model's
  `frameInput.start` (auto-swap applies as usual).

## 6. Story UX

- **Continuity toggle** in the composer footer next to "Add scene" (`Continuity: On`), default ON,
  per story (`meta.continuity`), reset by "Start over".
- **Queue visibility**: scene tiles keep their skeletons; chained-but-blocked tiles show
  "Waiting for Scene N"; a completed scene shows a small link icon on its successor when continuity
  fed it a start frame.
- **Manual refs**: two thumbnail chips under each scene ("Start frame", "End frame"); End frame
  renders only when the selected model has `frameInput.end`. File-picker upload → thumbnail + × to
  clear. Manual start overrides auto-chaining for that scene.
- **i2v note**: when `effectiveModelId ≠ requestedModelId`, the scene card shows a small `i2v` badge;
  tooltip = effective model label.
- Prompt flow is unchanged (composer prompt = scene 1; "Add scene" appends pre-filled continuations).

## 7. Error handling

| Failure | Behavior |
| --- | --- |
| Start ref unreadable server-side | 400, field `startImage`: "Continuity frame missing. Re-generate the previous scene or turn Continuity off." Scene marked failed with that message. |
| End-frame extraction fails client-side | Skip chaining for that scene, toast "Couldn't read the last frame — continuing without it"; successors run prompt-only. |
| Provider rejects the frame | Adaptive retry without it; `frameUsed: false`; scene renders; card shows the degradation note. Never fails a scene because of the frame. |
| Upload endpoint misuse | Non-image/oversized → 400 with plain message; storage failure → 503 retryable. |
| Reload mid-queue | Runner rehydrates; in-flight scenes re-queue and re-run. |

## 8. Testing & verification

- **Unit (vitest)**: request-maps payload shapes (±frames, per provider); service validation (ref
  checks, auto-swap precedence, end-frame gating, `frameUsed`/`effectiveModelId` surfacing); catalog
  sibling map + family rules; apikey-fan adaptive retry; `/api/media` upload route; runner scheduling
  (sequential vs parallel, toggle flips, blocked dependents, rehydration) with a fake store;
  conversion (ref normalization incl. provider-URL scenes, N−1 clip derivation, end-capable model
  preference, source story untouched).
- **Live smoke** (keys present in `.env.local`): Sogni WAN i2v chained pair; `seedance-2-5`
  `lastFrameUrl` (credits permitting); Grok video `image.url` relay check (documented fallback if
  rejected).
- **GUI pass** (playwright, existing verify-script habits): toggle off/on mid-run, manual ref
  upload/clear, i2v badge, blocked-tile note, reload-resume.

## 9. One-click image story → video story

Converts a completed image story into a video story whose clips animate consecutive images into
each other: clip *i* gets `startImageRef` = image *i*'s ref and `endImageRef` = image *i*+1's ref
(N images → N−1 clips).

- **Entry point**: a `Convert to video` button in the story footer, visible when `kind === "image"`
  and ≥ 2 scenes have completed media.
- **Ref normalization**: every source image must be a cache ref before conversion. Scenes rendered
  by Pollinations carry provider URLs — the client fetches them through the existing
  `/api/media?u=…` proxy (same-origin) and uploads via `uploadFrameRef()`. Cached scenes parse their
  ref with `refFromMediaUrl()`.
- **New sibling asset**: the converted story is a **new** asset (title `"<title> (video)"`,
  `kind: "video"`, same aspect/settings, `mode: "Story Mode"`, `meta.convertedFrom = <image story
  id>`); the image story is preserved untouched. The page switches to the new story, kind flips to
  video, and the clip queue appears on the board immediately.
- **Clip scenes**: `status: "queued"`, prompt = the source images' prompts joined
  (`"image i prompt → image i+1 prompt"` condensed by the same continuation copy used elsewhere —
  final wording at implementation), each with explicit `startImageRef` + `endImageRef`. Prompts stay
  short — the frames carry the look; the prompt carries the motion.
- **Parallel by rule**: because every clip has an explicit start ref, the §5 scheduling rule
  ("manual refs make a scene runnable") already renders all clips **in parallel** — no chaining
  needed between clips. Continuity toggle stays meaningful for scenes *added later* to the converted
  story.
- **Model resolution (end-capable)**: the user's selected video model is used when it has
  `frameInput.end`; otherwise the runner auto-picks the first available entry from a preference
  list of registered end-capable models — `ltx23-22b-fp8_i2v_distilled` (Sogni-native, fast,
  popular) → `minimax-h3-fl2va-fp8_i2v_turbo` → `seedance-2-5` → `minimax-h3-fl2va-fp8_flf2v_turbo`
  — recorded per story as `effectiveModelId`, with the same small model note on clip cards as
  auto-swapped scenes. Duration: the story's video duration setting, clamped per model as today.
- **Failure**: a failed clip retries standalone (its refs are explicit, so nothing upstream to
  re-run). The conversion never mutates the source story, so "Convert" can be re-run at any time.

## Out of scope (this iteration)

- End-frame strength controls (`firstFrameStrength` etc.) — defaults only.
- Continuity from a History asset as story seed ("start story from this image").
- Video-to-video / reference-video conditioning.
- Reordering scenes after generation.
