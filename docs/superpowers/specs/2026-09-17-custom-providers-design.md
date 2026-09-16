# Custom Providers — generic OpenAI / Google / Anthropic generation gateways

**Status:** awaiting review
**Date:** 2026-09-17
**Follows:** provider-settings (7f471d9), job engine Phase B (4d3f006), model-selection-tiers (01e0086)

## Problem

Providers are hard-coded adapters: apikey.fan ships three Grok image models and two Grok
video models; every other gateway is unreachable without a code change. The user wants to
point the studio at any relay or vendor — paste a base URL + API key, get the model list,
classify models, and have image, video, and text generation just work. This also delivers
ChatGPT / GPT-image models served through the apikey.fan relay the moment the key's group
includes them (today the key's group is Grok-only — verified live, 15 models, all xAI).

### Findings that shaped the design

- `GET https://apikey.fan/v1/models` works with the stored key and returns
  `{data: [{id, display_name, owned_by, …}]}` — 15 Grok-family models today, including a
  `grok-imagine-edit` img2img model our built-in catalog doesn't list.
- The `APIKEY_FAN_API_KEY` in `.env.local` has a `ss//` paste artifact (`ss//sk-…`); the
  relay rejects it. The trimmed key verifies OK. Fix shipped with this feature.
- `ModelDescriptor` / `NormalizedGenerationRequest` / the registry gate are already
  provider-agnostic; nothing below the registry needs to know a provider is custom.

## Goals

1. Settings UI: add a custom provider (name, wire format, base URL, API key), fetch its
   model list, classify each model as image / video / text / off, enable or disable.
2. Classified models appear in the normal composer pickers, run through the normal
   generation service + durable job engine, and survive restarts (video) like built-ins.
3. Custom **text** models become selectable as the Enhance task model (the one place text
   models are consumed today; the /writer spec will consume the same list later).
4. Wire formats v1: `openai` (OpenAI, xAI/Grok, OpenRouter, sub2api relays, vLLM, Ollama,
   LM Studio), `google` (Gemini API), `anthropic` (Claude — text only).

## Non-goals

- No additional formats in v1 for Replicate / fal / Runway / Luma / Kling / MiniMax /
  ComfyUI. The format registry (below) makes them additive later.
- Vision moderation stays Sogni-only (`sogni.vision.ts`).
- No per-model pricing, quotas, or usage tracking.
- No OAuth / hosted flows — API keys only.

## Architecture

Two new layers, both Strategy-plugged into the existing seams (Open/Closed: no existing
provider code changes).

```
lib/providers/custom/
  formats/
    types.ts          # ProviderFormat contract
    openai.ts         # OpenAI-compatible (incl. xAI/Grok + sub2api relays)
    google.ts         # Gemini API (generateContent + Veo predictLongRunning)
    anthropic.ts      # Messages API (text only)
    classify.ts       # name-based kind guessing shared by discovery
    index.ts          # FORMATS registry: id → adapter
  custom-provider.factory.ts   # CustomProviderEntry → ImageProvider & VideoProvider & JobProvider
  custom.text.ts               # chat completion entry point used by enhancement service
  discovery.service.ts         # server-side "fetch models + classify" orchestration
```

### ProviderFormat contract

```ts
interface ProviderFormat {
  readonly id: "openai" | "google" | "anthropic";
  readonly label: string;
  /** Wire capabilities, for UI hints. */
  readonly capabilities: { image: boolean; video: boolean; text: boolean };
  listModels(cfg: CustomProviderConfig): Promise<DiscoveredModel[]>;
  generateImage?(cfg, request: NormalizedGenerationRequest, model, ctx): Promise<GeneratedArtifact[]>;
  /** Async video job pair; formats without video omit it. */
  videoJobs?(cfg): VideoJobPair;   // { submit, poll } mapped onto JobProvider
  generateText?(cfg, request: TextGenerationRequest): Promise<TextGenerationResult>;
}
```

`DiscoveredModel = { model: string; label?: string; kind: ModelKind | "text" | "off" }` —
the adapter may pre-classify from richer metadata (e.g. Gemini's
`supportedGenerationMethods`); `classify.ts` guesses from the model id when metadata is
absent (video patterns checked before image: `video|veo|sora|kling|hailuo|seedance|runway`,
then `image|imagen|flux|dall|gpt-image|sd3|sdxl|stable-diff|kolors|seedream|imagine-image`,
else `text`).

### Per-format wire details (researched)

| | models | image | video | text |
|---|---|---|---|---|
| `openai` | `GET /models` | `POST /images/generations` (b64); `POST /images/edits` when a start frame is present — identical shape to the live-verified apikey.fan adapter | create tries `POST /videos/generations` → `{request_id}` (sub2api/xAI relay family); on 404 falls back to `POST /videos` (OpenAI Sora: `{model, prompt, seconds, size, input_reference}`); poll `GET /videos/{id}` parsing both response shapes (`{status, video:{url}}` relay / `{status}` Sora, content fetched with the Bearer key) | `POST /chat/completions` |
| `google` | `GET /v1beta/models` (`x-goog-api-key`), keep models advertising `generateContent` or `predictLongRunning`; name prefixes: `imagen-*`→image, `veo-*`→video | `POST /v1beta/models/{m}:generateContent` with `responseModalities:["TEXT","IMAGE"]` → `inlineData` parts; start frame rides as an inline `inlineData` input part | `POST /v1beta/models/{m}:predictLongRunning` → operation name → poll `GET /v1beta/{operation}` until `done` → download `video.uri` with key appended | `:generateContent` with `systemInstruction` |
| `anthropic` | `GET /v1/models` (`x-api-key` + `anthropic-version`) | — | — | `POST /v1/messages` (`max_tokens` required) |

Video job refs are the provider's own ids (`request_id`, Sora id, or Gemini operation
name). The executor already resolves the owning provider via `registry.resolve(job.modelId)`,
so no ref scheme changes are needed. Sync image submits park artifacts in the adapter
instance exactly like apikey-fan's `grokimg_` refs do (a restart loses the parking spot →
retryable failure — same accepted behavior as the built-in).

### Custom provider adapter (factory)

`createCustomProvider(entry)` returns one object implementing `ImageProvider`,
`VideoProvider` (when a video model exists), and `JobProvider`:

- `id` = the entry's slug (`my-relay`); model ids are `my-relay:<model>` — validated at
  save time to be `[a-z0-9-]{2,32}` and not collide with `apikey-fan|sogni|pollinations`.
- `isConfigured()` = entry enabled **and** key rule satisfied: `openai` accepts a missing
  key (local servers: Ollama/LM Studio/vLLM); `google` and `anthropic` require one.
- `listImageModels()/listVideoModels()` = entry models with that kind and `enabled`, mapped
  to `ModelDescriptor` (label = display name or id, `stylesSupported: true`,
  `costTier: "key-credits"`, `frameInput {start:true,end:false}` for image; video models get
  a `videoLimits {duration:{min:1,max:15}, ratios: all AspectKeys, resolutions: all}` —
  the pickers stay fully open since a generic relay's constraints are unknowable; the
  provider rejects what it can't do).
- Generation methods delegate to the format adapter; errors surface as `ProviderError`.

### Config schema

`ProviderConfig` gains one optional field (defaults-merge sanitize pattern, no version
bump — mirrors how `tasks`/`renderTimeouts` were added post-v1):

```ts
customProviders?: CustomProviderEntry[];
interface CustomProviderEntry {
  id: string;              // slug, unique, non-builtin
  label: string;
  format: "openai" | "google" | "anthropic";
  baseUrl: string;         // trimmed; /v1 appended lazily by the format adapter when missing
  apiKey: string | null;
  enabled: boolean;
  models: CustomModelEntry[];   // { model, label?, kind: "image"|"video"|"text"|"off", enabled }
  lastDiscoveredAt?: string;
}
```

### Registry wiring

`registry.ts` keeps the built-in list and appends custom adapters, built from
`getProviderConfig().customProviders`. The cached generation registry is invalidated by a
config revision counter (bumped in `updateProviderConfig`) so a Settings save applies
instantly — same mechanism as `invalidateProviderConfigCache` today. Priority order: keyed
built-ins, then custom providers in list order, then keyless Pollinations fallback.

### Enhancement (text) integration

`resolveEnhanceEngines()` gains a third engine source: for the selected task model, a
custom provider owning that text model (checked first, alongside sogni/pollinations);
the no-selection fallback chain stays sogni → pollinations (free capacity first), with
enabled custom text providers appended last. A shared `customTextComplete(providerId,
modelId, instruction, options)` in `custom.text.ts` talks to the owning adapter's format.
`allTextModelIds()` (task-model validation) and the Settings task picker must include
custom text models.

### API surface

- `POST /api/providers/discover` — body `{id?}` re-fetches models for a saved provider
  using its stored key; `{format, baseUrl, apiKey}` probes an unsaved one. Returns
  discovered models with guessed kinds. Server-side (no CORS, key never echoed back).
  Merge rule on save: existing classifications win; new models arrive pre-guessed
  (`kind`), vanished models are dropped.
- `PATCH` semantics of `/api/settings` extend: `customProviders: {upsert?: entry,
  remove?: id, setModel?: {providerId, model, kind?, enabled?}, …}` ops — exact op shape
  follows the existing patch-merge style (`ProviderSettingsUpdate.customProviders`).
- `GET /api/settings` payload: custom providers rendered as `ProviderView`s with
  `keySupported: true`, masked keys, and their model lists (incl. text models), so the
  existing Providers/Models sections and task picker render them with minimal change.
- `GET /api/models` needs **no changes** — custom models ride the registry.

### Settings UI

Providers pane gains a "Custom providers" block under the built-ins:

- Rows like built-ins (expand → base URL, format badge, masked key editor, Re-discover,
  Delete) plus an "Add provider" form: name, format select, base URL, key → *Fetch
  models* (calls discover with the unsaved form values, previews classified models) →
  *Save provider*.
- Model rows: label + kind select (Image / Video / Text / Off) + enable toggle; kind
  changes write through `setModel` ops. Unknown-format/no-key rows show the standard
  "Needs API key" badge. Mobile: rows stack per the existing flex-col patterns.

## Error handling

- Discovery failures (bad URL, 401, non-JSON) return field-mapped 400s
  (`ProviderSettingsError` style) — the form keeps its values.
- A custom provider whose key is removed renders as unconfigured; its models leave the
  pickers; queued jobs on it fail with the existing "provider not configured" path.
- Deleted/edited provider mid-render: `registry.resolve` misses → existing unknown-model
  failure (same as deleting a built-in model today).
- Per-request failures reuse the shared hardened client semantics (timeouts from render
  timeouts config; POST retries only on rate limits; GET retries 5xx).

## Testing

- **Unit (vitest, no network):** config sanitize/merge for `customProviders`; slug
  validation + collision rejection; classification heuristics; per-format payload/response
  mapping against recorded fixtures (relay video polling incl. Sora fallback, Gemini
  generateContent + Veo operation polling, Anthropic messages); registry ordering +
  revision-based invalidation; enhance engine chain with a custom task model; settings
  service ops (upsert/remove/setModel, key masking, unknown-provider rejection).
- **Live smoke (`scripts/verify-custom-providers.mjs`, mirrors existing verify scripts):**
  against apikey.fan with the fixed key — add as a custom OpenAI-format provider via the
  discover route → assert `grok-imagine-image` classifies as image → one small image
  generation through the custom provider → one tiny chat completion. Google/Anthropic are
  contract-tested only until the user supplies keys (noted in the script output).
- **GUI smoke:** add provider → classify → model appears in composer picker (follows the
  existing playwright patterns; seed config via `/api/settings`).

## Out of scope / later

- More formats (Replicate, fal, Runway, Luma, Kling, MiniMax/Hailuo, ComfyUI) — additive
  entries in the FORMATS registry.
- Streaming text (SSE) for the future /writer page can reuse `generateText` first; stream
  variants are format-level additions.
- Vision moderation over custom providers.
