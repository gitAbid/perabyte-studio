# PeraByte Production Studio Master Plan

> **Enriched execution specification:** Start at [docs/production/README.md](production/README.md). Its architecture, UI/UX, quality gates and dependency-checked task packets refine this roadmap and govern the next implementation. The standalone preview is a design prototype, not an implemented production UI.

**Status:** Architecture and delivery roadmap, 2026-10-03
**Product target:** Solo creator script-to-video studio; children’s stories are the first pilot.
**Delivery principle:** Ship small, independently verifiable increments. No phase claims model-perfect consistency; canonical references, approval gates, provenance, retries, and QC reduce risk and make failures inspectable.

## Product outcome

PeraByte should let one creator start from a reusable cast and world, write or import a script, shape it into shots, approve visual anchors, generate and select takes, bind narration/music/SFX, and export a finished video. The same shot pipeline must support solo clips and multi-shot stories, short and long form, portrait and landscape. First pilot defaults are English and ages 5–8, pending product-owner confirmation. Later genre profiles (mythology, documentary, promotion), thumbnails, descriptions, reels, and publishing reuse the production core.

The quality objective is continuity the creator can control: approved character identity and wardrobe, environment and spatial layout, props, story meaning, and voice remain attached to versioned source material. Generated assets are suggestions until reviewed; the system records which references, script revision, settings, provider/model, and approvals produced each accepted take.

## Existing architecture and constraints

The app is Next.js 16 / TypeScript. `app/api/*` routes are thin entry points into `lib/services/*`; domain rules live in pure `lib/domain/*` and `lib/story/*` modules; providers are registered behind interfaces in `lib/providers/types.ts` and `lib/providers/registry.ts`; repositories are separated under `lib/repositories/*`. This is a usable Strategy/port boundary. Build focused domain and application-service modules around it; avoid a generic workflow framework or unrelated UI rewrite.

Current story production already composes scene prompts from character/location rows (`lib/story/compose-shot.ts`), runs one scene at a time (`lib/story/server-runner.ts`), can render a keyframe, animate from it, and score it through an automatic vision gate (`lib/services/keyframe-gate.service.ts`, `lib/jobs/executor.ts`). This is a machine score with fail-open behavior, not a human approval workflow. Current jobs, stories, assets, and provider settings use synchronous JSON files under `.studio/`; media uses a disk-backed content-addressed cache through `lib/storage/bucket.ts`. Treat these as local/single-instance persistence, not production-grade shared durable storage. Production deployment gates must select and validate a transactional store, object store, worker runtime, and locking/idempotency design before claiming cross-instance durability.

The first implementation increment is implemented and verified, and intentionally narrow: strict reference/capability preflight, activated on story jobs that explicitly contain conditioning inputs, and explicit canonical story/scene character/location ID validation. It does not implement human approval, immutable revisions, audio, or mastering. Keep it separate from the later production increments described here. Current scene creation has a six-scene limit, and the character composer supports three characters per shot. P0 rejects cast overflow; P1 replaces the fixed scene limit with paginated/chunked shot planning and bounded batches so long episodes are feasible without pretending that six short clips form a 3–6 minute video.

## Target architecture

Keep API handlers as command/query adapters. Application services coordinate immutable domain records through repository ports and provider ports. Domain modules own validation, revision/dependency rules, approval state, capabilities, manifest validation, and QC policy. Provider adapters advertise capabilities and normalize provider-specific requests/results; they never silently discard a requested reference. A durable worker owns long-running renders, speech/audio generation, asset persistence, and FFmpeg assembly. A versioned render manifest is the explicit contract between orchestration and assembly.

```text
Studio UI → thin API → application services → domain policies
                                  │               │
                                  ├→ repositories ├→ immutable project/revision records
                                  ├→ provider ports (image/video/speech/music/vision)
                                  └→ durable queue → workers → media vault / FFmpeg
                                                           └→ QC report + accepted export
```

Core concepts: `Project` owns reusable cast/world and a production profile; `StoryRevision` is immutable script and scene structure; `ShotRevision` is immutable visual/audio intent; `Anchor` is a generated still with reference provenance and an explicit review status; `Take` is an immutable generated candidate; `Approval` records actor, target revision/hash, decision and timestamp; `AudioCue` binds narration/music/SFX to timeline intervals; `RenderManifest` snapshots accepted inputs; `Export` points to output and QC evidence. Solo work uses a one-shot project/shot through the same records and services, without default chaining to an unrelated prior render.

Dependency changes invalidate downstream approvals and manifests by input-hash/version, while preserving historical records and generated files per retention policy. A rejected or superseded take remains in history. Each human “approve” action applies only to the exact source fingerprint reviewed. Camera cuts re-anchor; continuous camera movement opts into explicit frame continuation. Model-judged scores can inform a review but cannot mark an anchor human-approved.

## Phased roadmap

### P0 — Strict reference and story canon foundation (implemented)

**Outcome:** Requests that explicitly require canonical references or IDs fail before provider work if inputs are malformed, missing, unsupported, or silently filtered. Legacy requests retain compatible permissive behavior.

**Ownership seams:** `lib/domain/reference-policy.ts` for pure capability validation; `lib/services/generation.service.ts` for shared preflight; `lib/story/canon.ts` for pure ID and cast membership checks; `lib/story/server-runner.ts` for pre-mutation validation and canonical location resolution; tests beside those modules. Routes remain thin.

**Verification on 2026-10-03:** 835 tests across 78 files passed; standalone typecheck and production build passed. Independent GPT-6.1 Sol review found no remaining P1/P2 issues in this increment. No paid generation or visual quality benchmark was performed. Existing Vite configuration and FFmpeg tracing warnings remain documented in TASKS.md.

**Gate:** Public service/runner tests prove strict unsupported start/end/context, over-capacity and unavailable media fail without a provider call; story/scene unknown character/location IDs fail with scene/field detail before state mutation; resolved location rows feed prompt composition. Legacy persisted jobs with no policy still run. Typecheck and production build pass. No paid generation is needed.

### P1 — Immutable production records, human anchor approval, provenance and retakes

**Outcome:** Creators can reuse the same cast/world in solo and story work, approve each visual anchor before animation, and return to any previous take without overwriting history. Default sequencing is independent; chaining is an explicit per-shot choice.

**Modules and responsibilities:**

- `lib/domain/production/*`: schema/value types and pure transitions for project, story/shot revisions, anchors, approvals, takes, dependencies and invalidation. Hash only normalized, versioned inputs.
- `lib/repositories/production.repository.ts` (or focused repository files): repository port and initial adapter. Add storage selection only after durability decision; preserve JSON adapter for local development/migration where useful.
- `lib/services/production.service.ts`, `approval.service.ts`, `take.service.ts`: command orchestration, revision creation, approval checks, retake history, and dependency invalidation.
- `app/api/projects/*`, `app/api/stories/*`, `app/api/shots/*`, `app/api/approvals/*`: thin validated endpoints; existing story endpoints migrate incrementally.
- `lib/story/*`: replace the six-scene ceiling with validated production shot budgets, stable ordering, pagination and resumable batch planning; adapt scene composition/runner to use immutable shot snapshots and explicit predecessor policy; automatic vision gate remains advisory.
- UI work in project/story/shot review surfaces: show pinned references, keyframe, provenance, approve/reject/edit, takes, stale approval reason, and retry state.

**Dependencies:** P0 canon/reference contract. Before production rollout, decide transactional DB, object storage, auth/tenant boundaries and migration/backup strategy. Load database-specific skills and security review before any schema work; no database migration is part of the first increment.

**Gate:** Unit tests cover revision immutability, hash changes on each dependency, approval only for matching fingerprints, invalidation after cast/wardrobe/world/script/shot edits, retained sibling takes, reject/retry paths and explicit chaining. Service/API tests prove unapproved or stale anchors cannot animate in strict production mode, and solo one-shot uses the same flow. A restart/multi-process test must establish persistence semantics of the selected adapter before deployment.

### P2 — Provider capability truth, quotes, idempotent workers and media vault

**Outcome:** Providers are selected only when they can honor requested inputs; costs and entitlements are visible before spend; queued work survives process restart and duplicate submissions; media is retained under our storage contract.

**Modules and responsibilities:**

- `lib/providers/types.ts` and `lib/domain/capabilities.ts`: capability vocabulary for text/image-to-video, start/end frames, timed keyframes, reference limits, native audio, speech/music/SFX, durations, aspect ratios, outputs and pricing metadata.
- `lib/domain/reference-policy.ts` (or its P2 successor): distinguish required references (generation must fail if the provider cannot consume them) from optional references (provider may omit only with explicit user-visible disclosure/receipt). A successful submission returns a typed `HonoredInputsReceipt` listing each requested input, whether it was honored, its provider field/mode, capability provenance and any disclosed omission. Persist this receipt with the job and final take. Receipt states distinguish mapped, provider-acknowledged, rejected and unknown inputs; they record conditioning transport, not a guarantee of visual adherence. QC and human review determine adherence separately. Success status alone must never imply every input was used. Strict means every required input is honored and every optional omission is surfaced before submission for user choice.
- `lib/providers/sogni/*`: SDK compatibility adapter, dynamic catalog, upload and job result mapping. Upgrade `@sogni-ai/sogni-client` from pinned range `^5.49.0` only after tests against exact installed SDK APIs.
- `lib/services/quote.service.ts`: estimate/entitlement boundary; return model, mode, expected range, assumptions and expiry. Require a fresh server quote and an authorized project spend cap for paid work; reuse that authorization while model, scope and budget remain within it. Do not silently switch subscription/unlimited work to Spark.
- `lib/jobs/*`: idempotency keys, durable enqueue/outbox, bounded retries/backoff, lease/heartbeat, cancellation, dead-letter/recovery and concurrency budgets; keep provider calls outside HTTP lifetime.
- `lib/storage/*` and `lib/repositories/media.repository.ts`: persistent media vault adapter, checksums, MIME/size checks, retention, derivative generation and signed access.
- `lib/services/provider-capability.service.ts`: live catalog normalization and capability cache with expiry; conservative unknown state.

**Sogni verification basis:** Official MiniMax H3 docs describe FL2VA image-to-video / first-last-frame FLF2V separately from Ref2VA. Timed keyframes require SDK 5.58 or later; current project range is 5.49. H3 fixed 24 fps accepts frame counts `124 + n*17` up to 362; Ref2VA accepts up to 12 mixed references (9 images, 3 video, 3 audio) as loose references; FastH3 is separate and lacks R2V; native stereo audio and two-stage generation are documented. Published H3 product and two-stage resolution notes conflict for R2V, so probe live capabilities and never promise 2K R2V without a successful capability check. Sources: [MiniMax H3](https://docs.sogni.ai/models/minimax-h3/), [Sogni media utilities](https://docs.sogni.ai/api-reference/media-utilities/), [Sogni direct generation](https://docs.sogni.ai/api-reference/direct-generation/).

**Adapter conformance concern:** Current `lib/providers/sogni/request-maps.ts` decides image `contextImages` support through curated static `sogniModelMeta(model)` metadata. A live catalog may advertise a capability absent from that local table, or local metadata may age out. P2 must make capability provenance explicit (`live catalog`, `SDK contract`, `curated fallback`, `unknown`), define precedence/expiry, and test that a live-advertised supported field reaches the SDK payload and is represented in the receipt. Unknown/stale capability data cannot satisfy a required reference. Verify every claimed mapping at the adapter boundary, not only in preflight.

**Pricing/quote policy:** Sogni pricing says H3 is covered by Unlimited/Pro fair use; subscription mode is automatic. Throughput differs by entitlement. Spark premium rates are model/quality dependent. Display the actual quote and entitlement response. Published 768p-class baseline render rates are 4 Spark/second for FastH3, 6 for LightX2V Turbo, 10 for Balanced and 16 for Standard, with a $0.005/Spark render-value benchmark; these are planning estimates, not account-specific quotes. Subscription coverage, input-video charges, timed-keyframe charges and two-stage surcharges change the effective cost. Never force Spark fallback. [Sogni pricing](https://docs.sogni.ai/pricing/).

**Gate:** Capability contract tests against captured/fixture catalogs and live non-billable discovery; SDK contract tests for each supported H3 mode; incompatible strict request is rejected before submission; quote expiry, entitlement denial and cap are exercised; duplicate idempotency keys create one provider job; recovery, lease loss and object-store outage are tested. Any paid smoke render requires explicit product/user authorization and a predeclared cap; none has been run for this plan.

### P3 — Narration, voice locks, music and sound effects

**Outcome:** Narration is script-revision-bound with reusable voice identity and pronunciation notes; music and SFX are reusable assets bound to explicit cues and timeline positions.

**Modules and responsibilities:**

- `lib/domain/audio/*`: voice profile, narration segment, cue, mix policy and timing contracts.
- `lib/providers/types.ts`, `lib/providers/*`: separate speech, music and sound-effect capability ports; provider-specific adapters. Keep generation separate from timeline placement.
- `lib/services/audio.service.ts`: narration segmentation, voice lock, timing alignment, music/SFX asset binding and validation against the active script/shot revision.
- `lib/repositories/audio.repository.ts`: voice/cue/source provenance and media references.
- UI: preview/regenerate selected line or cue, pin a voice, adjust cue in/out and gain, audition mix.

**Provider facts and gate:** Use upload-based music and curated/uploaded SFX first, with rights/source provenance captured per asset; generation remains behind replaceable ports. Sogni `generate_speech` accepts literal text up to 4096 characters with voice/clone/design options; cloning is per request rather than persistent voice training. Documented language list does not include Bengali, so validate language/voice support at runtime before offering Bengali. Direct generation documents music through `generate_music` and ACE Step. Sources: [Sogni media utilities](https://docs.sogni.ai/api-reference/media-utilities/), [Sogni direct generation](https://docs.sogni.ai/api-reference/direct-generation/). Gate requires stable voice identity across at least 10 segments, script-to-audio text coverage, cue timing and duration checks, provider failure recovery, and a clear unsupported-language path. Do not describe per-request cloning as a permanently trained voice.

### P4 — Versioned manifest, FFmpeg mastering and quality control

**Outcome:** Short and long form exports are reproducible from an immutable manifest and accepted assets, with explicit aspect ratio, timing, audio mix, captions and QC evidence.

**Modules and responsibilities:**

- `lib/domain/render-manifest.ts`: versioned, provider-neutral export input schema; deterministic validation and canonical serialization.
- `lib/services/manifest.service.ts`: snapshot only approved shot takes/audio bindings; fail if any dependency is stale or missing.
- `lib/media/ffmpeg/*` (or focused `lib/services/assembly.service.ts`): worker-only FFmpeg invocation, ordered clips, fades/transitions, narration/music/SFX mix, subtitles, poster and transcode profiles. Use FFmpeg filter graph `concat`, `amix`, `sidechaincompress` as appropriate, and two-pass `loudnorm` measurement/normalization ([FFmpeg filters documentation](https://ffmpeg.org/ffmpeg-filters.html)). For the pilot, set a product target of -14 LUFS integrated / -1 dBTP true peak; this is our mastering target, not a claim that YouTube mandates it. Narration-driven shot timing must respect each selected video model's legal frame/duration grid (including H3's quantization), and the manifest records any timing adjustment. Never shell-concatenate user input; use argument arrays, resource/time limits and temporary workspaces.
- `lib/domain/qc/*`, `lib/services/qc.service.ts`: machine-check codec/container, dimensions, frame rate, duration, black/silent gaps, audio peak/clipping, caption bounds and manifest-to-output consistency; emit report and artifact hashes.
- Export API/UI: asynchronous export status, downloadable master, preview, report, retry and retained versions.

**Initial profiles:** short 9:16, 30–60 seconds; long 16:9, 3–6 minutes. Both use same shot/take/audio graph. Define frame-rate, codec, loudness, subtitle and safe-area targets during implementation with pilot platform needs; store them in versioned profiles, not provider-specific logic.

**Gate:** Fixture manifests render deterministically; unit tests validate ordering and timeline arithmetic; worker integration tests verify retry/idempotency and cancellation; QC intentionally rejects malformed video, missing audio, clipping, black gaps and stale manifest inputs. Two end-to-end local exports (one short portrait, one long landscape) pass report checks before pilot. Capture resource/time budget per minute and maximum output size. Start with local FFmpeg; consider Remotion only if later graphical template requirements exceed filter graphs. No new renderer is required for the pilot. Filter behavior is documented in the [official FFmpeg filter reference](https://ffmpeg.org/ffmpeg-filters.html).

### P5 — Reliability pilot and product polish

**Outcome:** A small creator pilot completes work across sessions and can recover from provider, worker, storage and browser failures. Close operational gaps before adding provider or genre breadth.

**Gate:** Agreed pilot cohort and consent; persisted job recovery after worker restart; backup/restore exercise; tenant/auth checks; deletion and retention behavior; redacted operational logs; dashboard for queue age/failure/cost/storage/QC; support runbook and rollback path. Track first export completion, time-to-first-approved-anchor, retake rate, consistency rubric, failure recovery, user-reported control and cost per finished minute. Targets are set from observed baseline, not invented retrospectively.

### Later expansion — profiles, publishing and derivatives

Add mythology/documentary/promo writing and shot profiles against the same project/story/shot records. Generate thumbnail variants and descriptions only from the approved final manifest/export metadata; maintain source and approval links. Create reels by selecting ranges from accepted shots, not re-generating canonical story content by default. Add YouTube or other publishing only after OAuth scopes, account selection, upload privacy, metadata preview, explicit publish confirmation, resumable upload, and idempotency are designed. Publishing is a separate integration milestone after P5.

## Parallel work packages and dependency graph

Parallelize only modules with stable contracts and no shared file ownership. The integrator owns contracts, integration, migrations and final gates. Each work package produces a small reviewed PR/commit and tests at its boundary.

| Package | Can run alongside | Depends on | Main ownership | Acceptance gate |
|---|---|---|---|---|
| W0: P0 integration | None | Existing baseline | `reference-policy`, `generation.service`, `story/canon`, `server-runner` | P0 gate above, including story conditioning requests using strict policy; lock contract before other packages |
| W1: production domain records | W2 discovery spike | W0 | `lib/domain/production/*`, pure tests | revision/hash/invalidation transition tests pass |
| W2: storage/queue decision and capability spike | W1 domain modeling | W0; selected infrastructure decision before adapter implementation | ADR first; provider capability types + probe fixtures; no DB schema until selected | approved ADR, capability contract tests; no paid call |
| W3: approval/take services and UI | W4 provider capability | W1 record contract | `lib/services/approval.service.ts`, `take.service.ts`, approval routes/review UI | stale/unapproved keyframe cannot animate; history retained |
| W4: worker, quote and media adapters | Audio-domain modeling | W2 ADR/capability contract | `lib/jobs/*`, `lib/storage/*`, quote/Sogni adapter | dedupe/restart/quote gates; failure injection passes |
| W5: audio domain and UI | W3 review contracts, W4 provider interfaces | W1 revisions; speech/music capabilities | `lib/domain/audio/*`, audio service/repo/UI | voice lock, line coverage, cue timing gates |
| W6: manifest, assembly and QC | W3 accepted takes, W5 audio bindings, W4 durable workers | All inputs stable | `render-manifest`, `assembly.service`, `media/ffmpeg`, QC modules | both export profiles and QC suite pass |
| W7: pilot hardening | Can start operational planning early | W4–W6 | deployment config, observability, runbooks, pilot UX | P5 operational gate |

Research and implementation workers may work in parallel on separate files. Do not parallel-edit `lib/providers/types.ts`, `lib/jobs/*`, shared migration files, or shared production domain schemas. One designated integrator lands each shared contract first, then delegates provider-specific adapters or isolated UI work. GPT-6.1 Sol owns architecture/integration/review; GPT-6 Luna workers own bounded research, tests, and implementation packages as specified by the execution plan.

## Verification and benchmark protocol

Do not report proposed numbers below as measured. Before choosing model defaults or claiming continuity, build a repeatable six-shot story with the same two characters, fixed wardrobe and props, and two distinct locations. The story has an explicit beginning, goal/problem, attempt, consequence, resolution, and age-appropriate ending; every shot must advance or clarify that arc, with no invented cast/location IDs. Include a cut from location A to B, a return, close and wide framing, and one explicitly continuous move. Freeze canonical reference set, story/shot revision, seeds where supported, capability snapshot, model/version, prompt, aspect ratio, and generation settings. Produce three takes per shot for at least three independent runs; preserve every asset and cost/latency record.

Score blinded outputs against a rubric: face/identity, wardrobe, prop presence, environment layout/location, spatial relation, shot intent/story meaning, frame continuity where requested, voice identity/text fidelity, cue timing, and export QC. For story faithfulness, raters compare each shot against the approved story beat and mark contradiction, omission, or unsupported addition; any critical plot contradiction or dangerous age-inappropriate content blocks acceptance regardless of aggregate score. Two human raters independently mark pass/fail and 1–5 severity; adjudicate disagreements. Proposed P1 visual gate: at least 90% of approved anchor reviews pass required identity/wardrobe/location checks on first submission after no more than one prompt/reference refinement; proposed accepted-take gate: at least 85% retain those checks after animation. Story gate: zero critical plot contradictions across approved shots and at least 90% of shot intents judged faithful by both raters. These are pilot hypotheses, not guarantees; revise thresholds from baseline and user tolerance before enforcement. Report confidence intervals and per-category failures; do not collapse location or identity failures into one average.

The audio gate uses at least 10 narration segments across the story and checks voice consistency, exact intended text coverage, intelligibility, pronunciation exceptions, cue offsets, clipping and audibility under music. Assembly gate checks both target profiles against the manifest and QC report. Human approval remains the source of acceptance; model vision scores are diagnostic.

## Budget and operational controls

- Before provider submission, validate capability, entitlement, current quote, user cap, duration, output count and estimated storage. Fail closed when strict references or a required quote are unavailable.
- Define per-job limits for retries, parallelism, wall time, output bytes, vision calls and FFmpeg CPU/memory. Retry only classified transient faults with bounded backoff; provider ambiguity is reconciled by idempotency key before resubmission.
- Show estimated and actual spend per take, job, and project with quote id, entitlement mode, and variance. Reconcile provider receipts/usage where available; label unverified actuals clearly if provider reporting cannot identify final billing. Use subscription entitlement if valid; premium Spark use must stay within a previously authorized project budget, or obtain authorization for the specific additional spend. No automatic paid fallback. Apply per-project and per-day caps with a stop state users can understand.
- Record provider/model/SDK/capability snapshot and quote id with each job. Alert on rising queue age, repeated failure, quote drift, missing media, storage growth and QC regression.
- Keep secrets server-side, restrict media and project reads by owner, sanitize provider errors, and define retention, deletion and backup restoration before multi-user pilot.
- No paid experiments are included in this plan. Run a paid smoke test only within an authorized experiment or project budget that covers its model, inputs, maximum spend and expected output; obtain authorization only when that scope or cap is missing or exceeded.

## Key risks and responses

| Risk | Response |
|---|---|
| Reference conditioning still drifts across animation | Human-approved still before animation; strict capability checks; retake and anchor regeneration; measure separately by category/model. Never promise exact identity. |
| Provider catalog/SDK behavior changes | Capability snapshots, contract probes, version pinning, conservative unknown handling, scheduled compatibility review, no unsupported fallback. |
| Pricing or entitlement differs from an estimate | Fresh quote/entitlement response, user cap, confirmation, final charge reconciliation; no Spark substitution. |
| Sogni H3 docs disagree on R2V resolution or language support is absent | Live capability probe and small gated compatibility test; keep Bengali unavailable until verified. |
| Local JSON/disk persistence loses data or diverges across instances | Keep local adapter for development only; make production store decision and restore test a release gate. Load DB/security guidance before schema or RLS work. |
| Durable worker retries duplicate billed work | Stable idempotency key and outbox/lease state, query provider before resubmission, record attempt and provider reference. |
| Script edits silently invalidate visually approved work | Immutable revisions and dependency hashes; show exactly what became stale; retain old approval and take history. |
| FFmpeg resource exhaustion or unsafe input handling | Isolated worker, argument-array invocation, bounded inputs/resources/time, cancellation and temp cleanup, artifact inspection. |
| Kids content requires additional safeguards | Define age/content policy, moderation and reporting requirements with product owner; test prompt and output paths before pilot; avoid claiming child-safe output solely from provider filters. |
| Scope expansion delays core continuity | P0–P4 gates first; defer genres and publishing until pilot evidence supports them. |

## Decisions still required before their dependent phase

1. Confirm pilot age band, language(s), creator auth/tenant model, and which outputs count as suitable children’s content.
2. Select production persistence and hosting topology (transactional DB, object store, durable queue/worker); the current file-backed repositories do not settle this decision.
3. Agree spend ceilings, whether any subscription-backed Sogni entitlement is available, and who can authorize premium spend.
4. Set export codec, frame rate, loudness, caption policy, storage retention and target platform presets before P4 implementation.
5. Decide whether voice cloning is permitted for the pilot and the consent, labeling and retention rules for uploaded voice references.

Until each decision is made, continue work that does not depend on it (pure domain contracts, validation and local-only flows) and mark dependent production behavior as gated.
