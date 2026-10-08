# PeraByte Studio — Production Studio Product Requirements

**Document status:** v2.0 — UX-complete fusion (2026-10-06). Supersedes the v1 draft of this file
(story-pipeline goals only) and unifies it with the product UX vision.

**Sources fused into this document:**

1. `docs/PERABYTE_UX_VISION_SPEC.md` — the UX/product vision, committed verbatim alongside this
   doc. **Behavioral authority**: what the product must do and feel like.
2. v1 of this file — the delivery plan (FR-10…FR-20, Phases A–D, acceptance criteria).
3. `docs/production/` on `zcode/production-core` — the production domain layer (contracts,
   revisions, approvals, budget kernel, manifest, publishing profiles) and its UX spec.
4. Live capability audit of the studio app and providers, 2026-10-06 (models, frame chaining,
   reference limits, moderation, persistence).

**Precedence rule.** On *behavior*, the UX vision wins. On *capability and scope reality* — what
providers can actually do, what is already built, what is phased — this document wins. Where the
production domain layer already implements a vision behavior under a different name, this document
adopts the domain layer's vocabulary (§4) so we build one product, not two dialects of it.

**Anchor use case.** Story-driven episodic video — a repeating-format series (e.g. an AI-produced
children's channel), vertical reels/shorts cut from episodes, and promo clips — while staying
format-agnostic (bedtime story, reel, music video, trailer, adult anthology all compile to the
same manifest).

---

## 1. Product vision and philosophy

PeraByte is an **AI production studio / showrunner**, not a collection of generation tools. The
user expresses creative intent and approves results; the platform handles storytelling, shot
composition, camera direction, character placement, video generation, voices, music, sound,
editing and packaging.

Five principles from the vision govern every screen:

1. **Selection over configuration** — generate options → choose one → refine it. Technical
   generation controls are hidden by default.
2. **Canon before prompts** — characters and environments are reusable visual identities; once
   selected, users never re-describe them in prompts.
3. **Workspace isolation** — a workspace defines exactly which characters, environments, styles,
   voices, rules and prior productions are available to the AI context. Nothing else leaks in.
4. **Progressive complexity** — a beginner generates an episode from one idea; an advanced user
   can open scenes, shots, audio layers and generation versions.
5. **AI produces the first complete result** — the platform drafts everything; the user reviews
   and corrects.

### PeraByte-specific principles the vision omits (added in v2)

6. **Cost is never invisible.** Every automated pass spends real provider credits. Estimation
   before, ledger after (FR-17/FR-35). "How little does the creator need to do" is always
   answered *together with* "what will it cost".
7. **Human approval is never bypassed.** The domain layer's fail-closed approval gates are the
   product's spine. Principle 5 produces **complete drafts awaiting review**, never self-approved
   output. Auto Mode (FR-29) pre-satisfies gates into a review queue; it never skips them.
8. **Content rating is a first-class dimension.** PeraByte serves General-audience kids content
   *and* the uncensored adult wedge under one roof. Every workspace carries a rating that governs
   moderation, LoRA availability and publishability (FR-34).
9. **BYOK, local-first, single creator.** Keys are the user's; data lives locally (SQLite + media
   vault) until the SaaS boundary is crossed (§7, open decision 4).

---

## 2. Mental model and navigation

```text
GLOBAL CREATIVE SYSTEM                (studio libraries)
  Characters   Environments   Voices   Styles   Media
        │ selected into
        ▼
WORKSPACE  — a scoped universe: selected assets, style, world rules,
             rating, production defaults, continuity          (FR-21, NEW)
        │ owns
        ▼
PRODUCTIONS  (Projects)  — Episode / Story / Short / Music Video / Trailer
        │
        │  DESIGN ── STORY ── PRODUCE ── PUBLISH   (four user-facing stages)
        ▼
Canon → Script → Shot plan → Animatic → Anchors → Takes → Audio → Export
```

The four user-facing stages map one-to-one onto the production core's existing flow
(`docs/production/UX_SPEC.md`):

| Stage (vision §25) | Contains | Domain layer |
| --- | --- | --- |
| **DESIGN** | Production canon: cast, wardrobe, places, props, style | `CanonRevision` + `/canon` |
| **STORY** | Script, beats, shot plan, storyboard/animatic | `StoryRevision`, `ShotPlanRevision`, `AnimaticRevision` + `/script`, `/shots` |
| **PRODUCE** | Anchors, takes, voice, music, sound | `AnchorCandidate`, `Take`, `AudioMixRevision` + `/anchors`, `/takes`, `/audio` |
| **PUBLISH** | Final edit, QC, export, publishing package | `ExportRecord`, `PublicationPackage` + `/export` |

### Navigation alignment (current → target)

| Vision | Today | Target | Change |
| --- | --- | --- | --- |
| Home | `/` marketing landing | `/` stays marketing; **`/studio` = Studio Home** (workspaces + Continue working) | new |
| Workspaces | — | `/workspaces`, `/workspaces/[id]` | new (FR-21) |
| Create → Characters | `/character` (+ `/character/[id]`, `/edit`) | unchanged route | relabel only |
| Create → Environments | `/locations` label "Places" | same route, label **"Environments"** (FR-22) | relabel |
| Create → Generate | `/generate/image`, `/generate/video` | unchanged; gain workspace context header (FR-21.4) | add header |
| Library | `/images` "Renders", `/stories` | same routes, grouped as **Library**; add Audio/Productions filters (FR-33) | relabel + filters |
| Productions | `/story` console, `/production` (domain UI) | `/production/[projectId]` is the production hub; `/story` remains the lightweight scene console and imports into production | bridge |
| Settings | `/settings` | unchanged | — |

Naming is frozen with this document: user-facing words are **Character, Environment, Workspace,
Production, Storyboard, Shot, Take, Canon**. The vocabulary ban list (FR-39) applies everywhere.

---

## 3. System reality — three layers

### 3.1 Studio app (user-facing, on `feat/ui-overhall`/master)

Working today: character library with identity pinning (`identity {front, angles[], seed,
modelId}`) and six-view design sheets chained via img2img; environment ("Places") library with
uploaded reference plates (generation button present but disabled); writer (premise → draft →
scene split, cast-aware); scene console with server-side chain runner, keyframe ladder
(multi-ref edit → single img2img → none), vision quality gate, per-scene overrides, requeue and
reorder; solo image/video studios; settings (providers, keys, task models, render timeouts,
prompt budget, uncensored); moderation with smart masking; durable job engine with lanes and
boot recovery; content-addressed media cache served same-origin.

### 3.2 Production domain layer (headless, integrated on `zcode/production-core`)

Integrated: SQLite store + media vault + lossless `.studio/*.json` import; immutable
canon/story/shot-plan/animatic revisions with affected-shot invalidation; approval gates
(fail-closed, advisory vision scores, no bulk approve); anchor candidates; takes with reversible
selection; budget kernel (advisory quotes, standing authorization, atomic reservation +
reconciliation, provider proofs, entitlement unknown = block); manifest compiler + QC contracts;
publication profiles (manual-upload packages); durable worker/outbox model.
Pending (ordered): provider-proof composer + runtime wiring (I01-B6 C/W), full live quoting,
script/storyboard proposals (I02), creator-flow UI, audio import/mix (C09/C10), assembly/export
(C11/C12), reviewed pilots (C13/C14), release recovery (C15), speech/music (C16),
publication derivatives (C17+).

### 3.3 Providers (live capability facts, 2026-10-06)

- **Image generation**: Sogni (Krea 2 Turbo, Flux Schnell, Z-Image Turbo, Chroma 1 HD — every
  model accepts a starting image); Grok Imagine relay (3 image models, img2img via edits
  endpoint); Pollinations keyless fallback (prompt-only stills, no image input).
- **Multi-reference edit models** (identity-preserving refinement): GPT Image 2.5 Flare
  (≤16 context refs), Qwen Image Edit (≤3), Krea 2 Identity Edit (≤3). Request cap: 16 refs,
  trimmed to model max.
- **Real video generation**: Sogni families with per-family limits — WAN 2.2 LightX2V 1–10s,
  LTX 2.5 2–20s, Seedance 2.0 4–15s, Seedance 2.5 4–30s (start+end frames + `returnLastFrame`),
  MiniMax H3 ≈5.167–15.083s on a 24fps frame grid (only family with explicit resolutions);
  Grok Imagine video ≤15s, first-frame input only. Aspect snapping 4:5↔3:4, 3:2↔4:3.
- **Frame handoff parameters**: `referenceImage` (start), `referenceImageEnd` (end),
  `returnLastFrame`, `startingImage`; dual-keyframe on LTX 2.3 / Seedance 2.5 / MiniMax flf2v
  variants; Grok = start-only.
- **LoRA**: up to 8 per request; character-attribute LoRAs on the Krea 2 image family; 7 motion
  LoRAs on MiniMax H3 only; Mature group requires Uncensored Mode; unknown ids are stripped
  (fail-safe).
- **Text engines**: Sogni chat (abliterated Qwen default, second Qwen, DeepSeek vision with
  1024px inline cap), Pollinations keyless, custom OpenAI/Gemini/Anthropic gateways. Uncensored
  Mode pins to the abliterated model and drops engines that sanitize.
- **Absent**: TTS/voice, music/SFX generation (C16 planned), per-request USD pricing (costTier
  badge only — the budget kernel needs its quote feeds), publishing APIs.

---

## 4. Vocabulary alignment — one product, one language

| Vision term | Production-core contract | Studio app today | This doc's rule |
| --- | --- | --- | --- |
| Canon | `CanonRevision` (character\|location\|prop\|style) + `Approval` | character library, locations | "Canon" in UI; revision under the hood |
| Variant / version | immutable revisions, lineage `parentId` | character variations, attempts | V1…Vn chips; never overwrite approved |
| Workspace | — (new, sits above `Project`) | `StoryWorld.locationIds` (seed) | FR-21 |
| Production | `Project` + revisions | `/story` asset (legacy import) | "Production" in UI, `Project` in code |
| Scene | `ShotRevision` (beat-mapped, cast-bound) | `StoryScene` | "Scene" in UI, `Shot` in code |
| Shots (collapsed, §29) | framing + `targetFrames` inside `ShotRevision` | per-scene settings | collapsed "Shots (n)" disclosure |
| Take | `Take` + `takeSelectionVersion` (reversible selection) | requeue/attempt | Takes strip per scene (FR-25) |
| Storyboard | `ShotPlanRevision` + `AnimaticRevision` | keyframe grid in console | Storyboard = approved anchors view |
| Continuity | `castBindings` (pinned canon revisions) + explicit `continuation` pins + advisory `visionAssessment` | keyframe gate scores | FR-26 |
| Generate pipeline | job outbox + worker state machine | job engine lanes | one scheduler (see FR-24.5) |
| Cost | `BudgetQuote/Authorization/Reservation` + proofs | costTier badge | FR-35 surfaces the kernel |
| Publish | `ExportRecord` + `PublicationPackage` | manual download | platform ladder (FR-32) |
| Library | vault `Asset` records | `/images`, `/stories` | FR-33 |

---

## 5. Behavior specifications

Each area: **Behavior** (from the vision, refined) → **Today** → **Delta requirements**.
FR numbering continues from v1 (FR-10…FR-20); new FRs are FR-21+. Items marked **[added v2]**
are enhancements this document contributes beyond the two source docs.

### 5.1 Studio Home and navigation — FR-38

**Behavior.** Home emphasizes continuation and creation: primary actions (Create Character /
Create Environment / Generate ✨), workspace cards with production counts, and "Continue
working" (last-touched productions). No dashboard analytics. Every empty state teaches the next
action; onboarding is workspace → characters → environments → one-sentence idea → generate, with
voices/music/models inferred and changeable later.

**Today.** `/` is marketing-only; studio entry drops into a generator; nav labels drifted
("Renders", "Places", "Motion studio").

**Delta.**
- FR-38.1 `/studio` home per vision §4; marketing funnel unchanged.
- FR-38.2 Nav relabels per §2 table; one "Build a world" group (Characters, Environments), one
  "Library" group (Renders, Stories, Audio*, Productions*).
- FR-38.3 Empty states ship with every list surface (vision §52 wording standard).
- FR-38.4 First-run onboarding sequence (vision §53) with skip; returning flow "Create Next
  Episode" is the single most prominent CTA on a workspace home (vision §55).
- FR-38.5 **[added v2]** Breadcrumb-style context chip ("Workspace: Milo & Luna 🔒") on every
  generation surface, making active scope always visible (vision §22).

### 5.2 Character studio — canon creation (vision §5–9)

**Behavior.** Describe → generate 3–4 variants (each a character-sheet style image) → select →
refine (identity-preserving) → approve → save canon. Canon holds master appearance, face/body
references, six views, expressions, default outfit, personality, voice binding, identity anchor
data — presented as a polished profile, never a JSON blob. Refinement operates on the selected
variant: changing the jacket must not change the face.

**Today.** Wizard (Simple/Detailed), six-view sheet chaining, `identity {front, angles, seed,
modelId}` pinning, lineage variations, favorites/tags — substantially built. Gaps: no formal
variant-selection screen with compare/zoom/favorite/more-like-this; refine step is re-edit +
regenerate rather than reference-preserving edit; no version strip with "restore".

**Delta.**
- FR-21 depends: characters are the first canon kind workspace-selectable.
- FR-22.1 (shared with environments) Variant selection screen: 3–4 candidates, select, zoom,
  compare, favorite, "Generate more like this one" (feeds the selected image as lead context ref).
- FR-22.2 **Refine via edit models**: refinement requests route to multi-reference edit models
  (GPT Image ≤16 / Qwen ≤3 / Krea Identity ≤3) with `identity.front` as the mandatory lead
  reference; quick-change chips (Outfit, Hair, Colors, Expression, Accessories, Age, Style)
  compose structured edit instructions; free-text change box for the rest.
- FR-22.3 Version strip V1…Vn per character with select-as-canon and restore; approval of a new
  version creates a new `CanonRevision`, never mutating the old (domain rule already).
- FR-22.4 Optional per-character voice binding (FR-27) shown on the profile.
- **[added v2]** Canon profiles display a "used in N productions · M workspaces" line fed by
  workspace/production references, and pin provenance (model, seed, refs) under a collapsible
  "Identity details" — satisfying vision §50 (imagery over metadata) without hiding the audit
  trail the domain layer requires.

### 5.3 Environment studio — canon creation (vision §10–13)

**Behavior.** Same interaction model as characters: describe → 3–4 variants → select → refine
(lighting, time, weather, colors, props, layout, mood chips) → approve → canon with main view,
wide establishing, alternative angles, interior, day/sunset/night, weather variants.

**Today.** `LocationRow` = name, prose description, uploaded plate, lighting, palette, favorite.
"Generate plate" button is disabled ("coming soon"). No variants, no refinement, no derived
views. Server runner resolves locations per scene and injects plates as keyframe references.

**Delta — FR-23 (Environment studio).**
- FR-23.1 Enable plate generation: text → 3–4 plate variants via image models; refinement via
  edit models with the selected plate as lead reference (same machinery as FR-22.2).
- FR-23.2 Canon views: on approve, optionally generate the supporting set (wide establishing,
  day/sunset/night) as *derived* canon assets — each is an edit-model pass anchored on the
  approved plate. Users see "Generating canon views…" then a gallery; every view is
  individually re-rollable before locking.
- FR-23.3 Environments appear in the workspace picker, scene state, and storyboard cards exactly
  like characters; relabel "Places" → "Environments" everywhere (coordinate with the
  `feat/ui-overhall` review pass — open decision 6).
- **[added v2]** Lighting/palette fields become *structured* canon attributes (not prose) so the
  storyboard and continuity engine can reason about them ("sunset" is a value, not a substring).

### 5.4 Workspaces — the isolation layer (vision §14–20) — FR-21 [NEW]

**Behavior.** A workspace is a scoped universe: selected characters/environments/voices, style,
world rules, production defaults (format, language, rating), continuity, and its productions.
Creation is lightweight (name, characters, environments, style, format, language — the rest
later). Generation context includes *only* workspace-selected assets plus the current production;
unrelated global assets never influence generation. Removing an asset stops new generations from
using it but never breaks historical productions. Workspaces may hold variants of global assets
(Winter Outfit Milo) that stay isolated until "Save to Global Library".

**Today.** No workspace entity. Nearest analogues: per-story cast/location selection and
per-project `ProductionProfile` defaults in the domain layer.

**Delta.**
- FR-21.1 **Workspace entity** above Project: `{id, name, characterIds, environmentIds, voiceIds,
  styleBlock, worldRules, rating, productionDefaults, canonSnapshotRefs}` persisted in the
  production store (not `.studio` JSON). A workspace owns productions; a production belongs to
  exactly one workspace (vision §48).
- FR-21.2 **Isolation contract** (vision §17, verbatim include/exclude lists): the generation
  composer resolves canon references *only* through the active workspace; a global asset is
  reachable solely by explicit per-request "browse global library" selection, which the user
  makes once and which records in job params (testable: assert job reference sets ⊆ workspace
  selection ∪ explicit picks).
- FR-21.3 **Production snapshots**: on production create, pin the workspace's canon selections
  (revision ids + asset refs) into the production's canon set. Later workspace changes never
  alter past productions; new productions pick up the new canon (domain layer's revision
  immutability makes this nearly free).
- FR-21.4 Workspace context header on Generate/studio surfaces (FR-38.5); entering generation
  through a workspace pre-selects its scope.
- FR-21.5 Workspace asset management screen with in-workspace/global split (vision §19) and the
  historical-production guarantee above.
- FR-21.6 Workspace-specific asset variants: fork-on-write from a pinned global revision; stays
  workspace-local until "Save to Global Library" (which creates a *new* global revision; it
  never overwrites — resolving the vision's propagation ambiguity).
- FR-21.7 **[added v2]** Rating is a workspace property (`General | Mature | Adult`) driving:
  moderation defaults, Mature/adult LoRA and `nsfwLevel` availability, and publishability
  (FR-34). Kids workspaces get the v1 FR-19 guardrails (originality checklist, MFK/AI-disclosure
  defaults); Adult workspaces are export-only.
- FR-21.8 Workspaces are local-single-creator in v1 (no sharing/permissions — matches the domain
  layer's non-goal); the SaaS boundary (auth, multi-tenant) is open decision 4.

### 5.5 Story studio — conversational writing (vision §26) — FR-28

**Behavior.** Tell us what happens → story (title, synopsis, beats, scenes, dialogue, ending) →
iterate conversationally: "make the ending funnier", "give Luna more dialogue", "add a chase
before Scene 6", "make this appropriate for younger children".

**Today.** Writer produces premise → draft → strict-JSON scene split (3–8 scenes, no headings,
`---` separators verbatim, ~5s motion rule for video); Enhance/writer-enhance are single-shot;
"Save to Story" builds a scene console story. Uncensored keeps adult content through the
abliterated engine chain.

**Delta.**
- FR-28.1 **Revision chat**: multi-turn editing of the draft where each turn produces a new
  editable proposal with a visible diff (scenes added/removed/changed). Maps directly onto the
  domain layer's pending script/storyboard **Proposals** (I02) — build the chat on proposals, not
  a new draft type.
- FR-28.2 Instruction vocabulary covers the vision's examples; structural requests ("add a scene
  before N") renumber and preserve verbatim user text (writer's existing verbatim rule).
- FR-28.3 Story → production handoff creates a `StoryRevision` from the approved draft (beats
  carry stable ids; dialogue/narration stay verbatim — the domain layer already requires this).
- FR-28.4 **[added v2]** Age-appropriateness requests in kids workspaces route through the
  moderation endpoint as a pre-check on the *script*, not just images (v1 FR-20 extension).

### 5.6 Storyboard and shots (vision §27–29) — FR-24

**Behavior.** Storyboard is the main visual planning interface: ordered scene cards with image,
title, duration, characters, environment, generation state; drag to reorder; scene detail with
action, dialogue, camera, duration, regenerate/edit/approve. Shots exist internally, collapsed
("Shots (5)"), expanding to named shot lines — professional control without intimidation.

**Today.** Domain layer has the full model (beats → `ShotPlanRevision` → `AnimaticRevision` with
timing; storyboard components exist headless). Studio console shows scene cards with keyframe
refs and gate scores but not the storyboard presentation; durations are per-render seconds, not
plan-level timing.

**Delta.**
- FR-24.1 Storyboard view = the approved/anchor images laid out per the shot plan with plan
  timings (from `AnimaticRevision`), characters/environment chips, generation state, drag
  reorder (creating a new plan revision requiring re-approval per domain rules).
- FR-24.2 Scene detail card per vision §28: action, dialogue (structured per character), camera
  (framing + motion intent), duration; Regenerate / Edit / Approve actions wired to anchor
  candidates and approvals.
- FR-24.3 Shots collapsed disclosure per scene (framing lines from `ShotRevision`); expanding is
  optional and never required to produce an episode.
- FR-24.4 **Anchor-first, chain-by-choice** (reconciling vision §30 with v1 FR-11 and the domain
  `continuation` contract): every scene re-anchors from fresh keyframes built from cast +
  environment canon; "continue movement from previous" is an explicit per-scene toggle that pins
  the predecessor's end frame (`continuation.endFrameAssetId`). Never default-chained — this is
  already the domain rule; the UI must make it feel like the natural path (approve keyframes
  first, then animate, batch animation as the follow-up action).
- FR-24.5 One scheduler: production jobs and legacy scene-console jobs run on the production
  worker/outbox; the legacy keyframe-gate auto-flow must not double-run (domain note: legacy
  gate is advisory and must not trigger the new scheduler).
- FR-24.6 **[added v2]** Continuity affordance on the board: scenes flagged when a dependency
  changed (`DependencyIssue: DEPENDENCY_REPLACED | STORY_CHANGED | DEPENDENCY_MISSING` already
  computed by the domain read model) show a "Stale — re-anchor" chip; the vision's silent
  continuity engine surfaces as *one* calm badge, never a wall of warnings.

### 5.7 Scene generation and takes (vision §30–32) — FR-25

**Behavior.** The platform composes story context + character canon + environment canon + outfit
state + style + camera + action + dialogue + continuity into the generation request; users never
assemble prompts. Video generation uses takes: generate → pick the best → previous takes
recoverable; the chosen take is the scene's approved version.

**Today.** Composition is server-side and canon-aware (anchor clauses, location resolution,
seed derivation per story). Takes exist in the domain (`Take`, reversible selection,
approval-linked, retakes without touching siblings); the console has requeue but no takes strip.

**Delta.**
- FR-25.1 Takes strip per scene: Take 1/2/3…, select active, "Generate another take" reusing the
  exact original params (retry-is-a-retry rule from FR-10; new randomization is an explicit
  "different take" action, never silent).
- FR-25.2 Batch animation after anchor approval with per-flight cost estimate (FR-35) — never a
  blind batch spend.
- FR-25.3 Natural-language correction box per scene ("Make Luna look more nervous and move
  closer") maps to a **retake with direction note** — the note enters motion/visual intent and
  the params hash records it. See FR-31 for the NL scope table.
- FR-25.4 **[added v2]** Partial-cut degradation: a failed take never blocks the cut. The
  manifest compiles with the scene's approved anchor still (slug card) + audio, flagged
  "awaiting take"; the first cut is always deliverable (vision §39 honored under real failure).

### 5.8 Continuity engine (vision §33) — FR-26

**Behavior.** Continuity validates character identity, outfit, age, accessories, environment
identity, lighting, object placement, chronology; issues auto-repair or notify calmly; no AI
jargon.

**Today.** Keyframe gate scores identity/outfit/location (0–1 vs threshold, retry on fail) in
the console; the domain layer records advisory `visionAssessment` per anchor and pins
`castBindings`/`continuation` — validation exists, presentation and repair flows don't.

**Delta.**
- FR-26.1 Anchor gate remains advisory (domain rule) but its scores surface as the storyboard's
  per-scene quality chips; the vision's "Continuity issue detected — [Fix Automatically]"
  becomes **"Re-roll with guidance"** (a new anchor attempt with the failing dimension called
  out in the instruction), never a silent auto-approve.
- FR-26.2 Continuity report card per production (one screen: every scene × dimension, pass/warn/
  fail, links to the offending anchor/take) — the producer's pre-export checklist item.
- FR-26.3 Outfit/age/accessory comparisons use canon attributes (FR-23.3 structured fields;
  character structured spec already) so "Milo's jacket differs from Scene 04" is a real check,
  not vibes.
- FR-26.4 **[added v2]** Honest-scope note in-product: vision-grade checks (object placement,
  chronology) are labeled "best-effort" until a reliable detector exists; the report shows
  "not checked" rather than pretending. Ship identity/outfit/location/lighting first.

### 5.9 Voice system (vision §34–35) — FR-27

**Behavior.** Voices belong to characters; the scene determines emotional delivery (voice
identity + dialogue + scene emotion + action + context → performance). Simple optional overrides
per line (Auto default; Calm/Excited/Scared/Angry/Whisper/Shout presets); regenerate voice
per line. No obscure parameters.

**Today.** No TTS. Domain layer: narration `SpeechSegment`s with **voice lock** and language
capability gating; audio import is the first-release path; C16 = Sogni speech/music planned.
v1 FR-14 specced ElevenLabs-first.

**Vocabulary conflict resolved [added v2]:** the vision says both "voices belong to characters"
(§34) and "workspace selects voices" (§17/§47). Model: **global voice library** → each character
binds exactly one **locked voice** (canon) → a workspace's character selection implicitly selects
its voices; a workspace may *recast* a character's voice locally (workspace variant, FR-21.6)
without touching global canon.

**Delta.**
- FR-27.1 Voice presets in settings-adjacent library (provider, voice id, pacing, tags);
  per-character locked binding on the canon profile.
- FR-27.2 TTS provider adapter (open decision 5: ElevenLabs first vs Sogni C16 speech when
  live); per-line rendering with delivery presets; Auto = infer delivery from scene emotion and
  action via the text engine (one small classification pass, cached).
- FR-27.3 Import-first bridge: until TTS ships, the audio stage accepts uploaded narration per
  segment with the same voice-lock bookkeeping (domain already supports imported audio).
- FR-27.4 Dialogue lines attach to scenes/shots (script already carries verbatim dialogue);
  lip-sync is explicitly out of scope until a provider offers it (vision lists it; no provider
  does today — documented as roadmap, not promised).

### 5.10 Music and sound (vision §36) — phased under FR-14

**Behavior.** The system analyzes each scene and delivers a complete audio pass: dialogue,
ambience, SFX, music — with an "Edit Audio" escape hatch.

**Today/pending.** `AudioMixRevision`/`AudioCue` contracts integrated; import/mix + assembly
pending (C09–C12); generation (C16) later.

**Delta.**
- FR-14 stays the contract (upload-based music v1 with rights verified by uploader; API
  generation follow-up; ducking under narration; −14 LUFS; stems retained per shot).
- **[added v2]** Scene audio pass v1 = *suggestive, not generative*: the text engine proposes an
  audio plan per scene (ambience line, SFX list, music mood) that the user approves; sound comes
  from uploads/library until C16. The vision's "complete audio pass" arrives with C16; until
  then the UI never implies generated audio that doesn't exist.

### 5.11 Production editor: NL command bar + manifest view (vision §37–38) — FR-31

**Behavior.** An "Ask for a change" command bar persists across production; an Advanced Edit
timeline shows video/voice/music/SFX/captions tracks.

**Reconciliation.** v1's non-goal "no NLE" stands: assembly is manifest-driven. The vision's
timeline is delivered as a **manifest visualization with editing affordances** (reorder, trim
in/out, re-time, transition, disable, duplicate) — every interaction is a manifest operation
that recompiles deterministically; there is no freeform clip dragging against rendered frames.

**Delta.**
- FR-31.1 NL command bar scope (exact table, [added v2]):

  | User says | Mechanism |
  | --- | --- |
  | "make this scene more dramatic" | retake with direction note (FR-25.3) |
  | "swap scenes 3 and 4" | manifest reorder (new plan revision) |
  | "trim 2 seconds off scene 5" | manifest in/out points |
  | "Luna sounds scared here" | delivery preset on her lines (FR-27.2) |
  | "cut to the music from 0:45" | music cue bounds (AudioCue timeline) |
  | anything unrecognized | graceful fallback to the matching panel, never a dead end |

- FR-31.2 Advanced view = track-style rendering of the manifest (clips, voice, music, SFX,
  captions) with the affordances above; per-variant (16:9/9:16/1:1/4:5) and quality tiers
  (Standard/High/Master) map to encode presets; codecs/bitrates live under Advanced only
  (vision §42).
- FR-31.3 Single-shot change → reassembly in seconds (manifest recompile; FR-12 rule), with QC
  re-run on the new master only.

### 5.12 Auto Mode (vision §39, §23, §54) — FR-29 [flagship]

**Behavior.** "Milo and Luna accidentally wake a sleeping dragon · ~5 min · Create Episode ✨"
→ story, script, storyboard, shots, visuals, video, voices, music, sound, edit, captions all
drafted → "Your first cut is ready — Watch / Make Changes / Publish".

**Delta.**
- FR-29.1 Auto Mode is an **orchestration over the existing pipeline**, not a bypass: it runs
  proposal → approval-queue → anchors (gate advisory) → takes → audio → assembly with every
  human gate *pre-satisfied into a review queue*. "First cut" = assembled from best-scoring
  takes with all approvals pending; watching it never marks it approved. One guided review pass
  (per-gate cards, keyboard `a` to approve per the production UX spec) finalizes.
- FR-29.2 **[added v2]** Cost/length pre-flight on the create screen: "≈ 18 keyframes · 18 clips
  · ~40 voice lines · est. $X–$Y from your providers" with a hard confirm above the workspace
  budget threshold (budget kernel gates the run regardless — this makes it visible *before*).
- FR-29.3 Length modes from FR-12 (target duration vs narration-driven; reel 15/30/60s).
- FR-29.4 Failure isolation per FR-25.4: any stage failure downgrades that scene to slug+audio
  and continues; the run report lists what needs retakes.
- FR-29.5 Background by design (durable jobs survive closed tabs — already true); notify on
  first-cut-ready.

### 5.13 Music video mode (vision §40) — FR-30 [phased]

**Delta.**
- FR-30.1 v1: upload song (rights attested by uploader, FR-14 rule) + optional visual direction
  → text engine proposes sections/lyric beats → visual concept → storyboard → scenes, with the
  song as the music bed and narration-driven timing disabled (music drives).
- FR-30.2 Beat-synchronization is a **stated later phase** (needs onset/beat detection on the
  uploaded track; ffmpeg-based feasibility spike) — not promised in v1 UI copy.
- FR-30.3 Same manifest/compiler as episodes (FR-15); no separate renderer.

### 5.14 Publish studio and export (vision §41–43) — FR-32

**Behavior.** Ready-to-publish screen: final video, checklist (video/voice/music/sound/
captions), auto-prepared title/description/hashtags/thumbnail options/chapters, platform
checkboxes, explicit approve-then-publish.

**Delta.**
- FR-32.1 Platform ladder (honest states, [added v2]): **Manual package** (today:
  `PublicationPackage` with chapters + disclaimers) → **YouTube OAuth upload** (v1 FR-18, with
  per-channel defaults incl. MFK + AI disclosure) → Shorts/TikTok/Instagram (later; each needs
  approved API access — shown as "Connect" placeholders, never fake-enabled).
- FR-32.2 Rating gate (FR-34): General/Mature publishable (Mature → YouTube age-restriction
  default); **Adult workspaces are export-only** — the publish screen says so plainly.
- FR-32.3 Export options per vision §42 (aspects from one manifest; quality tiers; custom under
  Advanced). Derivatives (Shorts/promo) per v1 FR-15.
- FR-32.4 Every-upload checklist from v1 FR-19 presented at publish; publish confirmation is
  explicit and auditable (job record with video id).

### 5.15 Library and versioning (vision §44–46) — FR-33 / FR-37

**Delta.**
- FR-33.1 Library = discovery/reuse only (All / Characters / Environments / Images / Videos /
  Audio / Stories / Storyboards / Productions); an asset existing in the library never enters
  generation context — workspace selection controls context (vision §44 verbatim rule, enforced
  by FR-21.2).
- FR-33.2 Thumbnails on ingest; originals never load in galleries (FR-16 rule).
- FR-37.1 Canon-vs-generation is the visible model: approved canon objects show a canon badge;
  generated outputs show their lineage (which canon revisions produced them) — the domain's
  `inputsHash`/pins make this a query, and the vision's "only explicit approval alters canon"
  is the domain's existing law.
- FR-37.2 **[added v2]** Retention: keep the approved take + last 3 takes per scene by default;
  older takes prunable via a storage screen with explicit confirmation; production snapshots pin
  canon refs so pruning never breaks reproducibility. Vaults report size + biggest objects.

---

## 6. Cross-cutting UX standards — FR-39 [added v2, from vision §49–52]

- FR-39.1 **Language**: CTA vocabulary per vision §51 (Generate Variants / Use This Character /
  Generate More Like This / Create Episode / Approve / Publish…). Banned in primary UI: seed,
  CFG, sampler, reference weight, context strength, inference, and studio jargon flagged in the
  UI-overhaul review (SOLO, negative-prompt-as-term). Model/technical names appear only in
  Advanced and Settings. A jargon-audit script (like `scripts/ui-audit.mjs`) enforces this.
- FR-39.2 **Design language**: premium, cinematic, calm, AI-native; large previews; imagery over
  metadata; cards everywhere; obvious primary CTA; progressive disclosure. Not: SaaS dashboard,
  engineering console, node tool, traditional NLE.
- FR-39.3 **Failure UX**: every long action has explicit queued/running/failed states with
  per-stage diagnosis (assembly failures name the failing shot — FR-13); retry reuses exact
  params; nothing spins without a state.
- FR-39.4 **Responsive + a11y**: WCAG 2.2 AA (v1 §5 + production UX spec targets), mobile
  breakpoints, keyboard shortcuts with `data-testid` contract per the production UX spec.
- FR-39.5 **Cost visibility**: costTier badge today; budget-kernel-backed estimate/actual cards
  on every batch surface once quote feeds land (FR-35 = UI for FR-17).

---

## 7. Data and persistence

- The production store (**SQLite + media vault**, integrated) is the durable system of record;
  `.studio/*.json` is a lossless one-time import source (already built). This supersedes v1's
  "Supabase working default" — local single-creator is the shipped reality; Postgres/object
  storage returns only at the SaaS boundary (open decision 4).
- **New entity: Workspace** (FR-21.1) stored in the production store above `Project`.
- Production snapshot refs (FR-21.3) + content-addressed vault refs make vision §48's
  "old episodes remain reproducible" a storage-cheap property (refs, not copies).
- Usage events/cost ledger per FR-17 (kernel integrated; feeds pending).

---

## 8. Capability matrix — vision behavior → what powers it

| Vision behavior | Mechanism | Provider reality | Status |
| --- | --- | --- | --- |
| Character variants (§6–8) | image models + img2img; lineage | all Sogni image models take starting images; Grok edits | built (formalize selection UX) |
| Identity-preserving refine (§8) | multi-ref edit models, identity.front lead ref | GPT Image ≤16 / Qwen ≤3 / Krea Identity ≤3 | plumbing built; refine UI = FR-22.2 |
| Character canon sheet (§9) | six-view chain + identity pinning | Sogni | built |
| Environment canon (§10–13) | edit models anchored on plate | feasible today | FR-23 (plates: generate + views) |
| Story from idea (§23/26) | writer + text-engine chain | abliterated Qwen / Pollinations / custom | built; chat revision = FR-28 (I02) |
| Storyboard (§27) | ShotPlan/Animatic revisions + anchors | n/a (domain) | domain built; UI = creator flow |
| Real video scenes (§30) | i2v/t2v families + Grok video | WAN 1–10s, LTX 2–20s, Seedance 4–30s, MiniMax ≈5–15s; Grok ≤15s | built |
| First/last-frame handoff | `referenceImage(+End)`, `returnLastFrame` | LTX 2.3 + Seedance 2.5 dual; Grok start-only | built (constrained by family) |
| Takes (§32) | `Take` + reversible selection | any | domain built; UI = FR-25 |
| Continuity validation (§33) | castBindings + advisory vision gate | DeepSeek vision (1024px cap) | advisory built; report = FR-26 |
| Voice (§34–35) | TTS adapter + voice lock | **none today** (C16 planned; ElevenLabs option) | FR-27 (import bridge first) |
| Music/SFX (§36) | audio import → C16 generation | none today | phased (C09–C12, C16) |
| Assembly/master (§24) | manifest compiler + FFmpeg worker | local ffmpeg | contracts built; worker = C11/C12 |
| Cost control (v2 principle 6) | budget kernel + quotes | costTier badge only; quote feeds pending | kernel built; UI/feeds = FR-35 |
| Publish (§41–43) | export + publication package → OAuth | manual today | ladder FR-32 |
| Workspaces (§14–20) | new entity + isolation contract | n/a | FR-21 (new) |
| Auto Mode (§39) | orchestration + review queue | everything above | FR-29 (post-pipeline) |

---

## 9. Roadmap

Sequenced so the channel produces before the vision is complete (v1 strategy kept), aligned to
the production-core packet order. Vision sections land as noted.

- **P0 — Studio shell + workspaces.** FR-38 (home, nav, naming, empty states, onboarding),
  FR-21 (workspace entity + isolation + context header), FR-33 (library relabel/filters),
  FR-39 (language standard + jargon audit). *Pure data/UI; no new AI.*
- **P1 — Creator flow on the domain layer** (= production-core composer C, runtime W, creator
  UI packets): expose canon/script/shots/anchors/takes behind the four-stage navigation;
  FR-24 (storyboard + anchor-first UX), FR-25 (takes UI). *Depends on the pending C/W packets.*
- **P2 — Canon studios + writer chat.** FR-22 (variant selection + refine), FR-23 (environment
  generation + canon views), FR-28 (proposal chat, rides I02).
- **P3 — Audio.** C09/C10 import/mix + FR-27 voice (import bridge → TTS adapter when C16 or
  ElevenLabs decision lands), FR-14 mixing rules.
- **P4 — Assembly, export, derivatives.** C11/C12 + QC surfacing, FR-31 (NL bar + manifest
  view), FR-15 derivatives, export options.
- **P5 — Publish.** FR-32 platform ladder (manual → YouTube OAuth → placeholders), compliance
  checklists, rating gate.
- **P6 — Vision-complete layer.** FR-29 Auto Mode (flagship), FR-30 music video, FR-26.2
  continuity report polish, advanced timeline affordances.
- Pilots/recovery (C13–C15) run in parallel from P1; C16 (speech/music generation) upgrades P3
  capabilities when live.

---

## 10. Acceptance criteria

v1's criteria (§7 of the draft: mastered 3-min MP4, single-shot re-render isolation, reference
injection recorded, cost visible before/after, cross-device survival, kids compliance,
verify-scripts) all stand, plus:

1. A first-time user completes vision §54 (workspace → character → environment → one sentence →
   storyboard → first cut draft) without seeing a provider/model term outside Settings/Advanced.
2. A returning user creates the next episode from one sentence + length + cost confirmation
   (vision §55) with characters, environments, style, voices and continuity carried by the
   workspace.
3. Isolation test: for N random generations inside workspace W, the recorded reference set ⊆
   W's selection ∪ explicit user picks — asserted by test, not review.
4. Auto Mode produces a complete first-cut draft with zero auto-approvals; every gate has a
   pending review card; partial failures degrade per FR-25.4 without blocking delivery.
5. No banned vocabulary appears in primary UI (automated jargon audit in CI).
6. Removing a character from a workspace changes no historical production (snapshot test).
7. Adult-rated workspace publish screen offers export only, with a plain-language reason.

---

## 11. Open decisions

1. **Worker placement** for assembly at volume (local runner → container) — kept from v1;
   manifest interface keeps it swappable.
2. ~~Supabase vs alternatives~~ — **resolved**: local SQLite + vault is the shipped v1;
   hosted storage re-opens only at the SaaS boundary.
3. **Video provider expansion**: fal.ai Kling/Veo/Wan (FR-10) vs deepening Sogni families
   first — decide at P1 exit when real episode spend data exists.
4. **SaaS boundary**: single-creator local → multi-tenant (auth, hosting, Supabase-style
   storage) — trigger: external-user promotion, same as v1.
5. **TTS provider**: ElevenLabs-first vs waiting for Sogni speech (C16) — decide at P3 entry.
6. **"Places" → "Environments" relabel timing** — coordinate with the `feat/ui-overhall` naming
   pass (one rename event, not two).
7. **Adult-workspace publishing policy** — export-only is the v2 position; revisit only if a
   platform with permissive API terms emerges.
8. **Auto Mode estimate gating** — recommendation: hard confirm above a workspace-configurable
   threshold; confirm before P6.
