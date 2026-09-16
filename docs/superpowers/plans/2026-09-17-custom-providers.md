# Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user register generic OpenAI-compatible / Google Gemini / Anthropic gateways (URL + key → discover models → classify as image/video/text) and run image, video, and text generation through them.

**Architecture:** A `ProviderFormat` strategy registry (`lib/providers/custom/formats/`) implements per-wire-format listing + generation; a factory turns stored `CustomProviderEntry` configs into `ImageProvider & VideoProvider & JobProvider` adapters that join the existing registry (revision-counter invalidation). Config persists in `.studio/settings.json` (`customProviders[]`); Settings UI gains a Custom providers block; the enhance engine chain gains custom text engines.

**Tech Stack:** Next.js route handlers, vitest, existing provider contracts (`lib/providers/types.ts`), existing settings flow (`/api/settings` PUT → `applyProviderSettingsUpdate`).

**Spec:** `docs/superpowers/specs/2026-09-17-custom-providers-design.md`
**Worktree:** `.worktrees/custom-providers` (branch `feat/custom-providers`). All paths below are relative to the worktree root.

**Conventions to honor:** SOLID layers (provider adapters never leak HTTP details past the factory); tests colocated `*.test.ts`; vitest via `npx vitest run <file>`; commit after every task; never print API keys; the `apiKeyFanProvider` (`lib/providers/apikey-fan/`) is the reference adapter to mirror in shape and error-copy style.

---

### Task 1: Config schema — `customProviders[]` + revision counter

**Files:**
- Modify: `lib/repositories/provider-config.repository.ts`
- Test: `lib/repositories/provider-config.repository.test.ts`

- [ ] **Step 1: Failing tests** — add to the existing test file:

```ts
import {
  getDefaultProviderConfig,
  getConfigRevision,
  mergeProviderConfigPatch,
  // existing imports…
} from "./provider-config.repository";

describe("customProviders config", () => {
  const entry = {
    id: "my-relay",
    label: "My Relay",
    format: "openai" as const,
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-test",
    enabled: true,
    models: [
      { model: "gpt-image-1", label: "GPT Image", kind: "image" as const, enabled: true },
      { model: "grok-4.5", kind: "text" as const, enabled: false },
    ],
  };

  it("defaults to an empty list", () => {
    expect(getDefaultProviderConfig().customProviders).toEqual([]);
  });

  it("upsert adds then replaces by id", () => {
    mergeProviderConfigPatch({ customProviders: { upsert: entry } });
    // merge is pure: assert on returned value instead
    const merged = mergeProviderConfigPatch({ customProviders: { upsert: entry } });
    expect(merged.customProviders).toHaveLength(1);
    const replaced = mergeProviderConfigPatch({
      customProviders: { upsert: { ...entry, label: "Renamed" } },
    });
    expect(replaced.customProviders).toHaveLength(1);
    expect(replaced.customProviders[0].label).toBe("Renamed");
  });

  it("setModel mutates kind and enabled", () => {
    const merged = mergeProviderConfigPatch({
      customProviders: { upsert: entry },
    });
    const next = mergeAfter(merged, {
      customProviders: { setModel: { providerId: "my-relay", model: "grok-4.5", kind: "text", enabled: true } },
    });
    expect(next.customProviders[0].models[1]).toMatchObject({ kind: "text", enabled: true });
  });

  it("remove drops the entry", () => {
    const merged = mergeProviderConfigPatch({ customProviders: { upsert: entry } });
    const next = mergeAfter(merged, { customProviders: { remove: "my-relay" } });
    expect(next.customProviders).toHaveLength(0);
  });

  it("getConfigRevision bumps on updateProviderConfig", () => {
    const before = getConfigRevision();
    updateProviderConfig({ tasks: { enhance: null } });
    expect(getConfigRevision()).toBeGreaterThan(before);
  });
});

// helper in test file: applies a patch starting from a given config by
// pointing overridePath at a temp file seeded with that config (existing
// test helpers in this file already do temp-path seeding — reuse them).
```

- [ ] **Step 2: Run** `npx vitest run lib/repositories/provider-config.repository.test.ts` → new tests FAIL (`getConfigRevision` not exported, merge ignores `customProviders`).
- [ ] **Step 3: Implement** in the repository:

```ts
export const CUSTOM_FORMATS = ["openai", "google", "anthropic"] as const;
export type CustomProviderFormat = (typeof CUSTOM_FORMATS)[number];
export type CustomModelKind = "image" | "video" | "text" | "off";

export interface CustomModelEntry {
  model: string;
  label?: string;
  kind: CustomModelKind;
  enabled: boolean;
}

export interface CustomProviderEntry {
  id: string;
  label: string;
  format: CustomProviderFormat;
  baseUrl: string;
  apiKey: string | null;
  enabled: boolean;
  models: CustomModelEntry[];
  lastDiscoveredAt?: string;
}

export interface CustomProvidersPatch {
  upsert?: CustomProviderEntry;
  remove?: string;
  setModel?: { providerId: string; model: string; kind?: CustomModelKind; enabled?: boolean };
}

// ProviderConfig gains: customProviders: CustomProviderEntry[]  (always an array after sanitize)
// ProviderConfigPatch gains: customProviders?: CustomProvidersPatch
```

`getDefaultProviderConfig` adds `customProviders: []`. `mergeProviderConfigPatch` clones
`customProviders: current.customProviders.map(e => ({...e, models: e.models.map(m => ({...m}))}))`
then applies ops in order: `upsert` (replace by id or append), `remove` (filter),
`setModel` (find entry by id, find model, patch kind/enabled). Add module-level
`let configRevision = 0` + `export function getConfigRevision()`; bump it inside
`updateProviderConfig` and in `setProviderConfigPathForTests`/`resetProviderConfigForTests`.
`sanitizeLoadedConfig` parses `obj.customProviders` defensively: keep only entries where
`id` matches `/^[a-z0-9][a-z0-9-]{1,31}$/`, `format` is in CUSTOM_FORMATS, `baseUrl` is a
string; coerce `models` to valid entries (`model` non-empty string, `kind` valid, `enabled`
boolean default false); unknown fields dropped.

- [ ] **Step 4: Run** again → PASS (whole file).
- [ ] **Step 5: Commit** `feat(config): customProviders[] schema with op-based patches and revision counter`.

### Task 2: Format contract, classifier, hardened HTTP helper

**Files:**
- Create: `lib/providers/custom/formats/types.ts`, `lib/providers/custom/formats/classify.ts`, `lib/providers/custom/http.ts`
- Test: `lib/providers/custom/formats/classify.test.ts`, `lib/providers/custom/http.test.ts`

- [ ] **Step 1: `types.ts`** (pure types, no test needed):

```ts
import type { GeneratedArtifact, ProviderContext, TextGenerationRequest, TextGenerationResult } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";

export type DiscoveredKind = "image" | "video" | "text" | "off";
export interface DiscoveredModel { model: string; label?: string; kind: DiscoveredKind; }

export interface VideoJobPair {
  submit(request: NormalizedGenerationRequest, model: ModelDescriptor, ctx: ProviderContext): Promise<{ ref: string }>;
  poll(ref: string, request: NormalizedGenerationRequest, model: ModelDescriptor, ctx: ProviderContext): Promise<JobPollResult>;
}
// (JobPollResult from @/lib/providers/types — import it)

export interface ProviderFormat {
  readonly id: CustomProviderFormat; // from provider-config.repository
  readonly label: string;
  readonly capabilities: { image: boolean; video: boolean; text: boolean };
  listModels(cfg: CustomProviderEntry): Promise<DiscoveredModel[]>;
  generateImage?(cfg: CustomProviderEntry, request: NormalizedGenerationRequest, model: ModelDescriptor, ctx: ProviderContext): Promise<GeneratedArtifact[]>;
  videoJobs?(cfg: CustomProviderEntry): VideoJobPair;
  generateText?(cfg: CustomProviderEntry, request: TextGenerationRequest): Promise<TextGenerationResult>;
}
```

Note: `CustomProviderFormat` lives in the repository (Task 1) — if the import direction
feels inverted (providers importing from repositories), re-export the type from here and
import elsewhere from `formats/types`. Keep one definition site.

- [ ] **Step 2: `classify.test.ts`** then **`classify.ts`**:

```ts
// classify.test.ts
import { classifyModelId, guessEntry } from "./classify";
describe("classifyModelId", () => {
  it.each([
    ["gpt-image-1", "image"], ["imagen-4.0", "image"], ["flux-pro", "image"],
    ["grok-imagine-image", "image"], ["stable-diffusion-3.5", "image"],
    ["grok-imagine-video-1.5", "video"], ["veo-3.1-generate", "video"],
    ["sora-2", "video"], ["kling-v2", "video"],
    ["grok-4.5", "text"], ["gpt-4.1", "text"], ["claude-sonnet-4", "text"],
    ["qwen3.5-35b", "text"], ["my-weird-model", "off"],
  ])("%s → %s", (input, expected) => expect(classifyModelId(input)).toBe(expected));
});
describe("guessEntry", () => {
  it("enables guessed image/video, leaves text and off disabled", () => {
    const models = guessEntry([
      { model: "flux-pro" }, { model: "veo-3" }, { model: "grok-4.5" }, { model: "mystery" },
    ]);
    expect(models).toEqual([
      { model: "flux-pro", kind: "image", enabled: true },
      { model: "veo-3", kind: "video", enabled: true },
      { model: "grok-4.5", kind: "text", enabled: false },
      { model: "mystery", kind: "off", enabled: false },
    ]);
  });
});
```

Implementation: video patterns first `/video|veo|sora|kling|hailuo|seedance|runway|pika/i`,
then image `/image|imagen|flux|dall|sd3|sdxl|stable-diff|kolors|seedream|banana/i`,
else text; a model matching NEITHER list confidently → the heuristics above still return
`text` for unknown ids… careful: spec says unknown models default `off`. Split: confident
text = matches `/gpt|grok|claude|gemini|qwen|llama|deepseek|mistral|sonnet|opus|haiku|4\.\d|build/i`
or the id matched no image/video pattern — decision: unknown → `"off"`, so `classifyModelId`
returns `"off"` when no pattern matched AND no text pattern matched; keep table above consistent
(`my-weird-model → off`). `guessEntry(list: {model, label?}[]): CustomModelEntry[]` maps
kind via classifyModelId, `enabled: kind === "image" || kind === "video"`, keeps label.

- [ ] **Step 3: `http.test.ts`** then **`http.ts`** — mirror `lib/providers/apikey-fan/client.ts`
  semantics (Bearer auth, JSON, 429/408 retry on POST, 5xx retry on GET only, timeout via
  `AbortSignal.timeout` combined with caller signal, `ProviderError` mapping) but with
  neutral error copy that names the provider label. Injectable fetch for tests:

```ts
export interface HttpTarget { baseUrl: string; apiKey: string | null; label: string; }
export interface HttpCall {
  method?: "GET" | "POST";
  path: string;                       // appended verbatim to baseUrl
  body?: unknown;
  headers?: Record<string, string>;   // extra headers (google/anthropic auth variants)
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
}
export type FetchImpl = typeof fetch;
export function httpJson<T>(target: HttpTarget, call: HttpCall, fetchImpl: FetchImpl = fetch): Promise<T>;
// 401 → ProviderError(`The ${label} API key was rejected.`, {retryable:false, status:401})
// 404 → ProviderError(`That endpoint was not found on ${label}.`, {retryable:false, status:404})
// 429 → retryable; ≥500 retryable for GET; network/timeout → retryable
```

Tests: fake `fetchImpl` returns scripted Responses; assert auth header, body JSON,
retry-on-429 (2 calls), no-retry-on-400, 401 message, timeout path via aborted signal.

- [ ] **Step 4: Run** `npx vitest run lib/providers/custom/` → PASS.
- [ ] **Step 5: Commit** `feat(custom): format contract, model-kind classifier, hardened HTTP helper`.

### Task 3: `openai` format adapter

**Files:**
- Create: `lib/providers/custom/formats/openai.ts`
- Test: `lib/providers/custom/formats/openai.test.ts`

- [ ] **Step 1: Failing tests** — fake fetch, one test per behavior:

```ts
import { createOpenAiFormat } from "./openai";
const cfg = (baseUrl = "https://relay.example/v1"): CustomProviderEntry => ({ id: "relay", label: "Relay", format: "openai", baseUrl, apiKey: "sk-x", enabled: true, models: [] });
const fetchJson = (routes: Record<string, unknown>) => async (url: string) =>
  new Response(JSON.stringify(routes[new URL(url).pathname] ?? {}), { status: 200 });
```

1. `listModels` GETs `{base}/models` (base already ends `/v1`) → maps `data[].id`;
   base without `/v1` gets it appended (assert requested URL).
2. `generateImage` POSTs `/images/generations` `{model, prompt, n, size, response_format:"b64_json"}`
   with size from aspect (`ASPECTS[aspect].width×height`); response `data[].b64_json` →
   `GeneratedArtifact{bytes, ext:"png", seed}`; `revised_prompt` carried; `url`-only items →
   `bytes:null, url` set.
3. start frame present → POSTs `/images/edits` with `image: {url: dataUri}`; 400 →
   falls back to `/images/generations` and artifact gets `frameDropped: true`.
4. image 400 without frame → retries once WITHOUT `size`, then succeeds.
5. `videoJobs.submit` POSTs `/videos/generations` `{model, prompt, duration, image?{url}}`
   → `{request_id}` → `{ref: requestId}`; 404 → POSTs `/videos` `{model, prompt, seconds}`
   → `{id}`; start frame on the fallback → `frameDropped` flagged via ref suffix `~f`.
6. `videoJobs.poll` GET `/videos/{id}`: relay shape `{status:"done", video:{url:"/v1/videos/x/content"}}`
   → downloads bytes (fake fetch returns mp4 magic bytes) → completed artifact `ext:"mp4"`;
   `{status:"failed"}` → failed result; `{status:"running"}`-ish → running result;
   Sora shape `{status:"completed"}` → GET `/videos/{id}/content` → completed;
   `~f` ref → artifact `frameDropped: true`.
7. `generateText` POST `/chat/completions` `{model, messages:[…system?,…user], max_tokens?, temperature?}`
   → `choices[0].message.content`; strips `relay:` prefix from modelId if present (no —
   model ids here are raw; the factory passes raw model).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — constants:

```ts
const ASPECT_SIZE: Record<AspectKey, string> = {
  "16:9": "1280x720", "9:16": "720x1280", "1:1": "1024x1024", "4:5": "896x1120", "3:2": "1200x800",
};
export function resolveOpenAiBase(baseUrl: string): string {
  // append /v1 when the path has no version segment already
  try { const u = new URL(baseUrl);
    if (!/\/v\d+\w*$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, "")}/v1`;
    return u.toString().replace(/\/+$/, "");
  } catch { return baseUrl.replace(/\/+$/, ""); }
}
```

Poll normalizes both shapes:
```ts
const status = body.status; // done|completed|failed|expired|queued|in_progress|running|processing
const finished = status === "done" || status === "completed";
const failed = status === "failed" || status === "expired";
const rawUrl = body.video?.url; // relay; Sora omits → use `/videos/${id}/content`
```
Download with Bearer key + mp4 plausibility re-fetch (port `isPlausibleMp4` retry once from
apikey-fan, 5s wait). `capabilities {image:true, video:true, text:true}`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(custom): OpenAI-compatible format adapter`.

### Task 4: `google` format adapter (Gemini)

**Files:**
- Create: `lib/providers/custom/formats/google.ts`
- Test: `lib/providers/custom/formats/google.test.ts`

- [ ] **Step 1: Failing tests** (same fake-fetch pattern; auth header `x-goog-api-key`):
1. `listModels` GET `{base}/v1beta/models` → items `{name:"models/gemini-2.5-flash", displayName, supportedGenerationMethods:["generateContent"]}` → keep only methods containing `generateContent` or `predictLongRunning`; kind: `predictLongRunning`→video; `/imagen|image|banana/` in name→image; else text. `model` field strips `models/` prefix.
2. `generateText` POST `/v1beta/models/{m}:generateContent` `{contents:[{parts:[{text}]}], systemInstruction?{parts:[{text}]}, generationConfig:{temperature, maxOutputTokens}}` → joins `candidates[0].content.parts[].text`.
3. `generateImage` POST `:generateContent` with `generationConfig.responseModalities:["TEXT","IMAGE"]`; start frame → input `parts` gain `{inlineData:{mimeType, data}}` (base64 of FrameImage bytes); response parts `inlineData` → artifacts (`bytes` from base64, `ext` from mimeType `image/png`→png).
4. `videoJobs.submit` POST `/v1beta/models/{m}:predictLongRunning` `{instances:[{prompt, image?{bytesBase64Encoded, mimeType}}], parameters:{aspectRatio? only for 16:9/9:16}}` → `{name}` → ref.
5. `videoJobs.poll` GET `/v1beta/{ref}` → `!done` → running; `done` + `response.generateVideoResponse.generatedSamples[0].video.uri` OR `response.videos[0].{uri|bytesBase64Encoded}` → download uri with `x-goog-api-key` header (or decode base64) → completed; `done` + `error` → failed.

- [ ] **Step 2–4:** implement, run to green. Base rule: format calls use the stored base URL as-is + `/v1beta/...` paths (Google base is the API root).
- [ ] **Step 5: Commit** `feat(custom): Google Gemini format adapter (text, image, Veo video)`.

### Task 5: `anthropic` format adapter (text-only)

**Files:**
- Create: `lib/providers/custom/formats/anthropic.ts`
- Test: `lib/providers/custom/formats/anthropic.test.ts`

- [ ] **Step 1–4:** tests first: `listModels` GET `/v1/models` (headers `x-api-key`, `anthropic-version: 2023-06-01`) → `data[].id`, kind always `text`; `generateText` POST `/v1/messages` `{model, max_tokens: maxTokens ?? 1024, system?, messages:[{role:"user", content: userPrompt}]}` → join `content[].text` blocks. No image/video (capabilities false, methods absent).
- [ ] **Step 5: Commit** `feat(custom): Anthropic format adapter (text)`.

### Task 6: Format registry + custom provider factory

**Files:**
- Create: `lib/providers/custom/formats/index.ts`, `lib/providers/custom/parked-images.ts`, `lib/providers/custom/custom-provider.factory.ts`
- Test: `lib/providers/custom/custom-provider.factory.test.ts`

- [ ] **Step 1: `formats/index.ts`**:

```ts
import type { CustomProviderFormat } from "@/lib/repositories/provider-config.repository";
import { createOpenAiFormat } from "./openai";
import { createGoogleFormat } from "./google";
import { createAnthropicFormat } from "./anthropic";
export const FORMATS: Record<CustomProviderFormat, ProviderFormat> = {
  openai: createOpenAiFormat(), google: createGoogleFormat(), anthropic: createAnthropicFormat(),
};
export function formatFor(id: CustomProviderFormat): ProviderFormat { return FORMATS[id]; }
```

- [ ] **Step 2: `parked-images.ts`** — module-level `Map<string, GeneratedArtifact[]>` +
  `parkImage(ref, artifacts)`, `takeParkedImage(ref)`; survives adapter-instance rebuilds
  (settings saves mid-render). Ref prefix `cimg_`.
- [ ] **Step 3: Failing factory tests**, then **`custom-provider.factory.ts`**:

```ts
export function createCustomProvider(entry: CustomProviderEntry): ImageProvider & VideoProvider & JobProvider
```

Behavior (mirrors `apiKeyFanProvider`):
- `id = entry.id`, `label = entry.label`.
- `isConfigured()`: `entry.enabled && (entry.apiKey !== null || entry.format === "openai")`.
- `listImageModels()/listVideoModels()`: entry.models with matching kind + `enabled`,
  mapped to `ModelDescriptor {id: `${entry.id}:${m.model}`, providerId: entry.id, kind,
  model: m.model, label: m.label ?? m.model, stylesSupported: true, costTier: "key-credits",
  frameInput: {start:true, end:false}}`; video adds
  `videoLimits {duration:{min:1,max:15}, ratios: Object.keys(ASPECTS), resolutions: Object.keys(RESOLUTIONS)}`.
- `generateImage`: `formatFor(entry.format).generateImage?.(...)`; missing → `ProviderError("This provider does not support image generation.", {retryable:false, field:"model"})`.
- `generateVideo`: `driveJobToDeadline({provider: this, providerLabel: entry.label, kind:"video", deadlineMs: getStudioEnv().videoRenderDeadlineMs, …})`.
- `submitJob`: video → `formatFor(...).videoJobs(entry).submit(...)`; image → `await this.generateImage(...)` then `parkImage(ref, artifacts)` with `ref = cimg_${entry.id}_${Date.now().toString(36)}_…`; pollJob mirrors apikey-fan's parked-image branch + delegates video to format's poll.
- `textComplete(instruction, options)`: `formatFor(...).generateText` with
  `{systemPrompt: DEFAULT_TEXT_SYSTEM (same copy as sogni.text), userPrompt: instruction, modelId: raw model, signal}` → `.text`; 25s timeout inside formats via httpJson timeoutMs.

Tests: descriptor mapping incl. videoLimits; kind filtering + disabled models excluded;
isConfigured matrix (openai keyless ✓, google keyless ✗, disabled ✗); submitJob parks +
pollJob returns parked artifacts once; video delegates to format.videoJobs with fake format
injected via a `createCustomProvider(entry, format?)` second arg defaulting to `formatFor(entry.format)`.
- [x] **Commit** `feat(custom): provider factory bridging formats onto provider contracts`.

### Task 7: Registry wiring

**Files:**
- Modify: `lib/providers/registry.ts`
- Test: `lib/providers/registry.wiring.test.ts` (extend)

- [ ] **Step 1: Failing tests**: with `setProviderConfigPathForTests(tmp)` + a config file containing one custom entry (openai, one image + one video + one text model): `getGenerationRegistry().listModels("image")` contains `my-relay:my-image` AFTER the built-ins; `resolve("my-relay:my-image")` returns the custom provider; disabling the entry (rewrite config + revision bump) removes it without process restart; customs come before pollinations in order. Also `provider-settings.service.getProviderSettings()` (Task 8 asserts too — keep registry tests focused on registry).
- [ ] **Step 2: Implement**: in `registry.ts`

```ts
function buildCustomProviders(): AnyProvider[] {
  return getProviderConfig().customProviders.map(createCustomProvider);
}
let customRevision = -1;
let customProviders: AnyProvider[] = [];
function providersWithCustom(): AnyProvider[] {
  const revision = getConfigRevision();
  if (revision !== customRevision) { customProviders = buildCustomProviders(); customRevision = revision; }
  return [...registeredProviders.slice(0, 2), ...customProviders, registeredProviders[2]];
  // explicit order: apikey-fan, sogni, customs…, pollinations — do NOT hardcode indices;
  // compute: builtins = getRegisteredProviders(); keyed = builtins.filter(p => p.id !== "pollinations");
  // fallback = builtins.filter(p => p.id === "pollinations");
}
```

`getGenerationRegistry()` swaps its cached-registry check to compare `getConfigRevision()`
(same rebuild-on-change pattern). `setProvidersForTests` resets the custom cache too.
The dynamic gate ignores customs (lookup misses → allowed; model-level enablement already
handled by the factory's list filtering).
- [x] **Run** full `npx vitest run lib/providers/` → green. **Commit** `feat(registry): custom providers join the generation registry with revision-based reload`.

### Task 8: Settings service — views + validated ops

**Files:**
- Modify: `lib/services/provider-settings.service.ts`
- Test: `lib/services/provider-settings.service.test.ts` (extend)

- [ ] **Step 1: Failing tests** (seed config via existing temp-path helper):
1. `getProviderSettings()` with one custom entry → payload.providers includes
   `{id:"my-relay", label, enabled, keySupported:true, keyOptional:false, keySource:"settings", keyMasked:"••••key", models:[image/video views with id `my-relay:x`], textModels:[…], format:"openai"}`.
2. `applyProviderSettingsUpdate({customProviders:{upsert: valid}})` persists; invalid slug /
   builtin-id collision / bad format / bad baseUrl / duplicate model ids / bad kind →
   `ProviderSettingsError` with `field:"customProviders"`.
3. `setModel` unknown provider or model → error; valid → persisted.
4. `remove` unknown → error.
5. `tasks.enhance` accepts a custom text model id; unknown still rejected.
6. "at least one provider enabled" check counts enabled customs.
7. api keys never echoed: `keyMasked` only.

- [ ] **Step 2: Implement**:
- `ProviderView` gains `format?: CustomProviderFormat; keyOptional?: boolean;` and `id: string` (widen from `ProviderId` — internal lookups that index `config.providers[id]` must branch on built-in vs custom; keep a `BUILTIN_IDS` guard).
- After the built-in loop, append views built from `config.customProviders` (models from the entry itself — no registry lookup needed; this keeps views stable even when the key is missing).
- `keyView` gains a custom branch (settings-only source).
- `applyProviderSettingsUpdate` handles `raw.customProviders` ops with the validations from the tests; upsert normalizes (trim id/label/baseUrl/model ids/labels, dedupe models by id, default enabled:false for models without the flag, `lastDiscoveredAt: new Date().toISOString()` on discovery-driven upserts passed through from the caller).
- `allTextModelIds()` + `knownModelIds()` include custom entries (text models).
- Enabled-count check: built-ins enabled + custom entries enabled ≥ 1.
- **Commit** `feat(settings): custom provider views and validated upsert/remove/setModel ops`.

### Task 9: Discovery service + route

**Files:**
- Create: `lib/providers/custom/discovery.service.ts`, `app/api/providers/discover/route.ts`
- Test: `lib/providers/custom/discovery.service.test.ts`

- [ ] **Step 1: Failing tests** (inject a fake formats map):
1. `{format:"openai", baseUrl:"https://x/v1", apiKey:"k"}` → format.listModels called with an
   equivalent entry → returns guessed `CustomModelEntry[]` via `guessEntry`, `lastDiscoveredAt` set.
2. `{id:"my-relay"}` → uses stored entry + key; merge: existing model keeps `{kind, enabled, label}`,
   new models appended guessed, vanished dropped.
3. explicit `apiKey` in body overrides stored key (re-discover with a new key).
4. format 401 → error carries `field:"apiKey"`; 404/timeout → `field:"baseUrl"`;
   unknown format → 400.
5. Route test (optional, follow `app/api/settings` route test pattern if one exists — otherwise
   cover via service tests only): POST body passthrough + error mapping.

- [ ] **Step 2: Implement**:

```ts
export interface DiscoveredProviderPayload { models: CustomModelEntry[]; lastDiscoveredAt: string; }
export async function discoverProviderModels(
  input: { id?: string; format?: string; baseUrl?: string; apiKey?: string },
  formats: Record<string, ProviderFormat> = FORMATS,
): Promise<DiscoveredProviderPayload>
```

Route `app/api/providers/discover/route.ts`: `runtime = "nodejs"`, POST → JSON body →
service → `NextResponse.json({models…})`; `ProviderError` → 400/502 with `{error, field}`;
unexpected → 500. No key ever included in the response.
- [x] **Run** green. **Commit** `feat(discovery): server-side model discovery with kind guessing and merge-on-rediscover`.

### Task 10: Enhance engine integration

**Files:**
- Create: `lib/providers/custom/custom.text.ts`
- Modify: `lib/services/enhancement.service.ts`
- Test: `lib/services/enhancement.service.test.ts` (extend)

- [ ] **Step 1: Failing tests** (config seeded with a custom provider holding `grok-4.5`
  as an enabled text model):
1. `tasks.enhance = "my-relay:grok-4.5"` → `resolveEnhanceEngines()` first entry is the
   custom engine (providerId `"my-relay"`); running `runPromptEnhancement` hits the fake
   format (inject via a test seam: export `resolveEnhanceEngines` and assert on entries;
   engine `complete` calls `customTextComplete` → mock at module boundary with `vi.mock`).
2. No selection → chain sogni → pollinations → custom providers (custom appended last,
   one entry per enabled custom text provider, first enabled text model).
3. Custom provider disabled or model disabled → excluded.

- [ ] **Step 2: Implement** `custom.text.ts`:

```ts
export async function customTextComplete(providerId: string, instruction: string,
  options?: { signal?: AbortSignal; modelId?: string }): Promise<string>
// loads entry from config; finds adapter via createCustomProvider(entry) (or format directly);
// generateText({userPrompt: instruction, systemPrompt: DEFAULT_TEXT_SYSTEM, modelId: raw, signal});
// returns .text; entry missing → ProviderError(retryable:false)
```

`resolveEnhanceEngines()` in the service: extend `EngineEntry.providerId: string`; selected-model
branch checks custom entries (match `${entry.id}:${m.model}`) before/alongside sogni+pollinations;
fallback chain appends customs. `log` lines keep `engine` field working (string ids).
- [x] **Run** `npx vitest run lib/services/` → green. **Commit** `feat(enhance): custom text models join the enhancement engine chain`.

### Task 11: Settings UI — Custom providers block

**Files:**
- Create: `components/settings/CustomProvidersSection.tsx`
- Modify: `app/settings/page.tsx`, `components/settings/ProvidersSection.tsx` (statusOf `keyOptional`), possibly `components/settings/GeneralSection.tsx` (group label for custom entries in enhance picker — verify options rendering tolerates non-builtin provider ids; expected yes)
- Test: GUI verification only (Task 12)

- [ ] **Step 1: Read** `app/settings/page.tsx` and `GeneralSection.tsx` first; mirror the existing
  section composition, `SectionShell`, Toggle/Badge/Button imports, and the PATCH helper.
- [ ] **Step 2: Implement**:

- `ProvidersSection`: `statusOf` gains keyless-active case: `provider.keySource || !provider.keySupported || provider.keyOptional → Active`.
- `CustomProvidersSection({providers, onUpdate, onDiscover})`: 
  - Rows per custom provider (expand → base URL read-only + format Badge + KeyEditor-like
    key input + Re-discover + Delete buttons; model table below: label input? NO — label
    edit dropped for v1, show label text) — model rows: name, kind `<select>` (Image/Video/Text/Off),
    enable `<Toggle>`; each change → `onUpdate({customProviders:{setModel:{providerId, model, kind?, enabled?}}})`.
  - AddProviderForm (collapsed by default): name, format select (OpenAI-compatible / Google Gemini / Anthropic),
    base URL, API key (password), **Fetch models** → `onDiscover({format, baseUrl, apiKey})`
    → preview list of classified models (kind badges) → **Save provider** →
    `onUpdate({customProviders:{upsert: entry}})` (models from preview with user-adjusted kinds;
    entry id = slugified name, uniqueness enforced client-side with a counter suffix fallback).
  - Re-discover: `onDiscover({id})` then `onUpdate({customProviders:{upsert: mergedEntry}})`
    (merge already computed server-side — the discover response for `{id}` returns the merged
    model list, so upsert takes `{...entry, models, lastDiscoveredAt}`).
  - Errors from discover → toast (existing `useToast`).
- `app/settings/page.tsx`: render `<CustomProvidersSection>` under `<ProvidersSection>`
  in the Providers pane; add `discover` async helper hitting `POST /api/providers/discover`.
  Mobile: reuse existing stacking (`flex-col` patterns from shared.tsx).
- [x] **Commit** `feat(settings-ui): custom provider management block`.

### Task 12: Live smoke + env fix + full verification

**Files:**
- Create: `scripts/verify-custom-providers.mjs`
- Modify: `.env.local` (main tree + worktree copy): strip the `ss//` artifact from `APIKEY_FAN_API_KEY`

- [ ] **Step 1:** `sed -i '' 's|APIKEY_FAN_API_KEY=ss//|APIKEY_FAN_API_KEY=|' .env.local` (both trees); verify with a dry `/v1/models` curl (never print the key).
- [ ] **Step 2: Live smoke script** (model on `scripts/verify-character-sheet.mjs` — read it first for server boot/port conventions; dev port 3100):
  1. PUT `/api/settings` `customProviders.upsert {id:"verify-relay", label:"Verify Relay", format:"openai", baseUrl:"https://apikey.fan/v1", apiKey:$APIKEY_FAN_API_KEY, enabled:true, models:[]}`
  2. POST `/api/providers/discover {id:"verify-relay"}` → assert `grok-imagine-image` kind image,
     `grok-imagine-video-1.5` kind video, `grok-4.5` kind text; assert ≥10 models.
  3. GET `/api/models?kind=image` → contains `verify-relay:grok-imagine-image`.
  4. POST `/api/generate` (mirror payload shape from an existing verify script; model
     `verify-relay:grok-imagine-image`, count 1, simple prompt) → poll `/api/jobs/[id]` until done
     (timeout 120s) → assert media artifact path exists.
  5. PUT `/api/settings` `tasks.enhance = "verify-relay:grok-4.5"` → POST `/api/enhance {prompt:"a red apple"}` → `source:"ai"`.
  6. Cleanup: PUT `/api/settings` `customProviders.remove:"verify-relay"`, `tasks.enhance:null`.
     Print PASS/FAIL summary; exit code accordingly.
- [ ] **Step 3:** full `npx vitest run` (all suites green, count reported), `npx tsc --noEmit`, `npm run lint` if configured.
- [ ] **Step 4:** browser GUI check: add a fake-key provider → discover fails with field error toast; kind select round-trip persists. (Playwright script or manual via dev server; capture what was verified.)
- [ ] **Step 5: Commit** `test(verify): custom providers live smoke + env key artifact fix`.

### Task 13: Merge + wrap-up

- [ ] **Step 1:** re-run full suite in worktree; `git add -A && git commit` any stragglers.
- [ ] **Step 2:** merge to master (`git checkout master && git merge --no-ff feat/custom-providers`), run suite once on master, remove worktree (`git worktree remove .worktrees/custom-providers`), delete branch.
- [ ] **Step 3:** update memory (`custom-providers-spec.md` → implemented/merged state + gotchas), close out todos.

## Self-review notes

- Spec coverage: formats ✓(T3–5), discovery+classification ✓(T2,9), factory/registry ✓(T6–7), settings service/UI ✓(T8,11), enhance ✓(T10), video per platform ✓(T3–5), env fix ✓(T12), live smoke ✓(T12). Non-goals respected (no extra formats, moderation untouched).
- Type consistency: `CustomProviderEntry`/`CustomModelEntry` defined once in the repository (T1) and imported everywhere; `ProviderFormat` in `formats/types.ts`; `FORMATS` registry is the single format source for service + route.
- Watch-outs carried into execution: widen `ProviderView.id` carefully (built-in lookups index `config.providers[id]` — branch on `BUILTIN_IDS`); executor resolves providers per poll so module-level parked-images survives settings saves; never log or echo keys.
