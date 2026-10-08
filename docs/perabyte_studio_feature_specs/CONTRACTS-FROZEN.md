# CONTRACTS-FROZEN — Wave 0 authority record

**Status:** FROZEN by lead/integrator (2026-10-07). Feature agents consume these names. Changes require an explicit contract-change RFC (spec `02_SHARED_CONTRACTS.md` §12). "Frozen" = changes go through the lead, not around them.

Existing code wins where it already implements a spec concept (`cost pipeline §9`, `dependency invalidation §11`, `CanonRevision`, `Shot/Take/Approval/Job` schemas). The gap below is what Wave 0 adds.

---

## C1. Canon kind vocabulary

- `CanonEntityKindSchema` extends to `["character", "environment", "location", "prop", "style"]`.
- `"environment"` is the canonical written value going forward; `"location"` remains valid for legacy records (read path tolerates it). UI NEVER shows the word "location"/"Locations" — label is "Environment(s)".
- Helper: `isEnvironmentKind(kind)` = `kind === "environment" || kind === "location"`.

## C2. Workspace (new)

```ts
WorkspaceSchema = strictObject({
  version: SchemaVersionSchema,
  id: IdSchema,
  name: NonEmptyTextSchema.max(160),
  characterCanonIds: IdSchema[] (max 200),      // canon ENTITY ids (not revision ids)
  environmentCanonIds: IdSchema[] (max 200),
  styleCanonIds: IdSchema[] (max 50),
  worldBible: WorldBibleSchema,
  productionRecipe: ProductionRecipeSchema,
  rating: z.enum(["General", "Mature", "Adult"]),
  budgetPolicyId: NullableIdSchema,             // links to existing budget_policies table
  createdAt: UtcMillisSchema, updatedAt: UtcMillisSchema,
  saveVersion: positive int,                    // optimistic concurrency, same as Project
})
```

## C3. WorldBible (new, minimal-extensible)

```ts
WorldBibleEntrySchema = strictObject({ id: IdSchema, title: NonEmptyTextSchema.max(200), body: NonEmptyTextSchema.max(20_000), tags: string[] (max 20) })
WorldBibleSchema = strictObject({ version: positive int, summary: z.string().max(20_000), entries: WorldBibleEntrySchema[] (max 500) })
```

World Bible version bumps only through an explicit save command; it is content, not prose-prompt.

## C4. ProductionRecipe (new)

```ts
ProductionRecipeSchema = strictObject({
  version: positive int,
  qualityStrategy: z.enum(["economy", "balanced", "best"]),
  aspectRatio: z.enum(["16:9", "9:16"]),
  language: z.string().trim().min(2).max(35),
  defaultShotTargetFrames: PositiveFramesSchema,
})
```

`recipeVersion` referenced elsewhere = `productionRecipe.version`.

## C5. ProductionSnapshot (new; spec §3 verbatim shape)

```ts
ProductionSnapshotSchema = strictObject({
  id: IdSchema, projectId: IdSchema, workspaceId: IdSchema,
  characterRevisionIds: IdSchema[] (max 200),   // REVISION ids (pinned at production creation)
  environmentRevisionIds: IdSchema[] (max 200),
  styleRevisionIds: IdSchema[] (max 50),
  recipeVersion: positive int,
  worldBibleVersion: positive int,
  createdAt: UtcMillisSchema,
})
```

- `ProjectSchema` gains `workspaceId: NullableIdSchema` + `activeSnapshotId: NullableIdSchema` (both optional-on-read for legacy rows; writers set them for new projects).
- Workspace edits affect NEW productions only — snapshots are immutable.

## C6. CharacterState / EnvironmentState + inheritance (new; spec §4–§5 verbatim fields)

```ts
CharacterStateSchema = strictObject({
  characterCanonRevisionId: IdSchema,
  outfit: optional NonEmptyTextSchema.max(500), hairState: optional …max(500),
  accessories: string[] (max 20), carriedObjects: string[] (max 20),
  condition: string[] (max 20), agePresentation: optional …max(200), notes: optional …max(2000),
})
EnvironmentStateSchema = strictObject({
  environmentCanonRevisionId: IdSchema,
  zone: optional …max(200), lighting: optional …max(200), timeOfDay: optional …max(200),
  weather: optional …max(200), persistentProps: string[] (max 50),
})
```

- Pure resolver `resolveCharacterState(layers: Partial<CharacterState>[] )` / `resolveEnvironmentState(...)` in `lib/production/states.ts`: most specific layer wins per FIELD (not per object). Layer order: canon defaults → production → scene → shot override.
- `undefined` field = inherit from previous layer; `null` is NOT used for clearing.

## C7. Scene / Shot / Take mapping (spec §6 onto existing schemas)

- NEW `SceneSchema`:
```ts
strictObject({ version, id, projectId, storyRevisionId: NullableIdSchema, order: nonneg int,
  title: NonEmptyTextSchema.max(200), action: NonEmptyTextSchema.max(20_000),
  dialogue: array of strictObject({ characterCanonRevisionId: IdSchema, text: VerbatimTextSchema.max(20_000) }) max 100,
  durationTargetMs: UtcMillisSchema.nullable(),
  characterStates: CharacterStateSchema[] (max 10), environmentState: EnvironmentStateSchema.nullable(),
  contentHash: Sha256Schema, createdAt: UtcMillisSchema })
```
- `Shot` = existing `ShotRevision` + two additive nullable fields: `sceneId: NullableIdSchema`, `cameraMotion: z.string().max(200).nullable()` (freezes spec §6 `cameraMotion`; `framing`→`framing`, `durationTargetMs`→`targetFrames`, `takeIds/selectedTakeId` stay derived from `take_selections`, exposed via read model, NOT stored on the shot).
- `Scene.shotIds` is DERIVED (shots where `sceneId === scene.id`, ordered by `order`); never authored directly.
- `Take` = existing `TakeSchema` + additive: `directionNote: z.string().max(2000).nullable()`, `paramsHash: Sha256Schema` (alias populated alongside `inputsHash`; both hash the same request snapshot), `recommendation: z.enum(["none","recommended"]).nullable()`. `state` remains the existing richer `JobStatus` projection; UI maps to `queued|running|failed|ready`.

## C8. Approval state (spec §7)

- NEW `ApprovalStateSchema = z.enum(["draft", "recommended", "approved"])`.
- Derivation, not storage: `deriveApprovalState(input: { approval?: { decision: "approved" | "rejected" } | null; recommendedAt?: UtcMillis | null; rejected?: boolean }): ApprovalState` in `lib/production/approval-state.ts`. Precedence: explicit approval record → `approved` (or superseded/rejected → `draft` again); else `recommendedAt` set → `recommended`; else `draft`.
- Artifacts gain optional `recommendedAt: UtcMillisSchema.nullable()` where recommendation matters (anchor candidates, takes, story revisions). AI pipelines may write `recommendedAt`; ONLY `CreateApprovalCommand` (explicit user action) creates `approved`. Viewing a first cut never approves dependencies.

## C9. GenerationJob scope + retry semantics (spec §8)

- `ProductionJob` gains additive nullable fields: `scope: strictObject({ workspaceId: NullableIdSchema, productionId: NullableIdSchema, sceneId: NullableIdSchema, shotId: NullableIdSchema }).nullable()`, `retryOf: NullableIdSchema`, `resolvedReferenceIds: IdSchema[] (max 500)`.
- Retry derivations (pure functions in `lib/production/job-retry.ts`):
  - `tryAgainCommand(job)` → identical `requestSnapshot`, NEW id, `idempotencyKey` suffixed `-retry-<n>`, `retryOf = job.id`.
  - `differentTakeCommand(job, seed)` → same snapshot with `randomness.seed` replaced, `retryOf = job.id`.
  - `changeSomethingCommand(job, delta)` → snapshot + structured `delta` patch (typed per job kind), `retryOf = job.id`.
- Isolation admission: `assertResolvedRefsWithinWorkspace(resolvedReferenceIds, workspace)` in `lib/production/workspace-isolation.ts` — every resolved ref must be in `workspaceSelection ∪ productionSnapshot ∪ explicitUserPicks`; violation = `WorkspaceIsolationError` (job never enqueued). Called in `ProductionJobQueue.enqueue` admission path.

## C10. Manifest operations (spec §10)

Pure functions over `RenderManifest` in `lib/production/manifest-ops.ts`, each returning `{ manifest, inputsHash }` (recompile via existing `manifestInputsHash`):
`retimeShot(manifest, shotId, newDurationMs)` · `disableShot(manifest, shotId)` · `duplicateShot(manifest, shotId)` · `replaceTake(manifest, shotId, newAssetId)` · `setCaptions(manifest, captions)`.
(reorder/trim/transition/audio-cue-bounds already exist in `manifest.ts`.) No feature-local frame-level NLE code.

## C11. Routes + testids (frozen route table)

`/studio` (home) · `/workspaces` · `/workspaces/[id]` · `/environments` (legacy `/locations` → redirect) · `/voices` · `/library` · `/production/[projectId]/story` · `/production/[projectId]/storyboard` · `/production/[projectId]/continuity` · `/production/[projectId]/publish` · `/first-cut`.
Legacy `/production/[projectId]/{script,canon,plan,shots,anchors,takes,audio,export}` stay live until their successor passes verification, then redirect.
`data-testid` = `feature.entity.action` (spec 03), e.g. `storyboard.shot-card.approve`.

## C12. Shared UI primitives (spec 19 §5) — `components/production/primitives/`

One file per primitive, named exports, server-compatible (no client hooks unless marked `"use client"`):
`VariantGrid` · `CompareModal` · `GenerationStatus` · `ApprovalBadge` (consumes `ApprovalState`) · `WorkspaceContextChip` · `CostEstimateCard` (consumes BudgetQuote) · `NaturalLanguageChangeBox` · `VersionStrip` · `EmptyState` (re-export/extend existing) · `JobProgress` · `MediaPreview`.
`components/ui.tsx` is NOT modified by feature lanes — primitives compose existing `Button/Card/Badge` from it.

## C13. Persistence (new migration `005-workspaces.sql`)

Tables: `workspaces` (payload JSON + saveVersion + timestamps), `production_snapshots` (payload JSON, indexed by project), `scenes` (payload JSON, indexed by project+story_revision). Jobs table: add nullable columns `workspace_id`, `scene_id`, `retry_of`, `resolved_reference_ids` (JSON array). Store ports: `ProductionReadPort`/`ProductionWritePort` gain workspace/snapshot/scene CRUD methods following existing naming.

---

**Wave 0 gate:** contracts compile + contract tests pass (isolation invariant, state inheritance, retry derivations, approval-state precedence, manifest ops) + `npm run typecheck` green.

---

# Wave C+ — M4–M6 freeze (C14–C20, 2026-10-07)

Authority for Milestones 4–6 lanes. All shapes live in `lib/production/contracts.ts` unless noted. Existing production-core schemas are REUSED, not redefined: `AudioCue`, `AudioMixRevision`, `AudioMixSettings` (loudness), `SpeechSegment` (`proposals.ts`), `PublicationPackage` (`publishing.ts`), `ContinuityResult` (`continuity.ts`), retry commands (`job-retry.ts`).

## C14. Entitlement installer (Settings → Budget & authorization)

- Missing piece only: `ReviewedQuotePolicyConfig` (`lib/production/proof-policy.ts`) gains an installer/rotator/remover service + API + settings UI. Fail-closed remains the default state.
- API: `GET/PUT/DELETE /api/production/policy` — GET returns `{ configured: boolean, policy: { reviewedAt, dailyCapMicros?, perProductionCapMicros?, confirmThresholdMicros? } | null }` (never returns raw secrets); PUT accepts `ReviewedPolicyInputSchema`, persists canonical config via the existing reviewed-policy capture path; DELETE removes and logs.
- Audit: install/rotate/remove writes a `lib/logging/logger` entry with actor `settings-ui`.
- Doctor (`production-doctor.mjs`) flips `reviewedPolicyPresent` true once configured; proposals/budget admission unblock through the EXISTING chain (no new bypass).
- UI copy must state explicitly: "This authorizes real provider spend on this machine."

## C15. Guided re-roll (continuity → retake)

- `Re-roll with guidance` on a failing continuity dimension calls `changeSomethingCommand(job, delta)` (C9) where `delta` is the structured continuity guidance (dimension + note), producing a NEW take job with `retryOf` set. No prompt editing, no auto-approve; the new take enters Draft.

## C16. Audio mix contracts (spec 12)

- Frozen ALREADY in production-core: `AudioCueSchema`, `AudioMixRevisionSchema`, `AudioMixSettingsSchema` (loudness target range), `SpeechSegmentSchema` (`proposals.ts`).
- NEW additive fields on `AudioCue`: `delivery: DeliveryPresetSchema.nullable?` + `voiceId: NullableIdSchema` (optional on read; legacy cues parse unchanged).
- NEW `DeliveryPresetSchema = enum["auto","calm","excited","scared","angry","whisper","shout"]`.
- Voice bindings move from localStorage (`perabyte.voices.v1`) to server persistence (`lib/voices` read model + API); localStorage becomes a migration source only. Voice hierarchy unchanged: Global Voice → Character Canon Binding → Workspace-local Recast; recast never mutates canon.
- Loudness contract: default mix settings `-16 LUFS / -1.0 dBTP` (within existing schema ranges); assembly worker applies via existing loudnorm stage; stems retained.
- Route: `/production/[projectId]/audio` is the CANONICAL audio-mix route (legacy tag dropped); C11 table updated accordingly.

## C17. AutoRun state machine (spec 14, M5)

- `AutoRunSchema` (above): `awaiting_confirmation → running → awaiting_review → completed | failed | canceled`; stages `pending|queued|running|completed|failed|canceled|skipped` with per-scene lanes (`sceneId`) for failure isolation.
- Persistence: migration `007-auto-runs.sql` (`auto_runs` payload table, optimistic `saveVersion` like workspaces).
- Invariants: a run NEVER writes `approved` (only `recommendedAt`); cancel stops queued stages but preserves completed artifacts; boot resume re-claims `running` runs; rerun reuses recommended results where safe. Child jobs are ordinary ProductionJobs with `scope.productionId` — the orchestrator adds no new job kind.

## C18. TTS adapter seam (`lib/providers/production/tts-adapter.ts`)

- `TextToSpeechAdapter { id, available(), synthesize(TtsSynthesisRequest) → TtsSynthesisResult }` with module registry (`getTtsAdapter`/`setTtsAdapter`); null adapter = UI shows Import only (never fake-disabled Generate).
- Default engine (M5-4): `msedge-tts` (free, no key) as `edge-tts` adapter id; delivery presets map to style/rate hints; `speed` clamped 0.5–2.0. Generated-music/SFX stays behind the EXISTING `SogniAudioTransport` adapter (declared-fixture provenance — wire only behind availability gating).

## C19. Product metrics (spec 01 §7 / 17, M4)

- Migration `006-metrics.sql`: `metric_events` (id, project_id, workspace_id, kind, at, duration_ms, cost_micros, payload JSON with dims). No FKs (telemetry must not block deletes).
- `MetricEventSchema` + `RecordMetricEventCommandSchema` (above). Kinds frozen: `story_proposal_completed · storyboard_completed · first_cut_completed · generation_completed · generation_failed · asset_recommended · asset_approved · export_completed · review_completed`.
- Projections are computed at read (no projection tables): identity/environment/storyboard acceptance = approved÷(approved+rejected) per dims.assetKind; generated/selected ratio = generation_completed ÷ selected takes; cost-per-finished-minute = Σ reconciled cost ÷ export duration; time-to-* = first event of kind minus run/creation start; review time = `asset_recommended → asset_approved` deltas.
- Metric writes are best-effort: a failed metric write NEVER fails the domain operation.

## C20. Export sidecars + platform uploads (spec 15, M6)

- Sidecar emitters (M4-5/M6-2, `lib/media/production/` + `publishing.ts` consumers): `captions.srt` (from manifest captions), `thumbnail.png` (ffmpeg frame extract from the selected take), `title.txt/description.txt/hashtags.txt/chapters.txt` (editable metadata), `production.json` (serialized manifest descriptor). Package = zip of master + sidecars; failed export preserves the previous valid export.
- YouTube adapter (M6-1): credentials from env (`YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET`) — never stored in the DB; "Connect YouTube" surfaces ONLY when configured. Uploads create auditable `PlatformUploadRecordSchema` rows; OAuth failure never marks a publication complete; Adult workspaces are export-only.

**Wave C+ gate:** contracts compile + contract tests (AutoRun/C17 state refs, metric events, platform records, delivery-presets additive parse of legacy cues, storage version 7) + `npm run typecheck` green.
