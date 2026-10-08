# Perabyte Studio production-core review — 7 October 2026

Reviewed worktree: `/Users/abid/Projects/perabyte-studio/.worktrees/zcode-production-core`.
Branch: `zcode/production-core`; HEAD: `7570fd7d44075dc50a0ebefb72886bc341bfd762`.
Comparison: execution-design commit `2859a0557abca28caebd57c75a5e7165aaeca5e9` through HEAD; also checked current working-tree progress document. Original checkout and separate UI worktrees were not reviewed or edited.
Sources: referenced chat “Create video studio master plan”, local architecture, quality gates, UX specification, task packets and actual source/evidence. Two independent review axes were used. No implementation fixes or live provider calls were performed.

## Plan summary

Build a single-creator local video studio: script → immutable character/location/prop/style canon → approved story and shot plan/animatic → reference-conditioned stills → human-approved anchors → durable video jobs and accepted takes → narration/music/SFX → deterministic FFmpeg assembly → technical QC → human approval of the exact downloadable file. Support portrait shorts and landscape long films, preserving exact story lines and reference provenance. Use replaceable provider ports, local SQLite and content-addressed media, explicit budgets, idempotent requests and conservative handling of uncertain paid submissions. Imported audio is the first-release path; generated audio is an adapter extension. Later work includes genre workflows, thumbnails/reels and YouTube integration.

## Implementation and verification

The branch contains substantial implementations of persistence, revision/invalidation services, shot plans, human approvals, budget/proof composition, worker/vault, proposals, creator pages, imported audio, assembly, export QC, recovery tooling and publication-profile derivation.

Fresh checks on the reviewed branch:
- `npm run typecheck`: exit 0.
- `npm test`: exit 0; 133 files, 1,521 tests passed.
- `npm run build`: exit 0. Two dynamic-filesystem tracing warnings in frame-server/sqlite remain.
- `git diff --check`: exit 0.

Pilot evidence includes `films/c13-short-film-REVIEW-COPY.mp4` and `films/c14-long-film-REVIEW-COPY.mp4`. The latest saved pilot logs record technical QC passed, then `ready_for_review`, stopping without final human approval; long pilot had three advisories. This review did not watch/listen to the films or inspect the live production database. Neither automated checks nor file existence proves visual consistency or final release readiness.

## Standards and runtime findings

### S1 — P1: Expired export runners can mutate a replacement runner's job and remove its lease

`lib/media/production/assembly.ts:453-461`, `498-502`, `527-537`.
Heartbeat overwrites the lease before checking it; completion/failure/cancellation CAS checks only status, and cleanup removes lease.json unconditionally. If runner A stalls beyond its lease and B reclaims the export, A can later change B's rendering record or delete B's lease. An isolated reviewer probe confirmed A resumed with an error after B reclaimed: the export became failed and B's lease vanished. Architecture requires lease loss to prevent result mutation. Store the lease owner/token in durable state and fence heartbeat, every transition and cleanup against it.

### S2 — P1: Backup omits QC artifacts needed to finish restored films

`scripts/production-backup.mjs:117-136`; `lib/services/production/qc.ts:179`, `340-341`.
Backup captures SQLite and media but omits exports/<id>/qc-report-<id>.json. SQLite preserves ready_for_review and qcReportId. After restore, final review cannot load its QC report; rerunning QC is refused because status is no longer qc_pending. The existing export cannot progress to approval. Include checksummed QC/review artifacts in backup/restore, or implement a safe explicit recovery transition. Approved media remains downloadable from preserved checksum/bytes; this finding specifically concerns recovery of review state/evidence.

### S3 — P1: Default launch exposes the unauthenticated production studio beyond localhost

`package.json:6-8`; `lib/production/http.ts:17-58`.
Both Next launch scripts omit -H 127.0.0.1. The installed Next CLI documents a default of 0.0.0.0. The new local APIs have no multi-user authentication; same-origin compares against the request Host and does not exclude LAN clients accessing that origin. This breaches the architecture's default localhost-only boundary. Bind both commands to loopback and keep nonlocal access blocked until an authenticated deployment design exists. Launch lines predate this diff, but their unchanged behavior materially affects the newly added production APIs.

### S4 — P2: Interrupted exports do not resume automatically after restart

`lib/media/production/assembly.ts:555-569`; `lib/services/production/manifest.ts:272`; `scripts/production-worker.mjs:26`.
Assembly scheduling uses an in-memory list and is triggered by export POST. No startup/periodic scan reconnects durable queued/rendering exports; the standalone worker handles provider jobs, not export assembly. Restarting/reopening leaves an interrupted export stuck until a new export POST retriggers that project. Add durable export draining to the worker or a bounded startup/polling scheduler. A direct runExportAssembly reclaim test does not verify automatic restart wiring.

## Spec findings

### P1 — P1: Required dialogue may be missing while technical QC passes

`lib/services/production/qc.ts:185-186`; `lib/production/qc.ts:320-324`; `lib/production/audio.ts:209-226`.
QC drops dialogue when projecting story beats and checks only narration coverage. Audio alignment verifies cues that exist but does not require every spoken line to have a cue. Narration can be complete while dialogue is entirely absent, still passing automated QC. An offline review probe confirmed this. G06 requires all intended spoken lines and the automated blocker policy requires missing spoken segments to block. Check every narration/dialogue segment by stable beat/line identity, including repeated identical lines.

### P2 — P2: Multiple advisory intervals share one acknowledgment

`lib/services/production/qc.ts:353-356`; `components/production/export.tsx:612-613`.
Server matching and UI state are keyed only by advisory code. One reason satisfies every black/freeze/silence warning of that code and fills all corresponding fields. The quality policy requires each acknowledgment tied to exact frame/time. Use a stable advisory identifier bound to report and interval/cue.

### P3 — P2: Speech ducking and two-pass mastering are missing

`lib/media/production/assembly.ts:220-228`; `docs/production/ARCHITECTURE.md:142`.
Assembly applies cue gains and mixes all roles directly through amix and one-pass loudnorm. It does not duck music under speech or supply measured parameters for the required two-pass loudness pass. Full-mix loudness compliance cannot ensure intelligible narration over music. Implement the specified speech-controlled ducking and two-pass mastering, with a meaningful audible fixture.

### P4 — P2: Independent QC accepts the wrong audio format

`lib/production/qc.ts:263-327`, `429-433`.
QC records audio codec/rate/channels but does not reject mismatches. Root offline probe passed MP3/44.1 kHz/mono against AAC/48 kHz/stereo. Normal assembly validates these fields separately, reducing immediate exposure, but G08 promises independent measurement of the actual output. Validate all audio profile fields; color metadata is also absent from the probe/check. Add wrong-format regression fixtures.

## Documentation and release boundary

PROGRESS.md, HANDOVER.md and task-registry.json remain stale: they list implemented creator/audio/export/QC/proposal/recovery features as planned or incomplete. SESSION_STATE also carries historical next-packet text. Reconcile current acceptance/evidence against HEAD before future orchestration; do not overwrite history or infer acceptance from source alone.

Review totals: four standards/runtime findings (three P1, one P2), four spec findings (one P1, three P2). Most urgent standards issues are export lease fencing and recoverable backups; most urgent spec issue is missing dialogue escaping the automated gate. The core is substantially implemented and passes its current checks, but these defects and unverified final human pilot acceptance prevent declaring it production-ready.
