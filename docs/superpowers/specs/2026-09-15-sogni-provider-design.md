# Sogni AI Provider — Design

Date: 2026-09-15
Status: approved

## Goal

Add Sogni AI as a third generation provider (images + video), following the
established provider-adapter pattern (apikey.fan + Pollinations fallback). No
existing behavior changes beyond registry ordering and one provider-aware error
message.

## Verified API facts (from the official SDK source, `Sogni-AI/sogni-client`)

- Endpoints: REST `https://api.sogni.ai`, WebSocket `wss://socket.sogni.ai`.
  Project generation requires the WebSocket connection; REST-only mode cannot
  generate.
- Auth: `apiKey` config (auto-authenticates) plus a per-installation `appId`.
  Only **one connection per appId** is allowed → server-side singleton client.
  `appId` should be stable across restarts → env override, else generated UUID
  persisted next to the media cache.
- Generation: `projects.create(params)` → `project.waitForCompletion()` →
  `string[]` result URLs; results expire after 24h, so artifacts are returned
  as URLs and the service's existing `materializeArtifact` path downloads and
  caches them server-side (same as apikey.fan's object-storage links).
- Params (verified types): `type: 'image' | 'video'`, `modelId`,
  `positivePrompt`, `negativePrompt` (accepted by LTX/WAN/SD families, **not**
  by Seedance → fold into prompt like apikey.fan), `numberOfMedia`, `seed`
  (Uint32, applies to the first image only), `disableNSFWFilter`,
  `tokenType`, `network` ('fast' | 'relaxed'; video requires 'fast'),
  images: `sizePreset` + `width`/`height` (custom), `outputFormat`
  ('png'|'jpg'|'webp'); video: `ratio` ('adaptive'|'16:9'|'4:3'|'1:1'|'3:4'|'9:16'),
  `duration` (family-specific ranges: WAN 1–10, LTX 2.5 2–20, Seedance 2.0 4–15),
  `outputFormat` ('mp4').
- Model ids verified: images `krea2_turbo_fp8_scaled`, `flux1-schnell-fp8`,
  `z_image_turbo_bf16`, `chroma1-hd_fp8_scaled`; video
  `wan_v2.2-14b-fp8_t2v_lightx2v`, `ltx25-22b-int8_t2v_distilled`,
  `seedance-2-0-mini`.
- Free tier: email-verified accounts get 400 Spark render credits/month
  (usable with Krea 2 Turbo).

## Approach

Use the official `@sogni-ai/sogni-client` SDK inside a thin adapter.
Hand-rolling the socket protocol (undocumented, EIP712 auth, replay) was
rejected; REST-only polling cannot generate.

## Components

1. **`lib/config/env.ts`** — add `sogniApiKey` (null when unset → provider
   disabled), `sogniAppId` (null → generated + persisted in `mediaCacheDir`),
   `sogniRestUrl`, `sogniSocketUrl` (defaults above).
2. **`lib/providers/sogni/request-maps.ts`** — `PROVIDER_ID = "sogni"`, model
   catalog (4 image + 3 video), payload mapping:
   - image: `sizePreset: 'custom'`, width/height = aspect dims × resolution
     scale rounded to 8px, `disableNSFWFilter = !safe`, `numberOfMedia = count`,
     `seed >>> 0`, `outputFormat: 'png'`.
   - video: `ratio` map (4:5→3:4, 3:2→4:3), per-model duration clamp,
     `outputFormat: 'mp4'`; negative prompt folded into `positivePrompt` for
     Seedance only.
   - All projects use `network: 'fast'` (video requires it; keeps one code
     path). `steps`/`guidance` omitted → server defaults.
3. **`lib/providers/sogni/client.ts`** — lazily dynamic-imports the SDK,
   `SogniClient.createInstance({ appId, apiKey, network: 'fast', restEndpoint,
   socketEndpoint })`, memoized module singleton; test seam to inject a fake.
4. **`lib/providers/sogni/sogni.provider.ts`** — implements `ImageProvider &
   VideoProvider`: `isConfigured` = API key present; generation =
   `projects.create` → `waitForCompletion()` raced against a deadline inside
   the route's `maxDuration` (180s images / 240s video) and the request
   `AbortSignal`; result URLs → artifacts `{ bytes: null, url, ext, seed }`;
   SDK failures mapped to `ProviderError`.
5. **`lib/providers/registry.ts`** — order `[apiKeyFan, sogni, pollinations]`
   (keyed first, keyless fallback last).
6. **`lib/services/generation.service.ts`** — the hardcoded "needs the
   apikey.fan API key" message becomes provider-aware (`provider.label`).
7. **`next.config.ts`** — `serverExternalPackages: ["@sogni-ai/sogni-client"]`
   so the SDK's `ws` dependency stays external to the Next bundle.

No UI changes: the model pill reads the registry. Keys are env-gated like
apikey.fan (`SOGNI_API_KEY`, `SOGNI_APP_ID`, optional `SOGNI_REST_URL`,
`SOGNI_SOCKET_URL`).

## Error handling

- Unconfigured → provider absent from `listModels` (existing registry rule);
  generating a sogni model id unconfigured → provider-aware `field: "model"`
  error.
- Unconfigured generate call → `ProviderError` with `retryable: false` and
  `field: "model"` (same shape as apikey.fan).
- `waitForCompletion` rejection → `ProviderError(message, { retryable: true,
  status: 502 })`.
- Deadline exceeded → retryable timeout error (jobs keep running server-side;
  Sogni results survive 24h).

## Testing

- `request-maps.test.ts`: catalog ids, image size math + NSFW flag + seed
  clamp, video ratio/duration mapping, Seedance negative folding.
- `sogni.provider.test.ts`: fake client (injected via test seam) — config
  gating, artifact mapping, abort/timeout, error mapping.
- Existing suites stay green; registry unchanged (fakes only).

## Out of scope

- `relaxed` network (cost lever) and `tokenType` selection — both omitted,
  server defaults apply; revisit after live pricing data.
- Audio/LLM/3D-model capabilities of Sogni.
