# Sogni AI API Guide (for PeraByte Studio)

Distilled from the official reference at <https://docs.sogni.ai/api-reference/> (learned 2026-09-15),
cross-checked against the installed `@sogni-ai/sogni-client` 5.49 SDK types and the **live public model
catalog**. This is the project's working reference: what we call today, what exists for frame-chained
(story-continuation) generation, and the exact parameter names involved.

## 1. Conventions (applies to every endpoint)

| Topic | Fact |
| --- | --- |
| Base URL | `https://api.sogni.ai` |
| Auth | `Authorization: Bearer $SOGNI_API_KEY` (legacy `api-key` header still accepted). API keys are long-lived, wallet-scoped, **server-side only**. Session tokens are short-lived browser JWTs. |
| Errors | Non-LLM endpoints: `{ "status": "error", "errorCode": <n>, "message": "…" }`. LLM routes use the OpenAI error shape. `402` = vendor model needs Premium Spark; `409` = too many active workflows / duplicate confirm-cost; `503` = retry with backoff + jitter, **not** data loss. |
| Rate limits | `429` → honor `Retry-After`, else exponential backoff + jitter. |
| Idempotency | `Idempotency-Key` (or `X-Idempotency-Key`) header on side-effect writes, incl. `POST /v1/creative-agent/workflows`. Scoped per wallet; UUID recommended. Makes retries safe. |
| Billing | Two tokens: `sogni` (native, Sogni-network models) and `spark` (cash, vendor models). Pick via `token_type` body field or `X-Token-Type` header; `auto` default; vendor jobs force `spark`. |
| Vendor gating | Vendor models (`gpt-image-2`, `seedance2*`, `happyhorse-1.1-*`) need explicit opt-in by name; workflows return `402` before any step runs if the account lacks Premium Spark. |
| Cost approval | Workflows: submit with `confirm_cost: false` → `400` carrying `estimatedCapacity` → resubmit `confirm_cost: true`; cap with `max_estimated_capacity_units`. |

## 2. Generation Recipes (direct generation)

One endpoint, no chat session: `POST /v1/creative-agent/workflows` with
`input.steps[]` of hosted-tool calls. Poll `GET /v1/creative-agent/workflows/:id` or subscribe to the SSE
stream `…/:id/events/stream`. Completed artifact: `workflow.steps[0].artifacts[0].url`.

Hosted tools and key arguments (exact names):

- `generate_image`: `prompt`, `model` (e.g. `krea-2-turbo`; list via `GET /v1/model-catalog?mediaType=image`).
- `generate_video`: `prompt`, `videoModel`, `duration`. Common `videoModel` values: `ltx25` (default
  Sogni-native), `ltx23`, `wan22`, `seedance2`, `seedance2-mini` (legacy `seedance2-fast` routes here),
  `happyhorse-1.1-t2v` / `-i2v` / `-r2v` (Premium Spark).
- `generate_music`: `prompt`, `duration`, optional `lyrics` (from synchronous `compose_lyrics`).

**Image-to-video** is a two-step composition — `generate_image` keyframe feeding `generate_video` through
an in-band `dependsOn` binding:

```json
{
  "id": "clip",
  "toolName": "generate_video",
  "arguments": { "prompt": "Slow dolly-in as the sketch comes alive.", "duration": 5 },
  "dependsOn": [{
    "sourceStepId": "keyframe",
    "sourceArtifactIndex": 0,
    "targetArgument": "referenceImageIndices",
    "transform": "image_index",
    "required": true
  }]
}
```

So on the REST surface, the video tool consumes reference images through
`referenceImageIndices` (+ the uploaded image assets themselves).

## 3. Project Status (polling)

`GET /v2/projects/:id` (owner-authenticated; **v2**, not v1). HTTP `200` means *known*, not *succeeded* —
read `data.project.status` and `data.project.finished`:

| status | meaning | finished |
| --- | --- | --- |
| `pending` | accepted, awaiting authorization | false |
| `queued` | waiting to start | false |
| `processing` | assigned / rendering | false |
| `completed` | ≥1 output succeeded | true |
| `failed` / `canceled` | terminal, no successful output | true |

- Poll every ~2s, stop on `finished: true`, keep an overall deadline.
- `503` = status temporarily unverifiable → backoff, never resubmit because of it. `404` ≠ proof a
  project never existed (retention window). Another account's project is also `404`.
- Failed/canceled compact status (`statusOnly: true`) is retained **24h** after `endTime`; result
  artifacts are retained separately (SDK docs say 24h for hosted result URLs).

## 4. Media / image uploads (reference assets)

Presigned uploads — `GET /v2/media/uploadUrl` (audio/video) and `GET /v2/image/uploadUrl` (images):

- Query params: `type` (**required**), `jobId` (**required**), optional `contentType` (pins the S3 key),
  `id`/`imageId` (worker-side), `startContentType` (paired flows).
- **Artist-side image `type` values**: `startingImage`, `referenceImage`, `referenceImageEnd`,
  `contextImage*` (numbered). Media types: `referenceAudio`, `referenceVideo`; worker-side `complete`,
  `preview`.
- Response: `data.url` + `data.fields` (presigned POST form) + `maxSizeBytes` (100 MiB) +
  `allowedContentTypes` (images: png/jpeg/webp/gif).
- Upload = `multipart/form-data` POST to `url` with **every** `fields` entry, then the `file` field
  **last**; `204` on success.
- Downloads: `GET /v2/{media,image}/downloadUrl` → presigned GET for uploaded assets or finished job
  artifacts.

The SDK does this dance for us: `InputMedia = File | Buffer | Blob | true` and
`projects.create({ …, referenceImage: <Buffer>, referenceImageEnd: <Buffer> })` triggers the presigned
uploads automatically (`uploadReferenceImage` / `uploadReferenceImageEnd` internals).

## 5. Model discovery (public, no key)

- `GET /v1/model-catalog?mediaType=video&network=fast` (+ `include=parameters`) →
  `data.models[]` with `id`, `name`, `mediaType`, `tierId`, `availableNetworks`, `workerCounts`, `tags`.
  Cached 30s, ETag/304 support. Per-model: `GET /v1/model-catalog/:modelId?include=parameters`.
- `include=parameters` exposes **machine-readable capability metadata**, e.g. for `seedance-2-5`:
  `supports: { textToVideo, imageToVideo, imageAudioToVideo, videoToVideo, lastFrameExport: true }`,
  `acceptInputImage: true`, `referenceLimits`, `aliases` (`seedance-2-5_i2v` …), `durations[4..30]`,
  `ratios`, `isExternalAPI: true`, `vendor: bytedance`, `premiumOnly: true`. For i2v LTX models:
  `strength { min 0.3, max 1, default 0.7 }`.
- `GET /v1/model-demand?network=fast` → live `workersReady` / `jobsActive` / `jobsQueued` per model
  (snapshot only). Cached 15s.

### Live video-model landscape (verified 2026-09-15, network=fast, 58 models)

Naming is systematic — **the i2v sibling of a t2v model is the same id with `t2v` → `i2v`**:

| Family | t2v (today's picker) | i2v sibling (start frame) | first+last frame |
| --- | --- | --- | --- |
| WAN 2.2 | `wan_v2.2-14b-fp8_t2v_lightx2v`, `…_t2v` | `wan_v2.2-14b-fp8_i2v_lightx2v`, `…_i2v` | — |
| LTX 2.5 | `ltx25-22b-int8_t2v_distilled` | `ltx25-22b-int8_i2v_distilled` (has `strength` 0.3–1) | — |
| LTX 2.3 | `ltx23-22b-fp8_t2v_dev/_distilled` | `ltx23-22b-fp8_i2v_dev/_distilled` | keyframe interpolation: `referenceImage` + `referenceImageEnd` (`firstFrameStrength`/`lastFrameStrength` 0–1, default 0.6) |
| MiniMax H3 | `minimax-h3-fl2va-fp8_t2v(_turbo/_balanced)`, `minimax-h3-fastvideo-int8_t2v_turbo(_2stage)` | `…_i2v` variants | dedicated `…_flf2v` variants (**require both** frames) |
| Seedance (vendor) | `seedance-2-0`, `-fast`, `-mini` | same models (`acceptInputImage`) | `seedance-2-5`: `supports.lastFrameExport` |
| HappyHorse 1.1 (vendor) | `happyhorse-1.1-t2v` | `happyhorse-1.1-i2v` | — |

`returnLastFrame: true` on Seedance 2.5 exports the final frame as `job.lastFrameUrl` (SDK `Job` getter),
and `trimEndFrame: true` drops the duplicated end frame for seamless stitching of chained clips.

## 6. What PeraByte uses today vs. what this unlocks

Current provider (`lib/providers/sogni/`): SDK `projects.create` with `type/modelId/positivePrompt/
negativePrompt/numberOfMedia/seed/disableNSFWFilter/sizePreset/width/height/ratio/duration/outputFormat`.
The dynamic catalog (`catalog.ts`) **excludes** `i2v|s2v|v2v|animate|edit|kontext…` id patterns, so no
frame-input model is reachable yet. `SogniProject` (client.ts) only exposes `waitForCompletion(): string[]`
— `lastFrameUrl` needs a `jobCompleted` listener or `project.job(id)` lookup.

This guide unlocks, with named parameters:

1. **Story continuation (video)**: pass the previous scene's end frame as `referenceImage` (Buffer) —
   auto-selecting the `…_i2v` sibling of the chosen family; optional `referenceImageEnd` where the family
   supports it (LTX 2.3 keyframe, MiniMax H3 `flf2v`, Seedance 2.5).
2. **Frame sourcing**: `returnLastFrame: true` on `seedance-2-5` yields the exact end frame
   (`job.lastFrameUrl`); every other video model needs client-side canvas extraction of the mp4's final
   frame.
3. **Image-story chaining (img2img)**: `startingImage` (+ `startingImageStrength`, default 0.5) on image
   projects.
4. **Capability detection**: from the public catalog (`include=parameters` → `acceptInputImage`,
   `supports.imageToVideo`, `supports.lastFrameExport`, `strength`, `referenceLimits`) instead of
   hard-coding id patterns.

## 7. Related provider facts (for the same feature)

- **apikey.fan (xAI-compatible Grok)** — verified from docs.x.ai (2026-09-15):
  - `POST /v1/videos/generations` accepts `model`, `prompt`, `duration` **and `image: { url }`** — the
    source image becomes the video's first frame (async `request_id` polling, identical to our current
    flow). Docs show a hosted URL; the images-edit endpoint explicitly accepts **base64 data URIs** in the
    same `image.url` field, so data-URI frames are plausible but **unverified on the relay** — smoke test
    at implementation time, with a clean "no key → skip frame" fallback.
  - `POST /v1/images/generations` is prompt-only (no image input). Img2img on Grok goes through
    `POST /v1/images/edits` with `image: { url, type: "image_url" }` (public URL **or data URI**, up to 5
    source images). No last-frame conditioning on any Grok endpoint.
- **Pollinations** — deterministic prompt-URL images only; no image input at all (its "video" is a still
  keyframe). Story continuation degrades to prompt-only there.
