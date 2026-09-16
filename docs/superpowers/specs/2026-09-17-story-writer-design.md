# Story Writer — AI story composition → scene split → generation

- **Date:** 2026-09-17
- **Status:** Design approved; awaiting implementation plan
- **Scope decision:** Video/image output only. AI narration (TTS) is a separate follow-up feature — the studio has no audio provider today.

## Summary

A dedicated **Writer** surface (`/writer`) where the user composes a story or a
single scene with AI text models: describe what you want (or paste/write prose
yourself), have AI write or rewrite it, then one click splits the finished
prose into per-scene visual prompts that become a real story record — landing
on Story Mode ready to Generate. A secondary path hands a single polished
prompt to Solo Mode. No new generation machinery: everything downstream of the
split (chain frames, server runner, per-scene edit/re-run, cast anchors,
convert) is the existing story pipeline.

## Goals

1. Write a story from instructions (idea, tone, scene count, cast) using any
   configured text model — including the uncensored Sogni model.
2. Enhance/rewrite an existing draft with a natural-language instruction.
3. Split prose into renderable scene prompts effortlessly — one click to a
   reviewable story on `/story`.
4. Select the writer model per-session (pill) with a persistent default in
   Settings (`tasks.writer`, same pattern as `tasks.enhance`).
5. Elegant, modern UX consistent with studio conventions (max space, scroll
   allowed, no focus rings, PillSelect controls, dark-mode safe).

## Non-goals

- Audio/TTS narration (explicitly deferred by user).
- Streaming/token-by-token generation (one-shot with progress state, matching
  the existing Enhance interaction).
- Multi-document writer workspace, version history, or server-side drafts.
- Per-scene AI regeneration on the story page (inline prompt edit already
  exists there; AI per-scene rewrite can come later).

## UX design

### Page layout (`/writer`)

```
┌──────────────────────────────────────────────────────────────┐
│  Writer                                    [model pill ▾]     │
├──────────────────────────────────────────────────────────────┤
│  BRIEF                                                        │
│  [ idea / instructions textarea                            ]  │
│  Scenes: [5 ▾]   Tone: [None ▾]   Cast: [＋ characters]       │
│                                    [ Write for me ] [ ↻ ]     │
├──────────────────────────────────────────────────────────────┤
│  DRAFT                                                        │
│  [ story prose — large editable textarea, autosaved        ]  │
│  Enhance with: [ what should change?                   ] [✦]  │
├──────────────────────────────────────────────────────────────┤
│        [ Use in Solo ]        [ ✦ Split into 5 scenes ]       │
└──────────────────────────────────────────────────────────────┘
```

- **Brief bar**: idea/instructions textarea; scene-count PillSelect (1–12,
  default 5); Tone PillSelect (None, Dark, Whimsical, Romantic, Thriller,
  Documentary — presets fold into the writing instruction, not render styles);
  CastPicker (existing component) so attached characters shape the narrative
  and ride into the story record as `meta.characterIds` (anchors compose at
  Generate exactly as today).
- **Write for me**: brief → full story prose into the draft canvas. One-shot
  POST with in-button progress; aborts if re-clicked or navigated.
- **Regenerate** (`↻`): same as Write for me, replacing the current draft
  (confirm-swap when the canvas is non-empty).
- **Draft canvas**: plain editable text. Autosaved to `localStorage`
  (`perabyte.writer.draft.v1`: `{ brief, sceneCount, tone, draft, updatedAt }`)
  and restored on mount; a small "saved" tick is enough feedback.
- **Enhance**: instruction box + action → AI rewrites the current draft per the
  instruction. The previous draft is kept in an in-memory undo slot with a
  one-click Undo affordance until the next action.
- **Split into N scenes** (primary CTA): calls the split action, creates the
  story record, navigates to `/story?id=<id>`. The story page shows the scenes
  as reviewable cards (inline edit + per-scene re-run already exist) and the
  user hits Generate there — the existing server runner chains the renders.
- **Use in Solo** (secondary): runs split with count 1 → stores the single
  polished prompt in `sessionStorage` under `perabyte.writer.solo`
  (`{ prompt, at }`, consumed once on the generate page's mount then removed)
  → navigates to `/generate/image`. The generate page reads and clears that
  key on mount to prefill the composer. (A query param was rejected: prompts
  are long and would persist in history/share links.)
- **Model pill**: PillSelect of all text models from the providers'
  `listTextModels()` (Sogni qwen3.5-35b abliterated, qwen3.6-35b,
  deepseek-v4-flash-vision, Pollinations default), defaulting to the
  `tasks.writer` settings pick; session choice overrides for the session only.
- **Nav**: sidebar entry "Writer" between Generate and Characters; same entry
  added to the mobile nav list. Landing page (`/`) untouched.

### Content gate

Writing has no provider safety checker; the uncensored option is simply the
abliterated model in the picker (labeled like it is today in Settings).
Existing media-side moderation (18+ vision gate) is untouched — it runs on
renders, not prose.

## Architecture

Layered per studio conventions. No new provider capability — the existing
`TextProvider.generateText` contract is sufficient.

### New modules

| Layer | File | Responsibility |
| --- | --- | --- |
| Domain | `lib/domain/writer.ts` | Types, validation, instruction builders, robust scene-JSON extractor |
| Service | `lib/services/writer.service.ts` | `writeStory` / `enhanceStory` / `splitStory`, engine chain, caps |
| Shared | `lib/services/text-engine-chain.ts` | Engine-chain resolver extracted from `enhancement.service.ts`; both services consume it |
| Route | `app/api/writer/route.ts` | Thin controller: parse → service → response (mirrors `/api/enhance`) |
| Client | `lib/writer.ts` | Fetch client for `/api/writer` (mirrors `lib/enhancement.ts`) |
| Page | `app/writer/page.tsx` + `components/writer/WriterView.tsx` | The surface |

### Engine chain

`resolveTextEngines(config, taskModel, taskKey)` — shared by Enhance and
Writer: selected task model first (if the owning provider is enabled and the
model isn't disabled), then Sogni, then Pollinations. Writer passes
`tasks.writer` (new key in `TaskModelConfig`, default `null` → chain order).
Settings UI: a "Writer" row in the Models section beside Enhance (same
task-pick component). Adding the key follows the existing config
parse/merge/persist code paths.

### Data contracts

```ts
// lib/domain/writer.ts
interface WriterBrief {
  idea: string;            // 1..2000 chars after trim
  sceneCount: number;      // 1..12, default 5
  tone: WriterTone | null; // preset table in constants
  characterNames: string[]; // from cast, display names only
  uncensored: boolean;     // folds explicit "no sanitized euphemism" clause
}

type WriterAction = "write" | "enhance" | "split";

// POST /api/writer
{ action: "write",   brief: WriterBrief, modelId?: string }
{ action: "enhance", draft: string, instruction: string, modelId?: string } // draft ≤ 20_000 chars
{ action: "split",   draft: string, sceneCount: number, characterNames?: string[], modelId?: string }
// draft ≤ 20_000 chars on both enhance and split

// Responses
{ text: string; model: string; provider: string }                        // write / enhance
{ title: string; scenes: string[]; model: string; provider: string }     // split
```

Split contract: the model returns a JSON object `{ "title": "...",
"scenes": ["...", ...] }`; each scene string is a **self-contained visual
prompt** (shot description, characters by name + look, mood, camera) capped at
`PROMPT_MAX`. The extractor tolerates code fences, leading/trailing prose,
wrong counts (clamps/trims), and empty strings (filtered). Parse failure
triggers one automatic retry with a stricter instruction before erroring.

### Story record creation (client-side, existing API)

The writer page composes and POSTs the record itself (same id scheme and
shape the story page uses — `s_<base36>` id, `kind: "story"`, `mode:
"Story Mode"`, `meta: { continuity: true, running: false, characterIds }`),
with:

- `title` — split's title (fallback: first scene words or "Untitled story")
- `prompt` — the full prose draft (kept for reference/convert)
- `settings` — current composer defaults for story kind (aspect, resolution,
  duration, style, safe, modelId — the same defaults the story page seeds)
- `scenes` — one `StoryScene` per split prompt, `status: "queued"`,
  `url: null` (matching the page's add-scene defaults; exact values confirmed
  against the page code in the plan)

Failure to create the record keeps the user on `/writer` with the draft
intact and an error toast; nothing is lost (canvas autosave also still holds
it).

## Error handling

- **Engine failures**: chain falls through per engine (logged warn each hop).
  All engines fail → retryable error surfaced in-place ("The writer models
  are unavailable right now — try again"). No deterministic fallback for
  creative writing.
- **Abort**: re-click or navigation aborts the in-flight request (AbortError
  → 499 route semantics, matching Enhance).
- **Validation**: field errors mirror Enhance (`{ error, field }` 400s) —
  empty brief/draft, over-cap lengths, invalid action.
- **Split parse failure**: one stricter retry, then surfaced error; draft
  untouched.
- **Timeouts**: reuse the text providers' existing timeout (25 s Sogni); no
  new timeout config.

## Testing

Vitest, following existing service/domain test patterns:

- **Domain** (`writer.test.ts`): instruction builders embed brief fields;
  extractor handles clean JSON, fenced JSON, JSON with surrounding chatter,
  over/under-count clamping, empty-string filtering, over-length scene
  trimming at sentence boundaries.
- **Service** (`writer.service.test.ts`): engine-chain order (task model →
  Sogni → Pollinations), provider-disabled and model-disabled skips,
  write/enhance/split happy paths with mock engines, retry-on-parse-failure
  then failure, caps validation, abort propagation.
- **Chain extraction**: `enhancement.service` tests keep passing unchanged
  against the extracted resolver (behavior-preserving refactor).

## File inventory

**New:** `lib/domain/writer.ts`, `lib/domain/writer.test.ts`,
`lib/services/writer.service.ts`, `lib/services/writer.service.test.ts`,
`lib/services/text-engine-chain.ts`, `app/api/writer/route.ts`,
`lib/writer.ts`, `app/writer/page.tsx`, `components/writer/WriterView.tsx`.

**Modified:** `lib/repositories/provider-config.repository.ts` (`tasks.writer`),
`lib/services/enhancement.service.ts` (use extracted chain),
`components/settings/*` (Writer task row), `components/SiteChrome.tsx` (nav),
settings tests / config tests as needed.

## Follow-ups (out of scope, recorded)

- AI narration (TTS) per scene / full-story track — needs an audio provider.
- Streaming story output.
- AI per-scene rewrite from the story page.
