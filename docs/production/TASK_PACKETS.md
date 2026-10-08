# Production core task packets

**Status:** Planned. These packets describe work to do; they are not evidence that any item is implemented. The verified baseline is the P0 state in `TASKS.md` (835 tests, typecheck and production build passed on 2026-10-03). Start each worker from the integration branch's current reviewed HEAD, record its SHA, and use a separate worktree/branch. Do not edit the original checkout.

The aim is the fastest local, upload-ready product for one creator: script or imported script, reusable cast/world, shot planning, approved anchors, selectable takes, uploaded narration/music/SFX, and local mastered export. Current Next.js/TypeScript UI and provider strategy stay in use. A local SQLite database is the production-core store; use `better-sqlite3`, WAL, foreign keys, transactions, and migrations. Keep the existing content-addressed local media vault and harden atomic writes, checksum validation, and backup/restore. API routes submit/query; a dedicated same-host Node worker owns provider submit/poll and FFmpeg. There is no database-provider or vendor-cloud dependency in v1.

Architecture authority: `docs/production/ARCHITECTURE.md` (integrator-owned, C00) and the master plan `docs/PRODUCTION_STUDIO_MASTER_PLAN.md`. Where a packet and architecture contract differ, stop before coding and report the conflict; do not invent a competing interface. Existing boundaries to preserve include `app/api/*` thin routes, `lib/domain/*`, `lib/services/*`, `lib/providers/*`, `lib/repositories/*`, `lib/story/*`, `lib/jobs/*`, and `lib/storage/*`. Existing JSON-backed repositories are migration inputs, not a reason to alter old data destructively.

## Execution rules

- The integrator owns shared contracts, schema naming, migrations, dependency changes, and integration. C00 freezes interfaces/fixtures before workers implement against them. Do not add dependencies or edit lockfiles unless the packet explicitly assigns that file and C00 permits it.
- A packet's listed files are its ownership boundary. Do not edit another packet's files, generated files, package metadata, architecture decisions, or user changes. If an interface needs changing, send a proposal with the exact signature and reason; wait for integrator approval. Keep patches focused and commit only owned files.
- Worktrees can run in parallel only within the waves below. Packets in one wave must have disjoint owned files. A later wave starts only after its dependencies are integrated and the shared base SHA is announced. Do not combine packets or cherry-pick another worker's commit.
- Preserve current behavior outside the packet. No broad UI rewrite, generic workflow framework, cloud service or destructive migration. Paid calls follow the C13/C14/C16 scope-and-cap rule below; local upload must complete the first usable audio/export path.
- Before implementation, run the packet's RED command and save the failing output. Implement the smallest change; run the GREEN command and every listed case. If baseline failure prevents meaningful red evidence, record the exact baseline and use a deliberately failing focused assertion only when it tests the stated behavior. Never claim a case passed without output.
- A test that cannot run, a changed contract, out-of-scope edit, or unmet acceptance item means the packet is incomplete. Do not mark it done to unblock downstream work. Report blockers to the integrator.
- No user-facing success claim follows from unit tests alone. C15 release recovery and the C13/C14 end-to-end pilots are separate gates. Paid provider work is permitted only in C13/C14 real-film pilots, or C16 adapter smoke, when covered by an existing authorized project/experiment scope and cap. Reuse that authorization without asking again while the work remains inside scope and cap. If authorization is absent, ambiguous, or the cap would be exceeded, stop paid work and report the blocker; no worker may expand scope or cap.

## Stable task IDs and dependency order

The IDs are stable and should match the integrator's machine-readable registry. P0 is completed baseline metadata, not a dependency edge. `A` means architecture acceptance IDs; `T` means packet-specific behavioral checks; `G` means authoritative quality/release gates in `QUALITY_GATES.md`. All task states begin `planned` and dependencies list registered Cxx/Ixx packets only.

| Wave | Packet | Purpose | Depends on |
|---|---|---|---|
| 0 | C00 | Architecture contracts and fixtures | P0 baseline metadata |
| 1 | C01 | Durable local store and lossless import | C00 |
| 1 | C03 | Provider capability truth and H3 compatibility | C00 |
| 1 | C05 | Shot planning, long stories and animatic | C00 |
| 2 | I00 | Shared runtime, project profiles and HTTP boundary | C01, C03, C05 |
| 3 | C02 | Canonical immutable revisions and dependency invalidation | C01, C00, C05, I00 |
| 3 | C04 | Durable same-host worker and media vault hardening | C01, C03, C00, I00 |
| 4 | I01 | Standing budget authorization and durable spend reservations | C02, C04, I00 |
| 5 | C06 | Human approval and retake services | C02, C04, C05, I01 |
| 5 | I02 | Script-to-story and storyboard draft proposals | C02, C05, I00, I01 |
| 6 | C07 | Canon and script UI | C02, C04, C06, I02 |
| 6 | C09 | Audio cue domain and local import | C01, C02, C04, C06, C00 |
| 7 | C08 | Storyboard and takes UI | C05, C06, C07 |
| 7 | C10 | Audio cue UI | C09 |
| 8 | C11 | Manifest compiler and local FFmpeg export | C02, C04, C05, C06, C09, C00 |
| 9 | C12 | Export QC and download UI | C11 |
| 10 | C13 | Short portrait pilot | C08, C10, C12 |
| 11 | C14 | Long landscape pilot | C13, C12 |
| 12 | C15 | Recovery, backup/restore and release gate | C01, C04, C12, C13, C14 |
| 13 | C16 | Optional Sogni speech/music adapter | C09, C10 |
| 14 | C17 | Publication, genre profiles and derivatives | C15 |

P5 reliability in the master plan is represented by C15. UI delivery can occur incrementally, but each pilot requires the full dependency chain. Do not make C16/C17 a prerequisite for upload-ready audio or local export.

## Packet contracts

Every file path below is a proposed exact path. The integrator resolves public interface details in C00. A packet may add a narrowly necessary adjacent test file only after its owner gets approval; report it explicitly. `npm test -- <paths>` is the focused test command. Unless stated otherwise, all commands run from repository root using the installed package manager/runtime. Preserve the existing runner conventions if C00 explicitly chooses different commands.

### C00 — Architecture contracts and fixtures (integrator)

**Quality gates:** G00 (`docs/production/QUALITY_GATES.md`).

**Goal:** Freeze the local architecture, public types, dependency graph, SQLite schema vocabulary, migration policy, and deterministic fixtures so packet workers can implement independently.

**Owns:** `docs/production/ARCHITECTURE.md`, `docs/production/task-registry.json`, `lib/production/contracts.ts`, `lib/production/contracts.test.ts`, `lib/production/errors.ts`, `lib/production/hash.ts`, `lib/production/hash.test.ts`, `lib/repositories/production/ports.ts`, `docs/production/fixtures/project.json`, `docs/production/fixtures/story.json`, `docs/production/fixtures/shot-plan.json`, and integration-only `package.json`, `package-lock.json`, `pnpm-lock.yaml`. No worker may edit these.

**Must specify:** SQLite file location/config and backup boundary; WAL/foreign-key/transaction settings; schema version strategy; IDs, timestamps, JSON/canonical serialization and server-owned fingerprint rules; typed immutable Project, CanonRevision, StoryRevision, ShotPlanRevision, AnimaticRevision, ShotRevision, Approval (including `shotplan` and `audio` targets), Take, AudioMixRevision, AudioCue with integer source/timeline sample fields, Manifest, Export; repository/provider/service signatures; job state, leases, outbox/idempotency and worker ownership; media vault atomicity/checksum behavior; API error shape; local upload/export security bounds; fixture ownership. Freeze contracts and route DTOs under `lib/production/contracts.ts`, `lib/production/errors.ts`, `lib/production/hash.ts`, `lib/repositories/production/ports.ts`, `/api/production/*` commands, fixture files and exact acceptance IDs. Include the legacy asset importer endpoint and separate draft-download from checksum-bound final-download routes. Document no cloud DB or object store; paid calls are restricted to C13/C14 and scoped C16 smoke.

**Acceptance:** T00-01..T00-04. **RED/GREEN:** `npm test -- lib/production/contracts.test.ts lib/production/hash.test.ts` must first show missing contract assertions, then pass against fixtures after contracts are written. Vitest includes only `lib/**/*.test.ts`; app routes and scripts are verified via service tests or named Playwright scripts. `npm run typecheck` and `git diff --check` must exit 0. Include tests for canonical fingerprint stability, schema version rejection, and required-reference/fail-closed approval enums. C00 is not complete until packets can implement without guessing interfaces.

### C01 — Durable local store and lossless import

**Quality gates:** G00 (`docs/production/QUALITY_GATES.md`).

**Goal:** Introduce transactional SQLite behind repositories and perform a one-time, idempotent, lossless import from existing `.studio/` JSON records.

**Depends:** C00. **Acceptance:** A-01, T01-01..T01-06.

**Owns:** `lib/repositories/production/sqlite.ts`, `lib/repositories/production/migrations/001.sql`, `lib/repositories/production/legacy-import.ts`, `lib/repositories/production/sqlite.test.ts`, `lib/repositories/production/legacy-import.test.ts`, `scripts/import-legacy-studio.mjs`. C00 owns `package.json` and lockfiles, including the pinned driver change.

**Non-goals:** Rewriting all current repositories, deleting/renaming source JSON, cloud DB, media bytes in SQLite, UI, job worker, or domain transitions owned by C02.

**RED:** `npm test -- lib/repositories/production/sqlite.test.ts lib/repositories/production/legacy-import.test.ts` fails first on absent DB/migration/import cases. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** (1) fresh DB applies migrations once and reports schema version; (2) foreign keys reject orphan references; (3) a transaction that throws leaves no partial writes; (4) two repository instances see committed rows; (5) restart/reopen retains records; (6) importer preserves every legacy JSON record/value, unknown fields, IDs, timestamps and file bytes/references; (7) rerun is a no-op with same counts and hashes; (8) corrupt input is reported with source path and is not silently skipped; (9) importer writes a source backup and machine-readable lossless import report before marking complete; (10) legacy source files remain byte-identical. Do not perform destructive rewrite. Commit only owned files; report migration version and fixture hashes.

### C03 — Provider capability truth and H3 compatibility

**Quality gates:** G03, G04 (`docs/production/QUALITY_GATES.md`).

**Goal:** Make provider capabilities evidence-based, provenance-tagged and conservative; support local fixture/probe discovery for H3 without paid submissions.

**Depends:** C00. **Acceptance:** A-04, T03-01..T03-07.

**Owns:** `lib/providers/production/capabilities.ts`, `lib/providers/production/capabilities.test.ts`, `lib/providers/production/sogni-h3.ts`, `lib/providers/production/sogni-h3.test.ts`, `scripts/probe-production-capabilities.mjs`, `app/api/production/capabilities/route.ts`, `app/api/production/quotes/route.ts`.

**Non-goals:** Billing/quote authorization, generation calls, spending, editing existing Sogni request-map files, worker orchestration, or claiming model output will adhere visually.

**RED:** `npm test -- lib/providers/production/capabilities.test.ts lib/providers/production/sogni-h3.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** live fixture support takes precedence over stale curated fallback; provenance and expiry survive normalization; unknown/stale capability cannot satisfy required input; H3 FL2VA, FLF2V and Ref2VA are distinct modes; Ref2VA has numbered context references and no endpoint anchors (asset-field transport does not prove start/end-frame support); FastH3 does not imply R2V; timed keyframes require supported SDK version; frame counts satisfy documented `124 + 17n` grid and max 362; conflicting resolution facts remain unknown pending probe; probe is discovery-only and makes no paid call. Report captured SDK/catalog fixture source and version.

### C05 — Shot planning, long stories and animatic

**Quality gates:** G02 (`docs/production/QUALITY_GATES.md`).

**Goal:** Replace the six-scene ceiling with stable, bounded, resumable planning; create a cheap animatic from explicit durations and uploaded/placeholder media before expensive generation.

**Depends:** C00. **Acceptance:** A-07, T05-01..T05-08.

**Owns:** `lib/production/shot-plan.ts`, `lib/production/shot-plan.test.ts`, `lib/production/animatic.ts`, `lib/production/animatic.test.ts`, `lib/services/production/shot-plan.ts`, `lib/services/production/shot-plan.test.ts`. Do not edit `lib/story/server-runner.ts`.

**Non-goals:** A hard six-shot cap, video provider generation, approval UI, FFmpeg final mastering, or client-authoritative hashes.

**RED:** `npm test -- lib/production/shot-plan.test.ts lib/services/production/shot-plan.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** 1, 6, 7, 40, and configured maximum shots validate; stable order/IDs across pagination; bounded chunk resumes after interruption without duplicate shots; invalid scene duration reports scene ID; edits preserve untouched shot IDs; removing a shot requires a new approved beat-coverage plan; prior plan/animatic/revision history remains intact and prior exports stay downloadable with historical status; animatic timeline has no overlaps/gaps unless explicit transition; narration duration can inform shot duration; each selected video model's legal duration/frame grid is respected or visibly reported as a planned adjustment. Unit fixtures only; no paid render.

### C02 — Canonical immutable revisions and dependency invalidation

**Quality gates:** G01, G02, G03, G07 (`docs/production/QUALITY_GATES.md`).

**Goal:** Add typed, immutable project/canon/story/shot revisions with server-derived normalized fingerprints and explicit dependency invalidation while preserving history.

**Depends:** C01, C00, C05, I00. **Acceptance:** A-02, T02-01..T02-10.

**Owns:** `lib/production/revisions.ts`, `lib/production/revisions.test.ts`, `lib/services/production/revisions.ts`, `lib/services/production/revisions.test.ts`, `app/api/production/projects/route.ts`, `app/api/production/projects/[projectId]/canon/route.ts`, `app/api/production/projects/[projectId]/stories/route.ts`, `app/api/production/projects/[projectId]/shot-plans/route.ts`, `lib/repositories/production/ports.ts`, `lib/repositories/production/sqlite.ts`, `lib/repositories/production/sqlite.test.ts`, `lib/production/contracts.ts`, `lib/production/contracts.test.ts`, `app/api/production/projects/[projectId]/canon/selection/route.ts`, `app/api/production/projects/[projectId]/route.ts`, `lib/services/production/shot-plan.ts`, `lib/services/production/shot-plan.test.ts`.

**Non-goals:** Editing prior records in place, human approval decisions, UI, provider calls, or using client-supplied fingerprint as authority.

**RED:** `npm test -- lib/production/revisions.test.ts lib/services/production/revisions.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** project list and deep-link read model restore exact selected historical revisions, approvals, takes and jobs without triggering generation; identical normalized inputs produce identical fingerprints regardless of object key order; each cast reference/wardrobe/world/script/shot/settings dependency edit changes the dependent fingerprint; unrelated project edit does not; old revisions remain byte-equivalent/readable; new revision appends and points to parent; deleted/unknown canon ID fails before persistence; API ignores/rejects caller fingerprint; stale descendants are marked with exact changed dependency, not deleted. Verify persisted records by reopening SQLite.

**Shared outbox prerequisite for parallel C04:** In the owned ports/SQLite/tests, add acknowledgeOutbox(intentId,claimToken):boolean deleting only the matching current unexpired claimed intent; never delete job/events/history. Test wrong token, expired lease, successful one-time acknowledgement, replay false and retained history. Checkpoint the reviewed shared-file amendment separately so C04 can consume it while the rest of C02 continues. Record actual prerequisite SHA in SESSION_STATE; do not mark C02 done from this subset.

**Library binding prerequisite:** Add read-port getLatestCanonRevision(entityId) and getCanonRevisionByHash(entityId, contentHash), including SQLite implementation/tests. Strict SelectCanonRevisionCommand {projectId, entityId, expectedRevisionId:null-or-id, canonRevisionId} and selection POST route explicitly bind shared/historical canon without creating a row or approval. CreateCanon checks project-local binding CAS, global established entity kind, reuses global identical hash row or allocates latest global revision+1 in the same immediate transaction; guard safe integer overflow. Current SQLite natural uniqueness is entityId:contentHash, not entityId:revision; this increment enforces numeric allocation at transactional service level (do not edit migration001). Test two projects independently allocating2/3 from shared1, samecontentreuse, no-binding/shared/oldselection, wrongentity/kind/stale/missing rejection and rollback/reopen.

**Binding ADR:** Follow ARCHITECTURE.md “canon-only story successors and derived read response v2”. Implement/export one pure shot/story compatibility predicate in revisions.ts; use it in the owned C05 amendment, future C06/C11. Return required schemaVersion 2 dependencyIssues, preserving selected historical pointers. CAS canon against project selection, validate parent project, duplicate entity pins, dialogue speaker pins and coverage. Test exact unaffected sibling/take retention across genuinely approved canon-only successors, changed beats rejecting reuse, unapproved successor, foreign parent/plan, shared-library isolation, explicit continuation invalidation and SQLite reopen/rollback. Do not migrate persisted v1 records.

### C04 — Durable same-host worker and media vault hardening

**Quality gates:** G04, G05 (`docs/production/QUALITY_GATES.md`).

**Goal:** Provide bounded validated media import and job-query API routes, and run provider submit/poll and media persistence outside HTTP lifetime with transactional enqueue/outbox, leases, idempotent recovery and safe local files.

**Depends:** C01, C03, C00, I00. **Acceptance:** A-05, A-06, T04-01..T04-10.

**Owns:** `lib/jobs/production/worker.ts`, `lib/jobs/production/worker.test.ts`, `lib/jobs/production/queue.ts`, `lib/jobs/production/queue.test.ts`, `lib/repositories/production/jobs.sqlite.ts`, `lib/media/production/vault.ts`, `lib/media/production/vault.test.ts`, `scripts/production-worker.mjs`, `app/api/production/jobs/[id]/route.ts`, `app/api/production/assets/import/route.ts`, `scripts/production-doctor.mjs`, `app/api/production/health/route.ts`, `lib/providers/production/sogni-provider.ts`, `lib/providers/production/sogni-provider.test.ts`, `app/api/production/capabilities/route.ts`, `app/api/production/quotes/route.ts`.

**Approval policy prerequisite:** C04 owns the pure lib/production/approval-policy.ts latest-matching-decision helper because G04 must enforce already-recorded story/animatic decisions before provider I/O. Match exact target kind/id/hash; inspect only rows at maximum createdAt; fail if absent or if any tied latest decision is not approved. This module has no persistence, UI or command side effects; C06 approval commands consume it. C04 requires current story and animatic approvals, active plan/animatic relationships and shot membership; do not invent a shot-plan approval gate. Re-resolve after asynchronous capability/budget checks before submission. **Composition requirements:** Instantiate the accepted provider port through lazy explicit factories, with injected fake SDK transport for tests and a real installed-SDK transport path for production. Wire capability/quote HTTP handlers to that factory, accepted I00 bounded JSON/origin/error helpers and durable receipt storage. No process-global setter must be required for the app to work. Preserve unknown entitlement/pricing when live evidence is insufficient; never claim account affordability from model availability. Worker/web/probe connection app IDs must not displace legacy or each other (stable per role, exclusive worker ownership). Provider payload uses accepted H3 mapping, exact owned asset inputs and no silently removed required roles. Secrets resolve on server; never put them in responses/logs/evidence. Missing config yields actionable readiness failure. Do not call real credentials, generation or paid quote endpoints in worker verification. SDK timed controls remain blocked at installed 5.49; no package upgrade owned here.

**Non-goals:** Running worker in web request; cloud queue/object store; duplicate provider submission on timeout; raw path/URL from client; FFmpeg compilation (C11).

**RED:** `npm test -- lib/jobs/production/worker.test.ts lib/jobs/production/queue.test.ts lib/media/production/vault.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** approval policy filters exact target/hash, rejects absent/stale/rejected/conflicting same-time outcomes; story/animatic approval revocation or active pointer edits during awaits prevent submit; swapped/missing anchor bytes/roles and rejected conditioning produce zero paid submits; canon-only compatible shot reuse passes while changed story inputs fail. Doctor reports missing dependencies/storage/provider configuration without exposing secrets; health reports stale worker heartbeat accurately; a disconnected worker disables submit with actionable recovery; concurrent enqueue with same idempotency key creates one logical job/outbox item; provider timeout after acceptance reconciles by provider reference before resubmit; lease expiry reclaims once; heartbeat prevents a live job being stolen; process restart resumes queued and recoverable jobs; exhausted retries dead-letter with inspectable cause; cancel races produce one terminal state; vault writes use temp+atomic rename; checksum mismatch is rejected; traversal, symlink escape, oversized and MIME mismatch fail; missing media never yields a successful job. Assert provider stub submit count exactly, no real provider credentials/calls.

**C04 verification matrix (integrator maps evidence before acceptance):**

| ID | Required observable behavior | Evidence boundary |
| --- | --- | --- |
| T04-01 | Same idempotency key creates one job/intent; conflicting payload rejects | Real SQLite concurrent/replay fixtures |
| T04-02 | Live lease renews atomically with intent; expiry reclaims once; lost owner stops new side effects | Real SQLite heartbeat/expiry plus two-worker fault injection |
| T04-03 | Possible acceptance never auto-resubmits; full trusted acknowledgement recovers whether intent is retained or absent | SQLite reopen, receipt/reference persistence, exact submit count zero during recovery |
| T04-04 | Saved jobs restart; polling follows exact provider reference, bounded backoff/retry and inspectable exhaustion | Worker fake-provider tests plus installed-SDK-shaped completed result fixtures |
| T04-05 | Cancellation races preserve provider identity and one terminal outcome; late bytes do not select a take | Real-store worker cancellation fixtures |
| T04-06 | Vault stages, fully decodes, verifies checksum and atomically publishes owned bytes | Actual media fixtures, corrupt/truncated/oversized/traversal/symlink negatives |
| T04-07 | Multipart import publishes only after full source/rights validation; parser/abort errors settle and clean staging while retaining existing dedupe | Route streaming/abort/invalid-field fixtures with disk and database assertions |
| T04-08 | Scheduler ownership precedes store/heartbeat work; second process cannot alter owner; SIGKILL restart works; doctor/health report truthful readiness | Bounded real subprocess lifecycle, stale/live heartbeat and missing-config fixtures |
| T04-09 | Current story/animatic approvals and exact required conditioning gate I/O; asynchronous edits fail closed | Zero-submit fixtures plus installed SDK role/capability composition; no paid calls |
| T04-10 | Asset + AnchorCandidate/Take + result pointer commit atomically with exact receipt and historical approval pin | Real SQLite Take/Anchor, later rejection, rollback/reopen fixtures |

Each ID requires fresh root reproduction and independent review of the final candidate. Passing a subset never accepts the packet. Full integrated suite/typecheck/build and actual built API smoke follow review; creator visual quality and final film release remain later gates.

### C06 — Human approval and retake services

**Quality gates:** G01, G02, G03, G05 (`docs/production/QUALITY_GATES.md`).

**Goal:** Make anchor approval an explicit fail-closed human decision tied to exact source fingerprint, and preserve all takes/retakes.

**Depends:** C02, C04, C05, I01. **Acceptance:** A-03, A-08, T06-01..T06-09.

**Prerequisite slice amendment:** C06-PRE may begin after independently accepted/integrated I01-B3/B4 finance kernel, with exact ownership and recipe/API signatures frozen by the integrator. It supplies human approvals and canonical anchor/take request recipes/enqueue while paid composition is absent. I01-B6 consumes that recipe. Neither parent is done from this subset; follow ARCHITECTURE.md sequencing amendment.

**Owns:** `lib/production/approval.ts`, `lib/production/approval.test.ts`, `lib/services/production/approval.ts`, `lib/services/production/approval.test.ts`, `lib/services/production/takes.ts`, `lib/services/production/takes.test.ts`, `app/api/production/approvals/route.ts`, `app/api/production/shots/[shotId]/takes/route.ts`, `app/api/production/shots/[shotId]/anchors/route.ts`, `app/api/production/shots/[shotId]/selection/route.ts`.

**Binding ADR:** Use C02 exported shot/story compatibility predicate and selected-plan membership, allowing exact unchanged originating shots across approved canon-only story successors. Never copy story or plan approvals.

**Non-goals:** Treating model vision score as human approval;  overwriting takes; silent auto-approval; UI (C08).

**RED:** `npm test -- lib/production/approval.test.ts lib/services/production/approval.test.ts lib/services/production/takes.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** `shotplan` and `audio` approval targets bind to exact immutable hashes; missing, pending, stale or rejected human approval blocks animation; unavailable/exhausted vision is advisory and a human may explicitly acknowledge it while approving; only local human action for matching fingerprint approves; cast/world/script/shot edit makes approval stale; stale decision remains in history; reject requires reason and blocks; retake appends sibling and never replaces; selected take points at exact anchor/revision and provenance; solo one-shot uses same service; duplicate approval command is idempotent; model score can inform UI but cannot transition status. Include service-level stub asserting generation is never invoked when blocked.

### C07 — Canon and script UI

**Quality gates:** G01, G02 (`docs/production/QUALITY_GATES.md`).

**Goal:** Let a creator create/edit reusable project canon, import or edit the script, and inspect revision provenance and stale downstream work.

**Depends:** C02, C04, C06, I02. **Acceptance:** T07-01..T07-05.

**Owns:** `app/production/page.tsx`, `app/production/new/page.tsx`, `app/production/[projectId]/page.tsx`, `app/production/[projectId]/canon/page.tsx`, `app/production/[projectId]/script/page.tsx`, `components/production/project-canon.tsx`, `lib/production/project-canon.test.ts`, `scripts/verify-production-canon.mjs`.

**Non-goals:** New global visual system, auto-approval, shot/take UI, provider calls, or destructive editing of existing records.

**RED:** `npm test -- lib/production/project-canon.test.ts` fails first on create project, save new script revision, import bounds, and stale notice. Browser GREEN: `node scripts/verify-production-canon.mjs http://127.0.0.1:3100`. **GREEN:** `npm test -- lib/production/project-canon.test.ts`; `npm run typecheck`; `git diff --check`; manual local browser check using seeded fixture, with screenshot/evidence path in report.

**Required cases:** create project with reusable cast/world; upload/import plain text script with size/type bounds; save creates a new immutable revision; show source revision and dependencies; editing canon/script reports which anchors/takes are stale; failed save keeps editor data; keyboard focus and accessible labels for primary actions. No real user data.

### C09 — Audio cue domain and local import

**Quality gates:** G06 (`docs/production/QUALITY_GATES.md`).

**Goal:** Make uploaded narration/music/SFX sufficient for a finished export, with rights/source provenance, safe metadata, and cues bound to immutable revisions/timeline.

**Depends:** C01, C02, C04, C06, C00. **Acceptance:** T09-01..T09-08.

**Owns:** `lib/production/audio.ts`, `lib/production/audio.test.ts`, `lib/services/production/audio.ts`, `lib/services/production/audio.test.ts`, `app/api/production/projects/[projectId]/audio/route.ts`, `scripts/production-audio-import.mjs`.

**Non-goals:** Requiring generated speech/music, claiming Sogni supports Bengali, voice-clone training, automatic rights clearance, or audio UI (C10).

**RED:** `npm test -- lib/production/audio.test.ts lib/services/production/audio.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`.

**Required cases:** narration text references exact story revision; cue has nonnegative in/out, gain bounds and source asset provenance; overlap policy is explicit; stale script invalidates narration alignment; uploaded narration/music/SFX can be bound without any generation provider; unsupported codec/oversize/corrupt audio rejects before cue creation; rights/source acknowledgement retained; retry does not duplicate cue; timeline serializes deterministically; audio cue edits append AudioMixRevision; `Approval.targetKind=audio` binds to the exact mix revision and invalidates on cue/source/script changes. Test WAV/MP3 fixtures, no paid service.

### C08 — Storyboard and takes UI

**Quality gates:** G02, G03, G05 (`docs/production/QUALITY_GATES.md`).

**Goal:** Review ordered shots, anchor inputs, approval state and retake siblings in one practical workspace.

**Depends:** C05, C06, C07. **Acceptance:** T08-01..T08-07.

**Owns:** `app/production/[projectId]/shots/page.tsx`, `app/production/[projectId]/anchors/page.tsx`, `app/production/[projectId]/takes/page.tsx`, `components/production/storyboard.tsx`, `scripts/verify-production-shots.mjs`, `lib/production/storyboard.test.ts`.

**Non-goals:** Moving approval policy into client, auto-selecting/approving model output, six-shot restriction, or broad rewrite of existing story pages.

**RED:** `npm test -- lib/production/storyboard.test.ts` fails first on >6 shots, approve/reject states and sibling selection. Browser GREEN: `node scripts/verify-production-shots.mjs http://127.0.0.1:3100`. **GREEN:** `npm test -- lib/production/storyboard.test.ts`; `npm run typecheck`; `git diff --check`; manual browser check and screenshot evidence.

**Required cases:** show stable order across pages/chunks and duration; show pinned refs/provenance and exact stale reason; animation/submit buttons disabled for missing/pending/stale/rejected human approval; approval remains enabled for a current readable candidate with a complete checklist, saved inputs and explicit advisory acknowledgment; unavailable/exhausted vision is shown as an advisory warning with explicit acknowledge text; approval action uses server API and exact displayed revision; rejection/retake retains prior take; selected take is visually distinct and reversible; loading/error/retry states recover; keyboard-only navigation works. No provider call from rendering page.

### C10 — Audio cue UI

**Quality gates:** G06 (`docs/production/QUALITY_GATES.md`).

**Goal:** Import audio, audition it, place narration/music/SFX cues and adjust timeline/gain for an export.

**Depends:** C09. **Acceptance:** T10-01..T10-06.

**Owns:** `app/production/[projectId]/audio/page.tsx`, `components/production/audio.tsx`, `scripts/verify-production-audio.mjs`, `lib/production/audio-ui.test.ts`.

**Non-goals:** Provider generation as a requirement; editing the audio schema; advanced DAW/multitrack automation.

**RED:** `npm test -- lib/production/audio-ui.test.ts` fails first on upload error, cue placement, duration overflow and stale script. Browser GREEN: `node scripts/verify-production-audio.mjs http://127.0.0.1:3100`. **GREEN:** `npm test -- lib/production/audio-ui.test.ts`; `npm run typecheck`; `git diff --check`; manual browser check with local fixtures and screenshot evidence.

**Required cases:** upload-ready workflow works offline after app starts; preview and seek work; cue placement/trim/gain save server-side; narration segment can be aligned to script; overflow is actionable; stale narration is visible; music/SFX rights/source metadata shown; no blank-success state on upload failure.

### C11 — Manifest compiler and local FFmpeg export

**Quality gates:** G07, G08 (`docs/production/QUALITY_GATES.md`).

**Goal:** Snapshot exact approved visual takes and audio cues, compile reproducibly on the same-host worker, and produce a master plus manifest provenance.

**Depends:** C02, C04, C05, C06, C09, C00. **Acceptance:** T11-01..T11-09.

**Owns:** `lib/production/manifest.ts`, `lib/production/manifest.test.ts`, `lib/services/production/manifest.ts`, `lib/services/production/manifest.test.ts`, `lib/media/production/assembly.ts`, `lib/media/production/assembly.test.ts`, `lib/media/production/profiles.ts`, `app/api/production/projects/[projectId]/exports/route.ts`, `app/api/production/projects/[projectId]/manifests/route.ts`.

**Non-goals:** Shell interpolation/user-provided filter graph; compiling stale/unapproved content; mandatory generated audio; publishing; UI (C12).

**RED:** `npm test -- lib/production/manifest.test.ts lib/services/production/manifest.test.ts lib/media/production/assembly.test.ts`. **GREEN:** same command; `npm run typecheck`; `git diff --check`; local fixture render with command and output hash in report.

**Required cases:** canonical serialization stable; manifest pins revision IDs, exact take IDs, audio cue IDs, profile/version and hashes; missing/unapproved/stale/mismatched assets reject before FFmpeg; clip ordering and timeline arithmetic deterministic; legal duration quantization is recorded; compiler uses argument arrays, bounded duration/size, private temporary directory and cancellation cleanup; fixture clips plus uploaded audio produce playable MP4; rerun from same fixture inputs gives same manifest fingerprint (bitwise MP4 determinism is not required unless toolchain proves it). Never invoke a paid provider.

**Binding ADR:** Manifest selection uses C02 exported compatibility predicate plus exact selected-plan membership; preserve originating shot provenance and validate historical manifests against historical pins.

### C12 — Export QC and download UI

**Quality gates:** G08, G09 (`docs/production/QUALITY_GATES.md`).

**Goal:** Inspect completed output against manifest and expose report, review preview, retained exports and download state. Final download requires G09 approval of the exact checksum; draft review bytes remain distinct.

**Depends:** C11. **Acceptance:** T12-01..T12-08.

**Owns:** `lib/production/qc.ts`, `lib/production/qc.test.ts`, `lib/services/production/qc.ts`, `lib/services/production/qc.test.ts`, `app/api/production/exports/[id]/route.ts`, `app/api/production/exports/[id]/download/route.ts`, `app/production/[projectId]/export/page.tsx`, `components/production/export.tsx`, `lib/production/export-ui.test.ts`, `scripts/verify-production-export.mjs`, `app/api/production/exports/[id]/draft/route.ts`.

**Non-goals:** Silently accepting malformed output, deleting prior exports, remote publishing, or any claim that QC proves story meaning.

**RED:** `npm test -- lib/production/qc.test.ts lib/services/production/qc.test.ts lib/production/export-ui.test.ts`. **GREEN:** same; `npm run typecheck`; `git diff --check`; inspect fixture render in browser and save screenshot/report evidence.

**Required cases:** passing technical QC alone leaves final download blocked (428); explicit human end-to-end approval of the exported checksum unlocks final download; reencode changes checksum and requires new approval; silent draft skips absent audio QC but never becomes release-ready; codec/container, dimensions, frame rate and duration read from output; black/freeze/silent ranges and ASR produce named advisory warnings requiring human acknowledgment; missing required audio, clipping/peak, caption bounds and manifest mismatch produce profile-specific technical failures; accepted report includes output and input hashes; failed output remains inspectable and retryable; download is scoped to owning project and safe media reference; download never exposes filesystem path; prior export remains available after retry.

### C13 — Short portrait pilot

**Quality gates:** G01–G09 (`docs/production/QUALITY_GATES.md`).

**Goal:** Complete a real creator-reviewed 30–60 second 9:16 film using actual approved model takes or rights-cleared, intentionally selected imported shot clips.

**Depends:** C08, C10, C12. **Acceptance:** T13-01..T13-06.

**Owns:** `docs/production/pilots/short-portrait.md`, `scripts/pilot-short-portrait.mjs`. Film outputs, receipts and review screenshots are evidence artifacts, not repository fixtures. Pilot may expose defects but feature fixes return to their owning packet.

**Non-goals:** Exceeding standing authorized project/experiment scope and cap, treating generated imagery as child-safe by default, replacing the real film with fixtures, or making claims without creator review. Paid calls are allowed only within the existing authorized project/experiment scope and cap; reuse authorization while within scope and cap. If missing, ambiguous, or exceeded, stop paid work and report blocker.

**RED/GREEN:** First run records each missing step as a failure; final run executes the documented local workflow end-to-end; `npm run typecheck`, `npm test`, and `npm run build` must exit 0 on integrated base. Run `node scripts/pilot-short-portrait.mjs --preflight` for RED and `node scripts/pilot-short-portrait.mjs --final` for GREEN; Verify 30–60s, 9:16, report contains accepted manifest and QC evidence, download reopens and plays; creator watches the exact final downloadable bytes and accepts G01–G09. Colored/synthetic fixture video cannot count as film or release evidence. Store redacted logs, output hash, screenshots, environment/runtime and exact commands.

### C14 — Long landscape pilot

**Quality gates:** G01–G09 (`docs/production/QUALITY_GATES.md`).

**Goal:** Complete a real creator-reviewed 3–6 minute 16:9 film through many paginated shots and resumable batches, using actual approved model takes or rights-cleared, intentionally selected imported shot clips.

**Depends:** C13, C12. **Acceptance:** T14-01..T14-06.

**Owns:** `docs/production/pilots/long-landscape.md`, `scripts/pilot-long-landscape.mjs`. Film outputs, receipts and review screenshots are evidence artifacts, not repository fixtures.

**Non-goals:** Exceeding standing authorized project/experiment scope and cap, bypassing approval, artificially claiming continuity from concatenation, or changing core features inside pilot packet. Paid calls are permitted within the standing authorization; if missing, ambiguous, or over cap, stop and report. Synthetic/local assets may prove structural rehearsal only, never G10 cinematic pilot evidence.

**RED/GREEN:** Initial run demonstrates recorded blocker(s); final integrated run completes the 3–6 minute, 16:9 export through restart/resume across shot batches. `npm run typecheck`, `npm test`, and `npm run build` exit 0. Run `node scripts/pilot-long-landscape.mjs --preflight` for RED and `node scripts/pilot-long-landscape.mjs --final` for GREEN. Verify no 6-shot ceiling, stable order, no dropped cues, profile/QC/download valid. Record measured wall time, peak memory, output size, restart recovery and hashes. Synthetic/local assets may prove structural rehearsal only; final G10 evidence must be the real creator-reviewed film.

### C15 — Recovery, backup/restore and release gate

**Quality gates:** G10 (`docs/production/QUALITY_GATES.md`).

**Goal:** Prove a solo creator can recover local production records, jobs and media after process or host restart, and document release limitations.

**Depends:** C01, C04, C12, C13, C14. **Acceptance:** T15-01..T15-08.

**Owns:** `scripts/production-backup.mjs`, `scripts/production-restore.mjs`, `scripts/verify-production-recovery.mjs`, `lib/production/recovery.test.ts`, `docs/production/RELEASE_CHECKLIST.md`.

**Non-goals:** Cloud backup, multi-tenant claims, silent deletion, or auto-passing unmet gates.

**RED:** recovery test fails on absent/mismatched backup and interrupted job case. **GREEN:** `npm test -- lib/production/recovery.test.ts`; `npm run typecheck`; `git diff --check`; full clean backup/restore into isolated temp directory; kill/restart worker between job states; verify SQLite integrity, foreign keys, every referenced media checksum and export hashes.

**Required cases:** backup captures a consistent DB and media snapshot; restore refuses path traversal/partial/corrupt archive; restore preserves job idempotency and historical revisions/approvals/takes; expired lease recovers without duplicate submit; orphan media is reported; restore report lists every count/hash; checklist marks each release gate pass/fail/unknown with evidence. Never declare release-ready if a required item is unknown.

### C16 — Optional Sogni speech/music adapter (later)

**Quality gates:** G04, G06 (`docs/production/QUALITY_GATES.md`).

**Goal:** Add replaceable Sogni speech/music generation after local upload path and compatibility/consent policy are ready.

**Depends:** C09, C10. **Owns:** `lib/providers/production/sogni-audio.ts`, `lib/providers/production/sogni-audio.test.ts`, `lib/services/production/audio-generation.ts`, `lib/services/production/audio-generation.test.ts`. Later amendment scopes the provider call. Not required for v1.

**Gate:** SDK version/API contract tests, supported language/voice capability fixture, text coverage/timing, failure recovery and explicit per-request spend authorization. Do not state persistent voice training if the provider only offers per-request cloning. Paid adapter smoke is permitted only within a standing authorized project/experiment scope and cap; reuse authorization while within those bounds and block/report if absent or exceeded.

### C17 — Publication, genre profiles and derivatives (later)

**Quality gates:** G09, G10 (`docs/production/QUALITY_GATES.md`).

**Goal:** Reuse production records for metadata, thumbnails, reels and publishing after creator pilot evidence.

**Depends:** C15. **Owns:** `lib/production/publishing.ts`, `lib/production/publishing.test.ts`, `lib/services/production/publishing.ts`, `lib/services/production/publishing.test.ts`. Not scheduled and no v1 dependency. Keep mythology, documentary and promotion as versioned profiles over the same core; do not fork pipelines.

## Acceptance IDs

These acceptance IDs are owned by one packet, except A-06/A-08/A-09/A-10, which are integrator-owned umbrella outcomes spanning packets. Feature packets own their Txx checks; C00 owns the umbrella Axx review. Workers attach raw output or stable evidence.

| ID | Verifiable contract | Primary owner |
|---|---|---|
| A-01 | SQLite migrations, transaction boundaries, WAL/foreign keys, restart durability, safe non-destructive legacy import | C01 |
| A-02 | Immutable revision append, deterministic server fingerprint, dependency invalidation, historical retention | C02 |
| A-03 | Approval/retake binds exact revision fingerprint; fail closed; old takes and decisions preserved | C06 |
| A-04 | Capability provenance/expiry and provider request mapping; strict required refs never silently dropped | C03 |
| A-05 | Same-host worker, durable outbox/leases/idempotency/recovery; no request-lifetime generation | C04 |
| A-06 | Atomic checksummed local vault, audio/video asset references, versioned manifest compiler inputs | Integrator umbrella: C04/C09/C11 |
| A-07 | More than six shots, stable order/pagination/resume and duration/frame-grid-aware animatic | C05 |
| A-08 | Review UI shows exact provenance/state; human approve/reject and take selection invoke server services | Integrator umbrella: C06/C08 |
| A-09 | Usable project/script/canon/storyboard UI across a short portrait local workflow | Integrator umbrella: C07/C08/C13 |
| A-10 | Uploaded audio -> cue -> reproducible manifest -> local FFmpeg export -> QC report/download | Integrator umbrella: C09/C10/C11/C12 |


### I00 — Shared runtime, project profiles and HTTP boundary

**Goal:** Freeze reusable server composition before C02/C04; do not duplicate database configuration, profile defaults, request validation or error mapping in feature routes.

**Depends:** C01, C03, C05. **Gate:** G00. **Acceptance:** I00-01..I00-04. **Owns:** `lib/production/runtime.ts`, `lib/production/runtime.test.ts`, `lib/production/profiles.ts`, `lib/production/profiles.test.ts`, `lib/production/http.ts`, `lib/production/http.test.ts`.

**I00-01 runtime:** Resolve configured local data directory using `PERABYTE_STUDIO_DATA_DIR`, otherwise `.studio` under process working directory. Expose lazy `withProductionStore(operation, options?)` using the accepted SQLite adapter; open only when called, always close in finally on success/error, permit async operations outside database transaction, and allow typed injected store factory for tests. No database open, provider connection or media creation on import. Do not add a service locator or generic dependency injection framework.

**I00-02 profiles:** Two validated immutable default snapshots `storybook-short-v1` (9:16,1152frames) and `storybook-long-v1` (16:9,5760frames),24fps implied by contracts, English initial language, ageIntent5-8, no default spending cap. Resolve by ID; unknown ID gives stable INVALID_INPUT. Return independent snapshots so callers cannot mutate global defaults. Accept an explicit injected profile catalog for future genres/languages without editing story rules; no network/provider call or falsely authorized cap.

**I00-03 HTTP:** Shared helpers for same-origin mutations, bounded streaming JSON parsing (default2MiB, configurable positive safe integer cap), request ID/error envelopes and stable status mapping. Reject absent/foreign Origin for mutations, bad JSON, unknown strict DTO fields, oversized Content-Length and chunked bodies exceeding the actual byte bound. Do not trust Content-Length alone. Unknown internal errors return a sanitized generic500; never expose error stacks, credentials or local paths. Feature routes may override unknown-reference404 to422 for invalid command bindings. Export helpers from normal modules only, never extra Next route exports. Type validation stays in existing Zod schemas. No new authentication/hosting UI.

**I00-04 verification:** Behavioral RED then GREEN focused three files, typecheck, diff check; test lazy lifecycle/finally, actual configured temporary SQLite reopen, profile isolation/unknown ID/custom catalog, same-origin checks, strict parse/error status, actual streamed bounds without Content-Length, sanitized internal failures. Never use original user data or paid provider calls. Commit only six owned files; exact script-generated SHAs/log hashes and normal AGENT_PROTOCOL report. Independent review precedes integration. C02/C04 start from the accepted I00 integration base.

### I01 — Standing budget authorization and durable spend reservations

**Quality gates:** G04, G05. **Depends:** C02, C04, I00. **Acceptance:** I01-01..I01-06. **Release required:** yes; paid submission remains fail-closed until accepted.

**Goal:** Implement standing user budget authorization once and atomic accounting across concurrent jobs, restarts and uncertain billing. Profiles remain format/language defaults; nullable profile caps do not authorize spending.

**Owns:** `lib/production/budget.ts`, `lib/production/budget.test.ts`, `lib/services/production/budget.ts`, `lib/services/production/budget.test.ts`, `lib/repositories/production/migrations/002-budget.sql`, `lib/repositories/production/ports.ts`, `lib/repositories/production/sqlite.ts`, `lib/repositories/production/sqlite.test.ts`, `lib/production/contracts.ts`, `lib/production/contracts.test.ts`, `lib/jobs/production/queue.ts`, `lib/jobs/production/queue.test.ts`, `lib/jobs/production/worker.ts`, `lib/jobs/production/worker.test.ts`, `app/api/production/projects/[projectId]/budget/route.ts`. Shared amendments start only after both earlier owners finish and integration is reviewed.

**I01-01:** Immutable BudgetAuthorization pins project/provider/server-resolved spending account scope, operation scope, permitted entitlement modes, explicit currency, project and account-wide daily caps, human actor, timestamp and version. UTC daily bucket. Null/unknown means unauthorized. Strict AuthorizeBudgetCommand plus same-origin bounded budget API/query; supplied account identity must not override server evidence. Reductions/revocation append history and block new reservations.

**I01-02:** Durable reservation/ledger migration and ports: one reservation per project/idempotency key/job, pinned authorization/quote/request hash, currency, upper estimate and original UTC bucket. Distinguish reserved, reported actual, confirmed release and unresolved billing. Before provider I/O, validate exact fresh quote, current authorization, scope/account/currency and entitlement, atomically sum spend plus unresolved reservations, reserve maximum and transition to submitting. Quote withinAuthorizedCap yes alone is insufficient.

**I01-03:** Unknown estimate/currency/entitlement, expired quote, invalid account or exceeded cap results in zero provider calls. Subscription does not imply invented zero pricing. No implicit Spark fallback; needs explicit allowed scope and new quote. Local assembly/import stays usable without paid authorization.

**I01-04:** Release only on affirmative evidence of nonacceptance/nonbilling; timeout, requested cancellation, generic error and submission_unknown retain reservation. Provider-reported actual is a separate idempotent billing event; media completion never settles spend. Unknown billing stays visible. Actual above estimate records overrun and blocks every subsequent covered submission while actual plus outstanding liability exceeds the current cap.

**I01-05:** Restart reconstructs ledger; outstanding project liability survives midnight and daily attribution remains in original bucket. Across two projects same local spending account daily cap cannot be bypassed. Repeated reconciliation modifies totals once.

**I01-06 verification:** Behavioral RED/GREEN with real SQLite reopen: two jobs each fit alone but jointly exceed cap -> exactly one reserve/submit; replay samejob/reservation vs conflicting replay; zero submit on every missing/invalid authorization fact; crash after reserve vs possible acceptance; positive preaccept rejection releases once vs ambiguous failure retains; reconciliation duplicate/overrun; midnight/account-wide two-project totals; reduced/revoked caps; atomic rollback. Fake provider only, no real billing calls. Sol review required. No budget UI redesign (C07 adds minimal functional controls).

**I01 normative accounting details (Sol review):**

- AccountBudgetPolicy is authoritative per evidenced provider account + currency/unit, versioned with daily cap, expiry (null intentionally standing), revoked state and human actor. Project authorization references that policy plus its own project cap, allowed models/operations and permitted entitlement modes. Two projects cannot define competing account daily caps; a project update never implicitly raises account policy. Concurrent edits use version CAS. Renewal/increased caps never reset accumulated spending.
- Authorization expiresAt null intentionally means standing authorization; null caps/identity/estimates remain unauthorized. Recheck current policy/authorization versions and expiry/revocation in the transaction that reserves and enters submitting. That commit is the submission boundary. Revocation blocks jobs not yet crossing it; jobs already submitting or possibly accepted retain liability. Do not implement an unguarded reserve-now/submit-later gap.
- AccountEvidence pins stable provider account ID, evidence source/observedAt/expiresAt and credential/connection binding without raw secrets. Missing/stale evidence blocks. Display names, caller-supplied IDs and configured-key presence are insufficient. Credential/account changes invalidate pending quote bindings. Quote companion binding and reservation pin identical evidence/account/currency/unit. Preserve existing Quote DTO if adding a separate typed binding record suffices. No invented subscription/Spark conversion or zero pricing.
- ReconciliationEvidence comes from a trusted producer port, with provider/account/job/currency/unit, stable event key, evidence source/reference/time and explicit actual/nonacceptance/refund facts. Browser budget authorization routes cannot submit actual billing/refund/nonacceptance facts. If manual reconciliation is necessary, require an explicit human decision/reason/evidence and append-only provenance distinct from provider-reported facts. Duplicate identical event is a no-op; conflicting repeated key rejects atomically.
- All monetary/unit amounts and sums use nonnegative safe integers, reject overflow and quote minimum above maximum. No implicit currency conversion or mixing Spark token units with money. Pin bounded allowed model IDs and operation scope, including any charged text proposal operation; validate every execution. I01 must explicitly amend quote/ledger DTOs for text if the existing media-only operation enum is insufficient. Reservations bind server execution IDs (media job or text proposal request), never browser-invented billing identity. I02 may request a text reservation through the same budget service; no media job or approval is created by a proposal.
- Count known actual plus unresolved reservations, replacing a settled reservation's estimate liability exactly once. Unknown actual retains its upper estimate liability. Affirmative partial refund changes known spend once. Record actual even when it exceeds the estimate/cap, expose overrun, and block subsequent submissions while current liability exceeds a current applicable cap. Estimates cannot guarantee the provider's actual bill never exceeds an estimate.
- Additional required tests: competing daily-cap edits across projects, mixed currencies/units, queued expiry/revocation and revoke-versus-submit race, account/credential identity change between quote and reserve, browser forged billing/refund rejection, minimum greater than maximum, sum overflow, lowered cap below existing liabilities, renewal preserving totals, conflicting reconciliation replay, duplicate settlement after reopen.

### I02 — Script-to-story and storyboard draft proposals

**Quality gates:** G01, G02, G03. **Depends:** C02, C05, I00, I01. **Acceptance:** I02-01..I02-04. **Release required:** yes, so the script proposal button has a real validated service rather than a decorative control.

**Owns:** `lib/production/proposals.ts`, `lib/production/proposals.test.ts`, `lib/services/production/proposals.ts`, `lib/services/production/proposals.test.ts`, `lib/providers/production/text-planner.ts`, `lib/providers/production/text-planner.test.ts`, `app/api/production/projects/[projectId]/proposals/route.ts`.

**Goal:** Connect a modular text planning adapter to strict editable story/storyboard proposals using the selected immutable canon, then hand accepted drafts to existing C02/C05 commands. H3 is a video model, not the script planning engine. Reuse existing TextProvider interfaces through a narrow adapter; no silent provider/model fallback or provider cost invention. Human acceptance/approval remains separate.

**I02-01:** Strict versioned request/response DTOs contain project/expected selected canon/story snapshots, exact source script hash, proposed ordered beats or shot inputs, errors and completeness status. Provider output is untrusted. Generate proposal only; do not change selected revisions, insert approval, queue media, rewrite canon or auto-accept draft. A stale source snapshot blocks acceptance through existing CAS/gates. One-shot uses the same service.

**I02-02:** Preserve source script and every intended spoken line byte-for-byte, including Unicode and punctuation. Prefer explicit labeled dialogue/narration; plain narration scripts default to narration. Designated source speech is derived by a deterministic server parser or explicit human mapping before provider invocation; the model cannot choose which lines count as speech. Unmapped ambiguous segments keep completeness false. Bind each spoken proposal segment to a validated source range; reconstructing the ordered ranges must match the designated source speech exactly, with no omitted/duplicated/invented line. Reject split Unicode boundaries. Freeform ambiguous script needs visible editable mapping rather than invented authoritative speech. Visual/action proposals may add staging consistent with selected canon, but new character/location IDs, invented speakers, unknown beats and missing beat coverage fail. Human review is authoritative for plot meaning/visual quality.

**I02-03:** Prompt includes only selected immutable character/location/style/prop descriptions and reference provenance needed for that draft. Validate output strict JSON and explicit IDs, cast capacity, complete beat coverage, model frame grid and narration-aware planning. At most one structured repair attempt after malformed/invalid model output, then return visible errors and editable draft. Model context/output limits must be known or fail visibly; long scripts use bounded ordered chunks with stable beat IDs, no truncation/duplicate chunks, and completeness true only after all chunks validate. Use existing C05 validators; never silently alter approved shot timing/text to fit a model.

**I02-04 verification:** Fake TextProvider fixtures only: exact speech/Unicode, unknown canon/speaker, malformed/extra DTO fields, omitted/duplicated speech, incorrect source ranges, missing beat coverage, stale expected IDs, cast/frame invalidity, one-shot and >6 shots, bounded multi-chunk interruption/replay, one repair then fail, zero revision/approval/media writes on proposal. Validate adapter actually composes the selected provider; unknown/missing text entitlement/cost remains blocked under I01. Minimal C07/C08 controls invoke this API and require explicit accept/edit; UI redesign remains deferred. Real text calls are not authorized by this packet's fixture evidence.
