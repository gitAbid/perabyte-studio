# Smart Masking — Content-Aware 18+ Gating via Vision LLM

Date: 2026-09-16 · Status: **implemented** (merged d8c39fa, 2026-09-16; plan
`docs/superpowers/plans/2026-09-16-smart-masking.md`). Verified live: image_url
data-URI parts accepted, 1024px inline-image cap (handled via sharp downscale),
502-outage degradation end-to-end. Pending: the successful verdict round-trip
(`npm run verify:moderation <safe> <explicit>`) — Sogni's LLM gateway was down
for the whole test window.

## 1. Problem

Preview masking (the 18+ blur + "Show" veil) is currently keyed to a
**generation-time flag**, not to the content:

- `isSensitiveAsset()` → `asset.settings.safe === false` (`lib/domain/models.ts:119`)
- story scenes → `scene.safe === false` (`lib/types.ts:108`)
- solo in-flight/current render → live `settings.safe === false` (`components/GeneratorScreen.tsx:543`)
- `useMediaMask()` blurs iff `sensitive && settings.maskUncensored && !revealed` (`components/Media.tsx:25`)

`sensitive` means "rendered with the safety checker off". Two failure modes
follow:

1. **False masks** — an Uncensored-Mode render of a tame prompt (portrait,
   landscape) is blurred forever, even though nothing 18+ is in frame.
2. **False opens** — a safe-mode render can still produce explicit output
   (models are probabilistic; the provider safety checker gates *generation*,
   not the pixels we preview). Those show unmasked.

The goal: decide "does **this** image need the veil?" from the actual pixels,
using a multimodal LLM, with today's static flag kept as the pre-verdict
default and the failure fallback.

## 2. Approaches considered

| Approach | Idea | Verdict |
| --- | --- | --- |
| **A. Ref-keyed moderation service + `/api/moderate` (recommended)** | Verdicts are cached by the media-cache ref (the ref is already a sha256 of the bytes). Server service classifies on demand; client fetches lazily; server warms where it owns records. | Content-addressed dedupe for free; no Asset schema change; solo renders are client-created rows so server-side persist hooks can't cover them — lazy fetch does. |
| B. Classify-at-persist, verdict stored on `Asset.moderation` | Server classifies inside the generate route before writing the record. | Solo asset rows are created client-side (`lib/store.ts` mirrors to `/api/assets`), so the server has no row to patch at render time. Requires schema migration + a second write path; rejected. |
| C. Browser calls the vision LLM directly | Client sends the image to Sogni chat completions. | Exposes the API key to the browser; every key in this app is server-side. Rejected. |

Approach A it is, with B's *warm* variant (fire-and-forget classification
where the server does own records: story runner, detached-render absorption)
folded in as an optimization.

## 3. The classifier (specific rubric + result contract)

**Model**: Sogni `deepseek-v4-flash-vision-exp-dspark-1m` (the only
vision-capable model on the verified LLM surface, `docs/sogni-api-guide.md`
§LLM surface). Rides the existing subscription; no per-call charge observed.
Called through the same `POST /v1/chat/completions` endpoint as Enhance.

**Step 0 spike (must run first, before any feature code)**: live-verify that
this model accepts OpenAI-style `image_url` parts with a `data:` URI and
returns parseable JSON. Results recorded in `docs/sogni-api-guide.md`. If
image input is unsupported, the feature stays dormant (system degrades to
today's static behavior) and the spec is revisited.

**Input**: one still frame as `data:<contentType>;base64,…` —
the primary image for image assets, the poster frame for video assets
(`Asset.url` *is* the poster for videos).

**System prompt (rubric)** — the model acts as a content classifier for an
18+ preview gate on AI-generated media. It answers one question: *should this
image sit behind an 18+ blur?*

- SENSITIVE when the image shows: visible nudity (exposed breasts, genitals,
  or buttocks presented sexually), explicit sexual activity or simulation,
  erections or genital close-ups, masturbation, or fetish/sex-toy depictions.
  Cartoon/anime/art styles follow the same rules as photoreal.
- Any sexualized depiction of an apparently-under-18 person is SENSITIVE,
  no exceptions, highest priority rule.
- Artistic or non-sexual nudity is still SENSITIVE (the gate is age-based,
  not taste-based — see Open Decisions).
- SAFE when: everyone relevant is clothed — including swimwear, lingerie, or
  suggestive posing without nudity — or there are no people at all.
- Violence, gore, and non-sexual shock content are **out of scope**: this
  gate is the "uncensored 18+" mask, not a general safety filter.

**User message**: `Classify this image for an 18+ content gate. Reply with
JSON only, no prose, no code fences.`

**Result contract** (the model must return exactly this JSON):

```json
{
  "sensitive": true,
  "category": "nudity" | "sexual_activity" | "suggestive" | null,
  "confidence": 0.0,
  "reason": "free text, ≤200 chars, logged only — never shown in the UI"
}
```

- `suggestive` as a category with `sensitive: true` never occurs per the
  rubric (suggestive = safe); it exists so an off-rubric model reply can
  still be stored without being discarded.
- **Gray zone**: `confidence < 0.5` → treated as *uncertain* → fall back to
  the static flag for that asset (conservative when the static flag says
  sensitive, open when it says safe). The verdict is still persisted and
  logged with `uncertain: true`.
- Parse failure, missing fields, non-finite confidence, or provider error →
  no verdict; static flag rules. Never throws to the caller.

**Stored verdict** (`lib/domain/moderation.ts`):

```ts
interface ModerationVerdict {
  sensitive: boolean;
  category: "nudity" | "sexual_activity" | "suggestive" | null;
  confidence: number;      // clamped 0..1
  reason: string;          // ≤200 chars
  model: string;           // vision model id that produced it
  createdAt: number;       // epoch ms
}
```

## 4. Architecture (layered per repo conventions)

```
lib/domain/moderation.ts          pure: types, rubric prompt builder,
                                  parseVerdict(), effectiveSensitive()
lib/providers/sogni/sogni.vision.ts   sogniVisionComplete(prompt, image,
                                      options) — OpenAI-style multimodal
                                      messages; shared chat plumbing
                                      extracted from sogni.text.ts
lib/repositories/moderation.repository.ts   .studio/moderation.json,
                                            ref → verdict, assets.repository
                                            style (cache + sync writes +
                                            parse-on-load), test path override
lib/services/moderation.service.ts  classifyMediaRef(ref, {signal, logger})
                                    → { verdict | null, source } — never
                                    throws; ref-keyed cache + in-flight
                                    dedupe + concurrency cap 2
app/api/moderate/route.ts           POST { ref } → { ref, verdict|null,
                                    source: "cache"|"ai"|"static" }
components/Media.tsx                useSmartMask() replaces useMediaMask
                                    internals (reveal semantics unchanged)
```

**Service behavior** (`classifyMediaRef`):

1. Validate `isValidMediaRef(ref)` → else return `{ verdict: null, source: "static" }`.
2. Persisted cache hit → return it (`source: "cache"`).
3. Join an in-flight promise for the same ref if one exists (stampede guard).
4. Load bytes via `MediaRepository.get(ref)`; reject non-image refs by
   extension (`.mp4`, `.gif` — story scenes render mp4s with no poster, so
   they keep the static flag; frame sampling is out of scope), missing
   bytes, or size >4 MB → static fallback.
5. Call the vision model (25 s timeout, same `ProviderError` semantics as Enhance).
6. Parse + clamp verdict; persist; return (`source: "ai"`).
7. Any failure: structured `log.warn`, return static fallback. Concurrency
   capped at 2 simultaneous vision calls (the shared key pool is the scarce
   resource — same reasoning as the Enhance cache).

On the client, the media ref is parsed from the `/api/media?f=<ref>` src.
Srcs that are raw provider URLs (rare: only when the media-cache write
failed) carry no ref, so no verdict is requested and the static flag rules.

**Client behavior**:

- `lib/moderation-client.ts`: module-level `Map<ref, verdict>` + fetch
  dedupe; `requestVerdict(ref)` returns a stable promise per ref per session.
- `useSmartMask(staticSensitive, src)`: derives the media ref from the src
  (`/api/media?f=<ref>`), and when `settings.maskUncensored &&
  settings.smartMask` fires `requestVerdict` once per ref.
  `effectiveSensitive = verdict && verdict.confidence >= 0.5
  ? verdict.sensitive : staticSensitive`.
  While pending: static flag rules — uncensored renders stay blurred (no
  flash of explicit content); a safe-mode render that is actually explicit
  gains its veil when the verdict lands (~1–3 s after display).
- All `sensitive=` call sites switch to the hook: `Media.tsx` frames/stages,
  `SceneChainBadge`, story page tiles, `GeneratorScreen` current render +
  variation strips, results/history grids.
- Smart-mask fetches only happen when the mask setting itself is on; with
  `maskUncensored` off nothing is ever blurred (unchanged).

**Settings**: `smartMask: boolean` (default **on**) in `UserSettings`,
toggle "AI smart masking (judge content, not the render flag)" in
General → Content preferences directly under "Mask 18+ content". Off =
byte-identical to today's behavior. Sogni provider toggle + key remain the
provider-level gate; both off → static fallback silently.

**Warm hooks** (fire-and-forget, never awaited by the caller): story runner
after a scene's media persists; detached-render absorption path. Pure
optimization — the lazy client fetch is always the correctness path.

## 5. Data flow examples

- *New uncensored solo render, tame output*: completes → stage shows blurred
  (static flag) → verdict says `sensitive: false, category: null,
  confidence 0.9` → veil lifts by itself.
- *Safe-mode render, explicit output*: shows unmasked → verdict
  `sensitive: true` → veil appears.
- *Legacy library*: first display of each tile classifies once; the verdict
  is persisted, so every later view (and any other browser) is instant.
- *Sogni down / no key / toggle off*: static flag behavior, logged once per
  failure burst.

## 6. Privacy note

Classification sends the image bytes to Sogni's LLM endpoint — the same
vendor that already receives every prompt and i2v reference frame. Gated by
the `smartMask` toggle and the Sogni provider toggle. The reason string and
verdict are stored locally only.

## 7. Testing

- **Unit (vitest, no mocks for pure logic)**: `parseVerdict` (clean JSON,
  fenced JSON, prose-wrapped, missing fields, confidence clamp, reason trim,
  `<0.5` uncertainty flag); `effectiveSensitive` matrix (verdict × static ×
  gray zone × settings off); `classifyMediaRef` with a stubbed vision client
  (cache hit, in-flight dedupe, fallback on error, bad ref, oversized bytes,
  persistence round-trip via `setModerationPathForTests`); route contract
  (400 on bad ref, fallback shape).
- **Live smoke (real renders, per project convention)**: spike evidence in
  `docs/sogni-api-guide.md`; one known-safe and one known-explicit image from
  the media cache classified with expected verdicts; a real uncensored render
  that unblurs itself. Never use Grok for verification.

## 8. Risks

1. **Image input unverified** on `deepseek-v4-flash-vision-exp-dspark-1m` —
   Step 0 spike gates everything; failure = feature dormant, static behavior
   intact.
2. **"exp" model volatility** — the id is a constant; if ejected, fallback is
   static and the guide notes it. (A `tasks.moderation` model pick in
   provider settings is the natural follow-up, deliberately out of scope.)
3. **Model refusal on explicit images** (it may decline to describe them) —
   refusal parses as no-verdict → static flag. The spike includes an
   explicit-ish sample to measure this; the uncensored Qwen chat models have
   no vision and cannot substitute.
4. **First-scroll cost on a large library** — concurrency cap 2, persistent
   ref-keyed cache, one call per unique image ever.
5. **False negative shows explicit content unmasked** for ~seconds on
   safe-mode renders — inherent to post-hoc classification; the conservative
   rubric wording and the gray-zone rule keep it rare. Only the preview veil
   is affected; nothing is ever deleted or blocked.

## 9. Open decisions (recommendations applied — flag any you disagree with)

1. **Artistic nudity → masked?** Recommended: yes (the gate is 18+, not
   taste-based). One-line rubric change if you prefer artistic nudity open.
2. **Default on?** Recommended: yes — it only corrects the two failure modes
   above and silently falls back to today's behavior when unavailable.
3. **Gray-zone threshold 0.5** — recommended as a hard-coded parser constant
   for now; log carries `uncertain` so we can tune from real data later.
